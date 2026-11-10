// AI 精标：让模型按受控词表重新给案例定类别和多维标签
// 结果写进 ai_labels 表，不直接覆盖现有分类；确认效果后再用 --apply 落库
// 用法：node scripts/ai-tag.mjs --limit 500 [--concurrency 4] [--review-first] [--model xxx] [--apply]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatJson } from '../lib/llm.mjs';
import { taxonomy, subcategoryName } from '../lib/classify.mjs';
import { facetDefs, facetValueName } from '../lib/facets.mjs';
import { DB_PATH } from '../lib/paths.mjs';

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const has = name => process.argv.includes(`--${name}`);
const LIMIT = Number(arg('limit', 500));
const CONCURRENCY = Number(arg('concurrency', 4));
const RPM = Number(arg('rpm', 0));            // 每分钟请求上限（OpenRouter 免费模型是 20）
// --shard 1/2 表示两个进程并行，本进程只处理 id 除以 2 余 0 的那一半，互不重复
const SHARD = (() => {
  const v = arg('shard', '');
  const m = /^(\d+)\/(\d+)$/.exec(String(v || ''));
  return m ? { k: Number(m[1]) - 1, n: Number(m[2]) } : null;
})();
const APPLY = has('apply');
const REVIEW_FIRST = has('review-first');
// --source user 只处理某个来源的条目（自己加的条目优先标，它们最常用）
const SOURCE = arg('source', '');
// --vision 让模型连配图一起看（版式图、穿搭图这类光看文字判不准），需要视觉模型
const VISION = has('vision');
// --search-text：顺带产出一段"语义展开"检索文本，让按意思搜能命中说法不同的条目
const SEARCH_TEXT = has('search-text');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 60000;');
db.exec(`CREATE TABLE IF NOT EXISTS ai_labels (
  case_id INTEGER PRIMARY KEY,
  category TEXT, subcategory TEXT, facets TEXT, tags TEXT, search_text TEXT,
  confidence REAL, reason TEXT, model TEXT, applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

// ai_labels 是老表，建表语句里新增的列要单独补
{
  const lcols = db.prepare('pragma table_info(ai_labels)').all().map(c => c.name);
  if (!lcols.includes('search_text')) db.exec('ALTER TABLE ai_labels ADD COLUMN search_text TEXT');
}

const setting = k => db.prepare('select value from settings where key=?').get(k)?.value || '';
// 默认用网页设置里的接口；--base-url/--api-key 或设置里的 tagger_* 可以单独指定一个便宜/免费的接口（例如 OpenRouter）
const useTagger = has('tagger') || !!arg('base-url', null);
const llm = {
  baseUrl: arg('base-url', null) || (useTagger && setting('tagger_base_url')) || setting('llm_base_url'),
  apiKey: arg('api-key', null) || (useTagger && setting('tagger_api_key')) || setting('llm_api_key'),
  model: arg('model', null) || (useTagger && setting('tagger_model')) || setting('llm_model'),
};
if (!llm.baseUrl || !llm.apiKey) { console.error('还没有配置模型接口，请先在网页「设置」里填写'); process.exit(1); }
// 多个模型用逗号分隔，前一个失败就换下一个（免费模型经常限流或不按格式输出）
const MODELS = String(llm.model).split(',').map(m => m.trim()).filter(Boolean);
const FALLBACK = arg('fallback', null) || (useTagger ? '' : setting('llm_fallback_model'));
const CHAIN = [...new Set([...MODELS, ...(FALLBACK ? [FALLBACK] : [])])];

// 免费接口限速：保证每分钟不超过 RPM 次
const marks = [];
async function rateGate() {
  if (!RPM) return;
  for (;;) {
    const now = Date.now();
    while (marks.length && now - marks[0] > 60000) marks.shift();
    if (marks.length < RPM) { marks.push(now); return; }
    await new Promise(r => setTimeout(r, 60000 - (now - marks[0]) + 50));
  }
}

// ---------- 词表 ----------
const catList = taxonomy().categories.map(c =>
  `${c.code} ${c.name}${c.media === 'video' ? '（视频）' : ''}：${c.subs.map(s => `${s.code} ${s.name}`).join('；')}`).join('\n');
const facetList = facetDefs().map(f =>
  `${f.key}（${f.name}${f.multi ? '，可多选，最多3个' : '，只能选1个'}）：${f.values.map(v => `${v.code} ${v.name}`).join('；')}`).join('\n');

// 语义展开：把画面在讲什么、情绪、动作、同义说法都摊成词，供"按意思搜"命中
const SEARCH_EXTRA = `

另外再输出一个 search 字段：一段 60-120 字的中文检索文本，把这条提示词最终画面的内容摊开写成便于搜索的说法——谁在做什么、在哪、什么情绪氛围、什么视觉特征，并补上用户可能会用的同义说法（例如"孤独感"也写上"落寞、一个人、空旷"）。只写画面相关的词，不要写"提示词""生成"这类元词，不要重复标题原话。
完整输出格式变为：
{"category":"...","subcategory":"...","facets":{...},"confidence":0.85,"reason":"一句话理由","search":"检索文本"}`;

const SYSTEM = `你是提示词库的分类编辑。读一条 AI 绘图/视频提示词，判断它属于哪个类别，并按受控词表打多维标签。

类别（三层：大类 → 细分类）：
${catList}

多维标签词表（只能用下面出现过的代码，不要自创）：
${facetList}

判断原则：
1. 看的是"这条提示词最终会生成什么画面"，不是提示词里提到过什么词。画面里有人时主体就是人，风景、美食、道具只是他所处的环境。
2. 视频类提示词（有镜头运动、时长、分镜描述）用 C16 的细分类。
3. 拿不准的维度就不填，不要硬凑；confidence 反映你的把握（0-1）。
4. 服装穿搭类要分两种：只要配图里**出现真人穿着这套衣服**（哪怕只有其中一张图是真人），就按人像归类（C01 下对应的细分类，主体填真人人像）；只有当全部配图都是平铺单品、版式标注图、没有任何真人出镜时，才归到 C08-03 商品目录/穿搭展示。
5. 只输出 JSON，不要解释文字。

输出格式：
{"category":"C01","subcategory":"C01-03","facets":{"subject":"SB-person","genre":["GN-urban"],"style":["ST-photoreal"],"shot":["SH-cu"],"light":["LT-night"],"color":["CL-cool"],"scene":["SC-street"],"mood":["MD-lonely"]},"confidence":0.85,"reason":"一句话理由"}${SEARCH_TEXT ? SEARCH_EXTRA : ''}`;

const VALID_CATS = new Map(taxonomy().categories.map(c => [c.code, new Set(c.subs.map(s => s.code))]));
const VALID_FACETS = new Map(facetDefs().map(f => [f.key, { multi: !!f.multi, codes: new Set(f.values.map(v => v.code)) }]));

function clean(out) {
  const cat = VALID_CATS.has(out.category) ? out.category : null;
  const sub = cat && VALID_CATS.get(cat).has(out.subcategory) ? out.subcategory : null;
  const facets = {};
  for (const [key, raw] of Object.entries(out.facets || {})) {
    const def = VALID_FACETS.get(key);
    if (!def) continue;
    const codes = (Array.isArray(raw) ? raw : [raw]).filter(c => def.codes.has(c));
    if (codes.length) facets[key] = def.multi ? codes.slice(0, 3) : [codes[0]];
  }
  return { cat, sub, facets, confidence: Number(out.confidence) || null, reason: String(out.reason || '').slice(0, 200), search: String(out.search || '').slice(0, 600) };
}

// ---------- 选样本 ----------
// --redo-model a,b 表示只重标之前由这些模型标过的条目（用于统一标注口径）
const REDO = String(arg('redo-model', '')).split(',').map(x => x.trim()).filter(Boolean);
const done = REDO.length
  ? new Set()
  : new Set(db.prepare('select case_id from ai_labels').all().map(r => r.case_id));
const redoIds = REDO.length
  ? new Set(db.prepare(`select case_id from ai_labels where model in (${REDO.map(() => '?').join(',')})`).all(...REDO).map(r => r.case_id))
  : null;
const pool = db.prepare(`select id,title,prompt,raw_tags,tags,category_code,subcategory,media_type,facets,needs_review,source,image_url,extra_images
  from cases ${[REVIEW_FIRST ? 'needs_review = 1' : '', SOURCE ? `source = '${String(SOURCE).replace(/'/g, "''")}'` : ''].filter(Boolean).length ? 'where ' + [REVIEW_FIRST ? 'needs_review = 1' : '', SOURCE ? `source = '${String(SOURCE).replace(/'/g, "''")}'` : ''].filter(Boolean).join(' and ') : ''}`).all()
  .filter(r => (redoIds ? redoIds.has(r.id) : !done.has(r.id)) && (!SHARD || r.id % SHARD.n === SHARD.k));
// 按来源和大类分层抽样，别让某一类占满
const buckets = new Map();
for (const r of pool) {
  const k = `${r.source}|${r.category_code || '无'}`;
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(r);
}
for (const arr of buckets.values()) arr.sort(() => Math.random() - 0.5);
const picked = [];
const keys = [...buckets.keys()];
for (let round = 0; picked.length < LIMIT && keys.some(k => buckets.get(k).length); round++) {
  for (const k of keys) {
    const arr = buckets.get(k);
    if (arr.length && picked.length < LIMIT) picked.push(arr.pop());
  }
}
console.log(`抽样 ${picked.length} 条（覆盖 ${new Set(picked.map(p => p.source + p.category_code)).size} 个来源×类别组合），模型 ${CHAIN.join(' → ')}${RPM ? `，限速 ${RPM} 次/分钟` : ''}${SHARD ? `，第 ${SHARD.k + 1}/${SHARD.n} 片` : ''}`);

const save = db.prepare(`INSERT INTO ai_labels (case_id,category,subcategory,facets,tags,confidence,reason,model,search_text)
  VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET search_text=excluded.search_text,
  category=excluded.category, subcategory=excluded.subcategory, facets=excluded.facets, tags=excluded.tags,
  confidence=excluded.confidence, reason=excluded.reason, model=excluded.model, applied=0, created_at=datetime('now','localtime')`);

let ok = 0, failed = 0, catDiff = 0, quotaOut = false;
const started = Date.now();

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** 下载配图并转成 data URL；失败就当没有图 */
async function imagesOf(r) {
  if (!VISION) return [];
  const urls = [r.image_url, ...(() => { try { return JSON.parse(r.extra_images || '[]'); } catch { return []; } })()]
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 3);
  const out = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 6 * 1024 * 1024) continue;
      const ext = (u.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      out.push(`data:${MIME[ext] || 'image/jpeg'};base64,${buf.toString('base64')}`);
    } catch { /* 拿不到图就算了 */ }
  }
  return out;
}

async function label(r) {
  const body = String(r.prompt || '').slice(0, 2000);
  const user = `标题：${r.title}\n来源标签：${r.raw_tags || r.tags || '（无）'}\n类型：${r.media_type === 'video' ? '视频' : '图片'}\n提示词：\n${body}`;
  const pics = await imagesOf(r);
  const content = pics.length
    ? [{ type: 'text', text: `${user}\n\n下面是这条提示词的成品图，以画面为准判断类别：` },
       ...pics.map(u => ({ type: 'image_url', image_url: { url: u } }))]
    : user;
  for (const model of CHAIN) {
    try {
      await rateGate();
      const out = await chatJson({ ...llm, model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }], temperature: 0, maxTokens: 0, timeoutMs: 180000 });
      const c = clean(out);
      if (!c.cat) throw new Error('模型没给出合法类别');
      const names = Object.values(c.facets).flat().map(facetValueName).filter(Boolean);
      save.run(r.id, c.cat, c.sub, JSON.stringify(c.facets), names.join(','), c.confidence, c.reason, model, c.search || null);
      ok++;
      if (c.cat !== r.category_code) catDiff++;
      return;
    } catch (e) {
      const msg = e.message || '';
      // 免费额度用完就整批停下，别继续空转
      if (/free-model|per day|daily limit|402/i.test(msg)) { quotaOut = true; console.error(`  额度用完：${msg.slice(0, 100)}`); return; }
      if (/429|rate limit/i.test(msg)) { await new Promise(r => setTimeout(r, 20000)); }
      if (model === CHAIN[CHAIN.length - 1]) { failed++; console.error(`  #${r.id} 失败：${msg.slice(0, 80)}`); }
    }
  }
}

