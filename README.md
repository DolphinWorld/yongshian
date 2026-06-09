# AI Emergent Property (涌现 Yongshian)

First prototype for a local-first app that orchestrates discussion across multiple AI vendors and models.

## What works in this version

- Collapsible settings panel for model selection, summarizer model, max rounds, and bias control.
- Ranked default model list with OpenAI, Anthropic, Google Gemini, DeepSeek, and Ollama.
- Provider API-key/setup links and usage links where providers expose a usage page.
- Parallel real provider requests for each debate round.
- Per-round and whole-process quota/cost deltas.
- Final summary with common understanding and model-specific disagreement points.
- Extensible model/provider registry in `src/models.json`.

Provider calls are real. If an API key, local Ollama model, network path, or provider endpoint is unavailable, the app reports that model's error instead of generating a fallback answer.

## Add or change models

Edit `src/models.json` to add vendors and models. Each provider can define its display name, adapter, base URL, whether it is local, the API-key page, usage page, and credential label. Each model can define its id, provider API model name, detail name, vendor, default selected state, summarizer eligibility, local/cloud credential requirement, and estimated per-round cost.

## Run locally

```bash
npm run dev
```

Then open:

```text
http://localhost:4173
```

## Run as a desktop app with Tauri

This repo now includes a Tauri v2 shell in `src-tauri/`.

Install the native prerequisites first:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
xcode-select --install
```

Then restart the terminal and run:

```bash
npm install
npm run desktop:dev
```

To create a packaged desktop build:

```bash
npm run desktop:build
```

Current status on this machine: the Tauri config is recognized, the static frontend build works, and `npm run desktop:build` creates the macOS app and DMG bundles.

## Next implementation steps

1. Move API keys from browser localStorage into OS-native secure storage.
2. Add real quota fetching where providers expose supported usage APIs.
3. Add Ollama runtime detection through `http://localhost:11434/api/tags`.
4. Persist user defaults locally.
5. Add export/share for final summaries.
6. Add a native Tauri HTTP command if any provider blocks direct WebView requests with CORS.
