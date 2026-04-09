import { serve } from "bun";
import index from "./index.html";

type SttClientMessage =
  | { type: "start" }
  | { type: "chunk"; audioBase64: string; mimeType?: string }
  | { type: "stop" };

type SttServerMessage =
  | { type: "ready" }
  | { type: "status"; message: string; queueLength?: number }
  | { type: "partial"; text: string; fullText: string }
  | { type: "final"; fullText: string; finalized?: boolean }
  | { type: "error"; message: string };

type SttSession = {
  audioChunks: Array<Uint8Array>;
  bufferedChunkCount: number;
  cleanedTranscriptText: string;
  transcriptText: string;
  cleanupInFlight: boolean;
  cleanupRequested: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  inputMimeType?: string;
  processing: boolean;
  needsRerun: boolean;
  worker: ParakeetWorker | null;
  rawFinalSent: boolean;
  stopping: boolean;
  finalized: boolean;
  runCount: number;
};

type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; text?: string }
  | { type: "shutdown" }
  | { type: "error"; message?: string };

type ParakeetWorker = {
  process: ReturnType<typeof Bun.spawn>;
  writer: FileSink;
  reader: ReadableStreamDefaultReader<string>;
  errorTextPromise: Promise<string>;
  buffer: string;
};

const sttSessions = new Map<ServerWebSocket<SttSession>, SttSession>();
const parakeetWorkerScriptPath = new URL("../scripts/parakeet_worker.py", import.meta.url).pathname;

const sttModel = process.env.PARAKEET_MODEL ?? "mlx-community/parakeet-tdt-0.6b-v3";
const transcriptCleanupModel = process.env.TRANSCRIPT_CLEANUP_MODEL ?? "qwen3:8b";
const transcriptCleanupBaseUrl = process.env.TRANSCRIPT_CLEANUP_BASE_URL ?? "http://127.0.0.1:11434";
const transcriptCleanupEnabled = process.env.TRANSCRIPT_CLEANUP_ENABLED !== "false";
const transcriptCleanupTimeoutMs = Number(process.env.TRANSCRIPT_CLEANUP_TIMEOUT_MS ?? 6000);
const transcriptCleanupPauseMs = Number(process.env.TRANSCRIPT_CLEANUP_PAUSE_MS ?? 1800);
const codeTerms = [
  "Google Chrome",
  "Firefox",
  "Safari",
  "Visual Studio Code",
  "VS Code",
  "TypeScript",
  "JavaScript",
  "React",
  "Node.js",
  "Bun",
  "GitHub",
  "Git",
  "PostgreSQL",
  "SQLite",
  "WebSocket",
  "Tailwind",
  "Tailwind CSS",
  "shadcn",
  "shadcn/ui",
  "OpenAI",
  "Claude",
  "Docker",
  "FFmpeg",
];

const sendSttMessage = (ws: ServerWebSocket<SttSession>, payload: SttServerMessage) => {
  ws.send(JSON.stringify(payload));
};

const clearCleanupTimer = (session: SttSession) => {
  if (!session.cleanupTimer) {
    return;
  }

  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = null;
};

const readWorkerMessage = async (worker: ParakeetWorker) => {
  while (true) {
    const newlineIndex = worker.buffer.indexOf("\n");
    if (newlineIndex >= 0) {
      const line = worker.buffer.slice(0, newlineIndex).trim();
      worker.buffer = worker.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      return JSON.parse(line) as WorkerResponse;
    }

    const { done, value } = await worker.reader.read();
    if (done) {
      const stderr = await worker.errorTextPromise;
      throw new Error(stderr || "Parakeet worker exited unexpectedly");
    }

    worker.buffer += value;
  }
};

const writeWorkerMessage = async (worker: ParakeetWorker, payload: object) => {
  const data = `${JSON.stringify(payload)}\n`;
  worker.writer.write(data);
  await worker.writer.flush();
};

