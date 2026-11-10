// 导入/更新种子数据：541 个网站案例 + 15 类模板 + 通用规则。可重复运行，不会覆盖你的收藏、备注和自建案例。
import fs from 'node:fs';
import path from 'node:path';
import { SEED, DATA } from '../lib/paths.mjs';
import * as store from '../lib/db.mjs';
import { taxonomy, classifyWithin } from '../lib/classify.mjs';

const read = f => fs.readFileSync(path.join(SEED, f), 'utf8');
const cases = fs.existsSync(path.join(SEED, 'cases.json')) ? JSON.parse(read('cases.json')).cases : [];
const categories = JSON.parse(read('categories.json'));

// 逐案分析笔记：形如 "- 44 / 226 | 归类 | 子类型 | 要点"
const notes = new Map();
for (const f of (fs.existsSync(path.join(SEED, 'notes')) ? fs.readdirSync(path.join(SEED, 'notes')) : []).filter(f => f.endsWith('.md')).sort()) {
  for (const line of read(path.join('notes', f)).split('\n')) {
    const m = /^- ([\d\s/]+?)\s*(?:[（(][^）)]*[）)])?\s*\|(.+)$/.exec(line);
    if (!m) continue;
    const ids = m[1].split('/').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    const parts = m[2].split('|').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      const prev = notes.get(id);
      if (prev) prev.analysis += '\n' + parts.join(' | ');
      else notes.set(id, { subtype: parts.length >= 3 ? `${parts[0]} · ${parts[1]}` : (parts[0] || ''), analysis: parts.join(' | ') });
    }
  }
}

const catOf = new Map();
for (const c of categories) for (const id of c.ids) catOf.set(id, c.code);

const imageDir = path.join(DATA, 'images');
const localImages = fs.existsSync(imageDir) ? fs.readdirSync(imageDir) : [];
const findImage = id => {
  const f = localImages.find(n => n.startsWith(`case${id}.`));
  return f ? `images/${f}` : null;
};

const db = store.getDb();
db.exec('BEGIN');
try {
  for (const c of categories) {
    store.upsertCategory({
      code: c.code, name: c.name, description: c.description, sort: c.sort,
      template_md: fs.existsSync(path.join(SEED, 'templates', c.file)) ? read(path.join('templates', c.file)) : '',
    });
  }
  const rules = path.join('templates', '00_总览与通用规则.md');
  if (fs.existsSync(path.join(SEED, rules))) store.upsertDoc('rules', '总览与通用规则', read(rules));
  taxonomy().categories.forEach((c, ci) => {
    if (!store.getCategory(c.code)) {
      store.upsertCategory({ code: c.code, name: c.name, description: c.subs.map(s => s.name).join('、'), template_md: '', sort: 100 + ci });
    }
    c.subs.forEach((s, si) => store.upsertSubcategory({ code: s.code, category_code: c.code, name: s.name, sort: ci * 100 + si }));
  });

  const findExisting = db.prepare("SELECT id FROM cases WHERE source = 'canghe' AND source_case_id = ?");
  let created = 0, updated = 0, missingNotes = [];
  for (const c of cases) {
    const note = notes.get(c.id);
    if (!note) missingNotes.push(c.id);
    const code = catOf.get(c.id) || null;
    const sub = code ? classifyWithin(code, { title: `${c.title} ${note?.subtype || ''}`, prompt: c.prompt }) : null;
    const data = {
      source: 'canghe', source_case_id: c.id, title: c.title, prompt: c.prompt,
      category_code: code, subcategory: sub?.subcategory || null, classify_source: 'seed',
      model: 'GPT Image 2', media_type: 'image',
      subtype: note?.subtype || '', analysis: note?.analysis || '',
      tags: [...(c.styles || []), ...(c.scenes || [])],
      styles: c.styles || [], scenes: c.scenes || [], original_category: c.category,
      image_path: findImage(c.id), image_url: 'https://gpt-image2.canghe.ai' + c.image,
      source_url: c.githubUrl || c.sourceUrl || '',
    };
    const existing = findExisting.get(c.id);
    if (existing) { store.updateCase(existing.id, data); updated++; }
    else {
      if (store.getCaseRow(c.id)) throw new Error(`编号 ${c.id} 已被其他案例占用，无法按原编号导入`);
      store.createCase({ ...data, note: c.sourceLabel ? `作者 ${c.sourceLabel}` : '' }, { id: c.id });
      created++;
    }
  }
  store.ensureUserIdSequence();
  db.exec('COMMIT');
  const withImg = cases.filter(c => findImage(c.id)).length;
  console.log(`类别 ${categories.length} 个；案例新增 ${created}，更新 ${updated}；本地配图 ${withImg}/${cases.length}`);
  if (missingNotes.length) console.log(`以下案例没有解析到逐案笔记（仍已入库）：${missingNotes.join(', ')}`);
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
