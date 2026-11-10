// 抓取 OpenNana 免费提示词详情与图片/视频（可断点续传）
// 用法：node scripts/fetch-opennana.mjs [--concurrency 3] [--with-media] [--no-video] [--limit N]
// 默认只抓提示词详情，图片和视频保留链接；加 --with-media 才下载到本地
// 加 --refresh-list 会先重新拉取最新的免费列表（用于日后增量更新：已抓过的详情会自动跳过）
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../lib/paths.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const CONCURRENCY = Number(opt('concurrency', 3));
const LIMIT = Number(opt('limit', 0));
const WITH_MEDIA = args.includes('--with-media');
const WITH_VIDEO = !args.includes('--no-video');

const DIR = path.join(DATA, 'sources', 'opennana');
const DETAILS = path.join(DIR, 'details');
const MEDIA = path.join(DATA, 'media', 'opennana');
fs.mkdirSync(DETAILS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh) personal-prompt-library', Referer: 'https://opennana.com/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, asJson = true) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(asJson ? 60000 : 300000) });
      if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(5000 * (attempt + 1)); continue; }
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: r.status === 404 || r.status === 403 });
      return asJson ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      if (e.fatal) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw last;
}

function extOf(url, fallback) {
  const m = /\.(jpe?g|png|webp|gif|mp4|mov|webm)(?:\?|$)/i.exec(url || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : fallback;
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  const buf = await fetchRetry(url, false);
  fs.writeFileSync(file + '.part', buf);
  fs.renameSync(file + '.part', file);
  return true;
}

const LIST_FILE = path.join(DIR, 'list.json');
if (args.includes('--refresh-list') || !fs.existsSync(LIST_FILE)) {
  const items = new Map();
  for (let page = 1; ; page++) {
    const res = await fetchRetry(`https://api.opennana.com/api/prompts?access_type=0&limit=100&page=${page}`);
    const data = res?.data;
    for (const it of data?.items || []) if (Number(it.access_type) === 0) items.set(it.id, it);
    if (!data?.pagination?.has_more || !data.items?.length) break;
    await sleep(400);
  }
  fs.writeFileSync(LIST_FILE, JSON.stringify([...items.values()]));
  console.log(`已刷新免费列表：${items.size} 条`);
}
const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
const mediaFilter = opt('only-media', '');
const filtered = typeof mediaFilter === 'string' && mediaFilter ? list.filter(it => it.media_type === mediaFilter) : list;
const queue = LIMIT ? filtered.slice(0, LIMIT) : filtered;
const errors = [];
const stat = { details: 0, detailsSkipped: 0, images: 0, videos: 0, done: 0 };
const started = Date.now();

async function handle(item) {
  const detFile = path.join(DETAILS, `${item.id}.json`);
  let d;
  if (fs.existsSync(detFile)) {
    d = JSON.parse(fs.readFileSync(detFile, 'utf8'));
    stat.detailsSkipped++;
  } else {
    const res = await fetchRetry(`https://api.opennana.com/api/prompts/${encodeURIComponent(item.slug)}`);
    if (res.status !== 200 || !res.data) throw new Error(`detail status ${res.status} ${res.msg || ''}`);
    d = res.data;
    delete d.random_prompts;
    fs.writeFileSync(detFile, JSON.stringify(d));
    stat.details++;
    await sleep(250);
  }
  if (!WITH_MEDIA) return;
  const images = Array.isArray(d.images) ? d.images : [];
  for (let i = 0; i < images.length; i++) {
    if (await download(images[i], path.join(MEDIA, `${d.id}-${i + 1}.${extOf(images[i], 'jpg')}`))) stat.images++;
  }
  if (WITH_VIDEO) {
    const videos = Array.isArray(d.video_urls) ? d.video_urls : [];
    for (let i = 0; i < videos.length; i++) {
      if (await download(videos[i], path.join(MEDIA, `${d.id}-v${i + 1}.${extOf(videos[i], 'mp4')}`))) stat.videos++;
    }
  }
}

let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try { await handle(item); }
    catch (e) { errors.push({ id: item.id, slug: item.slug, error: String(e.message || e) }); }
    stat.done++;
    if (stat.done % 200 === 0 || stat.done === queue.length) {
      const min = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[${min} 分钟] ${stat.done}/${queue.length} 详情新增 ${stat.details} 跳过 ${stat.detailsSkipped} 图片 ${stat.images} 视频 ${stat.videos} 失败 ${errors.length}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
fs.writeFileSync(path.join(DIR, 'errors.json'), JSON.stringify(errors, null, 1));
console.log('完成', stat, '失败', errors.length);
