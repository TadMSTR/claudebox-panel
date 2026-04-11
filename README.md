# claudebox-panel

Control panel for the Claudebox homelab agent stack. Browser-based interface for:

- **Service health** — HTTP ping and mountpoint checks for all key services with live status
- **PM2 dashboard** — process status, restart/stop controls, log viewer
- **File browser** — browse and edit whitelisted config/repo paths with in-browser editor

## Stack

Express (Node.js) + vanilla HTML/JS frontend. PM2 for process management. SWAG + Authelia for reverse proxy and SSO.

## Setup

```bash
cd ~/repos/personal/claudebox-panel
npm install
pm2 start "npm run start" --name agent-panel --cwd ~/repos/personal/claudebox-panel
pm2 save
```

## SWAG proxy conf

```bash
cp panel.subdomain.conf /opt/appdata/swag/nginx/proxy-confs/
docker restart swag
```

## Access

`https://panel.yourdomain` — Authelia SSO required. Port: `3003`.

## Configuration

`config/config.js` — add file browser paths and health check services here.

## File Browser

Paths whitelisted in config only. Editable extensions: `.md .sh .conf .json .yaml .yml .env .txt .js .ts`. Ctrl+S saves.

## PM2 Actions

Uses PM2 programmatic API (no shell exec). Supported: `restart`, `stop`, `reload`. Delete not exposed.

## Service Health

Checks run every 30s in background, cached and served immediately. NFS checks via `/proc/mounts`.
