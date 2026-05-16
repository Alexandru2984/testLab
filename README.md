# Micu TestLab

Public health dashboard for the services hosted on the `micutu.com` VPS. Services
are **auto-discovered** from `/etc/nginx/sites-enabled/*`, then enriched with
metadata from `config/overrides.json`. The dashboard shows each service's
status, latency, stack badge, last-check time, and (for nginx-backed services)
whether the local upstream port is actually listening.

- **Public URL**: <https://test.micutu.com>
- **Project path**: `/home/micu/testlab`
- **Local listen address**: `127.0.0.1:3011` (loopback only — nginx terminates TLS)
- **Stack**: Node.js 24 + [Fastify 4](https://fastify.dev/) + vanilla HTML/CSS/JS (no build step)
- **Runtime**: systemd unit `testlab.service`
- **Reverse proxy**: nginx (`/etc/nginx/sites-available/test.micutu.com`)
- **TLS**: Let's Encrypt (`/etc/letsencrypt/live/test.micutu.com/`)

## How it works

On boot the server parses every file in `/etc/nginx/sites-enabled/` (skipping
`default`, `*.bak*`, `*.pre-*`, etc.), extracts each `server { ... }` block, and
records the `server_name` + first `proxy_pass http://127.0.0.1:PORT`. Pages with
`root`/`try_files` and no `proxy_pass` are tagged as `static`. Pure
HTTP→HTTPS redirect blocks (those with only `return 30x` and no upstream) are
ignored.

Each discovered service is then enriched from `config/overrides.json`:

- `hide`: list of `server_name`s to suppress (e.g. duplicate `www.` aliases).
- `meta`: per-host overrides — `name`, `stack`, `description`, `health`, `url`.
- `extra`: array of fully-manual entries for external services (same shape as
  the old format).

The Fastify backend then probes each public URL every 60 s with a 6 s timeout,
falling back from `health` to `url` on 404 and using a `HEAD` retry on network
errors. Auto-rediscovery runs every 5 min in the background — restart the
service if you need to pick up nginx changes immediately.

Status classification:

- `online` — HTTP < 500 and latency < 1500 ms
- `slow` — HTTP < 500 and latency ≥ 1500 ms
- `offline` — HTTP ≥ 500 or network error / timeout

For nginx-proxy services TestLab also takes a `ss -tln` snapshot and exposes
`upstreamListening` (`true`/`false`) — useful to spot services that are
"configured in nginx but the backend process is down" even when Cloudflare or
nginx returns a usable cached response.

## API

| Method | Path               | Description                                     |
|--------|--------------------|-------------------------------------------------|
| GET    | `/api/health`      | Liveness probe for TestLab itself               |
| GET    | `/api/services`    | Discovered service list + last-discovery time   |
| GET    | `/api/status`      | Cached probe results + summary (30 s TTL)       |
| POST   | `/api/check`       | Force a fresh probe of all services             |
| POST   | `/api/rediscover`  | Re-parse nginx + overrides, then probe          |

## Configuring with `config/overrides.json`

```json
{
  "hide": ["www.market.micutu.com"],

  "meta": {
    "pdf.micutu.com": {
      "name": "PDF Editor",
      "stack": "Django",
      "description": "PDF tools and editor",
      "health": "https://pdf.micutu.com/health"
    }
  },

  "extra": [
    {
      "name": "External thing",
      "url": "https://example.com",
      "stack": "External",
      "description": "Off-VPS service"
    }
  ]
}
```

- `meta` keys are the **`server_name`** value in the nginx config, not the URL.
- Hosts not in `meta` get a sensible default name + a stack of `Static`/`Other`.
- Stack values that match keywords (`Django`, `React`, `Go`, `Rust`, `Zig`,
  `C`/`C++`, `AI`, `Node.js`, `Python`, `Elixir`, `Ruby`, `Haskell`, `Clojure`,
  `Static`, etc.) get colour-coded badges.

After editing, either restart the service or hit `POST /api/rediscover`:

```bash
sudo systemctl restart testlab
# or
curl -X POST http://127.0.0.1:3011/api/rediscover
```

## Adding a new VPS service

You don't need to touch TestLab at all — just add the new nginx config under
`/etc/nginx/sites-enabled/` and TestLab will pick it up within 5 minutes (or
immediately after `POST /api/rediscover`). If you want a proper name / stack /
description, add a `meta` entry for the new `server_name` in `overrides.json`.

## Useful commands

```bash
# Service control
sudo systemctl status testlab
sudo systemctl restart testlab
sudo journalctl -u testlab -f
sudo journalctl -u testlab -n 100 --no-pager

# Local smoke test (bypasses nginx)
curl -s http://127.0.0.1:3011/api/health
curl -s http://127.0.0.1:3011/api/services | head -c 500
curl -X POST http://127.0.0.1:3011/api/rediscover

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
│   └── overrides.json        # hide + meta + extra layer
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── src/
    ├── server.js             # Fastify app, API, lifecycle
    ├── discovery.js          # nginx parser + ss snapshot
    └── healthcheck.js        # HTTP probe + status classifier
```

System files installed outside the project (do not commit):

- `/etc/systemd/system/testlab.service`
- `/etc/nginx/sites-available/test.micutu.com` (symlinked from `sites-enabled/`)

## Notes

- Backend binds only to `127.0.0.1` — never expose port 3011 directly.
- Cloudflare sits in front of `test.micutu.com` and may serve a JS challenge to
  unattended curl/bot traffic; a real browser flow is unaffected.
- The HTTP probe accepts any status `< 500` as "online" because Cloudflare
  often returns `403/503` challenge pages — that still indicates the origin is
  reachable.
- For full nginx-config discovery the service needs read access to
  `/etc/nginx/sites-enabled/`. The default permissions (`0644`) on each file are
  sufficient; the systemd unit uses `ProtectSystem=strict` which keeps `/etc`
  read-only but readable.
- Tune `DEFAULT_TIMEOUT_MS` and `SLOW_THRESHOLD_MS` in `src/healthcheck.js`
  if the defaults are too aggressive.
