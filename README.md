# Ginger

A personal voice assistant that speaks Vietnamese. You talk to it hands-free, it answers in a
natural voice, and it remembers what you told it in earlier conversations. Inside the app the
assistant calls itself "Gừng" (Vietnamese for ginger).

```
ginger/
├── backend/   FastAPI + Postgres/pgvector, LiveKit voice agent
├── app/       Expo (SDK 58, React Native, TypeScript), iOS + web
└── docs/      Notes (latency breakdown: docs/do-tre.md)
```

## How it works

The pipeline is STT → LLM + memory → TTS. It does not use a speech-to-speech model, because that
would cost more and make memory harder to control.

| Part | Service |
|---|---|
| Speech-to-text | Soniox real-time STT (`stt-rt-v6`), hinted with the assistant's name |
| LLM | Claude. Users pick Haiku, Sonnet (default) or Opus in Settings; background jobs use Haiku |
| Embeddings | Voyage AI `voyage-3.5` (1024 dimensions) |
| Text-to-speech | Soniox TTS (`tts-rt-v2`, Vietnamese voice `Linh`) |
| Real-time audio | LiveKit Cloud (WebRTC with echo cancellation; optional Krisp voice isolation) |

Voice flow on native and web: the app joins a LiveKit room → the `ginger` agent
(`backend/app/agent.py`) transcribes speech, calls Claude with memory and speaks the reply.
You can interrupt Ginger mid-sentence just by talking. Turns end on Soniox endpoint detection.

The app never holds provider API keys. It calls the backend with a self-chosen `APP_TOKEN` and a
random per-device ID (`X-Device-Id`). Each new device gets its own account, and all data is
scoped to that account.

## Running the backend

```bash
cd backend
docker compose up -d                 # Postgres with pgvector on port 5432
cp .env.example .env                 # fill in the API keys and APP_TOKEN
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The schema is created on startup. Health check: `curl localhost:8000/health`.

`.env` needs:

- `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SONIOX_API_KEY`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (create a project on
  [LiveKit Cloud](https://cloud.livekit.io))
- `APP_TOKEN`: a long random string, e.g. `python -c "import secrets; print(secrets.token_urlsafe(32))"`

The LiveKit voice agent runs as a separate process next to uvicorn. It does not auto-reload, so
restart it after changing its code:

```bash
python -m app.agent download-files   # first time only: downloads the VAD model
python -m app.agent dev
```

### Exposing the backend to a phone

A dev build blocks plain HTTP, and microphone access on the web needs HTTPS. The backend is
served over HTTPS with Tailscale Funnel, so the phone does not need Tailscale installed:

```bash
tailscale funnel --bg 8000           # → https://<machine>.<tailnet>.ts.net
```

This makes the backend public. `APP_TOKEN` is the only protection, so every route except
`/health` and the static web build must check it.

## Running the app

```bash
cd app
cp .env.example .env    # EXPO_PUBLIC_API_URL (backend HTTPS URL), EXPO_PUBLIC_APP_TOKEN
npm install
```

The app picks its voice mode from the runtime environment:

- **Development build** (`Ginger Dev`, bundle ID suffix `.dev`, installs next to the preview app):
  LiveKit voice with barge-in. Requires an Apple Developer account.

  ```bash
  npx eas-cli build --profile development --platform ios
  APP_VARIANT=development npx expo start --dev-client --tunnel
  ```

- **Preview** (standalone install, JS bundled at build time, no Metro needed). The backend URL
  comes from the EAS environment `preview` and is not committed. The token is not bundled: the
  app asks for it once and stores it in the Keychain.

  ```bash
  npx eas-cli env:create preview --name EXPO_PUBLIC_API_URL --value https://... --visibility plaintext
  npx eas-cli build --profile preview --platform ios
  ```

  To ship JS-only changes over the air (EAS Update, channel `preview`), run:

  ```bash
  bash scripts/ota.sh "What changed"
  ```

  Don't run `eas update` directly. It bundles locally, reads `app/.env` and would embed
  `EXPO_PUBLIC_APP_TOKEN`. The script disables `.env`, checks the bundle contains no token, and
  refuses to upload if the native fingerprint differs from the latest preview build. Native
  dependency or `app.json` changes still need a new build.

- **Web** (Safari on iPhone, no Apple Developer account needed): same LiveKit screen
  (`src/livekit.web.tsx`). The backend serves the exported web app at `/`, on the same origin as
  the API. The token is not bundled; the page asks for it once and keeps it in localStorage.

  ```bash
  npx expo export -p web     # builds into app/dist, which the backend serves directly
  ```

- **Expo Go**: falls back to a WebSocket `/voice` path (tap = hands-free, hold = push-to-talk).
  Voice barge-in does not work here.

On native, opening or returning to the app starts a conversation automatically, and switching
away ends it. The keyboard button in the header switches to **text chat**, which shares the same
conversation. The gear button opens **Settings**: choose the Claude model, toggle voice
isolation, view or delete individual memories, and clear memories, history or both.

## Memory

| Layer | Stored in | Added to the prompt |
|---|---|---|
| Short-term | `messages` | The last 20–29 messages of the current conversation (trimmed in steps of 10 to keep prompt caching effective) |
| Summary | `conversations.summary` | Summaries of the 3 most recent conversations, refreshed every 6 messages |
| Long-term | `memories` (1024-dim vectors) | All memories while there are ≤ 40; above that, the top 8 relevant to the question |

After each reply, a background task (it does not delay the response):

1. Has Haiku extract lasting facts about the user, embeds them and stores them. A fact with
   cosine ≥ 0.88 to an existing memory **overwrites** it, so corrections replace old facts.
2. Updates the conversation summary every 6 messages.

The prompt is ordered for caching: a stable system prompt (persona + past summaries), then the
history with a cache breakpoint on the last message, then the new message with the per-turn
context (current time + memories).

## API

Every endpoint except `/health` needs `Authorization: Bearer <APP_TOKEN>` and `X-Device-Id`.

| Method | Path | Notes |
|---|---|---|
| POST | `/livekit/token` | `{conversation_id?}` → `{url, token}` for a new LiveKit room with the Ginger agent |
| POST | `/chat` | `{message, conversation_id?}` → streamed text, `X-Conversation-Id` header |
| WS | `/voice` | Expo Go voice: `start` → PCM s16le → `end`; returns `transcript`, `reply_delta`, `reply` (with `audio_id`) |
| GET | `/voice/audio/{id}` | mp3 of a reply (Soniox TTS) |
| GET | `/conversations` | List conversations |
| GET | `/conversations/{id}/messages` | Conversation history |
| DELETE | `/conversations` | Delete all conversations (messages and summaries included) |
| GET | `/memories` | Long-term memories |
| DELETE | `/memories/{id}` | Delete one memory |
| DELETE | `/memories` | Delete all memories |
| GET | `/data/stats` | `{memories, conversations}` counts for Settings |
| GET | `/settings` | Selected model family, available models, voice isolation flag |
| PUT | `/settings` | `{model?, voice_isolation?}`: updates only the fields sent |

## Notes

- Replies are written as spoken language without markdown, so they go straight into TTS.
- Changing the embedding model also means changing `VECTOR(1024)` in `schema.sql`.
- Per-turn voice latency is about 3.0 s (median). See `docs/do-tre.md` for the breakdown and
  what has been tried.
- Next: Sign in with Apple to link several devices to one account, and retire the legacy
  WebSocket `/voice` path.
