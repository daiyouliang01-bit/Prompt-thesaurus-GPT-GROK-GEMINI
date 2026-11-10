import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, DB_PATH } from './paths.mjs';
import { relToUrl } from './files.mjs';
import { tagFacets, facetsToTags, extractQueryFacets } from './facets.mjs';
import { installCloudSyncQueue } from './cloud-sync.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  template_md TEXT,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'user',
  source_case_id INTEGER,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  category_code TEXT,
  subtype TEXT,
  analysis TEXT,
  tags TEXT,
  raw_tags TEXT,
  facets TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  styles TEXT,
  scenes TEXT,
  original_category TEXT,
  image_path TEXT,
  image_url TEXT,
  source_url TEXT,
  note TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_cases_category ON cases(category_code);
CREATE INDEX IF NOT EXISTS ix_cases_source ON cases(source, source_case_id);
CREATE TABLE IF NOT EXISTS subcategories (
  code TEXT PRIMARY KEY,
  category_code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS docs (
  key TEXT PRIMARY KEY,
  title TEXT,
  content TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS drive_files (
  case_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  drive_id TEXT,
  mime TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (case_id, kind, idx)
);
CREATE INDEX IF NOT EXISTS ix_drive_status ON drive_files(status);
CREATE INDEX IF NOT EXISTS ix_drive_id ON drive_files(drive_id);
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT,
  image_path TEXT,
  category_code TEXT,
  analysis_json TEXT,
  references_json TEXT,
  result_json TEXT,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`;

let db;
export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  // 多个进程同时写（网页服务、命令行、导入脚本）时排队等待，而不是直接报 database is locked
  db.exec('PRAGMA busy_timeout = 60000;');
  db.exec(SCHEMA);
  migrate(db);
  // 只安装触发器，不把既有 2.7 万条数据塞进队列；从安装后发生的变化开始增量同步。
  installCloudSyncQueue(db);
  return db;
}

// 增量迁移：给旧库补字段（按模型分类、细分类、视频、多图、分类来源）
const EXTRA_COLUMNS = {
  model: 'TEXT',
  media_type: "TEXT DEFAULT 'image'",
  subcategory: 'TEXT',
  video_url: 'TEXT',
  extra_images: 'TEXT',
  classify_score: 'REAL',
  classify_source: 'TEXT',
  raw_tags: 'TEXT',
  facets: 'TEXT',
  needs_review: 'INTEGER NOT NULL DEFAULT 0',
  search_text: 'TEXT',
};
function migrate(d) {
  const cols = new Set(d.prepare('PRAGMA table_info(cases)').all().map(c => c.name));
  for (const [name, type] of Object.entries(EXTRA_COLUMNS)) {
    if (!cols.has(name)) d.exec(`ALTER TABLE cases ADD COLUMN ${name} ${type}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS ix_cases_model ON cases(model)');
  d.exec('CREATE INDEX IF NOT EXISTS ix_cases_subcategory ON cases(subcategory)');
  d.exec('CREATE INDEX IF NOT EXISTS ix_cases_review ON cases(needs_review)');
}

// ---------- categories & docs ----------
export function upsertCategory({ code, name, description = '', template_md = '', sort = 0 }) {
  getDb().prepare(`INSERT INTO categories (code, name, description, template_md, sort) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description,
    template_md = excluded.template_md, sort = excluded.sort`).run(code, name, description, template_md, sort);
}

export function listCategories() {
  return getDb().prepare(`SELECT c.code, c.name, c.description, c.sort,
    (SELECT count(*) FROM cases WHERE category_code = c.code) AS count
    FROM categories c ORDER BY c.sort`).all();
}

export function getCategory(code) {
  return getDb().prepare('SELECT * FROM categories WHERE code = ?').get(code) || null;
}

export function upsertDoc(key, title, content) {
  getDb().prepare(`INSERT INTO docs (key, title, content) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET title = excluded.title, content = excluded.content`).run(key, title, content);
}

export function getDoc(key) {
  return getDb().prepare('SELECT * FROM docs WHERE key = ?').get(key) || null;
}

// ---------- settings ----------
export function getSettings() {
  const out = {};
  for (const r of getDb().prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function setSettings(obj) {
  const st = getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    st.run(k, v === null ? '' : String(v));
  }
}

// ---------- cases ----------
const CASE_COLS = ['source', 'source_case_id', 'title', 'prompt', 'category_code', 'subtype', 'analysis', 'tags', 'raw_tags', 'facets', 'needs_review',
  'styles', 'scenes', 'original_category', 'image_path', 'image_url', 'source_url', 'note', 'favorite',
  'model', 'media_type', 'subcategory', 'video_url', 'extra_images', 'classify_score', 'classify_source'];

export function upsertSubcategory({ code, category_code, name, sort = 0 }) {
  getDb().prepare(`INSERT INTO subcategories (code, category_code, name, sort) VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET category_code = excluded.category_code, name = excluded.name, sort = excluded.sort`)
    .run(code, category_code, name, sort);
}

/** 细分类列表；计数跟随当前的模型/媒体/来源筛选 */
export function listSubcategories(category = '', { model = '', mediaType = '', source = '' } = {}) {
  const cond = [];
  const condParams = [];
  if (model) {
    if (model === '未标注') cond.push('model IS NULL');
    else { cond.push('model = ?'); condParams.push(model); }
  }
  if (mediaType) { cond.push("coalesce(media_type, 'image') = ?"); condParams.push(mediaType); }
  if (source) { cond.push('source = ?'); condParams.push(source); }
  const extra = cond.length ? ' AND ' + cond.join(' AND ') : '';
  const where = category ? 'WHERE s.category_code = ?' : '';
  return getDb().prepare(`SELECT s.code, s.category_code, s.name,
    (SELECT count(*) FROM cases WHERE subcategory = s.code${extra}) AS count
    FROM subcategories s ${where} ORDER BY s.sort`).all(...condParams, ...(category ? [category] : []));
}

/** 每个受控标签取值在库里的条目数，用于筛选面板显示数量 */
export function facetCounts() {
  const rows = getDb().prepare("SELECT facets FROM cases WHERE facets IS NOT NULL AND facets <> ''").all();
  const out = {};
  for (const r of rows) {
    let f;
    try { f = JSON.parse(r.facets); } catch { continue; }
    for (const codes of Object.values(f)) for (const c of codes || []) out[c] = (out[c] || 0) + 1;
  }
  return out;
}

export function listModels() {
  return getDb().prepare(`SELECT coalesce(model, '未标注') AS model, count(*) AS count FROM cases GROUP BY coalesce(model, '未标注') ORDER BY count DESC`).all();
}

function normalize(input, { requireCore }) {
  const out = {};
  for (const k of CASE_COLS) {
    if (!(k in input) || input[k] === undefined) continue;
    let v = input[k];
    if (Array.isArray(v)) v = v.map(s => String(s).trim()).filter(Boolean).join(', ');
    if (k === 'favorite') v = v ? 1 : 0;
    // 网站案例是数字编号；GitHub 精选用 "仓库:条目" 文本键
    else if (k === 'source_case_id') v = v === null || v === '' ? null : /^\d+$/.test(String(v)) ? Number(v) : String(v);
    else v = v === null ? null : String(v).trim();
    out[k] = v;
  }
  if (requireCore) {
    if (!out.title) throw Object.assign(new Error('标题不能为空'), { status: 400 });
    if (!out.prompt) throw Object.assign(new Error('提示词不能为空'), { status: 400 });
  }
  return out;
}

/** 一个案例要同步到云盘的媒体：主图（本地图优先）、附图、视频；source 用来判断云盘里的文件是否还是最新的 */
export function mediaSources(r) {
  const out = [];
  const isHttp = u => /^https?:\/\//i.test(u || '');
  const local = rel => (rel && !isHttp(rel) && fs.existsSync(path.join(DATA, rel)) ? `local:${rel}` : '');
  const main = local(r.image_path) || (isHttp(r.image_url) ? r.image_url : '');
  if (main) out.push({ kind: 'image', idx: 0, source: main });
  let extra = [];
  try { extra = JSON.parse(r.extra_images || '[]'); } catch { extra = []; }
  (Array.isArray(extra) ? extra : []).forEach((u, i) => {
    const s = isHttp(u) ? u : local(u);
    if (s) out.push({ kind: 'image', idx: i + 1, source: s });
  });
  if (isHttp(r.video_url)) out.push({ kind: 'video', idx: 0, source: r.video_url });
  return out;
}

let driveStmt;
function driveUrls(r) {
  driveStmt ||= getDb().prepare("SELECT kind, idx, drive_id, source FROM drive_files WHERE case_id = ? AND status = 'done'");
  const rows = driveStmt.all(Number(r.id));
  if (!rows.length) return () => '';
  const current = new Map(mediaSources(r).map(s => [`${s.kind}:${s.idx}`, s.source]));
  const map = new Map(rows.filter(x => current.get(`${x.kind}:${x.idx}`) === x.source).map(x => [`${x.kind}:${x.idx}`, x.drive_id]));
  return key => (map.has(key) ? `/media/drive/${encodeURIComponent(map.get(key))}` : '');
}

export function toCase(r, { full = true } = {}) {
  if (!r) return null;
  const c = { ...r, favorite: !!r.favorite };
  const hasLocal = r.image_path && fs.existsSync(path.join(DATA, r.image_path));
  // 云盘里有就优先用云盘，没有再用本地文件或原链接
  const drive = driveUrls(r);
  c.image = drive('image:0') || (hasLocal ? relToUrl(r.image_path) : (r.image_url || ''));
  c.in_drive = !!drive('image:0');
  c.video = drive('video:0') || r.video_url || '';
  if (full) {
    let extra = [];
    try { extra = JSON.parse(r.extra_images || '[]'); } catch { extra = []; }
    c.images = extra.map((rel, i) => drive(`image:${i + 1}`) || (/^https?:/.test(rel) ? rel : relToUrl(rel)));
    if (r.subcategory) c.subcategory_name = getDb().prepare('SELECT name FROM subcategories WHERE code = ?').get(r.subcategory)?.name || '';
  }
  if (!full) {
    // 列表里不带完整图片地址，但要让卡片知道有几张图
    let extra = [];
    try { extra = JSON.parse(r.extra_images || '[]'); } catch { extra = []; }
    c.image_count = (c.image ? 1 : 0) + extra.length;
    c.prompt_snippet = (r.prompt || '').replace(/\s+/g, ' ').slice(0, 160);
    delete c.prompt;
    delete c.analysis;
  }
  delete c._score;
  return c;
}

export function getCaseRow(id) {
  return getDb().prepare('SELECT * FROM cases WHERE id = ?').get(Number(id)) || null;
}

export function getCase(id) {
  return toCase(getCaseRow(id));
}

const USER_ID_START = 1000;

/** 网站案例用原编号作为 id；自建案例从 1001 开始自增 */
export function ensureUserIdSequence() {
  const d = getDb();
  const cur = d.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'cases'").get();
  if (!cur) d.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('cases', ?)").run(USER_ID_START);
  else if (cur.seq < USER_ID_START) d.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cases'").run(USER_ID_START);
}

/**
 * 统一在入库口算受控多维标签：tags 列存受控标签名（供筛选），来源方自己写的标签原样留在 raw_tags
 * base 是库里已有的行（更新时用），input 里没给的字段从它取
 */
function withFacets(c, base = {}) {
  const touched = ['title', 'prompt', 'tags', 'analysis'].some(k => k in c);
  if (!touched) return c;
  // AI 精标或人工归类过的行，规则不许再覆盖它们的标签和维度（每日导入会更新正文，不能顺手把标注冲掉）
  // 来源方自己的标签仍然照常更新到 raw_tags
  if (['ai', 'manual'].includes(base.classify_source) && !('facets' in c)) {
    if ('tags' in c) { c.raw_tags = c.tags; delete c.tags; }
    return c;
  }
  const incoming = 'tags' in c ? c.tags : null;
  if (incoming !== null && incoming !== undefined) c.raw_tags = incoming;
  const src = {
    title: c.title ?? base.title ?? '',
    prompt: c.prompt ?? base.prompt ?? '',
    analysis: c.analysis ?? base.analysis ?? '',
    tags: c.raw_tags ?? base.raw_tags ?? base.tags ?? '',
  };
  const { facets } = tagFacets(src);
  c.facets = JSON.stringify(facets);
  const names = facetsToTags(facets);
  if (names.length) c.tags = names.join(',');
  return c;
}

export function createCase(input, { id } = {}) {
  const c = withFacets(normalize({ source: 'user', ...input }, { requireCore: true }));
  if (id !== undefined) c.id = Number(id);
  else ensureUserIdSequence();
  const cols = Object.keys(c);
  const info = getDb().prepare(`INSERT INTO cases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(k => c[k]));
  return getCase(Number(info.lastInsertRowid));
}

export function updateCase(id, input) {
  const c = withFacets(normalize(input, { requireCore: false }), getCaseRow(id) || {});
  if ('title' in c && !c.title) throw Object.assign(new Error('标题不能为空'), { status: 400 });
  if ('prompt' in c && !c.prompt) throw Object.assign(new Error('提示词不能为空'), { status: 400 });
  const cols = Object.keys(c);
  if (!getCaseRow(id)) throw Object.assign(new Error('案例不存在'), { status: 404 });
  if (cols.length) {
    getDb().prepare(`UPDATE cases SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now', 'localtime') WHERE id = ?`)
      .run(...cols.map(k => c[k]), Number(id));
  }
  return getCase(id);
}

export function deleteCase(id) {
  const row = getCaseRow(id);
  if (!row) throw Object.assign(new Error('案例不存在'), { status: 404 });
  if (row.image_path && row.image_path.startsWith('images/user/')) {
    fs.rmSync(path.join(DATA, row.image_path), { force: true });
  }
  getDb().prepare('DELETE FROM cases WHERE id = ?').run(Number(id));
}

const normPrompt = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 400);

/** 查找库里是否已有相同的提示词（忽略大小写、标点和空白；多语言分段的也逐段比较） */
export function findDuplicatePrompt(prompt) {
  const key = normPrompt(prompt);
  if (key.length < 20) return null;
  for (const r of getDb().prepare('SELECT id, prompt FROM cases').all()) {
    if (String(r.prompt).split(/【[^】\n]{1,20}】\n/).some(p => normPrompt(p) === key)) return getCase(r.id);
  }
  return null;
}

export function splitTerms(q) {
  return String(q || '').split(/[\s,，、;；|]+/).map(s => s.trim()).filter(Boolean).slice(0, 16);
}

function countIn(hay, term) {
  if (!hay) return 0;
  hay = hay.toLowerCase();
  let n = 0;
  for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + term.length)) n++;
  return n;
}

