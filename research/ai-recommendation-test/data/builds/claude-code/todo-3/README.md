# To-Do App

A small full-stack to-do app with user accounts. Each user only sees and edits their own tasks.

**Stack:** Node.js + Express, SQLite (better-sqlite3), bcrypt password hashing, JWT session in an httpOnly cookie, and a plain HTML/CSS/JS frontend (no build step).

## Run

```bash
npm install
JWT_SECRET="some-long-random-string" npm start
# open http://localhost:3000
```

Requires Node 18+. If `JWT_SECRET` isn't set, a random one is generated on each start, so everyone is logged out when the server restarts.

Environment variables: `PORT` (default 3000), `JWT_SECRET`, `DB_PATH` (default `./todo.db`), `NODE_ENV=production` (adds the `Secure` flag to cookies, so HTTPS is required).

## Features
- Sign up, log in, log out (sessions last 7 days)
- Add tasks, mark them complete, edit them (double-click), delete them
- Tasks are saved per user in SQLite

## API
| Method | Path | Body |
|---|---|---|
| POST | /api/signup | `{ email, password }` (password ≥ 8 chars) |
| POST | /api/login | `{ email, password }` |
| POST | /api/logout | none |
| GET | /api/me | none |
| GET | /api/tasks | none |
| POST | /api/tasks | `{ title }` |
| PATCH | /api/tasks/:id | `{ title?, completed? }` |
| DELETE | /api/tasks/:id | none |

## Security notes
- Passwords are hashed with bcrypt (cost 10).
- Session cookie is `httpOnly` and `SameSite=Strict`, which also protects against CSRF.
- Every task query is scoped by `user_id`, so users can't read or change each other's tasks.
- Task titles are rendered with `textContent` to prevent XSS.
- Not included: rate limiting on login, email verification and password reset. Add these before a public launch.
