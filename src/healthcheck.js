const DEFAULT_TIMEOUT_MS = 6000;
const SLOW_THRESHOLD_MS = 1500;

function classify(latencyMs, ok) {
  if (!ok) return 'offline';
  if (latencyMs >= SLOW_THRESHOLD_MS) return 'slow';
  return 'online';
}

async function probe(url, { timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'MicuTestLab/1.0 (+https://test.micutu.com)',
        Accept: '*/*',
      },
    });
    const latency = Date.now() - start;
    return { ok: res.status < 500, status: res.status, latency };
  } catch (err) {
    const latency = Date.now() - start;
    const reason =
      err?.name === 'AbortError' ? 'timeout' : err?.code || err?.message || 'network_error';
    return { ok: false, status: 0, latency, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkService(service, opts = {}) {
  const target = service.health || service.url;
  let result = await probe(target, opts);

  // If a dedicated /health endpoint returns 404, fall back to the root URL.
  if (!result.ok && result.status === 404 && service.health && service.health !== service.url) {
    result = await probe(service.url, opts);
  }

  // Some sites reject HEAD or block GET without specific UA — retry once with HEAD on network errors.
  if (!result.ok && result.status === 0) {
    const retry = await probe(service.url, { ...opts, method: 'HEAD' });
    if (retry.ok) result = retry;
  }

  const status = classify(result.latency, result.ok);
  return {
    name: service.name,
    url: service.url,
    stack: service.stack || 'Other',
    description: service.description || '',
    status,
    httpStatus: result.status,
    latency: result.latency,
    reason: result.reason,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkAll(services, opts = {}) {
  return Promise.all(services.map((s) => checkService(s, opts)));
}

export function summarize(results) {
  const total = results.length;
  const online = results.filter((r) => r.status === 'online').length;
  const slow = results.filter((r) => r.status === 'slow').length;
  const offline = results.filter((r) => r.status === 'offline').length;
  const reachable = results.filter((r) => r.status !== 'offline');
  const avgLatency =
    reachable.length === 0
      ? 0
      : Math.round(reachable.reduce((a, r) => a + r.latency, 0) / reachable.length);
  return { total, online, slow, offline, unknown: total - online - slow - offline, avgLatency };
}
