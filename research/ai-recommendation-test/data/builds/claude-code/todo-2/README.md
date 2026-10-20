# To-Do App

A small multi-user to-do app. Users can sign up, log in and manage their own private task list.

## Stack
- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`). A single file, `data.sqlite`, is created automatically
- **Auth:** email + password (hashed with bcrypt), cookie sessions saved in SQLite
- **Frontend:** plain HTML/CSS/JS, with no build step

## Run it
```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 18+.

### Environment variables
| Variable         | Default           | Notes |
|------------------|-------------------|-------|
| `PORT`           | `3000`            | |
| `SESSION_SECRET` | random per start  | **Set this in production**, or everyone gets logged out on restart |
| `DB_PATH`        | `./data.sqlite`   | |
| `NODE_ENV`       | –                 | `production` turns on secure cookies and `trust proxy` (needs HTTPS) |

## Features
- Sign up / log in / log out, with sessions that last 7 days
- Add, complete, rename (double-click) and delete tasks
- Filter by All / Active / Completed, plus "Clear completed"
- Tasks are saved per user. Every query is filtered by the logged-in user's id

## Security measures
- bcrypt password hashing (cost 12) and a login check that takes the same time whether or not the email exists
- A new session id is issued on login (prevents session fixation). Cookies are `httpOnly` and `SameSite=Lax`
- CSRF protection: write requests must be JSON and their Origin must match
- Auth endpoints are rate-limited per IP (20 tries per 15 minutes)
- Security headers including a strict CSP. Task titles are shown with `textContent`, so they can't inject code (XSS)

## API
All bodies are JSON.

| Method | Path                           | Body                     |
|--------|--------------------------------|--------------------------|
| POST   | `/api/signup`                  | `{ email, password }`    |
| POST   | `/api/login`                   | `{ email, password }`    |
| POST   | `/api/logout`                  | `{}`                     |
| GET    | `/api/me`                      | –                        |
| GET    | `/api/tasks`                   | –                        |
| POST   | `/api/tasks`                   | `{ title }`              |
| PATCH  | `/api/tasks/:id`               | `{ title?, completed? }` |
| DELETE | `/api/tasks/:id`               | –                        |
| POST   | `/api/tasks/clear-completed`   | `{}`                     |
