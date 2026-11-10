// 给全库算向量（只算新增或文本变动的条目）
// 用法：node scripts/embed-library.mjs [--limit N] [--batch 16] [--unload]
import { embed, saveVec, pendingCases, embedStats, available, EMBED_MODEL } from '../lib/embed.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 0));
const BATCH = Number(arg('batch', 16));
const UNLOAD = process.argv.includes('--unload');

const av = await available();
if (!av.ok) { console.error(av.reason); process.exit(1); }

const todo = pendingCases(LIMIT);
const before = embedStats();
console.log(`模型 ${EMBED_MODEL}；库里 ${before.total} 条，已有向量 ${before.done} 条，本次要算 ${todo.length} 条`);
if (!todo.length) { console.log('没有需要更新的条目'); process.exit(0); }

const t0 = Date.now();
let done = 0, failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const slice = todo.slice(i, i + BATCH);
  const last = i + BATCH >= todo.length;
  try {
    const vecs = await embed(slice.map(x => x.src), { keepAlive: UNLOAD && last ? '0' : undefined, timeoutMs: 180000 });
    slice.forEach((x, k) => saveVec(x.id, vecs[k], x.src));
    done += slice.length;
  } catch (e) {
    failed += slice.length;
    console.error(`  第 ${i} 批失败：${e.message.slice(0, 120)}`);
  }
  if (done % 500 < BATCH) {
    const min = (Date.now() - t0) / 60000;
    console.log(`  ${done}/${todo.length}　${(done / Math.max(min, 0.01)).toFixed(0)} 条/分钟　已用 ${min.toFixed(1)} 分钟`);
  }
}
console.log(`\n完成：成功 ${done}，失败 ${failed}，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
console.log(`库里现有向量 ${embedStats().done} 条${UNLOAD ? '；模型已卸载' : ''}`);
