# Realtime Chat Room

A multi-user chat room that updates in real time. You don't need to install anything: it uses only Node.js's standard library and plain browser JavaScript.

## Run it

```bash
node server.js        # or: npm start
```

Then open <http://localhost:3000> in several browser windows or on other devices on your network (`http://<your-ip>:3000`), choose a name in each one, and start chatting.

Configure with environment variables: `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

## Features

- Messages show up instantly for everyone in the room
- A list of who's online, plus join and leave notices
- "X is typing…" indicators
- New users see the last 100 messages
- Duplicate names get a suffix automatically (`Sam`, `Sam (2)`)
- Reconnects automatically after a network drop or server restart
- Links in messages are clickable, and newlines are kept (Shift+Enter)
- An unread count appears in the tab title when the tab is in the background
- Light and dark mode; works on phones (the user list slides in from the side)

## How it works

| Direction        | Mechanism                                   |
|------------------|---------------------------------------------|
| Server → clients | Server-Sent Events stream at `GET /events?name=…` |
| Client → server  | `POST /message` and `POST /typing` (JSON)   |

When you connect, the server sends a `welcome` event that includes a random **session token**. Every POST has to include that token, so nobody can post under someone else's name just by knowing it. Events the server sends: `welcome`, `message` (`type: "chat" | "system"`), `users`, `typing`.

I used SSE instead of WebSockets so the server needs no dependencies. Browsers reconnect SSE streams on their own, and SSE works through most proxies.

### Safety limits

- Messages: up to 1000 characters; control characters are removed
- Names: up to 24 characters; control and invisible characters are removed
- Rate limit: 15 messages per 10 seconds per user
- Request bodies: up to 8 KB
- Messages are always added to the page as text, never as HTML, which prevents XSS

## Limitations

- State lives in memory, so restarting the server clears the history. It also runs as a single process, so you can't load-balance it across several instances without adding something like Redis pub/sub.
- Over plain HTTP/1.1, a browser allows about 6 open connections per site. If you open more than ~6 chat tabs **in the same browser**, the extra tabs will hang. This doesn't happen behind an HTTP/2 proxy, and it doesn't limit how many different users can join.
- Behind nginx, turn off `proxy_buffering` for `/events` (the server already sends `X-Accel-Buffering: no`).

## Files

```
server.js          HTTP server, SSE broadcast, validation, rate limiting
public/index.html  Markup (join screen + chat screen)
public/style.css   Styles (responsive, dark mode)
public/app.js      Client: connection, rendering, typing, reconnection
```
