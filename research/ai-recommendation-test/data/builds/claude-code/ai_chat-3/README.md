# AI Chat

A small, self-hosted AI chat app (powered by Claude) where each user has an account and their conversation history is saved.

## Features
- Username/password accounts (bcrypt-hashed passwords, httpOnly session cookies; session tokens are stored hashed)
- Per-user conversation history stored in SQLite; every query checks that the conversation belongs to the user making the request
- Streaming responses, with a Stop button (partial replies are saved)
- Conversations get an automatic title from the first message, and can be renamed or deleted
- The full conversation history is sent to the model, so it keeps context across turns and after reloads

## Run
Requires Node 18+.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
# open http://localhost:3000
```

### Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | API key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Model ID |
| `MAX_TOKENS` | `2048` | Max tokens per reply |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `chat.db` | SQLite file location |
| `NODE_ENV` | — | Set to `production` to mark cookies `Secure` (requires HTTPS) |

## Structure
- `server.js`: Express API (auth, conversations, streaming chat via SSE)
- `db.js`: SQLite schema (users, sessions, conversations, messages)
- `public/`: Frontend (vanilla HTML/CSS/JS, no build step)

## Notes / limitations
- Very long conversations are sent in full each turn; if one goes past the model's context window, the request will fail. Starting a new chat works around this.
- The login rate limiter keeps its state in memory, so it resets on restart and only works for a single process.
- Replies are shown as plain text (no Markdown rendering).
