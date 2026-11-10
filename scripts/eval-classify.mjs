// 用 541 个已人工归类的网站案例评估规则分类器（类别级准确率 + 混淆最多的类别对）
import fs from 'node:fs';
import path from 'node:path';
import { SEED } from '../lib/paths.mjs';
import { classify } from '../lib/classify.mjs';

const cases = JSON.parse(fs.readFileSync(path.join(SEED, 'cases.json'), 'utf8')).cases;
const cats = JSON.parse(fs.readFileSync(path.join(SEED, 'categories.json'), 'utf8'));
const truth = new Map();
for (const c of cats) for (const id of c.ids) truth.set(id, c.code);

let ok = 0, top3 = 0, none = 0;
const confusion = new Map();
const perCat = new Map();
for (const c of cases) {
  const r = classify({ title: c.title, prompt: c.prompt });
  const t = truth.get(c.id);
  const pc = perCat.get(t) || { n: 0, ok: 0 };
  pc.n++;
  if (!r.category) none++;
  if (r.category === t) { ok++; pc.ok++; }
  else {
    const key = `${t} → ${r.category}`;
    confusion.set(key, (confusion.get(key) || 0) + 1);
  }
  if (r.category === t || r.alternatives.some(a => a.category === t)) top3++;
  perCat.set(t, pc);
}
console.log(`准确率 ${(ok / cases.length * 100).toFixed(1)}%（${ok}/${cases.length}），前三命中 ${(top3 / cases.length * 100).toFixed(1)}%，未分类 ${none}`);
console.log('各类别：', [...perCat.entries()].sort().map(([k, v]) => `${k} ${v.ok}/${v.n}`).join('  '));
console.log('最常见错判：', [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}×${v}`).join('  '));
