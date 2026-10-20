# To-Do App

A small multi-user to-do app. Users can sign up, log in and manage their own private task list.

## Run

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node.js 18+.

## Features

- Sign up / log in / log out with email + password
- Add, complete, edit (double-click), and delete tasks
- Filter: All / Active / Done, with a count of what's left
- Each user sees only their own tasks; data persists in SQLite (`todo.db`)

## Stack & design choices

| Concern   | Choice |
|-----------|--------|
| Server    | Node.js + Express |
| Storage   | SQLite via `better-sqlite3` (zero-config file DB) |
| Passwords | `bcryptjs`, cost 12 |
| Sessions  | JWT in an `httpOnly`, `SameSite=Strict` cookie (7 days) |
| Frontend  | Plain HTML/CSS/JS, no build step, served from `public/` |

### Security

- Passwords are hashed and never returned.
- Every todo query is scoped by `user_id`, so users can't read or change each other's tasks.
- The cookie is `httpOnly` (JS can't read it) and `SameSite=Strict`. Write endpoints also require `Content-Type: application/json` to protect against CSRF.
- Auth endpoints are rate-limited (20 attempts / 15 min per IP, in memory).
- Login gives the same error and similar timing whether or not the email exists.
- A strict Content-Security-Policy is set, and task text is rendered with `textContent` (no XSS).

## Configuration (env vars)

| Variable     | Default | Notes |
|--------------|---------|-------|
| `PORT`       | `3000`  | |
| `DB_PATH`    | `./todo.db` | |
| `JWT_SECRET` | auto-generated and stored in the DB | Set explicitly in production |
| `NODE_ENV`   | — | Set `production` to mark cookies `Secure` (requires HTTPS) |

## API

All endpoints are JSON. Todo endpoints require the auth cookie.

| Method | Path | Body |
|--------|------|------|
| POST   | `/api/signup` | `{ email, password }` |
| POST   | `/api/login`  | `{ email, password }` |
| POST   | `/api/logout` | — |
| GET    | `/api/me`     | — |
| GET    | `/api/todos`  | — |
| POST   | `/api/todos`  | `{ title }` |
| PATCH  | `/api/todos/:id` | `{ title?, completed? }` |
| DELETE | `/api/todos/:id` | — |
