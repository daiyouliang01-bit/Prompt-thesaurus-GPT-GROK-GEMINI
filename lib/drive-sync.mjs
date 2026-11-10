// 把库里的图片和视频同步到 Google 云盘：先下载原文件（或读本地文件），再上传；可断点续传、自动重试、空间快满时自动暂停
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './db.mjs';
import { DATA } from './paths.mjs';
import * as gd from './gdrive.mjs';
import { download } from './reverse.mjs';

const MAX_ATTEMPTS = 3;
const QUOTA_STOP = 0.95;
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT.jpeg = 'image/jpeg';
MIME_BY_EXT.m4v = 'video/mp4';

export const syncState = {
  running: false, stopRequested: false, startedAt: null, finishedAt: null,
  processed: 0, uploaded: 0, failed: 0, skipped: 0, bytes: 0, message: '',
};

const db = () => store.getDb();
const extOfPath = p => (/\.(\w{2,5})(?:\?|#|$)/.exec(p || '')?.[1] || '').toLowerCase();

function upsertStmt() {
  return db().prepare(`INSERT INTO drive_files (case_id, kind, idx, source, status) VALUES (?, ?, ?, ?, 'pending')
    ON CONFLICT(case_id, kind, idx) DO UPDATE SET source = excluded.source, status = 'pending', drive_id = NULL,
    mime = NULL, size = NULL, error = NULL, attempts = 0, updated_at = datetime('now', 'localtime')`);
}

function queueRow(row, existing, stmt) {
  let queued = 0;
  for (const s of store.mediaSources(row)) {
    const e = existing(row.id, s.kind, s.idx);
    if (!e || e.source !== s.source) { stmt.run(row.id, s.kind, s.idx, s.source); queued++; }
  }
  return queued;
}

/** 把所有案例的图片和视频登记进同步队列；已上传且来源没变的不重复登记 */
export function queueAll() {
  const known = new Map(db().prepare('SELECT case_id, kind, idx, source FROM drive_files').all()
    .map(x => [`${x.case_id}:${x.kind}:${x.idx}`, x]));
  const existing = (id, kind, idx) => known.get(`${id}:${kind}:${idx}`);
  const stmt = upsertStmt();
  let queued = 0;
  const rows = db().prepare('SELECT id, image_path, image_url, extra_images, video_url FROM cases').all();
  db().exec('BEGIN');
  try {
    for (const row of rows) queued += queueRow(row, existing, stmt);
    db().exec('COMMIT');
  } catch (e) {
    db().exec('ROLLBACK');
    throw e;
  }
  return queued;
}

function queueCase(row) {
  const get = db().prepare('SELECT source FROM drive_files WHERE case_id = ? AND kind = ? AND idx = ?');
  return queueRow(row, (id, kind, idx) => get.get(id, kind, idx), upsertStmt());
}

function setResult(item, fields) {
  const cols = Object.keys(fields);
  db().prepare(`UPDATE drive_files SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now', 'localtime')
    WHERE case_id = ? AND kind = ? AND idx = ?`).run(...cols.map(c => fields[c]), item.case_id, item.kind, item.idx);
}

const skip = message => Object.assign(new Error(message), { skip: true });

async function syncItem(item, folders, tmpDir) {
  let file;
  let mime = '';
  let temp = false;
  try {
    if (item.source.startsWith('local:')) {
      file = path.join(DATA, item.source.slice(6));
      if (!fs.existsSync(file)) throw skip('本地文件不存在');
      mime = MIME_BY_EXT[extOfPath(file)] || '';
    } else {
      file = path.join(tmpDir, `${item.case_id}-${item.kind}${item.idx}-${Date.now()}`);
      temp = true;
      mime = await download(item.source, file);
      if (mime === 'text/html') throw skip('链接是网页地址，不是图片或视频文件');
      if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error('下载到的文件是空的');
    }
    if (!/^(image|video)\//.test(mime)) mime = MIME_BY_EXT[extOfPath(item.source)] || (item.kind === 'video' ? 'video/mp4' : 'image/jpeg');
    const ext = EXT_BY_MIME[mime] || extOfPath(item.source) || (item.kind === 'video' ? 'mp4' : 'jpg');
    const uploaded = await gd.uploadFile(file, {
      name: `${item.case_id}-${item.kind}${item.idx}.${ext}`, mime,
      parentId: item.kind === 'video' ? folders.videos : folders.images,
      appProperties: { plib_case_id: String(item.case_id), plib_kind: item.kind, plib_idx: String(item.idx) },
    });
    const size = Number(uploaded.size) || fs.statSync(file).size;
    setResult(item, { status: 'done', drive_id: uploaded.id, mime, size, error: null });
    return { ok: true, size };
  } catch (e) {
    if (e.skip) {
      setResult(item, { status: 'skipped', error: e.message });
      return { skipped: true };
    }
    setResult(item, { status: 'failed', error: String(e.message || e).slice(0, 300), attempts: (item.attempts || 0) + 1 });
    // 授权失效或连不上 Google 时，继续跑也只会全部失败
    if (e.status === 401 || /连不上 Google/.test(e.message)) throw e;
    return { failed: true, error: e.message };
  } finally {
    if (temp && file) fs.rmSync(file, { force: true });
  }
}

async function checkQuota() {
  const info = await gd.about();
  const limit = Number(info.storageQuota?.limit || 0);
  const usage = Number(info.storageQuota?.usage || 0);
  if (limit && usage / limit >= QUOTA_STOP) {
    syncState.stopRequested = true;
    syncState.quotaFull = true;
    syncState.message = `云盘空间快满了（已用 ${fmtBytes(usage)} / 共 ${fmtBytes(limit)}），已自动暂停`;
  }
  return info.storageQuota;
}

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)}${u[i]}`;
}

/** 批量同步。only：image / video；limit：本次最多处理多少个文件 */
export async function runSync({ concurrency = 3, limit = 0, only = '', log = () => {} } = {}) {
  if (syncState.running) throw Object.assign(new Error('同步已经在进行中'), { status: 409 });
  if (!gd.isConnected()) throw Object.assign(new Error('还没有连接 Google 云盘'), { status: 400 });
  Object.assign(syncState, {
    running: true, stopRequested: false, quotaFull: false, startedAt: new Date().toISOString(), finishedAt: null,
    processed: 0, uploaded: 0, failed: 0, skipped: 0, bytes: 0, message: '正在整理同步队列…',
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-drive-'));
  try {
    // 上次异常退出时卡在“上传中”的，超过 30 分钟就重新排队
    db().prepare("UPDATE drive_files SET status = 'pending' WHERE status = 'uploading' AND updated_at < datetime('now', 'localtime', '-30 minutes')").run();
    const queued = queueAll();
    log(`新登记 ${queued} 个文件`);
    const folders = await gd.ensureFolders();
    await checkQuota();
    if (syncState.stopRequested) return syncState;
    syncState.message = '正在同步';
    const pick = db().prepare(`SELECT * FROM drive_files WHERE (status = 'pending' OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS}))
      ${only ? 'AND kind = ?' : ''} ORDER BY CASE kind WHEN 'image' THEN 0 ELSE 1 END, attempts, case_id, idx LIMIT 1`);
    let claimed = 0;
    const claim = () => {
      if (limit && claimed >= limit) return null;
      const row = only ? pick.get(only) : pick.get();
      if (!row) return null;
      setResult(row, { status: 'uploading' });
      claimed++;
      return row;
    };
    let fatal = null;
    const worker = async () => {
      for (let item; !syncState.stopRequested && !fatal && (item = claim());) {
        try {
          const r = await syncItem(item, folders, tmpDir);
          if (r.ok) { syncState.uploaded++; syncState.bytes += r.size; }
          else if (r.skipped) syncState.skipped++;
          else syncState.failed++;
        } catch (e) {
          fatal = e;
          syncState.failed++;
        }
        syncState.processed++;
        if (syncState.processed % 50 === 0) {
          log(`已处理 ${syncState.processed}：上传 ${syncState.uploaded}（${fmtBytes(syncState.bytes)}），跳过 ${syncState.skipped}，失败 ${syncState.failed}`);
          await checkQuota().catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(concurrency) || 3) }, worker));
    if (fatal) throw fatal;
    if (!syncState.quotaFull) syncState.message = syncState.stopRequested ? '已暂停' : (limit && claimed >= limit ? `已处理 ${claimed} 个文件（本次上限）` : '同步完成');
    return syncState;
  } catch (e) {
    syncState.message = `同步中断：${e.message}`;
    throw e;
  } finally {
    db().prepare("UPDATE drive_files SET status = 'pending' WHERE status = 'uploading'").run();
    syncState.running = false;
    syncState.finishedAt = new Date().toISOString();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log(`${syncState.message}：上传 ${syncState.uploaded}（${fmtBytes(syncState.bytes)}），跳过 ${syncState.skipped}，失败 ${syncState.failed}`);
  }
}

const caseJobs = new Map();
/** 新收藏或修改的案例：立刻把它的图片视频传到云盘（批量同步进行中时交给批量同步） */
export function syncCaseNow(caseId) {
  if (!gd.isConnected()) return Promise.resolve();
  const id = Number(caseId);
  if (caseJobs.has(id)) return caseJobs.get(id);
  const job = (async () => {
    const row = store.getCaseRow(id);
    if (!row) return;
    queueCase(row);
    if (syncState.running) return;
    const items = db().prepare("SELECT * FROM drive_files WHERE case_id = ? AND status IN ('pending', 'failed')").all(id);
    if (!items.length) return;
    const folders = await gd.ensureFolders();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-drive-case-'));
    try {
      for (const item of items) {
        setResult(item, { status: 'uploading' });
        await syncItem(item, folders, tmpDir).catch(() => {});
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })().catch(() => {}).finally(() => caseJobs.delete(id));
  caseJobs.set(id, job);
  return job;
}

export function syncCounts() {
  const out = { image: {}, video: {} };
  for (const r of db().prepare('SELECT kind, status, count(*) AS n, coalesce(sum(size), 0) AS bytes FROM drive_files GROUP BY kind, status').all()) {
    (out[r.kind] ||= {})[r.status] = { n: r.n, bytes: r.bytes };
  }
  return out;
}

/** 预计需要同步的文件数（还没登记进队列时也能看） */
export function estimate() {
  const r = db().prepare(`SELECT
    sum(CASE WHEN image_path IS NOT NULL OR image_url LIKE 'http%' THEN 1 ELSE 0 END) AS main,
    sum(CASE WHEN extra_images IS NOT NULL AND json_valid(extra_images) THEN json_array_length(extra_images) ELSE 0 END) AS extra,
    sum(CASE WHEN video_url LIKE 'http%' THEN 1 ELSE 0 END) AS videos
    FROM cases`).get();
  return { images: (r.main || 0) + (r.extra || 0), videos: r.videos || 0 };
}
