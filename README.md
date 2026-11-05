# Slate server

Node.js backend for the Slate Android app. No npm dependencies.

```
server/       the service (index.js)
render.yaml   Render Blueprint (deploy target)
```

## Run

```bash
cd server
node index.js     # PORT=3000 by default, data written to server/data/
```

## Deploy

Render → **New +** → **Blueprint** → pick this repository → **Apply**.
`render.yaml` sets the root directory, build command (`npm install`),
start command (`node index.js`) and the health check path.
