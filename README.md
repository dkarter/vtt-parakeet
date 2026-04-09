# bun-react-tailwind-shadcn-template

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Local transcript cleanup

The live STT pipeline can optionally post-process transcripts on the server through a local Ollama-compatible model. Raw transcription stays interactive while you speak, and cleanup runs only after a longer pause or when dictation stops. This is used to:

- remove filler words like `um`, `uh`, and `ah`
- fix common technical term recognition issues like `type script` -> `TypeScript`
- wrap known technical terms like `Google Chrome`, `Firefox`, `React`, and `shadcn/ui` in backticks

By default the server will try `http://127.0.0.1:11434` with model `qwen3:8b`, then fall back to heuristic cleanup if the model is unavailable.

Environment variables:

- `TRANSCRIPT_CLEANUP_ENABLED=false` disables model-based cleanup
- `TRANSCRIPT_CLEANUP_MODEL=qwen3:8b`
- `TRANSCRIPT_CLEANUP_BASE_URL=http://127.0.0.1:11434`
- `TRANSCRIPT_CLEANUP_TIMEOUT_MS=6000`
- `TRANSCRIPT_CLEANUP_PAUSE_MS=1800`
