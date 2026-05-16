const $ = (sel) => document.querySelector(sel);

const els = {
  refresh: $('#refresh-btn'),
  lastChecked: $('#last-checked'),
  cards: $('#cards'),
  total: $('#stat-total'),
  online: $('#stat-online'),
  offline: $('#stat-offline'),
  slow: $('#stat-slow'),
  latency: $('#stat-latency'),
  healthPill: $('#health-pill'),
};

function stackBadge(stack) {
  const key = String(stack || '').toLowerCase();
  let cls = '';
  if (key.includes('django') || key.includes('python') || key.includes('fastapi')) cls = 'stack-django';
  else if (key.includes('react') || key.includes('next')) cls = 'stack-react';
  else if (key.includes('c++') || key === 'c' || key.includes('cpp')) cls = 'stack-c';
  else if (key.includes('zig')) cls = 'stack-zig';
  else if (key.includes('rust')) cls = 'stack-rust';
  else if (key.includes('go')) cls = 'stack-go';
  else if (key.includes('ai') || key.includes('ml')) cls = 'stack-ai';
  else if (key.includes('node')) cls = 'stack-node';
  return `<span class="badge ${cls}">${escapeHtml(stack || 'Other')}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function formatLatency(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusLabel(s) {
  return { online: 'Online', offline: 'Offline', slow: 'Slow', unknown: 'Unknown' }[s] || 'Unknown';
}

function renderCards(results) {
  if (!results || results.length === 0) {
    els.cards.innerHTML = '<div class="placeholder">No services configured.</div>';
    return;
  }
  const sorted = [...results].sort((a, b) => {
    const order = { offline: 0, slow: 1, unknown: 2, online: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name);
  });
  els.cards.innerHTML = sorted
    .map((r) => {
      const latency = r.status === 'offline' ? '—' : formatLatency(r.latency);
      const httpLine =
        r.httpStatus > 0
          ? `HTTP ${r.httpStatus}`
          : r.reason
            ? r.reason
            : '—';
      return `
        <article class="card" data-status="${r.status}">
          <div class="card-head">
            <h3 class="card-name">${escapeHtml(r.name)}</h3>
            ${stackBadge(r.stack)}
          </div>
          <p class="card-desc">${escapeHtml(r.description || '')}</p>
          <div class="card-row">
            <span class="status-pill" data-status="${r.status}">
              <span class="status-dot"></span>${statusLabel(r.status)}
            </span>
            <span class="val">${escapeHtml(httpLine)}</span>
          </div>
          <div class="card-row">
            <span class="key">Latency</span><span class="val">${latency}</span>
          </div>
          <div class="card-row">
            <span class="key">Checked</span><span class="val">${formatTime(r.checkedAt)}</span>
          </div>
          <div class="card-row">
            <a class="visit" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)} →</a>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderOverview(summary, lastCheckedAt) {
  els.total.textContent = summary?.total ?? '—';
  els.online.textContent = summary?.online ?? '—';
  els.offline.textContent = summary?.offline ?? '—';
  els.slow.textContent = summary?.slow ?? '—';
  els.latency.textContent = summary?.avgLatency ? `${summary.avgLatency} ms` : '—';
  els.lastChecked.textContent = lastCheckedAt
    ? `Last check: ${new Date(lastCheckedAt).toLocaleTimeString()}`
    : 'Never checked';
}

async function loadStatus({ force = false } = {}) {
  setLoading(true);
  try {
    const endpoint = force ? '/api/check' : '/api/status';
    const res = await fetch(endpoint, { method: force ? 'POST' : 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderOverview(data.summary, data.lastCheckedAt);
    renderCards(data.results);
  } catch (err) {
    els.cards.innerHTML = `<div class="placeholder">Failed to load status. Retrying soon…</div>`;
    console.warn('status load failed', err);
  } finally {
    setLoading(false);
  }
}

async function checkApiHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error();
    els.healthPill.textContent = 'api: ok';
    els.healthPill.className = 'pill pill-ok';
  } catch {
    els.healthPill.textContent = 'api: down';
    els.healthPill.className = 'pill pill-bad';
  }
}

function setLoading(isLoading) {
  els.refresh.disabled = isLoading;
  els.refresh.innerHTML = isLoading
    ? '<span class="spinner"></span> Checking…'
    : 'Run checks now';
}

els.refresh.addEventListener('click', () => loadStatus({ force: true }));

(async function init() {
  await checkApiHealth();
  await loadStatus();
  // Auto-refresh every 45s (server caches for 30s anyway).
  setInterval(() => loadStatus(), 45_000);
  setInterval(checkApiHealth, 60_000);
})();
