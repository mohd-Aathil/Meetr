# MEETR

A lightweight always-on-top desktop overlay for meetings and interviews. It transcribes what is said, answers spoken questions, and reads your screen to answer the task in front of you.

## Features

- **Live transcription** via Deepgram, shown in the overlay.
- **Voice answers** via Groq: questions asked out loud are answered automatically.
- **Screen answers** via OpenRouter (`Shift+Enter`): the overlay hides, captures the screen, and answers the visible task with a vision model.
- **Hidden from screen shares**: the window uses Electron content protection, so it stays out of Meet, Zoom, Teams and Discord captures.
- **Resume notes**: open the settings panel and paste background notes; they are sent as context with every question.
- **Tray icon** and global shortcuts, so it works while another app has focus.

## Requirements

- Windows (the packaged build targets x64)
- Node.js 20+
- API keys for Deepgram, Groq and OpenRouter

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

| Variable | Purpose |
| --- | --- |
| `DEEPGRAM_API_KEY` | Live transcription. Get one at <https://console.deepgram.com/> |
| `GROQ_API_KEY` | Fast voice answers. Get one at <https://console.groq.com/> |
| `GROQ_MODEL` | Optional, defaults to `openai/gpt-oss-20b` |
| `OPENROUTER_API_KEY` | Screen answers. Get one at <https://openrouter.ai/keys> |
| `OPENROUTER_API_KEY_2` … `_5` | Optional extra keys, used automatically when an earlier one hits its limit |

`.env` is gitignored — never commit your keys. The app only reads it at startup, so restart after changing it.

## Run

```bash
npm start   # Vite dev server + Electron
```

Open the app through `npm start`, not the Vite URL in a browser: the UI needs the Electron bridge.

Build a Windows installer with `npm run dist` (output goes to `dist-app/`).

## Usage

| Action | Shortcut |
| --- | --- |
| Show / hide the overlay | `Ctrl+Shift+M` (or click the tray icon) |
| Analyze the screen | `Shift+Enter` |

1. Open the overlay (settings panel) and paste your notes or resume context.
2. Press **Listen** to start transcription. Ask questions out loud — finalized ones are answered automatically when **Auto-send voice questions** is ticked (pressing **Stop** also sends the latest transcript).
3. Press `Shift+Enter` whenever a coding task, slide or form is on screen.

Hide the overlay with Ctrl+Shift+M before sharing your screen if you want it out of the way; content protection keeps it out of captures either way.

## How screen answers stay available

Free OpenRouter models are rate limited, so `electron/openRouter.js` retries instead of failing on the first error:

1. It tries the free vision models in `FALLBACK_MODELS`, skipping one that is temporarily rate limited upstream.
2. If the key itself is out of quota (daily limit, no credits, bad key), it marks that key as cooling down and switches to the next configured key.
3. When every key is spent it stops with a message telling you to add `OPENROUTER_API_KEY_2`.

The model and key that last worked are remembered, so later questions start from there. Note that OpenRouter's free-model daily limit is per **account**, so a second key only gives you a fresh quota if it belongs to a different account.

## Project layout

```
electron/       main process: window, tray, shortcuts, IPC
  main.js       app lifecycle, screen capture, IPC handlers
  openRouter.js screen answers (model + API key fallback)
  groq.js       voice answers
  deepgramSession.js  live transcription
  preload.js    contextBridge API exposed to the UI as window.meetr
src/            React + Tailwind overlay UI
```

## Troubleshooting

- **`Error invoking remote method 'openrouter:ask'`** — the request failed. The trailing message says why: an upstream model hiccup (just retry), a spent key (add another key), or a missing key in `.env`.
- **Screen answers disabled** — `OPENROUTER_API_KEY` is missing or blank; add it and restart.
- **No transcript** — check `DEEPGRAM_API_KEY` and that system audio is playing.
- **Overlay missing after capture** — it reappears automatically; if not, press `Ctrl+Shift+M`.
