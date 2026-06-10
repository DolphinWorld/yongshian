# AI Emergent Property (涌现 Yongshian)

First prototype for a local-first app that orchestrates discussion across multiple AI vendors and models.

Yongshian is pronounced like "Yong Xian".

## What works in this version

- Collapsible settings panel for model selection, summarizer model, max rounds, and bias control.
- Ranked default model list with OpenAI, Anthropic, Google Gemini, DeepSeek, and Ollama.
- Provider API-key/setup links and usage links where providers expose a usage page.
- Parallel real provider requests for each debate round.
- Per-round and whole-process quota/cost deltas.
- Final summary with common understanding and model-specific disagreement points.
- Extensible model/provider registry in `src/models.json`.
- Private access setup for trusted devices through Tailscale detection, Tailscale Serve, and a local QR code.

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

## Private access from iPhone

Install Tailscale on the Mac and iPhone, then sign both into the same tailnet. In the desktop app, open Settings, use Private Access > Check, then Share App. The app starts a bundled local web server and configures:

```bash
tailscale serve http://127.0.0.1:4173
```

After Share App succeeds, scan the generated QR code from the iPhone while Tailscale is connected. The QR is generated locally; the private URL is not sent to an external QR service.

Cloud provider keys are owned by the Mac desktop app. The iPhone view reads only provider readiness and sends model requests back through the private Mac relay, so you should not need to re-enter OpenAI, Gemini, Claude, or DeepSeek keys on iOS after they are saved on the Mac. The relay only sends keys to the expected provider API hosts.

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
3. Persist user defaults locally.
4. Add export/share for final summaries.
5. Add deeper Tailscale status details, such as whether Serve is already configured.
