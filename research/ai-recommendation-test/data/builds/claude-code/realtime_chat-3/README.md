# 💬 Realtime Chat Room

A realtime chat room that many people can join from their browsers. It has
**no dependencies**: it only needs Node.js 18 or newer, so there's nothing to install.

## Run it

```bash
npm start          # or: node server.js
```

Open http://localhost:3000. To try it with several people, open more browser
tabs, or have others on your network open the `Network:` URL printed at startup.

Settings (environment variables): `PORT` (default `3000`) and `HOST` (default `0.0.0.0`).

## Features

- **Live messaging** for everyone in the room, using Server-Sent Events
- **Who's online** list with colored avatars
- **Join / leave notices**
- **Typing indicators** ("Alice and Bob are typing…")
- **Recent history**: newcomers see the last 100 messages
- **Survives connection problems**: short network drops reconnect on their own
  without join/leave noise, a page reload keeps your session, and after a
  server restart clients rejoin automatically with the same name
- Unique names (case-insensitive), messages grouped by sender, clickable links,
  multi-line messages (Shift+Enter), unread count in the tab title,
  "New messages ↓" button, light/dark mode, works on phones

## How it works

```
browser ──POST /api/join {name}────────────▶ server   → returns a secret session token
browser ◀──GET /api/events?token=… (SSE)──── server   ← welcome, msg, presence, typing
browser ──POST /api/messages {token,text}──▶ server   → sent to all open streams
browser ──POST /api/typing  {token}────────▶ server
browser ──POST /api/leave   {token}────────▶ server
```

- I used Server-Sent Events rather than WebSockets so the app needs no packages.
  Browsers reconnect SSE streams on their own, and it works through most proxies.
- Each session has a public `id` (shown to others) and a secret `token` (used to
  prove who sent a request), so nobody can post under someone else's name.
- When a user's last connection drops, the server waits 10 seconds before
  announcing that they left. That covers reloads and brief network drops.

## Safety measures

- Messages are inserted as plain text (`textContent`), never as HTML, so users can't inject scripts
- A strict Content-Security-Policy and other security headers
- Limits on message length (1000), name length (24), request size (16 KB) and
  number of users (200)
- Rate limit of 15 messages per 10 seconds per user; typing events are throttled
- Control and invisible characters are removed from names and messages
- Static file serving blocks access to files outside `public/`

## Limitations

- Everything is kept in memory, so restarting the server clears the history.
- The server is a single process. To run several instances you'd need a shared
  message bus (such as Redis pub/sub).
- There are no accounts: names are claimed first-come, first-served while in use.

## Files

```
server.js          HTTP server, API, SSE broadcasting, static files
public/index.html  Page layout (join screen + chat screen)
public/style.css   Styling (responsive, light/dark)
public/app.js      Client logic
```
