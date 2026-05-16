import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll, summarize } from './healthcheck.js';
import { buildServiceList } from './discovery.js';
import {
  initHistory,
  recordChecks,
  getSummary24h,
  getSparkline,
  getAllSparklines,
  getHistory,
} from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OVERRIDES_FILE = path.join(ROOT, 'config', 'overrides.json');
const DB_PATH = path.join(ROOT, 'state', 'history.db');

const HOST = process.env.TESTLAB_HOST || '127.0.0.1';
const PORT = Number(process.env.TESTLAB_PORT || 3011);
const CACHE_TTL_MS = 30_000;
const REFRESH_INTERVAL_MS = 60_000;
const REDISCOVER_INTERVAL_MS = 5 * 60_000;

const app = Fastify({
  logger: { level: 'info' },
  disableRequestLogging: false,
  // Honour X-Forwarded-For from the local nginx so rate-limit keys are real client IPs.
  trustProxy: ['127.0.0.1', '::1'],
});

let services = [];
let discoveryError = null;
let lastDiscoveredAt = null;
let lastResults = [];
let lastCheckedAt = null;
let runningCheck = null;

async function loadOverrides() {
  try {
    const raw = await readFile(OVERRIDES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function rediscover() {
  const overrides = await loadOverrides();
  const { services: list, discoveryError: err } = await buildServiceList(overrides);
  services = list;
  discoveryError = err;
  lastDiscoveredAt = new Date().toISOString();
  return services;
}

async function runChecks() {
  if (runningCheck) return runningCheck;
  runningCheck = (async () => {
    try {
      const results = await checkAll(services);
      // Attach host (healthcheck.js doesn't see it) before recording.
      const byUrl = new Map(services.map((s) => [s.url, s.host]));
      const enriched = results.map((r) => ({ ...r, host: byUrl.get(r.url) || null }));
      lastResults = enriched;
      lastCheckedAt = new Date().toISOString();
      try {
        recordChecks(enriched);
      } catch (err) {
        app.log.warn({ err }, 'history record failed');
      }
      return enriched;
    } finally {
      runningCheck = null;
    }
  })();
  return runningCheck;
}

async function ensureFresh() {
  if (!lastCheckedAt) {
    await runChecks();
    return;
  }
  const age = Date.now() - new Date(lastCheckedAt).getTime();
  if (age > CACHE_TTL_MS) await runChecks();
}

// Friendly error handler — never leak stack traces.
app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  reply.status(err.statusCode || 500).send({
    error: true,
    message: err.statusCode && err.statusCode < 500 ? err.message : 'Internal error',
  });
});

// Lightweight per-IP rate limiter for write/expensive endpoints. Each /api/check
// fans out one outbound request per service, so an unbounded POST flood would
// amplify into the upstream services. 12 requests / minute / IP is plenty for
// a human clicking the refresh button.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const rateBuckets = new Map();

function clientIp(req) {
  // Fastify already honours X-Forwarded-For via trustProxy; we set that below.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

app.addHook('onRequest', async (req, reply) => {
  if (req.method !== 'POST') return;
  if (!req.url.startsWith('/api/check') && !req.url.startsWith('/api/rediscover')) return;
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.start + RATE_LIMIT_WINDOW_MS - now) / 1000);
    reply
      .header('Retry-After', String(retryAfter))
      .status(429)
      .send({ error: true, message: 'Too many requests' });
  }
});

// Periodic bucket cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, b] of rateBuckets) {
    if (b.start < cutoff) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.get('/api/health', async () => ({
  ok: true,
  service: 'testlab',
  uptime: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
}));

app.get('/api/services', async () => ({
  services,
  lastDiscoveredAt,
  discoveryError,
}));

function mergeResults() {
  const byUrl = new Map(lastResults.map((r) => [r.url, r]));
  const summary24h = getSummary24h();
  return services.map((s) => {
    const r = byUrl.get(s.url);
    const h = summary24h.get(s.host) || {};
    return {
      name: s.name,
      url: s.url,
      host: s.host,
      stack: s.stack,
      description: s.description,
      type: s.type,
      source: s.source,
      upstreamPort: s.upstreamPort,
      upstreamListening: s.upstreamListening,
      status: r?.status || 'unknown',
      httpStatus: r?.httpStatus ?? 0,
      latency: r?.latency ?? 0,
      reason: r?.reason,
      checkedAt: r?.checkedAt || null,
      uptimePct24h: h.uptimePct ?? null,
      avgLatency24h: h.avgLatency24h ?? null,
      samples24h: h.total ?? 0,
    };
  });
}

app.get('/api/status', async () => {
  await ensureFresh();
  const merged = mergeResults();
  return {
    summary: summarize(merged),
    results: merged,
    lastCheckedAt,
    lastDiscoveredAt,
    discoveryError,
  };
});

app.post('/api/check', async () => {
  await runChecks();
  const merged = mergeResults();
  return {
    summary: summarize(merged),
    results: merged,
    lastCheckedAt,
    lastDiscoveredAt,
    discoveryError,
  };
});

app.get('/api/sparklines', async (req) => {
  const points = Math.max(1, Math.min(120, Number(req.query?.points) || 30));
  return { points, series: getAllSparklines(points) };
});

app.get('/api/sparkline/:host', async (req, reply) => {
  const host = String(req.params.host || '');
  if (!/^[a-z0-9.\-]{1,253}$/i.test(host)) {
    reply.status(400);
    return { error: true, message: 'invalid host' };
  }
  const points = Math.max(1, Math.min(120, Number(req.query?.points) || 60));
  return { host, points: getSparkline(host, points) };
});

app.get('/api/history/:host', async (req, reply) => {
  const host = String(req.params.host || '');
  if (!/^[a-z0-9.\-]{1,253}$/i.test(host)) {
    reply.status(400);
    return { error: true, message: 'invalid host' };
  }
  const hours = Math.max(1, Math.min(48, Number(req.query?.hours) || 24));
  return { host, hours, points: getHistory(host, hours) };
});

app.post('/api/rediscover', async () => {
  await rediscover();
  await runChecks();
  const merged = mergeResults();
  return {
    summary: summarize(merged),
    results: merged,
    lastCheckedAt,
    lastDiscoveredAt,
    discoveryError,
  };
});

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
  index: ['index.html'],
});

async function start() {
  try {
    initHistory(DB_PATH);
    app.log.info(`History DB at ${DB_PATH}`);
    await rediscover();
    app.log.info(
      { count: services.length, error: discoveryError },
      `Discovered ${services.length} services`
    );
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`TestLab listening on http://${HOST}:${PORT}`);
    // Re-snapshot after we ourselves are listening so the dashboard reflects this port.
    rediscover().catch((e) => app.log.error({ err: e }, 'post-listen rediscover failed'));
    runChecks().catch((e) => app.log.error({ err: e }, 'initial check failed'));
    setInterval(() => {
      runChecks().catch((e) => app.log.error({ err: e }, 'scheduled check failed'));
    }, REFRESH_INTERVAL_MS).unref();
    setInterval(() => {
      rediscover().catch((e) => app.log.error({ err: e }, 'rediscovery failed'));
    }, REDISCOVER_INTERVAL_MS).unref();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
