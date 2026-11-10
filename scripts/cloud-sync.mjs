import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeChanges,
  buildSyncBatch,
  collectChanges,
  installCloudSyncQueue,
} from '../lib/cloud-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.PLIB_DATA
  ? path.join(process.env.PLIB_DATA, 'library.db')
  : path.join(ROOT, 'data', 'library.db');
const CONFIG_PATH = process.env.PLIB_CLOUD_SYNC_CONFIG
  || path.join(os.homedir(), '.config', 'prompt-library', 'cloud-sync.json');
const BATCH_SIZE = Math.min(Math.max(Number(process.env.PLIB_CLOUD_SYNC_BATCH) || 50, 1), 100);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['site_url', 'sync_token', 'bypass_token']) {
    if (!cfg[key]) throw new Error(`云端同步配置缺少 ${key}`);
  }
  return cfg;
}

function curlPost(cfg, payloadFile) {
  // 凭据通过 curl 配置的 stdin 传入，不出现在进程参数或日志里。
  const q = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const curlConfig = [
    'silent',
    'show-error',
    'request = "POST"',
    `url = "${q(cfg.site_url.replace(/\/+$/, '') + '/api/sync')}"`,
    'header = "content-type: application/json"',
    `header = "x-plib-sync-token: ${q(cfg.sync_token)}"`,
    `header = "OAI-Sites-Authorization: Bearer ${q(cfg.bypass_token)}"`,
    `data-binary = "@${q(payloadFile)}"`,
    'max-time = 180',
    'write-out = "\\n%{http_code}"',
  ].join('\n');
  const out = execFileSync('/usr/bin/curl', ['--config', '-'], {
    input: curlConfig,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const cut = out.lastIndexOf('\n');
  const body = out.slice(0, cut);
  const status = Number(out.slice(cut + 1).trim());
  if (status < 200 || status >= 300) {
    const hint = status === 401
      ? '站点授权令牌已失效，需要重新生成同步令牌'
      : status === 403 ? '云端同步密钥不正确' : body.slice(0, 300);
    throw new Error(`云端同步失败（HTTP ${status}）：${hint}`);
  }
  return body ? JSON.parse(body) : {};
}

function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`本地数据库不存在：${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 60000;');
  installCloudSyncQueue(db);

  const cfg = loadConfig();
  if (!cfg) {
    console.log(`云端同步队列已安装；等待配置文件：${CONFIG_PATH}`);
    db.close();
    return;
  }

  let total = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-cloud-sync-'));
  try {
    for (;;) {
      const changes = collectChanges(db, BATCH_SIZE);
      if (!changes.length) break;
      const batch = buildSyncBatch(db, changes);
      const payloadFile = path.join(tmpDir, 'payload.json');
      fs.writeFileSync(payloadFile, JSON.stringify(batch), { mode: 0o600 });
      const result = curlPost(cfg, payloadFile);
      if (!result.ok || Number(result.received) !== batch.operations.length) {
        throw new Error('云端没有确认完整批次，队列保留等待重试');
      }
      acknowledgeChanges(db, changes);
      total += changes.length;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    db.close();
  }
  console.log(total ? `云端同步完成：${total} 项` : '云端同步：没有待处理变化');
}

try {
  main();
} catch (error) {
  console.error(`[${new Date().toISOString()}] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
