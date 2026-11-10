// 把已抓取的 OpenNana 详情导入本地库（可重复运行：更新内容，但保留你的收藏、备注和手动归类）
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../lib/paths.mjs';
import * as store from '../lib/db.mjs';
import { classify, taxonomy } from '../lib/classify.mjs';

const DETAILS = path.join(DATA, 'sources', 'opennana', 'details');
const MEDIA_REL = 'media/opennana';
const LOCAL_MEDIA = process.argv.includes('--local-media');

const MODEL_NAMES = {
  'nano banana pro': 'Nano Banana Pro',
  'nano banana 2': 'Nano Banana 2',
  'nano banana': 'Nano Banana',
  chatgpt: 'ChatGPT',
  'gpt image 2': 'GPT Image 2',
  'gpt-image-2': 'GPT Image 2',
  grok: 'Grok',
  'seedance 2.0': 'Seedance 2.0',
  seedance: 'Seedance 2.0',
  midjourney: 'Midjourney',
};
export function normalizeModel(m) {
  const k = String(m || '').trim().toLowerCase();
  if (!k) return null;
  return MODEL_NAMES[k] || String(m).trim();
}

function composePrompt(prompts) {
  const list = (prompts || []).filter(p => p && String(p.text || '').trim());
  if (!list.length) return '';
  if (list.length === 1) return list[0].text.trim();
  // 中文在前、英文在后，其余语言按原顺序
  const order = p => (p.type === 'zh' ? 0 : p.type === 'en' ? 1 : 2);
  return [...list].sort((a, b) => order(a) - order(b))
    .map(p => `【${p.label || p.type || '提示词'}】\n${p.text.trim()}`).join('\n\n');
}

const mediaFiles = new Map();
if (fs.existsSync(path.join(DATA, MEDIA_REL))) {
  for (const f of fs.readdirSync(path.join(DATA, MEDIA_REL))) {
    if (f.endsWith('.part')) continue;
    const m = /^(\d+)-(\d+)\./.exec(f);
    if (!m) continue;
    const arr = mediaFiles.get(Number(m[1])) || [];
    arr.push({ n: Number(m[2]), rel: `${MEDIA_REL}/${f}` });
    mediaFiles.set(Number(m[1]), arr);
  }
}

// 细分类表（含新增的 C16 视频生成）
const tax = taxonomy();
tax.categories.forEach((c, ci) => {
  if (!store.getCategory(c.code)) {
    store.upsertCategory({ code: c.code, name: c.name, description: c.subs.map(s => s.name).join('、'), template_md: '', sort: 100 + ci });
  }
  c.subs.forEach((s, si) => store.upsertSubcategory({ code: s.code, category_code: c.code, name: s.name, sort: ci * 100 + si }));
});

const files = fs.existsSync(DETAILS) ? fs.readdirSync(DETAILS).filter(f => f.endsWith('.json')) : [];
const db = store.getDb();
const findExisting = db.prepare("SELECT id, classify_source FROM cases WHERE source = 'opennana' AND source_case_id = ?");
let created = 0, updated = 0, skipped = 0, manualKept = 0;
const byModel = new Map();
const byCat = new Map();

for (let i = 0; i < files.length; i += 500) {
  db.exec('BEGIN');
  try {
    for (const f of files.slice(i, i + 500)) {
      const d = JSON.parse(fs.readFileSync(path.join(DETAILS, f), 'utf8'));
      const prompt = composePrompt(d.prompts);
      if (!prompt || Number(d.access_type) !== 0) { skipped++; continue; }
      const mediaType = d.media_type === 'video' ? 'video' : 'image';
      const local = (mediaFiles.get(d.id) || []).sort((a, b) => a.n - b.n).map(x => x.rel);
      const remote = Array.isArray(d.images) ? d.images : [];
      const tags = Array.isArray(d.tags) ? d.tags : [];
      const model = normalizeModel(d.model);
      const zhText = (d.prompts || []).filter(p => p.type === 'zh').map(p => p.text).join(' ');
      const enText = (d.prompts || []).filter(p => p.type !== 'zh').map(p => p.text).join(' ');
      const cls = classify({ title: d.title, tags, prompt: `${zhText} ${enText}`, mediaType });

      const data = {
        source: 'opennana', source_case_id: d.id, title: d.title || d.slug, prompt, model, media_type: mediaType,
        // 默认只保留图片链接；加 --local-media 才使用已下载到本地的图片
        tags, image_path: LOCAL_MEDIA ? local[0] || null : null, image_url: remote[0] || null,
        extra_images: JSON.stringify(LOCAL_MEDIA && local.length > 1 ? local.slice(1) : remote.slice(1)),
        video_url: Array.isArray(d.video_urls) && d.video_urls.length ? d.video_urls[0] : null,
        source_url: d.source_url || `https://opennana.com/awesome-prompt-gallery/${d.slug}`,
        analysis: [d.description, d.notes].filter(Boolean).join('\n'),
      };
      const existing = findExisting.get(d.id);
      if (existing && ['manual', 'ai'].includes(existing.classify_source)) {
        manualKept++;
      } else {
        Object.assign(data, { category_code: cls.category, subcategory: cls.subcategory, classify_score: cls.score, classify_source: 'rule' });
      }
      if (existing) { store.updateCase(existing.id, data); updated++; }
      else { store.createCase({ ...data, note: d.source_name ? `作者 ${d.source_name}` : '' }); created++; }
      byModel.set(model || '未标注', (byModel.get(model || '未标注') || 0) + 1);
      byCat.set(cls.category || '未分类', (byCat.get(cls.category || '未分类') || 0) + 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

console.log(`OpenNana：新增 ${created}，更新 ${updated}，跳过（无提示词/付费）${skipped}，保留手动归类 ${manualKept}`);
console.log('按模型：', [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，'));
console.log('按类别：', [...byCat.entries()].sort().map(([k, v]) => `${k} ${v}`).join('，'));