const startParakeetWorker = async () => {
  const process = Bun.spawn(["uv", "run", "--with", "parakeet-mlx", "python", "-u", parakeetWorkerScriptPath, sttModel], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!process.stdin || !process.stdout || !process.stderr) {
    throw new Error("Failed to start Parakeet worker pipes");
  }

  const worker: ParakeetWorker = {
    process,
    writer: process.stdin,
    reader: process.stdout.pipeThrough(new TextDecoderStream()).getReader(),
    errorTextPromise: new Response(process.stderr).text(),
    buffer: "",
  };

  const firstMessage = await readWorkerMessage(worker);
  if (firstMessage.type === "ready") {
    return worker;
  }

  const stderr = await worker.errorTextPromise;
  throw new Error(firstMessage.type === "error" ? firstMessage.message || stderr || "Parakeet worker failed to initialize" : stderr || "Parakeet worker failed to initialize");
};

const stopParakeetWorker = async (worker: ParakeetWorker | null) => {
  if (!worker) {
    return;
  }

  try {
    await writeWorkerMessage(worker, { type: "shutdown" });
  } catch {
    // Ignore shutdown write failures when the worker is already exiting.
  }

  try {
    await worker.writer.end();
  } catch {
    // Ignore double-close errors.
  }

  await worker.process.exited;
};

const runCommand = async (cmd: Array<string>) => {
  const process = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${cmd.join(" ")}`);
  }

  return stdout;
};

const extensionFromMimeType = (mimeType?: string) => {
  if (!mimeType) {
    return "webm";
  }

  if (mimeType.includes("mp4") || mimeType.includes("mpeg")) {
    return "m4a";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  return "webm";
};

const transcribeChunksWithWorker = async (worker: ParakeetWorker, audioChunks: Array<Uint8Array>, mimeType?: string) => {
  const tmpRoot = process.env.TMPDIR ?? "/tmp";
  const workDir = `${tmpRoot}/vtt-stt-${crypto.randomUUID()}`;
  const extension = extensionFromMimeType(mimeType);
  const inputPath = `${workDir}/chunk.${extension}`;
  const wavPath = `${workDir}/chunk.wav`;

  try {
    await Bun.$`mkdir -p ${workDir}`;
    await Bun.write(inputPath, Buffer.concat(audioChunks.map(chunk => Buffer.from(chunk))));

    await runCommand([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      wavPath,
    ]);

    await writeWorkerMessage(worker, { type: "transcribe", audioPath: wavPath });
    const response = await readWorkerMessage(worker);

    if (response.type === "result") {
      return response.text?.trim() ?? "";
    }

    if (response.type === "error") {
      throw new Error(response.message || "Parakeet worker transcription failed");
    }

    throw new Error("Unexpected Parakeet worker response");
  } finally {
    await Bun.$`rm -rf ${workDir}`;
  }
};

const normalizeErrorMessage = (message: string) => {
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
};

const escapeRegExp = (value: string) => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const wrapKnownTechnicalTerms = (text: string) => {
  return codeTerms.reduce((currentText, term) => {
    const pattern = new RegExp(`(?<!\`)\\b${escapeRegExp(term)}\\b(?!\`)`, "gi");
    return currentText.replace(pattern, matched => `\`${matched}\``);
  }, text);
};

const correctCommonTechnicalTerms = (text: string) => {
  return text
    .replace(/\bgoogle\s+chrome\b/gi, "Google Chrome")
    .replace(/\bfire\s*fox\b/gi, "Firefox")
    .replace(/\bvisual\s+studio\s+code\b/gi, "Visual Studio Code")
    .replace(/\bvs\s+code\b/gi, "VS Code")
    .replace(/\btype\s*script\b/gi, "TypeScript")
    .replace(/\bjava\s*script\b/gi, "JavaScript")
    .replace(/\bnode\s*js\b/gi, "Node.js")
    .replace(/\bweb\s*socket\b/gi, "WebSocket")
    .replace(/\bpost\s*gres(?:ql)?\b/gi, "PostgreSQL")
    .replace(/\bsql\s*lite\b/gi, "SQLite")
    .replace(/\btail\s*wind(?:\s+css)?\b/gi, matched => (matched.toLowerCase().includes("css") ? "Tailwind CSS" : "Tailwind"))
    .replace(/\bshad\s*cn(?:\s*slash\s*ui|\s*ui)?\b/gi, matched =>
      matched.toLowerCase().includes("ui") ? "shadcn/ui" : "shadcn",
    );
};