let idx = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < picked.length && !quotaOut) {
    const r = picked[idx++];
    await label(r);
    const n = ok + failed;
    if (n % 25 === 0) console.log(`  ${n}/${picked.length}　成功 ${ok}　失败 ${failed}　与规则分类不同 ${catDiff}　用时 ${Math.round((Date.now() - started) / 60000)} 分钟`);
  }
}));

if (quotaOut) console.log('\n（因额度用完提前结束，下次运行会接着没标过的条目继续）');
console.log(`\n完成：成功 ${ok}，失败 ${failed}，其中大类与规则分类不同 ${catDiff} 条（${(catDiff / Math.max(ok, 1) * 100).toFixed(1)}%）`);
console.log('结果存在 ai_labels 表，用 node scripts/dev/compare-ai.mjs 查看对比');

if (APPLY) {
  const rows = db.prepare('select * from ai_labels where applied = 0').all()
    .filter(a => !SHARD || a.case_id % SHARD.n === SHARD.k);
  db.exec('BEGIN');
  const upd = db.prepare("update cases set category_code=?, subcategory=?, facets=?, tags=?, search_text=coalesce(?, search_text), classify_source='ai', needs_review=0 where id=? and classify_source<>'manual'");
  for (const a of rows) { upd.run(a.category, a.subcategory, a.facets, a.tags, a.search_text || null, a.case_id); }
  for (const a of rows) db.prepare('update ai_labels set applied = 1 where case_id = ?').run(a.case_id);
  db.exec('COMMIT');
  console.log(`已落库 ${rows.length} 条`);
}
