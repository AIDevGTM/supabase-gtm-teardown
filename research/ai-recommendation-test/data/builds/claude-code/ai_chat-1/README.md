# AI Chat

A small, self-hosted AI chat app with user accounts. Each user's conversations are saved to the app's database and come back when they sign in again.

## Features
- Register and sign in. Passwords are hashed with bcrypt. Sessions use httpOnly cookies, and only a SHA-256 hash of each session token is stored.
- Multiple conversations per user: create, switch, rename, delete.
- Replies stream in from Claude (Anthropic API) as they're generated.
- Full history is stored in SQLite and sent as context with every message.
- New conversations are titled from their first message.
- Each user can only access their own conversations (checked on every request).
- Text is rendered with `textContent`, so messages can't inject HTML.

## Run it
Requires Node 18+.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # or: cp .env.example .env and use `node --env-file=.env server.js`
npm start
```
Open http://localhost:3000, create an account, and start chatting.

## Configuration (env vars)
| Var | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Any Messages API model |
| `MAX_TOKENS` | `2048` | Max reply length |
| `SYSTEM_PROMPT` | helpful assistant | |
| `PORT` | `3000` | |
| `DATABASE_PATH` | `./data/chat.db` | SQLite file |
| `NODE_ENV` | — | Set to `production` to mark cookies `Secure` (needs HTTPS) |

## Structure
```
server.js        Express API: auth, conversations, streaming chat
db.js            SQLite schema (users, sessions, conversations, messages)
public/          Static frontend (index.html, app.js, style.css)
```

## API
- `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET/POST /api/conversations`
- `GET/PATCH/DELETE /api/conversations/:id`
- `POST /api/conversations/:id/messages` streams back `data: {...}` events: `meta`, `delta`, `done`, `error`

## Notes and limitations
- If the AI call fails before producing any text, the user's message is removed from the conversation and put back in the input box. If a reply is cut off partway, the partial reply is saved.
- The whole conversation is sent as context each time. Very long chats may eventually hit the model's context limit.
- The login rate limiter is in-memory, so it's per-process only. Put the app behind a proxy or use a shared store if you run multiple instances.
