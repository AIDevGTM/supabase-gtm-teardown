# Realtime Chat

A multi-user, multi-room realtime chat. It has **no dependencies**: you only need Node.js 16+.

## Run

```bash
npm start            # or: node server.js
# open http://localhost:3000 in several browser tabs / devices
```

Optional env vars: `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

Others on your network can join at `http://<your-ip>:3000`. Use **Copy invite link** to share a specific room (`/?room=my-room`).

## Features

- Join with a display name and any room name (rooms are created on demand)
- Live message delivery to everyone in the room
- Online user list with join/leave notices
- "X is typing…" indicators
- Last 100 messages per room shown to people who join later
- Auto-reconnect with full state resync
- Duplicate names are made unique ("Ada (2)")
- Clickable links, multi-line messages (Shift+Enter), unread count in the tab title
- Dark mode and mobile layout

## How it works

| Direction        | Mechanism                                   |
|------------------|---------------------------------------------|
| Server → clients | Server-Sent Events: `GET /events?room=&name=` |
| Client → server  | `POST /send`, `POST /typing` (JSON)          |
| Health check     | `GET /health`                               |

When you connect, the server gives you a random secret token in the `welcome` event. Every POST must include that token, so nobody can post under someone else's name. Messages are rendered with `textContent` (never `innerHTML`), so there's no XSS. The server also limits message and name length, request body size, and messages per user (15 per 10 seconds).

## Limitations

- Everything is kept in memory, so restarting the server clears all history.
- It runs as a single process. To run more than one instance, you'd need a shared pub/sub such as Redis.
- There are no accounts: names are just display labels.
