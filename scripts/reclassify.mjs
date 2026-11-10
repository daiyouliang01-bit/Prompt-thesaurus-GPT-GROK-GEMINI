// 全库重算：受控多维标签（facets）+ 大类细分类 + 待确认标记
// 用法：node scripts/reclassify.mjs [--dry-run] [--only-auto] [--limit N]
import { DatabaseSync } from 'node:sqlite';
import { classify, subcategoryName } from '../lib/classify.mjs';
import { tagFacets, facetsToTags, facetDefs, facetValueName } from '../lib/facets.mjs';
import { DB_PATH } from '../lib/paths.mjs';

const DRY = process.argv.includes('--dry-run');
const ONLY_AUTO = process.argv.includes('--only-auto');
const li = process.argv.indexOf('--limit');
const LIMIT = li > -1 ? Number(process.argv[li + 1]) : 0;
const LOW_SCORE = 5;   // 低于这个分视作“勉强命中”，进待确认

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 60000;');

// 迁移：新增三列
const cols = db.prepare('pragma table_info(cases)').all().map(c => c.name);
const addCol = (name, ddl) => { if (!cols.includes(name)) { db.exec(`ALTER TABLE cases ADD COLUMN ${ddl}`); console.log(`新增列 ${name}`); } };
addCol('facets', 'facets TEXT');
addCol('raw_tags', 'raw_tags TEXT');
addCol('needs_review', 'needs_review INTEGER NOT NULL DEFAULT 0');

// 原站标签只搬一次，之后 tags 列交给受控标签
if (!DRY) {
  // 只对还没算过受控标签的老行做一次备份；算过之后 tags 里装的是受控标签，再倒灌会污染原站标签
  const n = db.prepare("update cases set raw_tags = tags where raw_tags is null and facets is null and tags is not null and tags <> ''").run().changes;
  if (n) console.log(`原站标签备份到 raw_tags：${n} 条`);
}

// 手动归类和 AI 精标过的条目都不动
const KEEP = "classify_source in ('manual','ai')";
const where = ONLY_AUTO ? `where not (${KEEP})` : '';  // 不加 --only-auto 时也会处理 ai 行，但只补缺的维度
const rows = db.prepare(`select id,title,tags,raw_tags,prompt,analysis,category_code,subcategory,media_type,classify_source,facets from cases ${where} order by id${LIMIT ? ` limit ${LIMIT}` : ''}`).all();
console.log(`处理 ${rows.length} 条${DRY ? '（试算，不写库）' : ''}`);

const upd = db.prepare('update cases set category_code=?, subcategory=?, classify_score=?, classify_source=?, facets=?, tags=?, needs_review=? where id=?');
const stat = { catChanged: 0, subChanged: 0, tagged: 0, review: 0, noSubject: 0 };
const facetCount = new Map();
const moves = new Map();

if (!DRY) db.exec('BEGIN');
let i = 0;
for (const r of rows) {
  const src = { title: r.title, tags: r.raw_tags || r.tags, prompt: r.prompt, analysis: r.analysis };
  const { facets } = tagFacets(src);
  const manual = r.classify_source === 'manual' || r.classify_source === 'ai';
  const c = manual
    ? { category: r.category_code, subcategory: r.subcategory, score: null, rule: null }
    : classify({ title: r.title, tags: src.tags, prompt: r.prompt, mediaType: r.media_type || 'image' });

  const tagNames = facetsToTags(facets);
  const lowScore = !manual && (c.score ?? 0) < LOW_SCORE;
  const noSubject = !(facets.subject || []).length;
  if (noSubject) stat.noSubject++;
  const review = (lowScore || !c.category || !c.subcategory) && !manual ? 1 : 0;
  if (review) stat.review++;
  if (!manual && c.category !== r.category_code) {
    stat.catChanged++;
    const k = `${r.category_code || '无'} → ${c.category || '无'}`;
    moves.set(k, (moves.get(k) || 0) + 1);
  }
  if (!manual && c.subcategory !== r.subcategory) stat.subChanged++;
  if (tagNames.length) stat.tagged++;
  for (const f of facetDefs()) for (const code of facets[f.key] || []) facetCount.set(code, (facetCount.get(code) || 0) + 1);

  // AI / 手动归类过的条目：保留它们的判断，只把它们还没有的维度用规则补上
  let outFacets = facets, outTags = tagNames;
  if (manual) {
    let kept = {};
    try { kept = JSON.parse(r.facets || '{}'); } catch { kept = {}; }
    const merged = { ...kept };
    let added = 0;
    for (const [k, v] of Object.entries(facets)) {
      if (!(merged[k] || []).length && (v || []).length) { merged[k] = v; added++; }
    }
    outFacets = merged;
    outTags = facetsToTags(merged);
    if (added) stat.filled = (stat.filled || 0) + 1;
  }

  if (!DRY) {
    upd.run(c.category || null, c.subcategory || null, c.score ?? null,
      manual ? r.classify_source : 'rule', JSON.stringify(outFacets), outTags.join(','), review, r.id);
  }
  if (++i % 5000 === 0) console.log(`  已处理 ${i}`);
}

if (!DRY) db.exec('COMMIT');

if (stat.filled) console.log(`给 AI/手动归类的条目补上缺的维度：${stat.filled} 条`);
console.log(`\n大类变化 ${stat.catChanged}，细分变化 ${stat.subChanged}，打上受控标签 ${stat.tagged}，待确认 ${stat.review}，未识别出主体 ${stat.noSubject}`);
console.log('\n迁移最多的方向：');
for (const [k, v] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${k.padEnd(16)} ${v}`);
console.log('\n各维度覆盖：');
for (const f of facetDefs()) {
  const items = f.values.map(v => [v.name, facetCount.get(v.code) || 0]).sort((a, b) => b[1] - a[1]);
  const total = items.reduce((s, x) => s + x[1], 0);
  console.log(`  ${f.name}(${total}) ${items.slice(0, 6).map(([n, c]) => `${n}${c}`).join(' ')}`);
}
