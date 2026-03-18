/**
 * FND Tracker — SQLite Database Layer
 *
 * Deduplication strategy (three layers):
 *
 *  1. UUID primary key  — if two devices assign the same id (collision),
 *     only the first insertion wins (INSERT OR IGNORE).
 *
 *  2. Content hash      — a SHA-256 of normalised key fields catches
 *     near-duplicates that arise when two devices log the same event
 *     in the same minute with slightly different ids.
 *     Entries whose hash already exists in the table are rejected.
 *
 *  3. Last-write-wins   — if an entry with the same id already exists
 *     but the incoming updated_at is newer, the row is updated.
 */

'use strict';

const path   = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'fnd-tracker.db');
const db = new Database(DB_PATH);

// WAL mode: safe for concurrent readers + one writer
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

/* ─── Schema ─────────────────────────────────────────────────── */
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id           TEXT PRIMARY KEY,
    entry_type   TEXT NOT NULL,        -- 'event' | 'med' | 'food' | 'checkin'
    data         TEXT NOT NULL,        -- full JSON blob
    content_hash TEXT NOT NULL,        -- SHA-256 of normalised key fields
    device_id    TEXT NOT NULL,        -- originating device
    created_at   TEXT NOT NULL,        -- ISO-8601 (entry timestamp)
    updated_at   TEXT NOT NULL,        -- ISO-8601 (last write)
    deleted      INTEGER DEFAULT 0     -- soft-delete flag
  );

  CREATE INDEX IF NOT EXISTS idx_entry_type    ON entries(entry_type);
  CREATE INDEX IF NOT EXISTS idx_created_at    ON entries(created_at);
  CREATE INDEX IF NOT EXISTS idx_content_hash  ON entries(content_hash);
  CREATE INDEX IF NOT EXISTS idx_deleted       ON entries(deleted);
`);

/* ─── Content hashing ────────────────────────────────────────── */

/**
 * Round an ISO timestamp down to the nearest minute.
 * Used to treat events logged within the same minute as identical.
 */
function floorMinute(iso) {
  const d = new Date(iso);
  d.setSeconds(0, 0);
  return d.toISOString();
}

/**
 * Produce a stable content hash for an entry.
 * Fields used intentionally exclude free-text notes so that
 * "same event, different note wording" is still a duplicate.
 */
function contentHash(entryType, data) {
  let key;
  switch (entryType) {
    case 'event':
      // Same user, same minute → same event
      key = {
        t: 'event',
        ts: floorMinute(data.timestamp || new Date().toISOString()),
        user: (data.userName || '').toLowerCase().trim(),
      };
      break;
    case 'med':
      key = {
        t: 'med',
        ts: floorMinute(data.timestamp || new Date().toISOString()),
        name: (data.name || '').toLowerCase().trim(),
      };
      break;
    case 'food':
      key = {
        t: 'food',
        ts: floorMinute(data.timestamp || new Date().toISOString()),
        name: (data.name || '').toLowerCase().trim(),
      };
      break;
    case 'checkin':
      // One check-in per user per calendar day
      key = {
        t: 'checkin',
        date: (data.timestamp || '').slice(0, 10),
        user: (data.userName || '').toLowerCase().trim(),
      };
      break;
    default:
      key = { t: entryType, ts: data.timestamp, id: data.id };
  }
  return crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

/* ─── Prepared statements ────────────────────────────────────── */
const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO entries
    (id, entry_type, data, content_hash, device_id, created_at, updated_at, deleted)
  VALUES
    (@id, @entry_type, @data, @content_hash, @device_id, @created_at, @updated_at, 0)
`);

const stmtUpdate = db.prepare(`
  UPDATE entries
  SET data = @data, updated_at = @updated_at, deleted = 0
  WHERE id = @id AND updated_at < @updated_at
`);

const stmtHashExists = db.prepare(`
  SELECT id FROM entries WHERE content_hash = ? AND deleted = 0 LIMIT 1
`);

const stmtSoftDelete = db.prepare(`
  UPDATE entries SET deleted = 1, updated_at = ? WHERE id = ?
`);

/* ─── Public API ─────────────────────────────────────────────── */

/**
 * Return all non-deleted entries, grouped by type.
 */
function getAllData() {
  const rows = db
    .prepare('SELECT * FROM entries WHERE deleted = 0 ORDER BY created_at ASC')
    .all();

  const result = { events: [], meds: [], food: [], checkins: [] };
  for (const row of rows) {
    try {
      const entry = JSON.parse(row.data);
      entry.id = row.id;  // ensure id is always present
      switch (row.entry_type) {
        case 'event':   result.events.push(entry);   break;
        case 'med':     result.meds.push(entry);     break;
        case 'food':    result.food.push(entry);     break;
        case 'checkin': result.checkins.push(entry); break;
      }
    } catch { /* skip malformed rows */ }
  }
  return result;
}

/**
 * Apply a batch of changes from a device.
 *
 * Returns only the entries that were actually inserted or updated
 * (i.e. deduplicated entries are silently dropped).
 */
function applyChanges(changes, sourceDeviceId) {
  const accepted = [];

  const runBatch = db.transaction((changes) => {
    for (const change of changes) {
      if (!change || !change.id || !change._type) continue;

      const now        = new Date().toISOString();
      const entryType  = change._type;
      const hash       = contentHash(entryType, change);
      const createdAt  = change.timestamp || now;
      const updatedAt  = change._updatedAt || now;

      // ── Layer 2: content-hash dedup ───────────────────────────
      const hashRow = stmtHashExists.get(hash);
      if (hashRow && hashRow.id !== change.id) {
        // Duplicate content with a different id — discard silently
        console.log(`[dedup] ${entryType} ${change.id} → matches existing ${hashRow.id}`);
        continue;
      }

      // ── Layer 1 + 3: insert (ignore) then update if newer ─────
      const row = {
        id:           change.id,
        entry_type:   entryType,
        data:         JSON.stringify(change),
        content_hash: hash,
        device_id:    sourceDeviceId || change._deviceId || 'unknown',
        created_at:   createdAt,
        updated_at:   updatedAt,
      };

      const inserted = stmtInsert.run(row);
      if (inserted.changes > 0) {
        accepted.push(change);
        continue;
      }

      // Row already exists — apply last-write-wins update
      const updated = stmtUpdate.run({ id: change.id, data: row.data, updated_at: updatedAt });
      if (updated.changes > 0) {
        accepted.push(change);
      }
    }
  });

  runBatch(changes);
  return accepted;
}

/**
 * Soft-delete an entry by id.
 */
function softDelete(id, _deviceId) {
  stmtSoftDelete.run(new Date().toISOString(), id);
}

module.exports = { getAllData, applyChanges, softDelete };
