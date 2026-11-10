// 把 ai_labels 表里的标注重新写回案例（用于被覆盖后的恢复）
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../lib/paths.mjs';
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 60000;');
const rows = db.prepare(`select a.* from ai_labels a join cases c on c.id = a.case_id
  where c.classify_source <> 'manual'
    and (c.classify_source <> 'ai' or coalesce(c.category_code,'') <> coalesce(a.category,'') or coalesce(c.facets,'') <> coalesce(a.facets,''))`).all();
console.log(`需要恢复 ${rows.length} 条`);
const upd = db.prepare(`update cases set category_code=?, subcategory=?, facets=?, tags=?,
  search_text=coalesce(?, search_text), classify_source='ai', needs_review=0 where id=? and classify_source<>'manual'`);
db.exec('BEGIN');
let n = 0;
for (const a of rows) { upd.run(a.category, a.subcategory, a.facets, a.tags, a.search_text || null, a.case_id); n++; }
db.exec('COMMIT');
const stat = db.prepare("select classify_source, count(*) n from cases group by 1").all();
console.log(`已恢复 ${n} 条`);
for (const r of stat) console.log(`  ${r.classify_source || '(空)'}：${r.n}`);
