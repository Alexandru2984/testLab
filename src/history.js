import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const RETENTION_HOURS = 48;
const PRUNE_INTERVAL_MS = 60 * 60_000;

let db = null;
let stmts = null;

export function initHistory(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      status TEXT NOT NULL,
      latency INTEGER NOT NULL,
      http_status INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checks_host_time ON checks (host, checked_at DESC);
  `);

  stmts = {
    insert: db.prepare(
      'INSERT INTO checks (host, status, latency, http_status, checked_at) VALUES (?, ?, ?, ?, ?)'
    ),
    recentByHost: db.prepare(
      'SELECT status, latency, http_status, checked_at FROM checks WHERE host = ? AND checked_at >= ? ORDER BY checked_at ASC'
    ),
    summary24h: db.prepare(`
      SELECT
        host,
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('online', 'slow') THEN 1 ELSE 0 END) AS ok,
        AVG(CASE WHEN status != 'offline' THEN latency END) AS avg_latency
      FROM checks
      WHERE checked_at >= ?
      GROUP BY host
    `),
    sparkByHost: db.prepare(
      'SELECT status, latency, checked_at FROM checks WHERE host = ? AND checked_at >= ? ORDER BY checked_at ASC LIMIT ?'
    ),
    prune: db.prepare('DELETE FROM checks WHERE checked_at < ?'),
  };

  setInterval(() => {
    try {
      prune();
    } catch (err) {
      // best-effort; will retry next interval
    }
  }, PRUNE_INTERVAL_MS).unref();
}

export function recordChecks(results) {
  if (!stmts) return;
  const now = Date.now();
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    for (const r of results) {
      if (!r.host) continue;
      stmts.insert.run(
        r.host,
        r.status || 'unknown',
        Math.max(0, Math.round(r.latency || 0)),
        r.httpStatus || 0,
        now
      );
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw err;
  }
}

export function getSummary24h() {
  if (!stmts) return new Map();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = stmts.summary24h.all(cutoff);
  const out = new Map();
  for (const row of rows) {
    out.set(row.host, {
      total: row.total,
      ok: row.ok,
      uptimePct: row.total ? Math.round((row.ok / row.total) * 1000) / 10 : null,
      avgLatency24h: row.avg_latency != null ? Math.round(row.avg_latency) : null,
    });
  }
  return out;
}

export function getSparkline(host, points = 60) {
  if (!stmts) return [];
  // Look back 24h for the requested number of samples.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return stmts.sparkByHost.all(host, cutoff, points);
}

export function getAllSparklines(points = 30) {
  if (!stmts) return {};
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = db
    .prepare(
      `SELECT host, status, latency, checked_at FROM checks
       WHERE checked_at >= ? ORDER BY host, checked_at ASC`
    )
    .all(cutoff);
  const grouped = {};
  for (const r of rows) {
    if (!grouped[r.host]) grouped[r.host] = [];
    grouped[r.host].push({ status: r.status, latency: r.latency, t: r.checked_at });
  }
  // Trim each series to the last N samples.
  for (const h of Object.keys(grouped)) {
    if (grouped[h].length > points) grouped[h] = grouped[h].slice(-points);
  }
  return grouped;
}

export function getHistory(host, hours = 24) {
  if (!stmts) return [];
  const cutoff = Date.now() - hours * 3600 * 1000;
  return stmts.recentByHost.all(host, cutoff);
}

function prune() {
  if (!stmts) return 0;
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  const r = stmts.prune.run(cutoff);
  return r.changes;
}
