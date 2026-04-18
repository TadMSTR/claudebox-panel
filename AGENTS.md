---
tier: baseline
---

# AGENTS.md — claudebox-panel

Admin panel for the claudebox AI workstation. Express.js backend with a vanilla JS frontend, served behind SWAG and protected by a bearer token.

## What it does

Provides a browser-based interface for monitoring and operating claudebox:
- Agent session management (LibreChat conversation control)
- PM2 process management
- Docker container status
- System and health diagnostics
- File browser
- Backrest backup status
- Update management

## Structure

```
src/
  server.js          # Express app — auth middleware, route mounts, CSP headers
  routes/
    agents.js        # LibreChat agent/session API
    backrest.js      # Backrest backup queries
    diagnostics.js   # System diagnostics
    docker.js        # Docker container status
    files.js         # File browser API
    health.js        # Health checks
    pm2.js           # PM2 process control
    system.js        # System info
    updates.js       # Update checks
config/
  config.js          # Port, allowed origins, other settings
public/
  index.html         # Single-page frontend entry point
  app.js             # Frontend logic (vanilla JS)
```

## Auth

All `/api/*` routes require an `x-panel-token` header matching `PANEL_TOKEN` from `.env`. The check uses `crypto.timingSafeEqual`. Copy `.env.example` to `.env` and set `PANEL_TOKEN` before starting.

## Running locally

```bash
npm install
cp .env.example .env   # set PANEL_TOKEN
node src/server.js
```

Or via PM2 (production):
```bash
pm2 start src/server.js --name claudebox-panel
```

## Adding a new route

1. Create `src/routes/<feature>.js`
2. Mount it in `server.js` under `/api/<feature>` with `tokenAuth` middleware
3. Add any config entries to `config/config.js`
4. **Run a security review before committing** — any route that touches the filesystem, spawns processes, or proxies to other services needs a review for path traversal, injection, and privilege escalation risks

## Git workflow

Branch before editing — do not commit directly to `main`.

```bash
git checkout -b feature/<name>
# make changes
git push origin feature/<name>
# open a PR
```

## Security notes

- Rate limited: 120 req/min per IP on all `/api` routes
- CSP headers set on all responses — no inline scripts, no external resources
- `child_process` usage requires explicit review
- File path handling in `routes/files.js` must be reviewed for traversal risks