function termScore(r, terms) {
  let s = 0;
  for (const raw of terms) {
    const t = raw.toLowerCase();
    s += Math.min(countIn(r.title, t), 3) * 6
      + Math.min(countIn(r.subtype, t), 3) * 5
      + Math.min(countIn(r.tags, t), 3) * 3
      + Math.min(countIn(r.note, t), 3) * 3
      + Math.min(countIn(r.analysis, t), 5) * 2
      + Math.min(countIn(r.prompt, t), 8);
    if (String(r.id) === t || String(r.source_case_id) === t) s += 50;
  }
  return s;
}

export function searchCases({ q = '', category = '', subcategory = '', model = '', mediaType = '', source = '', favorite = false, facets = {}, review = false, semantic = null, tier = 0, limit = 48, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (category) { where.push('category_code = ?'); params.push(category); }
  if (subcategory) { where.push('subcategory = ?'); params.push(subcategory); }
  if (model) {
    if (model === '未标注') where.push('model IS NULL');
    else { where.push('model = ?'); params.push(model); }
  }
  if (mediaType) { where.push("coalesce(media_type, 'image') = ?"); params.push(mediaType); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (favorite) where.push('favorite = 1');
  if (review) where.push('needs_review = 1');
  if (tier) { where.push('quality_tier <= ?'); params.push(Number(tier)); }
  // 受控标签筛选：facets = { subject: 'SB-person', light: ['LT-night','LT-neon'] }，同维度取或，跨维度取与
  for (const [key, val] of Object.entries(facets || {})) {
    const codes = (Array.isArray(val) ? val : [val]).map(String).filter(Boolean);
    if (!codes.length) continue;
    where.push(`(${codes.map(() => "instr(coalesce(facets, ''), ?) > 0").join(' OR ')})`);
    params.push(...codes.map(c => `"${c}"`));
  }
  const terms = splitTerms(q);
  // semantic 是 Map(case_id → 余弦相似度)，由上层先算好传进来
  const hay = "lower(title || ' ' || prompt || ' ' || coalesce(analysis, '') || ' ' || coalesce(tags, '') || ' ' || coalesce(raw_tags, '') || ' ' || coalesce(search_text, '') || ' ' || coalesce(subtype, '') || ' ' || coalesce(note, '') || ' ' || id || ' ' || coalesce(source_case_id, ''))";
  // 语义模式下不按字面过滤（"按意思搜"的重点就是命中说法不同的条目），只在语义候选里排序
  if (semantic && semantic.size) {
    const ids = [...semantic.keys()];
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else {
    for (const t of terms) { where.push(`instr(${hay}, ?) > 0`); params.push(t.toLowerCase()); }
  }
  const rows = getDb().prepare(`SELECT * FROM cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(...params);
  const queryFacets = q ? extractQueryFacets(q) : {};
  const queryCodes = Object.values(queryFacets).flat();
  if (semantic && semantic.size) {
    // 语义相似度为主，词面命中、受控标签意图命中与黄金质量作为加成
    for (const r of rows) {
      const sim = semantic.get(r.id) || 0;
      r._sim = sim;
      const tierBoost = (r.quality_tier === 1 ? 6 : r.quality_tier === 2 ? 2 : -5);
      let facetHit = 0;
      if (queryCodes.length && r.facets) {
        for (const c of queryCodes) if (r.facets.includes(`"${c}"`)) facetHit += 3;
      }
      r._score = sim * 100 + (terms.length ? Math.min(termScore(r, terms), 40) * 0.25 : 0) + (r.favorite ? 3 : 0) + tierBoost + Math.min(facetHit, 15);
    }
    rows.sort((a, b) => b._score - a._score || b.id - a.id);
  } else if (terms.length) {
    for (const r of rows) {
      const tierBoost = (r.quality_tier === 1 ? 3 : r.quality_tier === 2 ? 0 : -3);
      let facetHit = 0;
      if (queryCodes.length && r.facets) {
        for (const c of queryCodes) if (r.facets.includes(`"${c}"`)) facetHit += 2.5;
      }
      r._score = termScore(r, terms) + tierBoost + Math.min(facetHit, 12);
    }
    rows.sort((a, b) => b._score - a._score || b.favorite - a.favorite || b.id - a.id);
  } else {
    const rank = s => (s === 'user' ? 2 : s === 'canghe' ? 1 : 0);
    rows.sort((a, b) => (b.quality_tier === 1 ? 2 : 0) - (a.quality_tier === 1 ? 2 : 0) || rank(b.source) - rank(a.source) || b.favorite - a.favorite
      || (a.source === 'user' ? b.id - a.id : (b.source_case_id || 0) - (a.source_case_id || 0)));
  }
  return { total: rows.length, items: rows.slice(offset, offset + limit).map(r => toCase(r, { full: false })) };
}

/** 生成提示词时检索参考案例：关键词得分 + 类别加权 + 收藏/自建加权 + 黄金标杆(Tier 1)优先，按提示词去重 */
export function retrieveReferences({ keywords = [], category = '', secondary = [], limit = 6, pinnedIds = [], facets = null, onlyTier1 = true } = {}) {
  const pinned = pinnedIds.map(id => getCaseRow(id)).filter(Boolean);
  const pinnedSet = new Set(pinned.map(r => r.id));
  const terms = [...new Set(keywords.flatMap(splitTerms))];
  let querySql = 'SELECT * FROM cases';
  if (onlyTier1) {
    querySql += ' WHERE quality_tier = 1 OR favorite = 1 OR source = \'user\'';
  }
  const rows = getDb().prepare(querySql).all().filter(r => !pinnedSet.has(r.id));
  // 需求里已经判出维度时，同维度的案例更值得参考（同是夜景街头人像，比只是词面相近的有用得多）
  const wanted = [];
  for (const [key, codes] of Object.entries(facets || {})) {
    for (const c of (Array.isArray(codes) ? codes : [codes])) if (c) wanted.push({ key, code: c });
  }
  const scored = rows.map(r => {
    const ts = terms.length ? termScore(r, terms) : 0;
    let s = ts + Math.min((r.prompt || '').length / 800, 3);
    if (wanted.length && r.facets) {
      let hit = 0;
      for (const w of wanted) if (r.facets.includes(`"${w.code}"`)) hit += w.key === 'subject' ? 5 : 2.5;
      s += Math.min(hit, 18);
    }
    if (category && r.category_code === category) s += 8;
    else if (secondary.includes(r.category_code)) s += 3;
    if (r.favorite) s += 4;
    if (r.source === 'user') s += 3;
    if (r.quality_tier === 1) s += 5;
    return { r, s, ts };
  }).sort((a, b) => b.s - a.s);

  const seen = new Set(pinned.map(r => r.prompt.replace(/\s+/g, '').slice(0, 300)));
  const out = pinned.map(r => ({ ...toCase(r), score: null, pinned: true }));
  for (const x of scored) {
    if (out.length >= limit + pinned.length) break;
    if (x.ts === 0 && x.r.category_code !== category && !(wanted.length && x.s > 12)) continue;
    const key = x.r.prompt.replace(/\s+/g, '').slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...toCase(x.r), score: Math.round(x.s * 10) / 10 });
  }
  return out;
}


export function stats() {
  const d = getDb();
  const one = sql => d.prepare(sql).get().n;
  let masters = [];
  try {
    masters = d.prepare('SELECT id, name, category, region, era, description, specs_json, prompt_snippet FROM aesthetic_masters ORDER BY sort_order ASC').all()
      .map(m => ({ ...m, specs: JSON.parse(m.specs_json || '{}') }));
  } catch {}
  return {
    total: one('SELECT count(*) AS n FROM cases'),
    user: one("SELECT count(*) AS n FROM cases WHERE source = 'user'"),
    favorite: one('SELECT count(*) AS n FROM cases WHERE favorite = 1'),
    generations: one('SELECT count(*) AS n FROM generations'),
    masters,
  };
}

// ---------- generations ----------
export function saveGeneration({ goal, image_path, category_code, analysis, references, result, model }) {
  const info = getDb().prepare(`INSERT INTO generations (goal, image_path, category_code, analysis_json, references_json, result_json, model)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(goal || '', image_path || null, category_code || null,
    JSON.stringify(analysis || {}), JSON.stringify(references || []), JSON.stringify(result || {}), model || '');
  return Number(info.lastInsertRowid);
}

function toGeneration(r) {
  if (!r) return null;
  const cat = r.category_code ? getCategory(r.category_code) : null;
  const refs = JSON.parse(r.references_json || '[]');
  const refImg = refs.map(x => x.image || x.image_url).filter(Boolean)[0] || '';
  return {
    id: r.id, goal: r.goal, model: r.model, created_at: r.created_at,
    image: r.image_path ? relToUrl(r.image_path) : '',
    reference_image: refImg,
    category: cat ? { code: cat.code, name: cat.name } : { code: r.category_code, name: '' },
    analysis: JSON.parse(r.analysis_json || '{}'),
    references: refs,
    result: JSON.parse(r.result_json || '{}'),
  };
}

export function getGeneration(id) {
  return toGeneration(getDb().prepare('SELECT * FROM generations WHERE id = ?').get(Number(id)));
}

export function listGenerations(limit = 30) {
  return getDb().prepare('SELECT * FROM generations ORDER BY id DESC LIMIT ?').all(Number(limit)).map(r => {
    const g = toGeneration(r);
    const refImg = (g.references || []).map(x => x.image || x.image_url).filter(Boolean)[0] || '';
    return {
      id: g.id, goal: g.goal, image: g.image, reference_image: refImg,
      category: g.category, created_at: g.created_at,
      prompt_snippet: (g.result.prompt || '').replace(/\s+/g, ' ').slice(0, 100)
    };
  });
}
