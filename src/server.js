import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll, summarize } from './healthcheck.js';
import { buildServiceList } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OVERRIDES_FILE = path.join(ROOT, 'config', 'overrides.json');

const HOST = process.env.TESTLAB_HOST || '127.0.0.1';
const PORT = Number(process.env.TESTLAB_PORT || 3011);
const CACHE_TTL_MS = 30_000;
const REFRESH_INTERVAL_MS = 60_000;
const REDISCOVER_INTERVAL_MS = 5 * 60_000;

const app = Fastify({
  logger: { level: 'info' },
  disableRequestLogging: false,
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
      lastResults = results;
      lastCheckedAt = new Date().toISOString();
      return results;
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
  return services.map((s) => {
    const r = byUrl.get(s.url);
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
