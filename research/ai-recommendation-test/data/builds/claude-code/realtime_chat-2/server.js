'use strict';

/**
 * Realtime chat room server — zero dependencies.
 *
 * Transport:
 *   - Server -> client: Server-Sent Events  (GET  /events?room=..&name=..)
 *   - Client -> server: JSON POST            (POST /send, POST /typing)
 *
 * State is held in memory (rooms, users, last N messages per room).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const HISTORY_LIMIT = 100;      // messages kept per room
const MAX_MESSAGE_LEN = 2000;   // characters
const MAX_NAME_LEN = 24;
const MAX_ROOM_LEN = 32;
const MAX_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 20000;
const RATE_WINDOW_MS = 10000;   // rate limit: N messages per window
const RATE_MAX = 15;

const INDEX_PATH = path.join(__dirname, 'index.html');

/** @type {Map<string, {name: string, clients: Map<string, Client>, history: object[]}>} */
const rooms = new Map();
/** @type {Map<string, Client>} token -> client */
const clientsByToken = new Map();

/**
 * @typedef {Object} Client
 * @property {string} id
 * @property {string} token
 * @property {string} name
 * @property {string} color
 * @property {string} room
 * @property {http.ServerResponse} res
 * @property {number[]} sentAt
 */

// ---------- helpers ----------

const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  // strip control chars except newline/tab, trim, clamp
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

function sanitizeRoom(value) {
  const cleaned = sanitizeText(value || '', MAX_ROOM_LEN)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'lobby';
}

function colorFor(seed) {
  const hash = crypto.createHash('md5').update(seed).digest();
  const hue = ((hash[0] << 8) | hash[1]) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { name, clients: new Map(), history: [] };
    rooms.set(name, room);
  }
  return room;
}

function uniqueName(room, desired) {
  const taken = new Set([...room.clients.values()].map((c) => c.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired.slice(0, MAX_NAME_LEN - 4)} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function userList(room) {
  return [...room.clients.values()]
    .map((c) => ({ id: c.id, name: c.name, color: c.color }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sendEvent(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* connection already gone; cleanup happens on 'close' */
  }
}

function broadcast(room, event, data, exceptId) {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) sendEvent(client, event, data);
  }
}

function pushHistory(room, entry) {
  room.history.push(entry);
  if (room.history.length > HISTORY_LIMIT) room.history.shift();
}

function systemMessage(room, text) {
  const entry = { type: 'system', id: randomId(), text, ts: Date.now() };
  pushHistory(room, entry);
  broadcast(room, 'message', entry);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(body) {
  const token = body && typeof body.token === 'string' ? body.token : '';
  return clientsByToken.get(token) || null;
}

// ---------- route handlers ----------

function handleEvents(req, res, url) {
  const desiredName = sanitizeText(url.searchParams.get('name') || '', MAX_NAME_LEN);
  if (!desiredName) {
    sendJson(res, 400, { error: 'Name is required' });
    return;
  }
  const roomName = sanitizeRoom(url.searchParams.get('room'));
  const room = getRoom(roomName);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
  });
  res.write('retry: 2000\n\n');
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  const id = randomId();
  /** @type {Client} */
  const client = {
    id,
    token: randomId(18),
    name: uniqueName(room, desiredName),
    color: colorFor(desiredName.toLowerCase()),
    room: roomName,
    res,
    sentAt: [],
  };

  room.clients.set(id, client);
  clientsByToken.set(client.token, client);

  sendEvent(client, 'welcome', {
    id: client.id,
    token: client.token,
    name: client.name,
    color: client.color,
    room: roomName,
    history: room.history,
    users: userList(room),
  });

  systemMessage(room, `${client.name} joined`);
  broadcast(room, 'presence', { users: userList(room) });

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.clients.delete(id);
    clientsByToken.delete(client.token);
    broadcast(room, 'typing', { userId: id, name: client.name, typing: false });
    systemMessage(room, `${client.name} left`);
    broadcast(room, 'presence', { users: userList(room) });
    if (room.clients.size === 0) {
      // Keep history around for a while so a quick refresh doesn't wipe it.
      setTimeout(() => {
        const r = rooms.get(roomName);
        if (r && r.clients.size === 0) rooms.delete(roomName);
      }, 30 * 60 * 1000).unref();
    }
  });
}

async function handleSend(req, res) {
  const body = await readJsonBody(req);
  const client = authenticate(body);
  if (!client) return sendJson(res, 401, { error: 'Not connected' });

  const text = sanitizeText(body.text, MAX_MESSAGE_LEN);
  if (!text) return sendJson(res, 400, { error: 'Message is empty' });

  const now = Date.now();
  client.sentAt = client.sentAt.filter((t) => now - t < RATE_WINDOW_MS);
  if (client.sentAt.length >= RATE_MAX) {
    return sendJson(res, 429, { error: 'Slow down — you are sending messages too quickly' });
  }
  client.sentAt.push(now);

  const room = rooms.get(client.room);
  if (!room) return sendJson(res, 410, { error: 'Room no longer exists' });

  const entry = {
    type: 'chat',
    id: randomId(),
    userId: client.id,
    name: client.name,
    color: client.color,
    text,
    ts: now,
  };
  pushHistory(room, entry);
  broadcast(room, 'message', entry);
  broadcast(room, 'typing', { userId: client.id, name: client.name, typing: false });
  sendJson(res, 200, { ok: true, id: entry.id });
}

async function handleTyping(req, res) {
  const body = await readJsonBody(req);
  const client = authenticate(body);
  if (!client) return sendJson(res, 401, { error: 'Not connected' });
  const room = rooms.get(client.room);
  if (room) {
    broadcast(room, 'typing', { userId: client.id, name: client.name, typing: !!body.typing }, client.id);
  }
  sendJson(res, 200, { ok: true });
}

function handleIndex(res) {
  fs.readFile(INDEX_PATH, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not load index.html');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return handleIndex(res);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      return handleEvents(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      return await handleSend(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/typing') {
      return await handleTyping(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      let users = 0;
      for (const r of rooms.values()) users += r.clients.size;
      return sendJson(res, 200, { ok: true, rooms: rooms.size, users });
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down…');
  for (const client of clientsByToken.values()) {
    try { client.res.end(); } catch (_) { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = server;
