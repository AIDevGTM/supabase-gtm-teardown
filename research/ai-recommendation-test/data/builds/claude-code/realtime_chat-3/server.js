'use strict';

/**
 * Realtime chat room server — zero dependencies (Node >= 18).
 *
 * Transport:
 *   - Server -> client: Server-Sent Events (GET /api/events?token=...)
 *   - Client -> server: small JSON POST requests
 *
 * API:
 *   POST /api/join      { name }          -> { token, user, limits }
 *   GET  /api/events?token=...            -> SSE stream (welcome, msg, presence, typing)
 *   POST /api/messages  { token, text }   -> { ok, seq }
 *   POST /api/typing    { token }         -> 204
 *   POST /api/leave     { token }         -> 204
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HISTORY_LIMIT = 100;          // messages kept in memory and sent to newcomers
const MAX_MESSAGE_LENGTH = 1000;    // characters
const MAX_NAME_LENGTH = 24;         // characters
const MAX_USERS = 200;              // concurrent sessions
const RECONNECT_GRACE_MS = 10000;   // how long a dropped user is kept before "left"
const HEARTBEAT_MS = 15000;         // SSE keep-alive comment interval
const MAX_BODY_BYTES = 16 * 1024;
const TYPING_THROTTLE_MS = 1000;
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 15;          // messages per window per user

// ---------------------------------------------------------------------------
// State (in memory)
// ---------------------------------------------------------------------------
/** @type {Map<string, Session>} token -> session */
const sessions = new Map();
const history = [];
let nextSeq = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function charLength(str) {
  return Array.from(str).length;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏ -‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // strip control chars except tab (\u0009) and newline (\u000a)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function colorFor(name) {
  let hash = 5381;
  for (const ch of name.toLowerCase()) hash = ((hash << 5) + hash + ch.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360}, 65%, 45%)`;
}

function publicUser(s) {
  return { id: s.id, name: s.name, color: s.color };
}

function userList() {
  return [...sessions.values()]
    .filter((s) => s.announced)
    .map(publicUser)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data, exceptSession = null) {
  for (const s of sessions.values()) {
    if (s === exceptSession) continue;
    for (const res of s.streams) sendEvent(res, event, data);
  }
}

function broadcastPresence() {
  broadcast('presence', { users: userList() });
}

function addToHistory(msg) {
  history.push(msg);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

function systemMessage(text) {
  const msg = { seq: nextSeq++, kind: 'system', text, ts: Date.now() };
  addToHistory(msg);
  broadcast('msg', msg);
}

function scheduleLeave(s) {
  clearTimeout(s.leaveTimer);
  s.leaveTimer = setTimeout(() => removeSession(s), RECONNECT_GRACE_MS);
}

function removeSession(s) {
  if (sessions.get(s.token) !== s) return;
  clearTimeout(s.leaveTimer);
  sessions.delete(s.token);
  for (const res of s.streams) res.end();
  s.streams.clear();
  if (s.announced) {
    systemMessage(`${s.name} left the chat`);
    broadcastPresence();
  }
}

function getSession(body) {
  const token = typeof body.token === 'string' ? body.token : '';
  const s = token && sessions.get(token);
  if (!s) throw httpError(401, 'Your session has expired. Please rejoin.');
  return s;
}

function sendJson(res, status, data) {
  if (status === 204 || data === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(httpError(413, 'Request body too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      } catch {
        reject(httpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
function handleJoin(res, body) {
  const name = sanitizeName(body.name);
  const len = charLength(name);
  if (len === 0) throw httpError(400, 'Please enter a name.');
  if (len > MAX_NAME_LENGTH) throw httpError(400, `Names can be at most ${MAX_NAME_LENGTH} characters.`);

  const lower = name.toLowerCase();
  for (const s of sessions.values()) {
    if (s.name.toLowerCase() === lower) throw httpError(409, `The name "${name}" is already taken.`);
  }
  if (sessions.size >= MAX_USERS) throw httpError(503, 'The chat room is full. Try again later.');

  /** @typedef {ReturnType<typeof makeSession>} Session */
  const s = makeSession(name);
  sessions.set(s.token, s);
  scheduleLeave(s); // cleaned up silently if the client never opens a stream

  sendJson(res, 200, {
    token: s.token,
    user: publicUser(s),
    limits: { maxMessageLength: MAX_MESSAGE_LENGTH, maxNameLength: MAX_NAME_LENGTH },
  });
}

function makeSession(name) {
  return {
    token: crypto.randomBytes(24).toString('hex'),
    id: crypto.randomUUID(),
    name,
    color: colorFor(name),
    streams: new Set(),
    leaveTimer: null,
    announced: false,
    sendTimes: [],
    lastTypingAt: 0,
  };
}

function handleEvents(req, res, token) {
  const s = token && sessions.get(token);
  if (!s) return sendJson(res, 401, { error: 'Your session has expired. Please rejoin.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
  });
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.write('retry: 2000\n\n');

  clearTimeout(s.leaveTimer);
  s.leaveTimer = null;

  const firstConnection = !s.announced;
  if (firstConnection) {
    s.announced = true;
    systemMessage(`${s.name} joined the chat`); // goes to everyone else
  }

  s.streams.add(res);
  sendEvent(res, 'welcome', { self: publicUser(s), users: userList(), history });
  if (firstConnection) broadcastPresence();

  req.on('close', () => {
    s.streams.delete(res);
    if (s.streams.size === 0 && sessions.get(s.token) === s) scheduleLeave(s);
  });
}

function handleMessage(res, body) {
  const s = getSession(body);
  const text = sanitizeText(body.text);
  if (!text) throw httpError(400, 'Message is empty.');
  if (charLength(text) > MAX_MESSAGE_LENGTH) {
    throw httpError(400, `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`);
  }

  const now = Date.now();
  s.sendTimes = s.sendTimes.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (s.sendTimes.length >= RATE_LIMIT_MAX) {
    throw httpError(429, 'You are sending messages too fast. Please slow down.');
  }
  s.sendTimes.push(now);
  s.lastTypingAt = 0;

  const msg = { seq: nextSeq++, kind: 'chat', user: publicUser(s), text, ts: now };
  addToHistory(msg);
  broadcast('msg', msg);
  sendJson(res, 200, { ok: true, seq: msg.seq });
}

function handleTyping(res, body) {
  const s = getSession(body);
  const now = Date.now();
  if (s.announced && now - s.lastTypingAt >= TYPING_THROTTLE_MS) {
    s.lastTypingAt = now;
    broadcast('typing', { user: publicUser(s) }, s);
  }
  sendJson(res, 204);
}

function handleLeave(res, body) {
  const token = typeof body.token === 'string' ? body.token : '';
  const s = token && sessions.get(token);
  if (s) removeSession(s);
  sendJson(res, 204);
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
    return handleEvents(req, res, url.searchParams.get('token'));
  }

  const routes = {
    '/api/join': handleJoin,
    '/api/messages': handleMessage,
    '/api/typing': handleTyping,
    '/api/leave': handleLeave,
  };
  const handler = routes[route];
  if (!handler) return sendJson(res, 404, { error: 'Not found.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });

  const body = await readJson(req);
  return handler(res, body);
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad request.' });
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden.' });
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err && err.status) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    return sendJson(res, 500, { error: 'Internal server error.' });
  }
});

const heartbeat = setInterval(() => {
  for (const s of sessions.values()) {
    for (const res of s.streams) res.write(': ping\n\n');
  }
}, HEARTBEAT_MS);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Chat server running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Network: http://${a.address}:${PORT}`);
    }
  }
});

function shutdown() {
  console.log('\nShutting down...');
  clearInterval(heartbeat);
  for (const s of sessions.values()) {
    clearTimeout(s.leaveTimer);
    for (const res of s.streams) res.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
