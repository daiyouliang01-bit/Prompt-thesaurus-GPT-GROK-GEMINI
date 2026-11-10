import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  acknowledgeChanges,
  buildSyncBatch,
  collectChanges,
  installCloudSyncQueue,
} from '../lib/cloud-sync.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-cloud-sync-test-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE cases (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE drive_files (
      case_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      drive_id TEXT,
      status TEXT,
      PRIMARY KEY (case_id, kind, idx)
    );
    CREATE TABLE generations (
      id INTEGER PRIMARY KEY,
      goal TEXT
    );
  `);
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('installing the queue does not enqueue existing rows', () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO cases (id, title, prompt) VALUES (1, '已有', 'existing')").run();
    installCloudSyncQueue(f.db);
    assert.deepEqual(collectChanges(f.db), []);
  } finally { f.close(); }
});

test('case insert, update and delete are queued and repeated changes coalesce', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO cases (id, title, prompt) VALUES (7, '新条目', 'prompt')").run();
    let changes = collectChanges(f.db);
    assert.equal(changes.length, 1);
    assert.deepEqual({ kind: changes[0].kind, entityId: changes[0].entityId, operation: changes[0].operation },
      { kind: 'case', entityId: 7, operation: 'upsert' });
    const firstVersion = changes[0].version;

    f.db.prepare("UPDATE cases SET title = '改过' WHERE id = 7").run();
    changes = collectChanges(f.db);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].operation, 'upsert');
    assert.ok(changes[0].version > firstVersion);

    f.db.prepare('DELETE FROM cases WHERE id = 7').run();
    changes = collectChanges(f.db);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].operation, 'delete');
  } finally { f.close(); }
});

test('drive media changes queue their owning case', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO drive_files (case_id, kind, idx, drive_id, status) VALUES (9, 'image', 0, 'abc', 'done')").run();
    const changes = collectChanges(f.db);
    assert.equal(changes.length, 1);
    assert.deepEqual({ kind: changes[0].kind, entityId: changes[0].entityId, operation: changes[0].operation },
      { kind: 'case', entityId: 9, operation: 'upsert' });
  } finally { f.close(); }
});

test('generation changes are queued independently', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO generations (id, goal) VALUES (3, '测试')").run();
    assert.deepEqual(collectChanges(f.db).map(c => [c.kind, c.entityId, c.operation]), [['generation', 3, 'upsert']]);
    f.db.prepare('DELETE FROM generations WHERE id = 3').run();
    assert.deepEqual(collectChanges(f.db).map(c => [c.kind, c.entityId, c.operation]), [['generation', 3, 'delete']]);
  } finally { f.close(); }
});

test('acknowledgement removes only the exact version that was sent', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO cases (id, title, prompt) VALUES (11, 'v1', 'p')").run();
    const sent = collectChanges(f.db);
    f.db.prepare("UPDATE cases SET title = 'v2' WHERE id = 11").run();

    acknowledgeChanges(f.db, sent);
    const remaining = collectChanges(f.db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].entityId, 11);
    assert.ok(remaining[0].version > sent[0].version);

    acknowledgeChanges(f.db, remaining);
    assert.deepEqual(collectChanges(f.db), []);
  } finally { f.close(); }
});

test('sync batch includes the current case row and all media rows', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO cases (id, title, prompt) VALUES (21, '案例', 'prompt')").run();
    f.db.prepare("INSERT INTO drive_files (case_id, kind, idx, drive_id, status) VALUES (21, 'image', 0, 'img-21', 'done')").run();
    const changes = collectChanges(f.db);
    const batch = buildSyncBatch(f.db, changes);
    assert.equal(batch.operations.length, 1);
    assert.equal(batch.operations[0].kind, 'case');
    assert.equal(batch.operations[0].operation, 'upsert');
    assert.equal(batch.operations[0].row.id, 21);
    assert.equal(batch.operations[0].media.length, 1);
    assert.equal(batch.operations[0].media[0].drive_id, 'img-21');
  } finally { f.close(); }
});

test('sync batch represents a deleted case without row data', () => {
  const f = fixture();
  try {
    installCloudSyncQueue(f.db);
    f.db.prepare("INSERT INTO cases (id, title, prompt) VALUES (22, '案例', 'prompt')").run();
    f.db.prepare('DELETE FROM cases WHERE id = 22').run();
    const batch = buildSyncBatch(f.db, collectChanges(f.db));
    assert.deepEqual(batch.operations, [{ kind: 'case', entityId: 22, operation: 'delete' }]);
  } finally { f.close(); }
});
