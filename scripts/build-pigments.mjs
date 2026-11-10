#!/usr/bin/env node
// ==========================================================================
// 调色盘词典生成器：把「本库自身的资料」转化成可视化标签词典
//
// 数据来源（全部取自本项目自己的数据，不引入任何外部词典）：
//   1) seed/facets.json —— 我们自己的 16 维受控词表（分类骨架：主体/题材/风格/光线…）
//   2) data/library.db 的 cases.facets —— 每条案例的受控归属，用来算每个取值的真实案例量
//   3) data/library.db 的 cases.raw_tags —— 本库 2.7 万条语料沉淀的自由标签，
//      用 lift（该取值下的出现率 ÷ 全库出现率）挖出每个取值下最有辨识度的细标签
//   4) 细标签缺中文或缺英文时，用设置里的本地模型批量补齐（结果缓存到 seed/tag-glossary.json）
//
// 产物：public/pigments.js（window.PIGMENT_DICTIONARY）
//
// 用法：
//   node scripts/build-pigments.mjs              # 挖取 + 生成（缺词条先用占位，不调模型）
//   node scripts/build-pigments.mjs --translate  # 顺带把缺的双语标签补齐（带缓存，可反复跑）
//   node scripts/build-pigments.mjs --top=16 --min=3
// ==========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, SEED, PUBLIC } from '../lib/paths.mjs';

const args = new Map(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const TOP = Number(args.get('top')) || 12;      // 每个取值最多挖多少条细标签
const MIN_N = Number(args.get('min')) || 3;     // 细标签至少要在这个取值下出现几次
const DO_TRANSLATE = args.has('translate');

const GLOSSARY_PATH = path.join(SEED, 'tag-glossary.json');
const OUT_PATH = path.join(PUBLIC, 'pigments.js');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;
const ASCII = /^[\x20-\x7e]+$/;

const seed = JSON.parse(fs.readFileSync(path.join(SEED, 'facets.json'), 'utf8'));
const glossary = fs.existsSync(GLOSSARY_PATH) ? JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8')) : {};

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const TOTAL_CASES = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;

// ---------- 1. 语料自由标签：全库词频 + 每条案例的标签集 ----------
const corpusFreq = new Map();
const caseTags = new Map();
for (const { id, raw_tags } of db.prepare("SELECT id, raw_tags FROM cases WHERE raw_tags IS NOT NULL AND raw_tags != ''").all()) {
  const tags = new Set(String(raw_tags).split(',').map(t => t.trim()).filter(t => t && t.length <= 24));
  caseTags.set(id, tags);
  for (const t of tags) corpusFreq.set(t, (corpusFreq.get(t) || 0) + 1);
}

// 维度关键词表（取自我们自己的 seed/facets.json），用来判断一条语料标签该归到哪个维度
const dimKws = new Map();
for (const dim of seed.facets) {
  const kws = new Set();
  for (const v of dim.values) {
    kws.add(v.name);
    for (const k of v.kw || []) if (k && String(k).length >= 2) kws.add(String(k).toLowerCase());
  }
  dimKws.set(dim.key, kws);
}

// ---------- 2. 每个受控取值的案例量 + 辨识度细标签 ----------
// 语料标签先按“我们自己的词表”判断它属于哪个维度：串了维度的（在光线下挖出场景词）直接丢掉，
// 词表里完全没有的才算“语料新词”，门槛更高，标 fresh 供人工把它收编进受控词表。
const dimensionOf = text => {
  const t = String(text).toLowerCase();
  const hits = [];
  for (const [key, kws] of dimKws) {
    for (const kw of kws) {
      if (!kw) continue;
      if (ASCII.test(kw)) {
        const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
        if (re.test(t)) { hits.push(key); break; }
      } else if (t.includes(kw)) { hits.push(key); break; }
    }
  }
  return hits;
};

const valueCases = db.prepare('SELECT id FROM cases WHERE facets LIKE ?');
const results = [];
const unknownCands = new Map();   // 词表没有的语料标签 → 它在各受控取值下的证据（用来判断它该归到哪个维度）
for (const dim of seed.facets) {
  const categories = [];
  const dimValueNames = new Set(dim.values.map(v => v.name));
  for (const v of dim.values) {
    const ids = valueCases.all(`%"${v.code}"%`).map(r => r.id);
    const n = ids.length;
    const enFromSeed = (v.kw || []).find(k => ASCII.test(k) && !/^\d/.test(k)) || '';
    const pigments = n ? [{ zh: v.name, en: enFromSeed || v.name, count: n, controlled: true }] : [];

    if (n >= MIN_N) {
      const freq = new Map();
      for (const id of ids) for (const t of caseTags.get(id) || []) freq.set(t, (freq.get(t) || 0) + 1);
      const scored = [];
      for (const [t, k] of freq) {
        if (k < MIN_N) continue;
        if (dimValueNames.has(t)) continue;              // 受控取值本身不重复当细标签
        const lift = (k / n) / ((corpusFreq.get(t) || 0) / TOTAL_CASES);
        if (lift < 1.5) continue;                        // 只留“在这个取值下明显更常见”的
        const belongs = dimensionOf(t);
        if (!belongs.length) {                           // 词表里没有的：先攒证据，回头按最贴近的取值归维度
          if (!unknownCands.has(t)) unknownCands.set(t, []);
          unknownCands.get(t).push({ dim: dim.key, dimName: dim.name, cat: v.name, code: v.code, k, n, lift, score: (k / n) * lift });
          continue;
        }
        if (!belongs.includes(dim.key)) continue;        // 串到别的维度去了，交给那个维度去挖
        scored.push({ tag: t, count: k, lift, score: (k / n) * lift });
      }
      scored.sort((a, b) => b.score - a.score || b.count - a.count);
      const seen = new Set();
      for (const s of scored) {
        if (pigments.length >= TOP + 1) break;
        const key = s.tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pigments.push({ zh: s.tag, count: s.count, controlled: false, lift: Math.round(s.lift * 10) / 10 });
      }
    }
    categories.push({ id: v.code, name: v.name, en: enFromSeed || v.name, count: n, pigments });
  }
  results.push({
    id: `dim_${dim.key}`, key: dim.key, name: dim.name, multi: !!dim.multi,
    count: categories.reduce((s, c) => s + c.count, 0),
    categories: categories.filter(c => c.count > 0).length,
    categoriesAll: categories.length,
    groups: categories,
  });
}

// 语料新词：词表里还没有的标签。按“它最贴近的那个受控取值”归维度——
// 要求证据足够（≥8 条案例）、在该取值下明显更常见（lift ≥ 2.5），且领先其它维度 1.5 倍以上才算归属明确。
const FRESH_MIN = 8;
const FRESH_LIFT = 2.5;
const FRESH_MARGIN = 1.5;
const freshByDim = new Map();
for (const [tag, cands] of unknownCands) {
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best || best.k < FRESH_MIN || best.lift < FRESH_LIFT) continue;
  const rivalDim = cands.find(c => c.dim !== best.dim);
  if (rivalDim && rivalDim.score * FRESH_MARGIN > best.score) continue;   // 归属不明确，先不收
  if (!freshByDim.has(best.dim)) freshByDim.set(best.dim, []);
  freshByDim.get(best.dim).push({ zh: tag, count: best.k, lift: Math.round(best.lift * 10) / 10, cat: best.cat });
}
for (const dim of results) {
  const list = (freshByDim.get(dim.key) || []).sort((a, b) => b.lift - a.lift || b.count - a.count).slice(0, 16);
  dim.freshTags = list;
}

