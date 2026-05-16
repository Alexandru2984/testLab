# Micu TestLab

Public health dashboard for the services hosted on the `micutu.com` VPS. Lists each
project with its stack badge, online/offline status, latency, last-check timestamp,
and a configurable set of endpoints to probe.

- **Public URL**: <https://test.micutu.com>
- **Project path**: `/home/micu/testlab`
- **Local listen address**: `127.0.0.1:3011` (loopback only — nginx terminates TLS)
- **Stack**: Node.js 24 + [Fastify 4](https://fastify.dev/) + vanilla HTML/CSS/JS (no build step)
- **Runtime**: systemd unit `testlab.service`
- **Reverse proxy**: nginx (`/etc/nginx/sites-available/test.micutu.com`)
- **TLS**: Let's Encrypt (`/etc/letsencrypt/live/test.micutu.com/`)

## How it works

The Fastify server loads `config/services.json` once at boot and runs an in-memory
health probe every 60s (with a 30s cache for `/api/status`). Each probe hits
`service.health` when defined and falls back to `service.url` for services without
a dedicated health endpoint. Errors are categorised as `online` / `slow` (≥ 1500 ms)
/ `offline` and surfaced to the dashboard, with the raw `reason` (`timeout`,
`ECONNREFUSED`, etc.) shown in the card — no stack traces are ever exposed.

The frontend is served as static files from `public/` by Fastify itself.

## API

| Method | Path             | Description                                     |
|--------|------------------|-------------------------------------------------|
| GET    | `/api/health`    | Liveness probe for TestLab itself               |
| GET    | `/api/services`  | Raw service config                              |
| GET    | `/api/status`    | Cached results + summary (auto-refreshes 30 s)  |
| POST   | `/api/check`     | Force a fresh probe of all services             |

## Service config

Edit `config/services.json` to add or remove services. Each entry supports:

```json
{
  "name": "PDF Editor",
  "url": "https://pdf.micutu.com",
  "health": "https://pdf.micutu.com/health",
  "stack": "Django",
  "description": "PDF tools and editor"
}
```

- `url` (required) — public URL displayed and used as fallback target.
- `health` (optional) — dedicated health endpoint; if it returns 404 the probe
  retries against `url`.
- `stack` (optional) — used for the colored badge: `Django`, `React`, `Go`, `Rust`,
  `Zig`, `C++`, `AI`, `Node.js`, etc. Unknown stacks fall back to a neutral badge.
- `description` (optional) — short caption shown under the name.

After editing, restart the service so the new config is loaded:

```bash
sudo systemctl restart testlab
```

## Useful commands

```bash
# Service control
sudo systemctl status testlab
sudo systemctl restart testlab
sudo systemctl reload-or-restart testlab

# Live logs
sudo journalctl -u testlab -f
sudo journalctl -u testlab -n 100 --no-pager

# Local smoke test (bypasses nginx)
curl -s http://127.0.0.1:3011/api/health
curl -s http://127.0.0.1:3011/api/status | head -c 500

# Nginx
sudo nginx -t
sudo systemctl reload nginx

# TLS cert
sudo certbot certificates | grep -A2 test.micutu.com

# Dependencies
cd /home/micu/testlab && npm install --omit=dev
```

## Files

```
/home/micu/testlab
├── README.md
├── .gitignore
├── package.json
├── config/
│   └── services.json
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── src/
    ├── server.js
    └── healthcheck.js
```

System files installed outside the project (do not commit):

- `/etc/systemd/system/testlab.service`
- `/etc/nginx/sites-available/test.micutu.com` (symlinked from `sites-enabled/`)

## Notes

- Backend binds only to `127.0.0.1` — never expose port 3011 directly.
- Cloudflare sits in front of `test.micutu.com` and may serve a JS challenge to
  unattended curl/bot traffic; a real browser flow is unaffected.
- Health check timeout is 6 s and `slow` threshold is 1500 ms — tune in
  `src/healthcheck.js` if needed.