const cleanupTranscriptHeuristics = (text: string) => {
  const withoutFillers = text
    .replace(/(^|[\s,.;:!?-])(uh|um|umm|uhh|ah|ahh|er|erm)(?=($|[\s,.;:!?-]))/gi, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  return wrapKnownTechnicalTerms(correctCommonTechnicalTerms(withoutFillers));
};

const postProcessTranscriptWithLocalModel = async (text: string) => {
  const cleanedWithHeuristics = cleanupTranscriptHeuristics(text);

  if (!transcriptCleanupEnabled || !cleanedWithHeuristics) {
    return cleanedWithHeuristics;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), transcriptCleanupTimeoutMs);

  try {
    const response = await fetch(`${transcriptCleanupBaseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: transcriptCleanupModel,
        stream: false,
        options: {
          temperature: 0,
        },
        messages: [
          {
            role: "system",
            content:
              "You clean up speech-to-text transcripts for a coding assistant. Return only the cleaned transcript text, with no quotes or commentary. Remove filler words like um, uh, ah, and repeated speech artifacts when they are not meaningful. Keep the user's meaning, tone, and intent intact. Correct obvious technical term recognition errors. Wrap product names, app names, browser names, libraries, frameworks, languages, and tool names in backticks when they are concrete technical references, for example `Google Chrome`, `Firefox`, `TypeScript`, `React`, `Bun`, `WebSocket`, and `shadcn/ui`. Do not invent facts. Do not add punctuation beyond light cleanup.",
          },
          {
            role: "user",
            content: cleanedWithHeuristics,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Cleanup request failed with ${response.status}`);
    }

    const payload = (await response.json()) as { message?: { content?: string } };
    const cleanedText = payload.message?.content?.trim();

    if (!cleanedText) {
      return cleanedWithHeuristics;
    }

    return wrapKnownTechnicalTerms(correctCommonTechnicalTerms(cleanedText));
  } catch {
    return cleanedWithHeuristics;
  } finally {
    clearTimeout(timeout);
  }
};

const mergeTranscript = (currentText: string, nextText: string) => {
  const current = currentText.trim();
  const next = nextText.trim();

  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (next === current) {
    return current;
  }

  if (next.includes(current) || next.length >= current.length) {
    return next;
  }

  return current;
};

const closeSttSession = (ws: ServerWebSocket<SttSession>) => {
  const session = sttSessions.get(ws);
  if (session) {
    clearCleanupTimer(session);
    void stopParakeetWorker(session.worker);
    session.worker = null;
  }

  ws.close();
  sttSessions.delete(ws);
};

const finalizeSttSession = async (ws: ServerWebSocket<SttSession>) => {
  const session = sttSessions.get(ws);
  if (!session || session.finalized) {
    return;
  }

  session.finalized = true;
  clearCleanupTimer(session);

  const rawFinalText = session.transcriptText.trim();

  if (!session.rawFinalSent) {
    sendSttMessage(ws, {
      type: "final",
      fullText: rawFinalText,
      finalized: false,
    });
    session.rawFinalSent = true;
  }

  if (!rawFinalText) {
    sendSttMessage(ws, {
      type: "final",
      fullText: "",
      finalized: true,
    });
    closeSttSession(ws);
    return;
  }

  sendSttMessage(ws, {
    type: "status",
    message: "Cleaning final transcript...",
    queueLength: session.bufferedChunkCount,
  });

  const cleanedText = await postProcessTranscriptWithLocalModel(session.transcriptText);
  const finalText = mergeTranscript(session.cleanedTranscriptText, cleanedText) || session.transcriptText;
  session.cleanedTranscriptText = finalText;

  sendSttMessage(ws, {
    type: "final",
    fullText: finalText,
    finalized: true,
  });

  closeSttSession(ws);
};

