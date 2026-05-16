import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll, summarize } from './healthcheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SERVICES_FILE = path.join(ROOT, 'config', 'services.json');

const HOST = process.env.TESTLAB_HOST || '127.0.0.1';
const PORT = Number(process.env.TESTLAB_PORT || 3011);
const CACHE_TTL_MS = 30_000;
const REFRESH_INTERVAL_MS = 60_000;

const app = Fastify({
  logger: { level: 'info' },
  disableRequestLogging: false,
});

let services = [];
let lastResults = [];
let lastCheckedAt = null;
let runningCheck = null;

async function loadServices() {
  const raw = await readFile(SERVICES_FILE, 'utf8');
  services = JSON.parse(raw);
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

app.get('/api/services', async () => ({ services }));

app.get('/api/status', async () => {
  await ensureFresh();
  return {
    summary: summarize(lastResults),
    results: lastResults,
    lastCheckedAt,
  };
});

app.post('/api/check', async () => {
  await runChecks();
  return {
    summary: summarize(lastResults),
    results: lastResults,
    lastCheckedAt,
  };
});

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
  index: ['index.html'],
});

async function start() {
  try {
    await loadServices();
    app.log.info(`Loaded ${services.length} services from ${SERVICES_FILE}`);
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`TestLab listening on http://${HOST}:${PORT}`);
    // Kick off first check in background.
    runChecks().catch((e) => app.log.error({ err: e }, 'initial check failed'));
    setInterval(() => {
      runChecks().catch((e) => app.log.error({ err: e }, 'scheduled check failed'));
    }, REFRESH_INTERVAL_MS).unref();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
