# Slate server

Backend for the Slate Android app. Plain Node.js (no npm dependencies), JSON file
storage, JSON API. It handles accounts, direct and group messages, presence
(online / last seen), typing indicators, delivery + read receipts, media,
reports and moderator bans.

```
server/
  index.js      the whole server
  package.json  npm start
```

## Run locally

```bash
cd server
node index.js            # http://localhost:3000, data in server/data/
PORT=4000 DATA_DIR=/tmp/slate node index.js
```

Quick check: `curl localhost:3000/health` → `{"ok":true,...}`.

## Deploy on Render

**Blueprint (recommended):** push this repo to GitHub, then in Render choose
*New → Blueprint*, pick the repository and apply. `render.yaml` at the repo root
creates the web service with the right root directory, build and start commands.

**Manual:** *New → Web Service* → connect the repo → Root Directory `server`,
Runtime `Node`, Build Command `npm install`, Start Command `node index.js`,
Health Check Path `/health`.

Point the app at the deployed URL: **Settings → Server** (default is
`https://slate-server.onrender.com`; change it to your own service URL).

Notes:

- Free instances sleep after ~15 minutes idle. The first request afterwards can
  take 30–60 s; the app retries in the background and registration allows for a
  slow cold start.
- Free instances have **no persistent disk**. The state file (`server/data/state.json`)
  survives process restarts but is lost on a redeploy. On a paid plan attach a
  disk mounted at `/var/data` and set `DATA_DIR=/var/data`.
- Set `ADMIN_KEY` (the Blueprint generates one) to control who can grant
  moderator rights.

## Environment

| Variable     | Default            | Meaning                                            |
|--------------|--------------------|----------------------------------------------------|
| `PORT`       | `3000`             | HTTP port (Render sets this)                       |
| `DATA_DIR`   | `server/data`      | Where `state.json` and uploaded media are stored   |
| `PUBLIC_URL` | request host       | Base URL used when returning uploaded media links  |
| `ADMIN_KEY`  | *(unset)*          | Enables `POST /api/admin/grant`                    |

## Moderators

Usernames `1`, `mod1` … `mod20` are moderators. To make any other account a
moderator (after it has registered):

```bash
curl -X POST "$URL/api/admin/grant" \
  -H "content-type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"user":"alice","mod":true}'
```

Moderators can list open reports, resolve them, and ban/unban accounts. Bans are
enforced server-side: a banned account cannot sign in or send, its open sessions
get `403 BANNED` on every write, and `/api/sync` reports the ban so the app shows
the "account banned" screen. Lifting the ban restores the account.

## API

All endpoints return JSON. Authenticated calls need `Authorization: Bearer <token>`
(returned by register/login). Errors are `{"error":"CODE","message":"..."}`.

| Method | Path | Body / query | Notes |
|--------|------|--------------|-------|
| GET  | `/health` | – | liveness probe |
| POST | `/api/register` | `username, password, display?` | 409-ish `USERNAME_TAKEN` |
| POST | `/api/login` | `username, password` | `BANNED` + reason/until when suspended |
| POST | `/api/logout` | – | drops the token |
| GET  | `/api/me` | – | current profile |
| POST | `/api/profile` | `display?, bio?, avatar?` | avatar is a URL from `/api/upload` |
| GET  | `/api/users` | `?q=` search, `?u=` exact | exact returns `{found, user}` |
| GET  | `/api/sync` | `?since=<seq>` | messages, receipts, typing, users, groups, `seq`, `epoch` |
| POST | `/api/send` | `to, body, type, media?, dur?, clientId?` | `to` is a username or `g:<gid>`; `clientId` makes retries idempotent |
| POST | `/api/typing` | `to, typing` | 6 s TTL |
| POST | `/api/read` | `peer` | sets a read timestamp the sender picks up |
| POST | `/api/upload` | `data` (base64/data URL), `mime` | ≤ 8 MB, returns `{url}` |
| GET  | `/media/<file>` | – | serves uploads |
| POST | `/api/groups` | `name, members[]` | creator becomes owner |
| POST | `/api/groups/<gid>/members` | `username, remove?` | needs ADD/REMOVE rights |
| POST | `/api/groups/<gid>/info` | `name?, bio?, photo?` | needs EDIT |
| POST | `/api/groups/<gid>/role` | `op: add/update/delete/assign, …` | needs ROLES |
| POST | `/api/groups/<gid>/leave` \| `/delete` | – | owner cannot leave, only delete |
| POST | `/api/report` | `target, reason, descr?, snapshot?` | goes to the mod inbox |
| GET  | `/api/mod/reports` | – | moderator only |
| POST | `/api/mod/report` | `id, status` | moderator only |
| POST | `/api/mod/ban` | `user, reason?, until?` | `until` is epoch ms, `0` = permanent |
| POST | `/api/mod/unban` | `user` | |
| POST | `/api/admin/grant` | `user, mod` | needs `x-admin-key: $ADMIN_KEY` |

Presence: a client is online for 50 s after its last authenticated request; the
app polls `/api/sync` every 3 s, which doubles as the heartbeat.
