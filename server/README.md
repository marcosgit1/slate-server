# Slate server

Node.js service for the Slate Android app. Standard library only — no npm
dependencies, no database server: state lives in `DATA_DIR/state.json` and
uploaded media in `DATA_DIR/media`.

```bash
node index.js
```

## Environment

| Variable     | Default       | Meaning                                   |
|--------------|---------------|-------------------------------------------|
| `PORT`       | `3000`        | HTTP port (Render sets it)                |
| `DATA_DIR`   | `server/data` | State + media directory                   |
| `PUBLIC_URL` | request host  | Base URL used for uploaded media links    |

`GET /health` returns `{"ok":true}` and is used as the Render health check.

Free instances have no persistent disk: attach one and point `DATA_DIR` at the
mount path if state must survive redeploys.
