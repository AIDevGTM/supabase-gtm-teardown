# AI Chat

A small full-stack AI chat app where each user has their own account and saved conversation history.

- **Accounts**: username/password sign-up and sign-in (bcrypt-hashed passwords, httpOnly session cookies; only hashed session tokens are stored)
- **History**: every conversation and message is saved in SQLite per user; reopen, rename, or delete chats from the sidebar
- **AI replies**: streamed live from Anthropic's Claude; you can stop a reply partway and the partial text is saved
- **No build step**: Express backend + plain HTML/CSS/JS frontend

## Quick start

Requires Node.js 18+.

```bash
npm install
cp .env.example .env      # then set ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000, create an account, and start chatting.

Without an API key the app still runs (accounts and history work) but shows a banner and AI replies return an error.

## Configuration (`.env`)

| Variable            | Default                  | Notes                                          |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                        | Required for AI replies                        |
| `ANTHROPIC_MODEL`   | `claude-sonnet-4-5`      | Any Messages API model id                      |
| `MAX_TOKENS`        | `2048`                   | Max tokens per reply                           |
| `HISTORY_LIMIT`     | `50`                     | Most recent messages sent to the model as context |
| `SYSTEM_PROMPT`     | helpful-assistant prompt |                                                |
| `PORT`              | `3000`                   |                                                |
| `DB_PATH`           | `./data/chat.db`         | SQLite file (created automatically)            |
| `NODE_ENV`          | —                        | `production` marks cookies `Secure` (HTTPS only) |
| `TRUST_PROXY`       | —                        | Set to `1` behind a reverse proxy (correct client IPs for rate limiting) |

## Project layout

```
server.js          Express API, auth, SQLite schema, Claude streaming
public/index.html  UI markup (auth screen + chat screen)
public/app.js      Client logic: auth, sidebar, streaming chat
public/styles.css  Styling (dark theme, responsive)
```

## API

All endpoints are JSON; mutating requests must send `Content-Type: application/json` (part of the CSRF protection, with `SameSite=Lax` cookies).

| Method | Path                               | Description                                  |
| ------ | ---------------------------------- | -------------------------------------------- |
| POST   | `/api/signup`                      | `{username, password}` → creates account + session |
| POST   | `/api/login`                       | `{username, password}`                       |
| POST   | `/api/logout`                      |                                              |
| GET    | `/api/me`                          | Current user + whether AI is configured      |
| GET    | `/api/conversations`               | The user's conversations, newest first       |
| POST   | `/api/conversations`               | Create an empty conversation                 |
| GET    | `/api/conversations/:id`           | Conversation + all messages                  |
| PATCH  | `/api/conversations/:id`           | `{title}` rename                             |
| DELETE | `/api/conversations/:id`           | Delete conversation and its messages         |
| POST   | `/api/conversations/:id/messages`  | `{content}` → Server-Sent Events stream (`meta`, `delta`, `done` / `error`) |

Every conversation query is scoped to the signed-in user, so users can only ever see their own history.

## Notes

- The user's message is saved before the model is called, so it is never lost even if the AI request fails.
- The first message auto-titles the conversation; titles can be renamed from the sidebar.
- Only one reply streams per conversation at a time (concurrent sends get `409`).
- Auth endpoints are rate-limited in memory (20 attempts / 15 min per IP). For multi-instance deployments, swap in a shared store.
