import { readdir, readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

const SITES_DIR = '/etc/nginx/sites-enabled';

// Files to ignore when scanning sites-enabled.
const SKIP_PATTERNS = [
  /^default$/i,
  /\.bak(\..*)?$/i,
  /\.bak-/i,
  /\.pre-/i,
  /\.disabled$/i,
  /~$/,
];

function shouldSkipFile(name) {
  return SKIP_PATTERNS.some((re) => re.test(name));
}

// Strip nginx comments to keep regexes simple.
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])#.*$/, '$1'))
    .join('\n');
}

// Find top-level `server { ... }` blocks via brace balancing.
function extractServerBlocks(text) {
  const blocks = [];
  const src = stripComments(text);
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      blocks.push(src.slice(start, i - 1));
      re.lastIndex = i;
    }
  }
  return blocks;
}

function extractServerNames(block) {
  const names = new Set();
  const re = /(^|\n)\s*server_name\s+([^;]+);/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    for (const raw of m[2].split(/\s+/)) {
      const name = raw.trim();
      if (!name) continue;
      if (name === '_' || name === 'default') continue;
      if (name.includes('$') || name.includes('*')) continue;
      // Skip mail-autodiscovery hostnames (handled by mail server, not the dashboard)
      if (/^(autodiscover|autoconfig)\./i.test(name)) continue;
      names.add(name);
    }
  }
  return [...names];
}

function extractUpstreamPort(block) {
  // Match proxy_pass http(s)://127.0.0.1:PORT or localhost:PORT
  const re = /proxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/i;
  const m = re.exec(block);
  return m ? Number(m[1]) : null;
}

function isRedirectOnly(block) {
  // Redirect-only blocks: no proxy_pass, no root/try_files, have a top-level return 30x/404
  if (/proxy_pass\s+/.test(block)) return false;
  if (/\b(root|try_files|alias)\s+/.test(block)) return false;
  return /\breturn\s+\d{3}\b/.test(block);
}

function isStaticBlock(block) {
  if (/proxy_pass\s+/.test(block)) return false;
  return /\b(root|try_files|alias)\s+/.test(block);
}

function detectIfWebsocket(block) {
  return /proxy_set_header\s+Upgrade\s+\$http_upgrade/i.test(block);
}

async function parseFile(absPath) {
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    return [];
  }
  const blocks = extractServerBlocks(text);
  const found = [];
  for (const block of blocks) {
    const names = extractServerNames(block);
    if (names.length === 0) continue;
    if (isRedirectOnly(block)) continue;
    const port = extractUpstreamPort(block);
    const type = port ? 'proxy' : isStaticBlock(block) ? 'static' : 'unknown';
    const websocket = detectIfWebsocket(block);
    for (const name of names) {
      found.push({
        host: name,
        port,
        type,
        websocket,
        sourceFile: path.basename(absPath),
      });
    }
  }
  return found;
}

// Per host, prefer the most informative entry: proxy > static > unknown,
// and keep a defined port if any block has one.
function consolidate(entries) {
  const byHost = new Map();
  const rank = { proxy: 3, static: 2, unknown: 1 };
  for (const e of entries) {
    const existing = byHost.get(e.host);
    if (!existing) {
      byHost.set(e.host, { ...e });
      continue;
    }
    const merged = { ...existing };
    if ((rank[e.type] || 0) > (rank[existing.type] || 0)) {
      merged.type = e.type;
    }
    if (!merged.port && e.port) merged.port = e.port;
    merged.websocket = merged.websocket || e.websocket;
    byHost.set(e.host, merged);
  }
  return [...byHost.values()];
}

export async function listenSnapshot() {
  // Returns a Set of localhost-listening TCP ports.
  try {
    const { stdout } = await execAsync('ss -tln', { timeout: 2000 });
    const ports = new Set();
    for (const line of stdout.split('\n')) {
      const m = /\s(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\*|\[::\]):(\d+)\s/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
    return ports;
  } catch {
    return new Set();
  }
}

export async function discoverFromNginx({ sitesDir = SITES_DIR } = {}) {
  let files;
  try {
    files = await readdir(sitesDir);
  } catch (err) {
    return { entries: [], error: `Cannot read ${sitesDir}: ${err.code || err.message}` };
  }
  const targets = files.filter((f) => !shouldSkipFile(f));
  const lists = await Promise.all(
    targets.map((name) => parseFile(path.join(sitesDir, name)))
  );
  const consolidated = consolidate(lists.flat());
  return { entries: consolidated, error: null };
}

// Build the final service list from nginx discovery + overrides.
export async function buildServiceList(overrides = {}) {
  const { entries, error } = await discoverFromNginx();
  const listening = await listenSnapshot();
  const hide = new Set(overrides.hide || []);
  const meta = overrides.meta || {};

  const fromNginx = entries
    .filter((e) => !hide.has(e.host))
    .map((e) => {
      const m = meta[e.host] || {};
      return {
        name: m.name || prettyName(e.host),
        host: e.host,
        url: m.url || `https://${e.host}`,
        health: m.health || null,
        stack: m.stack || guessStack(e),
        description: m.description || defaultDescription(e),
        source: 'nginx',
        type: e.type,
        upstreamPort: e.port,
        upstreamListening: e.port ? listening.has(e.port) : null,
      };
    });

  const extras = (overrides.extra || []).map((s) => ({
    name: s.name,
    host: s.host || hostFromUrl(s.url),
    url: s.url,
    health: s.health || null,
    stack: s.stack || 'Other',
    description: s.description || '',
    source: 'extra',
    type: s.type || 'external',
    upstreamPort: null,
    upstreamListening: null,
  }));

  const all = [...fromNginx, ...extras].sort((a, b) => a.host.localeCompare(b.host));
  return { services: all, discoveryError: error };
}

function prettyName(host) {
  // 'pdf.micutu.com' -> 'Pdf'; 'aichat.micutu.com' -> 'Aichat'
  const sub = host.split('.')[0];
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function defaultDescription(entry) {
  if (entry.type === 'static') return 'Static site';
  if (entry.type === 'proxy') return entry.websocket ? 'Reverse proxy (WebSocket)' : 'Reverse proxy';
  return '';
}

function guessStack(entry) {
  // Heuristics until overrides.json provides a label.
  if (entry.type === 'static') return 'Static';
  return 'Other';
}
