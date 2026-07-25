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
  topic        TEXT,
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
  topic               TEXT,
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

// 기존 DB 마이그레이션: 누락된 컬럼을 추가 (SQLite엔 ADD COLUMN IF NOT EXISTS가 없음).
function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn('news_items', 'topic', 'TEXT');
ensureColumn('candidates', 'topic', 'TEXT');

// ---------- news_items ----------

// 신규 뉴스 삽입. URL 중복이면 무시하고 null 반환. 성공 시 삽입된 row id.
export function insertNewsItem({ topic, source, url, title, summary, publishedAt }) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO news_items (topic, source, url, title, summary, published_at)
     VALUES (@topic, @source, @url, @title, @summary, @publishedAt)`
  );
  const info = stmt.run({
    topic: topic ?? null,
    source,
    url,
    title,
    summary: summary ?? null,
    publishedAt: publishedAt ?? null,
  });
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

// 특정 주제의 최근 N시간 미사용(후보로 안 쓰인) 뉴스 — 겹침 방지.
export function getRecentUnusedNewsItems(topic, hours) {
  return db
    .prepare(
      `SELECT n.* FROM news_items n
       WHERE n.topic = ?
         AND n.collected_at >= datetime('now', ?)
         AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.news_item_id = n.id)
       ORDER BY n.published_at DESC, n.collected_at DESC`
    )
    .all(topic, `-${hours} hours`);
}

export function getNewsItem(id) {
  return db.prepare('SELECT * FROM news_items WHERE id = ?').get(id);
}

// ---------- candidates ----------

export function insertCandidate({ newsItemId, topic, rank, aiReason, cardJson, status = 'pending' }) {
  const info = db
    .prepare(
      `INSERT INTO candidates (news_item_id, topic, rank, ai_reason, card_json, status)
       VALUES (@newsItemId, @topic, @rank, @aiReason, @cardJson, @status)`
    )
    .run({
      newsItemId,
      topic: topic ?? null,
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

// 오늘(로컬 날짜) 해당 주제로 발행 완료된 후보 수 — 자동 발행 일일 한도 판정용.
export function countPublishedToday(topic) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM candidates
       WHERE topic = ? AND status = 'published'
         AND date(created_at, 'localtime') = date('now', 'localtime')`
    )
    .get(topic).n;
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