// ---------- 3. 双语补齐 ----------
const needZh = new Set();  // 只有英文的细标签
const needEn = new Set();  // 只有中文的细标签
const knownZh2En = new Map();
const knownEn2Zh = new Map();
for (const dim of seed.facets) for (const v of dim.values) {
  const en = (v.kw || []).find(k => ASCII.test(k) && !/^\d/.test(k));
  if (en) { knownZh2En.set(v.name, en); knownEn2Zh.set(en.toLowerCase(), v.name); }
}
const resolve = t => {
  let zh = '', en = '';
  if (CJK.test(t)) { zh = t; en = knownZh2En.get(t) || glossary[t]?.en || ''; if (!en) needEn.add(t); }
  else { en = t; zh = knownEn2Zh.get(t.toLowerCase()) || glossary[t]?.zh || ''; if (!zh) needZh.add(t); }
  return { zh, en };
};

async function translateMissing() {
  const todo = [...needZh, ...needEn].filter(t => !glossary[t]?.done);
  if (!todo.length) return;
  const { DatabaseSync: S } = await import('node:sqlite');
  const sdb = new S(DB_PATH, { readOnly: true });
  const get = k => sdb.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  const baseUrl = (get('llm_base_url') || process.env.PLIB_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = get('llm_api_key') || process.env.PLIB_API_KEY || '';
  const model = process.env.PLIB_MODEL || get('tagger_model') || get('llm_model') || '';
  if (!baseUrl || !model) throw new Error('设置里没有可用的模型接口，无法补齐双语标签');
  console.log(`[glossary] 需要补齐 ${todo.length} 条（模型 ${model}）`);
  const BATCH = 60;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const prompt = `下面是一批 AI 绘画提示词用的标签（中英混排）。请为每一条补上另一种语言：\n`
      + `- 如果是中文标签，给出它在 AI 图像/视频提示词里最常用的英文写法（小写、可直接拼进 prompt 的短语，不要解释）\n`
      + `- 如果是英文标签，给出准确的中文名（2-8 个字）\n`
      + `只输出 JSON 对象，键是原标签，值是补出的另一种语言。\n\n` + JSON.stringify(batch, null, 0);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4000 }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`模型接口 ${res.status}：${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || '';
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) { console.warn('[glossary] 这批没有解析出 JSON，跳过'); continue; }
    let parsed; try { parsed = JSON.parse(m[0]); } catch { console.warn('[glossary] JSON 解析失败，跳过'); continue; }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      glossary[k] = CJK.test(k) ? { zh: k, en: v.trim(), done: true } : { zh: v.trim(), en: k, done: true };
    }
    console.log(`[glossary] ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    fs.writeFileSync(GLOSSARY_PATH, JSON.stringify(glossary, null, 1));
  }
}

