// 本地向量检索：用 ollama 跑 bge-m3 算嵌入，向量存在库里
// 模型默认只在内存里留 60 秒（keep_alive），不搜的时候不占内存
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.mjs';

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
export const EMBED_MODEL = process.env.PLIB_EMBED_MODEL || 'bge-m3';
const KEEP_ALIVE = process.env.PLIB_EMBED_KEEP_ALIVE || '60s';

let db;
function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 60000;');
  // search_text 由 AI 精标产出，这里可能先于 db.mjs 的迁移运行，补一次
  const cols = db.prepare('pragma table_info(cases)').all().map(c => c.name);
  if (!cols.includes('search_text')) db.exec('ALTER TABLE cases ADD COLUMN search_text TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    case_id INTEGER PRIMARY KEY,
    vec BLOB NOT NULL,
    dim INTEGER NOT NULL,
    model TEXT NOT NULL,
    src_hash TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  return db;
}

/** ollama 在不在 */
export async function available() {
  try {
    const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { ok: false, reason: `ollama 返回 ${r.status}` };
    const models = (await r.json()).models || [];
    const has = models.some(m => (m.name || '').split(':')[0] === EMBED_MODEL.split(':')[0]);
    return has ? { ok: true, models: models.map(m => m.name) }
      : { ok: false, reason: `ollama 在运行，但还没有 ${EMBED_MODEL}，请先执行 ollama pull ${EMBED_MODEL}` };
  } catch {
    return { ok: false, reason: 'ollama 没在运行（启动：brew services start ollama）' };
  }
}

/** 批量取嵌入向量；keepAlive 传 '0' 表示用完立刻卸载模型 */
export async function embed(texts, { keepAlive = KEEP_ALIVE, timeoutMs = 120000 } = {}) {
  const input = Array.isArray(texts) ? texts : [texts];
  const r = await fetch(`${HOST}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input, keep_alive: keepAlive, truncate: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`ollama 嵌入失败 ${r.status}：${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const out = (j.embeddings || []).map(v => normalize(Float32Array.from(v)));
  if (out.length !== input.length) throw new Error(`ollama 返回了 ${out.length} 条向量，期望 ${input.length} 条`);
  return out;
}

/** 归一化后点积就是余弦相似度 */
function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** 参与嵌入的文本：标题 + 受控标签 + 语义展开 + 提示词正文（截断） */
export function embedSource(c) {
  return [
    c.title,
    c.tags || '',
    c.search_text || '',
    c.analysis || '',
    String(c.prompt || '').slice(0, 1200),
  ].filter(Boolean).join('\n');
}

const hash = s => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
};

export function saveVec(caseId, vec, src) {
  getDb().prepare(`INSERT INTO embeddings (case_id, vec, dim, model, src_hash, updated_at)
    VALUES (?,?,?,?,?,datetime('now','localtime'))
    ON CONFLICT(case_id) DO UPDATE SET vec=excluded.vec, dim=excluded.dim, model=excluded.model,
      src_hash=excluded.src_hash, updated_at=excluded.updated_at`)
    .run(caseId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), vec.length, EMBED_MODEL, hash(src));
}

/** 哪些条目还需要算（新增的，或文本变了的） */
export function pendingCases(limit = 0) {
  const rows = getDb().prepare(`select c.id, c.title, c.tags, c.search_text, c.analysis, c.prompt, e.src_hash
    from cases c left join embeddings e on e.case_id = c.id and e.model = ?`).all(EMBED_MODEL);
  const out = [];
  for (const r of rows) {
    const src = embedSource(r);
    if (r.src_hash !== hash(src)) out.push({ id: r.id, src });
    if (limit && out.length >= limit) break;
  }
  return out;
}

let cache = null;
/** 把全部向量读进内存（约 1024 维 × 4 字节 × 条数，2.7 万条约 110MB） */
function vectors() {
  const stamp = getDb().prepare('select count(*) n, max(updated_at) t from embeddings where model = ?').get(EMBED_MODEL);
  const key = `${stamp.n}|${stamp.t}`;
  if (cache && cache.key === key) return cache;
  const rows = getDb().prepare('select case_id, vec, dim from embeddings where model = ?').all(EMBED_MODEL);
  const ids = new Int32Array(rows.length);
  const dim = rows[0]?.dim || 0;
  const mat = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => {
    ids[i] = r.case_id;
    mat.set(new Float32Array(r.vec.buffer, r.vec.byteOffset, dim), i * dim);
  });
  cache = { key, ids, mat, dim, n: rows.length };
  return cache;
}

/** 语义检索：返回 [{id, score}]，score 是余弦相似度 */
export async function semanticSearch(query, { limit = 200 } = {}) {
  const [qv] = await embed(query);
  const { ids, mat, dim, n } = vectors();
  if (!n || dim !== qv.length) return [];
  const scored = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) s += mat[off + d] * qv[d];
    scored.push({ id: ids[i], score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function embedStats() {
  const d = getDb();
  return {
    model: EMBED_MODEL,
    done: d.prepare('select count(*) n from embeddings where model = ?').get(EMBED_MODEL).n,
    total: d.prepare('select count(*) n from cases').get().n,
  };
}