const runTranscriptCleanup = async (ws: ServerWebSocket<SttSession>) => {
  const session = sttSessions.get(ws);
  if (!session || session.cleanupInFlight || !session.transcriptText.trim()) {
    return;
  }

  session.cleanupInFlight = true;
  session.cleanupRequested = false;

  sendSttMessage(ws, {
    type: "status",
    message: "Pause detected. Cleaning transcript...",
    queueLength: session.bufferedChunkCount,
  });

  try {
    const cleanedText = await postProcessTranscriptWithLocalModel(session.transcriptText);
    const mergedCleanedText = mergeTranscript(session.cleanedTranscriptText, cleanedText);

    if (mergedCleanedText && mergedCleanedText !== session.cleanedTranscriptText) {
      session.cleanedTranscriptText = mergedCleanedText;
      sendSttMessage(ws, {
        type: "partial",
        text: mergedCleanedText,
        fullText: mergedCleanedText,
      });
    }
  } finally {
    session.cleanupInFlight = false;

    if (session.stopping) {
      void finalizeSttSession(ws);
      return;
    }

    if (session.cleanupRequested) {
      session.cleanupRequested = false;
      session.cleanupTimer = setTimeout(() => {
        session.cleanupTimer = null;
        void runTranscriptCleanup(ws);
      }, transcriptCleanupPauseMs);
      return;
    }

    sendSttMessage(ws, {
      type: "status",
      message: "Live transcription running",
      queueLength: session.bufferedChunkCount,
    });
  }
};

const scheduleTranscriptCleanup = (ws: ServerWebSocket<SttSession>) => {
  const session = sttSessions.get(ws);
  if (!session) {
    return;
  }

  clearCleanupTimer(session);

  if (session.cleanupInFlight) {
    session.cleanupRequested = true;
    return;
  }

  session.cleanupTimer = setTimeout(() => {
    session.cleanupTimer = null;
    void runTranscriptCleanup(ws);
  }, transcriptCleanupPauseMs);
};