// 先用词表/缓存把双语补上，再把模型补出来的回填一遍；补不齐的先保留原标签
let missing = 0;
const applyGloss = () => {
  missing = 0;
  const fix = p => {
    const cur = p.zh;
    const r = resolve(cur);
    p.zh = r.zh || cur;
    p.en = r.en || p.en || p.zh;
    if (!r.en) missing++;
  };
  for (const dim of results) {
    for (const g of dim.groups) {
      const kept = [];
      const seenZh = new Set([g.name]);   // 受控取值本身不再重复出现
      for (const p of g.pigments) {
        fix(p);
        const key = p.zh.toLowerCase();
        if (!p.controlled && seenZh.has(key)) continue;  // 撞名（含大小写/同义重复）的只留一条
        seenZh.add(key);
        kept.push(p);
      }
      g.pigments = kept;
    }
    for (const f of dim.freshTags || []) fix(f);         // 新词候选同样补齐双语
  }
};
applyGloss();               // 第一遍：走词表，同时把缺口登记进 needZh / needEn
if (DO_TRANSLATE) {
  // 模型偶尔漏译几条，来回补几轮直到没有新缺口（最多 4 轮，避免死循环）
  let prevSize = -1;
  for (let round = 1; round <= 4 && missing > 0; round++) {
    if (needZh.size + needEn.size === prevSize) break;
    prevSize = needZh.size + needEn.size;
    await translateMissing();
    applyGloss();
  }
}
if (missing) console.warn(`[警告] 还有 ${missing} 条细标签缺英文（跑 --translate 可补齐），已先用中文兜底`);

// ---------- 4. 产出 ----------
const dimsOut = results.filter(d => d.groups.some(g => g.count > 0));
const allPigments = dimsOut.flatMap(d => d.groups.flatMap(g => g.pigments));
const freshOut = dimsOut.flatMap(d => d.freshTags || []);
const stats = {
  totalCases: TOTAL_CASES,
  dimensions: dimsOut.length,
  categories: dimsOut.reduce((s, d) => s + d.groups.filter(g => g.count > 0).length, 0),
  pigments: allPigments.length,
  controlled: allPigments.filter(p => p.controlled).length,
  mined: allPigments.filter(p => !p.controlled).length,
  fresh: freshOut.length,   // 词表里还没有、从语料挖出来的新词候选
  generatedAt: new Date().toISOString(),
};
const payload = `// 由 scripts/build-pigments.mjs 从本库自身数据生成，未引入任何外部词典：\n`
  + `//   1) seed/facets.json —— 本库的 ${stats.dimensions} 维受控词表（${stats.controlled} 个取值）\n`
  + `//   2) library.db 的 cases.facets —— ${stats.totalCases.toLocaleString()} 条案例的受控归属，决定每个标签的案例量\n`
  + `//   3) library.db 的 cases.raw_tags —— 语料自由标签：与所在维度词表一致的按“取值内占比 × 辨识度(lift)”收成 ${stats.mined} 条细标签；\n`
  + `//      词表里没有的按维度归属（该维度占比 ≥60%）收成 ${stats.fresh} 条「新词候选」，供后续收编进受控词表\n`
  + `// 生成时间 ${stats.generatedAt}；重新生成：node scripts/build-pigments.mjs --translate\n`
  + `window.PIGMENT_STATS = ${JSON.stringify(stats)};\n`
  + `window.PIGMENT_DICTIONARY = ${JSON.stringify(dimsOut.map(d => ({
    id: d.id, key: d.key, name: d.name, multi: d.multi, count: d.count,
    categories: d.groups.filter(g => g.count > 0).map(g => ({
      id: g.id, name: g.name, en: g.en, count: g.count,
      pigments: g.pigments.map(p => ({ zh: p.zh, en: p.en, count: p.count, controlled: !!p.controlled })),
    })),
    freshTags: (d.freshTags || []).map(f => ({ zh: f.zh, en: f.en, count: f.count, lift: f.lift, cat: f.cat })),
  })), null, 1)};\n`;
fs.writeFileSync(OUT_PATH, payload);

console.log(`[pigments] ${stats.dimensions} 维 / ${stats.categories} 类别 / ${stats.pigments} 标签（受控 ${stats.controlled} + 语料 ${stats.mined}）+ ${stats.fresh} 条新词候选，覆盖 ${stats.totalCases.toLocaleString()} 条案例 → ${path.relative(process.cwd(), OUT_PATH)}`);
for (const d of dimsOut) {
  const n = d.groups.filter(g => g.count > 0).length;
  const p = d.groups.reduce((s, g) => s + g.pigments.length, 0);
  console.log(`  ${d.name.padEnd(6)} ${String(n).padStart(3)} 类别  ${String(p).padStart(4)} 标签  ${String((d.freshTags || []).length).padStart(3)} 新词`);
}
