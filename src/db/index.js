// SQLite 상태·이력. 스키마는 idempotent (CREATE IF NOT EXISTS).
// candidates.status 흐름: pending → approved/skipped → generating → uploaded → published/failed
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

mkdirSync(paths.data, { recursive: true });

const db = new Database(paths.db);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS news_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  news_item_id        INTEGER NOT NULL REFERENCES news_items(id),
  rank                INTEGER,
  ai_reason           TEXT,
  card_json           TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  telegram_message_id INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publishes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id),
  ig_carousel_id TEXT,
  ig_reel_id     TEXT,
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  error         TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------- news_items ----------

// 신규 뉴스 삽입. URL 중복이면 무시하고 false 반환. 성공 시 삽입된 row id.
export function insertNewsItem({ source, url, title, summary, publishedAt }) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO news_items (source, url, title, summary, published_at)
     VALUES (@source, @url, @title, @summary, @publishedAt)`
  );
  const info = stmt.run({ source, url, title, summary: summary ?? null, publishedAt: publishedAt ?? null });
  return info.changes > 0 ? info.lastInsertRowid : null;
}

export function newsUrlExists(url) {
  return !!db.prepare('SELECT 1 FROM news_items WHERE url = ?').get(url);
}

// 최근 N시간 내 수집된 뉴스.
export function getRecentNewsItems(hours) {
  return db
    .prepare(`SELECT * FROM news_items WHERE collected_at >= datetime('now', ?) ORDER BY collected_at DESC`)
    .all(`-${hours} hours`);
}

export function getNewsItem(id) {
  return db.prepare('SELECT * FROM news_items WHERE id = ?').get(id);
}

// ---------- candidates ----------

export function insertCandidate({ newsItemId, rank, aiReason, cardJson, status = 'pending' }) {
  const info = db
    .prepare(
      `INSERT INTO candidates (news_item_id, rank, ai_reason, card_json, status)
       VALUES (@newsItemId, @rank, @aiReason, @cardJson, @status)`
    )
    .run({
      newsItemId,
      rank: rank ?? null,
      aiReason: aiReason ?? null,
      cardJson: cardJson ? JSON.stringify(cardJson) : null,
      status,
    });
  return info.lastInsertRowid;
}

export function getCandidate(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (row && row.card_json) row.card = JSON.parse(row.card_json);
  return row;
}

export function updateCandidateStatus(id, status) {
  db.prepare('UPDATE candidates SET status = ? WHERE id = ?').run(status, id);
}

export function setCandidateCardJson(id, cardJson) {
  db.prepare('UPDATE candidates SET card_json = ? WHERE id = ?').run(JSON.stringify(cardJson), id);
}

export function setCandidateTelegramMessageId(id, messageId) {
  db.prepare('UPDATE candidates SET telegram_message_id = ? WHERE id = ?').run(messageId, id);
}

// ---------- publishes ----------

export function insertPublish({ candidateId, igCarouselId, igReelId, error }) {
  const info = db
    .prepare(
      `INSERT INTO publishes (candidate_id, ig_carousel_id, ig_reel_id, error)
       VALUES (@candidateId, @igCarouselId, @igReelId, @error)`
    )
    .run({
      candidateId,
      igCarouselId: igCarouselId ?? null,
      igReelId: igReelId ?? null,
      error: error ?? null,
    });
  return info.lastInsertRowid;
}

// ---------- meta (key-value) ----------

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export default db;