const processSttQueue = async (ws: ServerWebSocket<SttSession>) => {
  const session = sttSessions.get(ws);
  if (!session || session.processing) {
    return;
  }

  session.processing = true;

  while (true) {
    const startChunkCount = session.audioChunks.length;
    session.needsRerun = false;
    session.runCount += 1;

    sendSttMessage(ws, {
      type: "status",
      message:
        session.runCount === 1
          ? "Preparing local Parakeet model (first run may take 1-3 minutes)..."
          : `Transcribing buffered audio... (${startChunkCount} chunks captured)`,
      queueLength: session.bufferedChunkCount,
    });

    try {
      if (!session.worker) {
        session.worker = await startParakeetWorker();
      }

      const text = await transcribeChunksWithWorker(session.worker, session.audioChunks, session.inputMimeType);
      const mergedText = mergeTranscript(session.transcriptText, text);

      const transcriptChanged = mergedText !== session.transcriptText;

      session.transcriptText = mergedText;

      if (mergedText && transcriptChanged) {
        session.cleanedTranscriptText = mergeTranscript(session.cleanedTranscriptText, mergedText);

        sendSttMessage(ws, {
          type: "partial",
          text: mergedText,
          fullText: mergedText,
        });
      }

      sendSttMessage(ws, {
        type: "status",
        message: "Live transcription running",
        queueLength: session.bufferedChunkCount,
      });

      if (session.stopping && !session.rawFinalSent) {
        sendSttMessage(ws, {
          type: "final",
          fullText: session.transcriptText,
          finalized: false,
        });
        session.rawFinalSent = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local STT failed";
      sendSttMessage(ws, {
        type: "error",
        message: `Local Parakeet transcription failed: ${normalizeErrorMessage(message)}`,
      });
      closeSttSession(ws);
      return;
    }

    session.bufferedChunkCount = 0;

    if (!session.needsRerun && startChunkCount === session.audioChunks.length) {
      break;
    }
  }

  session.processing = false;

  if (session.stopping) {
    void finalizeSttSession(ws);
    return;
  }

  scheduleTranscriptCleanup(ws);
};

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    "/*": index,

    "/api/hello": {
      async GET(req) {
        return Response.json({
          message: "Hello, world!",
          method: "GET",
        });
      },
      async PUT(req) {
        return Response.json({
          message: "Hello, world!",
          method: "PUT",
        });
      },
    },

    "/api/hello/:name": async req => {
      const name = req.params.name;
      return Response.json({
        message: `Hello, ${name}!`,
      });
    },

    "/api/stt/live": req => {
      const upgraded = server.upgrade(req, {
        data: {
          audioChunks: [],
          bufferedChunkCount: 0,
          cleanedTranscriptText: "",
          cleanupInFlight: false,
          cleanupRequested: false,
          cleanupTimer: null,
          transcriptText: "",
          inputMimeType: undefined,
          processing: false,
          needsRerun: false,
          worker: null,
          rawFinalSent: false,
          stopping: false,
          finalized: false,
          runCount: 0,
        },
      });

      if (!upgraded) {
        return new Response("Upgrade failed", { status: 400 });
      }

      return;
    },
  },

  websocket: {
    open(ws) {
      const session = ws.data;
      sttSessions.set(ws, session);
      sendSttMessage(ws, { type: "ready" });
    },

    message(ws, message) {
      if (typeof message !== "string") {
        sendSttMessage(ws, { type: "error", message: "Invalid message type" });
        return;
      }

      let payload: SttClientMessage;

      try {
        payload = JSON.parse(message) as SttClientMessage;
      } catch {
        sendSttMessage(ws, { type: "error", message: "Invalid JSON payload" });
        return;
      }

      const session = sttSessions.get(ws);
      if (!session) {
        sendSttMessage(ws, { type: "error", message: "STT session not found" });
        return;
      }

      if (payload.type === "start") {
        session.audioChunks = [];
        session.bufferedChunkCount = 0;
        session.cleanedTranscriptText = "";
        session.cleanupInFlight = false;
        session.cleanupRequested = false;
        session.transcriptText = "";
        session.inputMimeType = undefined;
        session.processing = false;
        session.needsRerun = false;
        session.worker = null;
        session.rawFinalSent = false;
        session.stopping = false;
        session.finalized = false;
        session.runCount = 0;
        clearCleanupTimer(session);
        sendSttMessage(ws, {
          type: "status",
          message: "Microphone connected. Waiting for audio chunks...",
          queueLength: 0,
        });
        return;
      }

        if (payload.type === "chunk") {
          if (!payload.audioBase64) {
            return;
          }

          clearCleanupTimer(session);
          session.audioChunks.push(Buffer.from(payload.audioBase64, "base64"));
          session.bufferedChunkCount += 1;
          if (!session.inputMimeType && payload.mimeType) {
            session.inputMimeType = payload.mimeType;
          }

        if (session.processing) {
          session.needsRerun = true;
        }

        sendSttMessage(ws, {
          type: "status",
          message: session.processing ? "Audio buffered while transcribing..." : "Audio chunk received",
          queueLength: session.bufferedChunkCount,
        });

        if (!session.processing) {
          void processSttQueue(ws);
        }

        return;
      }

      if (payload.type === "stop") {
        session.stopping = true;
        clearCleanupTimer(session);
        if (!session.processing && !session.cleanupInFlight) {
          void finalizeSttSession(ws);
        }
      }
    },

    close(ws) {
      const session = sttSessions.get(ws);
      if (session) {
        clearCleanupTimer(session);
      }
      sttSessions.delete(ws);
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
