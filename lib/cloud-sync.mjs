/**
 * 本地 → 云端增量同步队列。
 *
 * 用 SQLite 触发器捕获 cases / drive_files / generations 的变化。队列按实体合并：
 * 一条案例短时间内被改十次，只保留一个待同步项。version 防止网络请求期间的新修改
 * 被旧请求的确认误删。
 */

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_sync_queue (
  kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  version INTEGER NOT NULL DEFAULT 1,
  changed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (kind, entity_id)
);

CREATE TRIGGER IF NOT EXISTS cloud_sync_cases_insert
AFTER INSERT ON cases BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', NEW.id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_cases_update
AFTER UPDATE ON cases BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', NEW.id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_cases_delete
AFTER DELETE ON cases BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', OLD.id, 'delete')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'delete', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_media_insert
AFTER INSERT ON drive_files BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', NEW.case_id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_media_update
AFTER UPDATE ON drive_files BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', NEW.case_id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_media_delete
AFTER DELETE ON drive_files BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('case', OLD.case_id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_generations_insert
AFTER INSERT ON generations BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('generation', NEW.id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_generations_update
AFTER UPDATE ON generations BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('generation', NEW.id, 'upsert')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'upsert', version = version + 1, changed_at = datetime('now', 'localtime');
END;

CREATE TRIGGER IF NOT EXISTS cloud_sync_generations_delete
AFTER DELETE ON generations BEGIN
  INSERT INTO cloud_sync_queue (kind, entity_id, operation) VALUES ('generation', OLD.id, 'delete')
  ON CONFLICT(kind, entity_id) DO UPDATE SET operation = 'delete', version = version + 1, changed_at = datetime('now', 'localtime');
END;
`;

export function installCloudSyncQueue(db) {
  db.exec(QUEUE_SCHEMA);
}

export function collectChanges(db, limit = 100) {
  return db.prepare(`SELECT kind, entity_id AS entityId, operation, version, changed_at AS changedAt
    FROM cloud_sync_queue ORDER BY changed_at, kind, entity_id LIMIT ?`).all(Number(limit));
}

export function acknowledgeChanges(db, changes) {
  const remove = db.prepare('DELETE FROM cloud_sync_queue WHERE kind = ? AND entity_id = ? AND version = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const change of changes) remove.run(change.kind, Number(change.entityId), Number(change.version));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 构造发送给云端的最小批次；删除项只发送 tombstone。 */
export function buildSyncBatch(db, changes) {
  const getCase = db.prepare('SELECT * FROM cases WHERE id = ?');
  const getMedia = db.prepare('SELECT * FROM drive_files WHERE case_id = ? ORDER BY kind, idx');
  const getGeneration = db.prepare('SELECT * FROM generations WHERE id = ?');
  const operations = [];

  for (const change of changes) {
    const base = { kind: change.kind, entityId: Number(change.entityId), operation: change.operation };
    if (change.operation === 'delete') {
      operations.push(base);
      continue;
    }
    if (change.kind === 'case') {
      const row = getCase.get(Number(change.entityId));
      if (row) operations.push({ ...base, row, media: getMedia.all(Number(change.entityId)) });
      else operations.push({ ...base, operation: 'delete' });
      continue;
    }
    if (change.kind === 'generation') {
      const row = getGeneration.get(Number(change.entityId));
      if (row) operations.push({ ...base, row });
      else operations.push({ ...base, operation: 'delete' });
    }
  }

  return { operations };
}
