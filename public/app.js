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
  search: $('#search'),
  filters: $('#status-filters'),
  visibleCount: $('#visible-count'),
};

const state = {
  results: [],
  summary: null,
  lastCheckedAt: null,
  query: '',
  statusFilter: 'all',
};

function stackBadge(stack) {
  const key = String(stack || '').toLowerCase();
  let cls = '';
  if (key.includes('django')) cls = 'stack-django';
  else if (key.includes('python') || key === 'r' || key.includes('shiny')) cls = 'stack-python';
  else if (key.includes('react') || key.includes('next')) cls = 'stack-react';
  else if (key.includes('c++') || key === 'c' || key.includes('cpp') || key.includes('assembly') || key.includes('fortran') || key.includes('cobol')) cls = 'stack-c';
  else if (key.includes('zig')) cls = 'stack-zig';
  else if (key.includes('rust')) cls = 'stack-rust';
  else if (key.includes('go') || key.includes('golang')) cls = 'stack-go';
  else if (key.includes('ai') || key.includes('ml')) cls = 'stack-ai';
  else if (key.includes('node')) cls = 'stack-node';
  else if (key.includes('elixir') || key.includes('phoenix')) cls = 'stack-elixir';
  else if (key.includes('ruby')) cls = 'stack-ruby';
  else if (key.includes('haskell') || key.includes('lisp') || key.includes('clojure') || key.includes('racket')) cls = 'stack-haskell';
  else if (key.includes('static')) cls = 'stack-static';
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

function applyFilters(results) {
  const q = state.query.trim().toLowerCase();
  return results.filter((r) => {
    if (state.statusFilter !== 'all' && r.status !== state.statusFilter) return false;
    if (!q) return true;
    return (
      (r.name || '').toLowerCase().includes(q) ||
      (r.host || '').toLowerCase().includes(q) ||
      (r.url || '').toLowerCase().includes(q) ||
      (r.stack || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    );
  });
}

function metaChips(r) {
  const chips = [];
  if (r.upstreamPort) {
    const cls = r.upstreamListening === false ? 'warn' : r.upstreamListening === true ? 'ok' : '';
    const indicator =
      r.upstreamListening === false ? ' ✗' : r.upstreamListening === true ? ' ✓' : '';
    chips.push(`<span class="chip ${cls}">:${r.upstreamPort}${indicator}</span>`);
  }
  if (r.type && r.type !== 'proxy') {
    chips.push(`<span class="chip">${escapeHtml(r.type)}</span>`);
  }
  if (r.source === 'extra') chips.push(`<span class="chip">manual</span>`);
  return chips.length ? `<div class="meta-line">${chips.join('')}</div>` : '';
}

function renderCards(results) {
  const filtered = applyFilters(results);
  els.visibleCount.textContent =
    filtered.length === results.length
      ? `${results.length} services`
      : `${filtered.length} of ${results.length}`;

  if (filtered.length === 0) {
    els.cards.innerHTML = `<div class="placeholder">No services match the filter.</div>`;
    return;
  }
  const sorted = [...filtered].sort((a, b) => {
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
          ${metaChips(r)}
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
    state.results = data.results || [];
    state.summary = data.summary;
    state.lastCheckedAt = data.lastCheckedAt;
    renderOverview(state.summary, state.lastCheckedAt);
    renderCards(state.results);
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

els.search.addEventListener('input', (e) => {
  state.query = e.target.value;
  renderCards(state.results);
});

els.filters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  for (const f of els.filters.querySelectorAll('.filter')) f.classList.remove('active');
  btn.classList.add('active');
  state.statusFilter = btn.dataset.filter;
  renderCards(state.results);
});

(async function init() {
  await checkApiHealth();
  await loadStatus();
  setInterval(() => loadStatus(), 45_000);
  setInterval(checkApiHealth, 60_000);
})();
