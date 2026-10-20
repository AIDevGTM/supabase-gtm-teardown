'use strict';

/**
 * Realtime chat room server.
 *
 * Zero dependencies — uses only Node's standard library.
 *   - Server -> client: Server-Sent Events (GET /events)
 *   - Client -> server: JSON POSTs (/message, /typing)
 *
 * Each SSE connection is a "session". On connect the server issues a random
 * token that the client must include on every POST, so people can't post as
 * someone else just by knowing their name.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HISTORY_LIMIT = 100; // messages replayed to newly joined users
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NAME_LENGTH = 24;
const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 15; // per user per window
const HEARTBEAT_MS = 25_000;

/** token -> { token, name, color, res, sentAt: number[], lastTypingAt: number } */
const clients = new Map();
/** Ring buffer of recent chat + system messages. */
const history = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data, exceptToken) {
  for (const client of clients.values()) {
    if (client.token !== exceptToken) sendEvent(client.res, event, data);
  }
}

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(httpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Strip control characters and collapse whitespace in a display name. */
function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠-⁯]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** Keep newlines/tabs in messages but drop other control characters. */
function cleanMessage(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** If the name is already in use (case-insensitive), append a number. */
function uniqueName(name) {
  const taken = new Set([...clients.values()].map((c) => c.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Deterministic, readable color per name. */
function colorFor(name) {
  const hash = crypto.createHash('md5').update(name.toLowerCase()).digest();
  const hue = ((hash[0] << 8) | hash[1]) % 360;
  return `hsl(${hue}, 65%, 42%)`;
}

function userList() {
  return [...clients.values()]
    .map((c) => ({ name: c.name, color: c.color }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function record(message) {
  history.push(message);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

function postSystem(text) {
  const message = { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() };
  record(message);
  broadcast('message', message);
}

function requireClient(body) {
  const client = typeof body.token === 'string' ? clients.get(body.token) : undefined;
  if (!client) throw httpError(401, 'Not connected — please rejoin the chat');
  return client;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleEvents(req, res, url) {
  const requested = cleanName(url.searchParams.get('name'));
  if (!requested) return sendJson(res, 400, { error: 'A name is required' });

  const name = uniqueName(requested);
  const client = {
    token: crypto.randomBytes(24).toString('hex'),
    name,
    color: colorFor(name),
    res,
    sentAt: [],
    lastTypingAt: 0,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
  });
  res.write('retry: 2000\n\n');
  req.socket.setKeepAlive(true);
  req.socket.setNoDelay(true);
  req.socket.setTimeout(0);

  clients.set(client.token, client);

  sendEvent(res, 'welcome', {
    token: client.token,
    name: client.name,
    color: client.color,
    history,
    users: userList(),
  });
  postSystem(`${client.name} joined the chat`);
  broadcast('users', userList());

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  // NB: listen on `res`, not `req` — on modern Node, req 'close' fires as
  // soon as the (empty) request body is consumed, not when the socket dies.
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!clients.delete(client.token)) return;
    postSystem(`${client.name} left the chat`);
    broadcast('users', userList());
  });
}

async function handleMessage(req, res) {
  const body = await readJson(req);
  const client = requireClient(body);
  const text = cleanMessage(body.text);

  if (!text) throw httpError(400, 'Message is empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw httpError(400, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);
  }

  const now = Date.now();
  client.sentAt = client.sentAt.filter((t) => now - t < RATE_WINDOW_MS);
  if (client.sentAt.length >= RATE_MAX_MESSAGES) {
    throw httpError(429, 'You are sending messages too fast — slow down a little');
  }
  client.sentAt.push(now);

  const message = {
    id: crypto.randomUUID(),
    type: 'chat',
    name: client.name,
    color: client.color,
    text,
    ts: now,
  };
  record(message);
  broadcast('message', message);
  sendJson(res, 201, { ok: true, id: message.id });
}

async function handleTyping(req, res) {
  const body = await readJson(req);
  const client = requireClient(body);
  const now = Date.now();
  if (now - client.lastTypingAt > 1000) {
    client.lastTypingAt = now;
    broadcast('typing', { name: client.name }, client.token);
  }
  sendJson(res, 200, { ok: true });
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function handleStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return sendJson(res, 404, { error: 'Not found' });
  const [file, type] = entry;
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) return sendJson(res, 500, { error: 'Could not read file' });
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && pathname === '/message') return await handleMessage(req, res);
    if (req.method === 'POST' && pathname === '/typing') return await handleTyping(req, res);
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, users: clients.size });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return handleStatic(res, pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down…');
  for (const client of clients.values()) client.res.end();
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
