import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import dictationStartSound from "./assets/dictation-start.mp3";
import dictationStopSound from "./assets/dictation-stop.mp3";
import { Mic, SendHorizontal, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import "./index.css";

type ChatRole = "user" | "agent";

type ChatMessage = {
  id: number;
  role: ChatRole;
  text: string;
};

const combineTranscript = (...parts: Array<string>) => {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
};

const toWebSocketUrl = () => {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/api/stt/live`;
};

const bufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

const ShortcutKey = ({ children }: { children: string }) => {
  return (
    <span className="inline-flex min-w-6 items-center justify-center rounded-md border border-border/80 bg-muted/70 px-2 py-1 text-[11px] font-medium leading-none shadow-xs">
      {children}
    </span>
  );
};

export function App() {
  const isAppleDevice = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  const dictationShortcut = isAppleDevice ? "Cmd+Shift+D" : "Ctrl+Shift+D";
  const dictationShortcutKeys = isAppleDevice ? ["Cmd", "Shift", "D"] : ["Ctrl", "Shift", "D"];

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "agent",
      text: "Hey, I am your agent. Ask me to plan, debug, or write code and I will help.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeechLoading, setIsSpeechLoading] = useState(false);
  const [speechError, setSpeechError] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [speechStatus, setSpeechStatus] = useState("");
  const [speechQueueLength, setSpeechQueueLength] = useState(0);

  const messageListRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const startSoundRef = useRef<HTMLAudioElement | null>(null);
  const stopSoundRef = useRef<HTMLAudioElement | null>(null);
  const baseInputRef = useRef("");
  const committedSpeechRef = useRef("");
  const stoppingRef = useRef(false);

  const playCue = useCallback((audioRef: { current: HTMLAudioElement | null }) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Ignore play rejections from browser audio policies.
    });
  }, []);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    startSoundRef.current = new Audio(dictationStartSound);
    stopSoundRef.current = new Audio(dictationStopSound);

    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      socketRef.current?.close();
      startSoundRef.current = null;
      stopSoundRef.current = null;
    };
  }, []);

  const buildAgentReply = (text: string) => {
    return `Got it. You said: "${text}". I can turn that into a concrete implementation plan next.`;
  };

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();

    if (!text || isReplying) {
      return;
    }

    const userMessage: ChatMessage = {
      id: Date.now(),
      role: "user",
      text,
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setLiveTranscript("");
    setIsReplying(true);

    window.setTimeout(() => {
      const agentMessage: ChatMessage = {
        id: Date.now() + 1,
        role: "agent",
        text: buildAgentReply(text),
      };

      setMessages((current) => [...current, agentMessage]);
      setIsReplying(false);
    }, 600);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      const form = event.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    }
  };

  const toggleListening = useCallback(async () => {
    if (isListening) {
      try {
        playCue(stopSoundRef);
        stoppingRef.current = true;
        mediaRecorderRef.current?.stop();
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        socketRef.current?.send(JSON.stringify({ type: "stop" }));
        setIsListening(false);
        setLiveTranscript("");
        setSpeechStatus("Stopped");
        setSpeechQueueLength(0);
      } catch {
        setSpeechError("Unable to stop microphone transcription.");
      }
      return;
    }

    setSpeechError("");
    setSpeechStatus("Connecting to local STT...");
    setIsSpeechLoading(true);
    baseInputRef.current = input;
    committedSpeechRef.current = "";
    stoppingRef.current = false;

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = mediaStream;

      const socket = new WebSocket(toWebSocketUrl());
      socketRef.current = socket;

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as
          | { type: "ready" }
          | { type: "status"; message: string; queueLength?: number }
          | { type: "partial"; text: string; fullText: string }
          | { type: "final"; fullText: string; finalized?: boolean }
          | { type: "error"; message: string };

        if (payload.type === "status") {
          setSpeechStatus(payload.message);
          if (typeof payload.queueLength === "number") {
            setSpeechQueueLength(payload.queueLength);
          }
          return;
        }

        if (payload.type === "ready") {
          setSpeechStatus("Socket ready. Waiting for first chunk...");
          return;
        }

        if (payload.type === "partial") {
          committedSpeechRef.current = payload.fullText;
          setLiveTranscript(payload.text);
          setInput(combineTranscript(baseInputRef.current, payload.fullText));
          setSpeechStatus("Live transcription running");
          return;
        }

        if (payload.type === "final") {
          committedSpeechRef.current = payload.fullText;
          setLiveTranscript("");
          setInput(combineTranscript(baseInputRef.current, payload.fullText));
          setSpeechStatus(payload.finalized === false ? "Final transcript ready. Cleaning..." : "Transcription complete");
          setSpeechQueueLength(0);
          if (payload.finalized !== false) {
            socket.close();
          }
          return;
        }

        if (payload.type === "error") {
          setSpeechError(payload.message);
          setIsListening(false);
          setLiveTranscript("");
          setSpeechStatus("Transcription error");
          socket.close();
        }
      };

      socket.onclose = () => {
        socketRef.current = null;
        setIsListening(false);
        if (stoppingRef.current) {
          stoppingRef.current = false;
        }
      };

      const onSocketError = () => {
        setSpeechError("Local STT socket failed. Is the Bun server running?");
        setIsListening(false);
        setSpeechStatus("Socket connection failed");
      };

      socket.onerror = onSocketError;

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("socket_error")), { once: true });
      });

      socket.send(JSON.stringify({ type: "start" }));

      const preferredMimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
      const selectedMimeType = preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));

      const mediaRecorder = selectedMimeType
        ? new MediaRecorder(mediaStream, {
            mimeType: selectedMimeType,
            audioBitsPerSecond: 96_000,
          })
        : new MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (recordedEvent) => {
        if (!recordedEvent.data.size || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        void recordedEvent.data.arrayBuffer().then((buffer) => {
          socket.send(
            JSON.stringify({
              type: "chunk",
              audioBase64: bufferToBase64(buffer),
              mimeType: recordedEvent.data.type || selectedMimeType,
            }),
          );
        });
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(750);
      setIsListening(true);
      playCue(startSoundRef);
    } catch {
      setSpeechError("Could not start local speech-to-text. Check microphone permissions and try again.");
      setIsListening(false);
      setLiveTranscript("");
      setSpeechStatus("Failed to start local STT");
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    } finally {
      setIsSpeechLoading(false);
    }
  }, [input, isListening, playCue]);

  useEffect(() => {
    const onShortcutKeyDown = (event: globalThis.KeyboardEvent) => {
      const isDictationShortcut =
        event.shiftKey && event.key.toLowerCase() === "d" && (event.metaKey || (!isAppleDevice && event.ctrlKey));

      if (!isDictationShortcut || event.repeat || isSpeechLoading) {
        return;
      }

      event.preventDefault();
      void toggleListening();
    };

    window.addEventListener("keydown", onShortcutKeyDown);
    return () => {
      window.removeEventListener("keydown", onShortcutKeyDown);
    };
  }, [isAppleDevice, isSpeechLoading, toggleListening]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl items-center px-4 py-6 sm:px-6 lg:px-8">
      <Card className="h-[88dvh] w-full overflow-hidden border-white/30 bg-card/95 backdrop-blur-sm shadow-2xl">
        <CardHeader className="border-b border-border/70 pb-5">
          <CardTitle className="text-xl tracking-tight sm:text-2xl">Agent Chat</CardTitle>
          <p className="text-muted-foreground text-sm">Type a prompt or use local Parakeet live transcription.</p>
        </CardHeader>

        <CardContent className="flex h-full flex-col gap-4 px-4 pb-4 sm:px-6">
          <div ref={messageListRef} className="flex-1 space-y-3 overflow-y-auto pr-1 pt-2">
            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={
                    message.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground shadow"
                      : "max-w-[85%] rounded-2xl rounded-bl-sm border border-border/80 bg-muted/60 px-4 py-2.5 text-sm"
                  }
                >
                  {message.text}
                </div>
              </div>
            ))}

            {isReplying ? (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm border border-border/80 bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground">
                  Agent is thinking...
                </div>
              </div>
            ) : null}
          </div>

          <form onSubmit={sendMessage} className="space-y-2 border-t border-border/70 pt-4">
            <div className="flex min-h-20 items-stretch gap-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Ask your coding agent anything..."
                rows={2}
                className="h-full max-h-40 min-h-20 resize-y bg-background/70"
              />

              <div className="grid w-9 shrink-0 grid-rows-2 gap-2 self-stretch">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant={isListening ? "destructive" : "outline"}
                        size="icon"
                        className={
                          isListening
                            ? "dictation-recording h-full w-full"
                            : !isSpeechLoading
                            ? "dictation-invite h-full w-full border-amber-400/70 bg-amber-50/80 text-amber-950 hover:bg-amber-100/90"
                            : "h-full w-full"
                        }
                        onClick={() => void toggleListening()}
                        disabled={isSpeechLoading}
                        aria-label={isListening ? `Stop listening (${dictationShortcut})` : `Start voice input (${dictationShortcut})`}
                      >
                        {isListening ? <Square /> : <Mic />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="flex items-center gap-3">
                      <span>{isListening ? "Stop dictation" : "Start dictation"}</span>
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        {dictationShortcutKeys.map((key) => (
                          <ShortcutKey key={key}>{key}</ShortcutKey>
                        ))}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <Button type="submit" size="icon" className="h-full w-full" disabled={!input.trim() || isReplying} title="Send message">
                  <SendHorizontal />
                </Button>
              </div>
            </div>

            {isListening ? <p className="text-xs text-muted-foreground">Listening and streaming to local STT...</p> : null}
            {speechStatus ? <p className="text-xs text-muted-foreground">Status: {speechStatus}</p> : null}
            {speechQueueLength > 0 ? <p className="text-xs text-muted-foreground">Queued chunks: {speechQueueLength}</p> : null}
            {liveTranscript ? <p className="text-xs text-muted-foreground">Latest chunk: {liveTranscript}</p> : null}
            {speechError ? <p className="text-xs text-destructive">{speechError}</p> : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default App;
