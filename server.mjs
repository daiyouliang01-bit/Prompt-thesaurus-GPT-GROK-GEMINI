import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PUBLIC } from './lib/paths.mjs';
import * as store from './lib/db.mjs';
import { saveDataUrl } from './lib/files.mjs';
import { runGeneration, refineGeneration, autoTag, testConnection } from './lib/generate.mjs';
import { classify, classifyWithin, subcategoryName } from './lib/classify.mjs';
import { facetDefs } from './lib/facets.mjs';
import * as embedLib from './lib/embed.mjs';
import { labelCaseSoon } from './lib/autotag.mjs';
import { runReverse, refineWithGenerated } from './lib/reverse.mjs';
import { Readable } from 'node:stream';
import * as gd from './lib/gdrive.mjs';
import * as drive from './lib/drive-sync.mjs';
import { relaunchWithProxy } from './lib/proxy-env.mjs';

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function readJson(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`请求体过大（上限 ${Math.round(limit / 1048576)}MB）`), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

function within(base, rel) {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

function maskedSettings() {
  const s = store.getSettings();
  const key = s.llm_api_key || '';
  return {
    llm_base_url: s.llm_base_url || '', llm_model: s.llm_model || '', llm_vision_model: s.llm_vision_model || '',
    llm_temperature: s.llm_temperature || '', llm_max_tokens: s.llm_max_tokens || '', llm_fallback_model: s.llm_fallback_model || '',
    llm_api_key_set: !!key, llm_api_key_hint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    tagger_base_url: s.tagger_base_url || '', tagger_model: s.tagger_model || '',
    tagger_api_key_set: !!s.tagger_api_key,
    tagger_api_key_hint: s.tagger_api_key ? `${s.tagger_api_key.slice(0, 4)}…${s.tagger_api_key.slice(-4)}` : '',
  };
}

function casePayload(body) {
  const data = {};
  for (const k of ['title', 'prompt', 'category_code', 'subcategory', 'subtype', 'analysis', 'tags', 'note', 'source_url', 'favorite', 'model', 'media_type', 'video_url', 'image_url']) {
    if (k in body) data[k] = body[k];
  }
  if (data.image_url && !/^https?:\/\//i.test(String(data.image_url))) delete data.image_url;
  if ('category_code' in body || 'subcategory' in body) data.classify_source = 'manual';
  if (body.image) data.image_path = saveDataUrl(body.image, 'images/user');
  else if (body.image_remove) { data.image_path = null; data.image_url = null; }
  return data;
}

// 会改动配置或发起授权的接口，只允许提示词库自己的网页和插件调用（普通网页无法带自定义请求头跨域提交）
function requireClient(req) {
  if (!req.headers['x-plib-client']) throw Object.assign(new Error('请从提示词库网页操作'), { status: 403 });
}

let quotaCache = null;
let llmModelCache = null;

// ---------- 云盘文件读取：图片缓存到本地，视频按 Range 转发 ----------
const DRIVE_CACHE = path.join(DATA, 'cache', 'drive');
const CACHE_LIMIT = 1024 * 1024 * 1024;
let lastPrune = 0;
function pruneDriveCache() {
  if (Date.now() - lastPrune < 5 * 60000) return;
  lastPrune = Date.now();
  try {
    const files = fs.readdirSync(DRIVE_CACHE).map(f => {
      const p = path.join(DRIVE_CACHE, f);
      const st = fs.statSync(p);
      return { p, size: st.size, t: st.atimeMs };
    });
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_LIMIT) return;
    for (const f of files.sort((a, b) => a.t - b.t)) {
      fs.rmSync(f.p, { force: true });
      total -= f.size;
      if (total < CACHE_LIMIT * 0.8) break;
    }
  } catch { /* 缓存目录不存在或读不到时忽略 */ }
}

async function serveDrive(req, res, driveId) {
  const row = store.getDb().prepare("SELECT drive_id, mime, source FROM drive_files WHERE drive_id = ? AND status = 'done' LIMIT 1").get(driveId);
  if (!row) { res.writeHead(404); return res.end('Not found'); }
  const fallback = () => {
    if (/^https?:\/\//i.test(row.source || '')) { res.writeHead(302, { Location: row.source }); return res.end(); }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('云盘读取失败');
  };
  try {
    if (/^image\//.test(row.mime || '')) {
      const cacheFile = path.join(DRIVE_CACHE, driveId.replace(/[^\w-]/g, '_'));
      if (!fs.existsSync(cacheFile)) {
        const r = await gd.openMedia(driveId);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.mkdirSync(DRIVE_CACHE, { recursive: true });
        fs.writeFileSync(`${cacheFile}.part`, Buffer.from(await r.arrayBuffer()));
        fs.renameSync(`${cacheFile}.part`, cacheFile);
        pruneDriveCache();
      }
      res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': fs.statSync(cacheFile).size, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(cacheFile).pipe(res);
    }
    const r = await gd.openMedia(driveId, req.headers.range);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const headers = { 'Content-Type': row.mime || r.headers.get('content-type') || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    if (!r.headers.get('content-encoding')) {
      for (const h of ['content-length', 'content-range']) if (r.headers.get(h)) headers[h] = r.headers.get(h);
    }
    res.writeHead(r.status, headers);
    const body = Readable.fromWeb(r.body);
    req.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    return body.pipe(res);
  } catch {
    if (res.headersSent) return res.destroy();
    return fallback();
  }
}

const htmlPage = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.7 -apple-system,'PingFang SC',sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#1f2328">
<h2>${title}</h2><p>${body}</p><p><a href="/">回到提示词库</a></p></body>`;

const routes = [
  ['GET', /^\/api\/stats$/, () => store.stats()],
  ['GET', /^\/api\/categories$/, () => store.listCategories()],
  ['GET', /^\/api\/categories\/(C\d\d)$/, (req, m) => store.getCategory(m[1]) || Promise.reject(Object.assign(new Error('类别不存在'), { status: 404 }))],
  ['GET', /^\/api\/docs\/rules$/, () => store.getDoc('rules')],
  ['GET', /^\/api\/models$/, () => store.listModels()],
  ['GET', /^\/api\/subcategories$/, (req, m, url) => store.listSubcategories(url.searchParams.get('category') || '', {
    model: url.searchParams.get('model') || '', mediaType: url.searchParams.get('media_type') || '', source: url.searchParams.get('source') || '',
  })],
  ['GET', /^\/api\/cases$/, async (req, m, url) => store.searchCases({
    q: url.searchParams.get('q') || '', category: url.searchParams.get('category') || '',
    subcategory: url.searchParams.get('subcategory') || '', model: url.searchParams.get('model') || '',
    mediaType: url.searchParams.get('media_type') || '',
    source: url.searchParams.get('source') || '', favorite: url.searchParams.get('favorite') === '1',
    review: url.searchParams.get('review') === '1',
    tier: Number(url.searchParams.get('tier')) || 0,
    // 受控标签：?f_subject=SB-person&f_light=LT-night,LT-neon
    facets: Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith('f_'))
      .map(([k, v]) => [k.slice(2), v.split(',').filter(Boolean)])),
    semantic: url.searchParams.get('semantic') === '1' && url.searchParams.get('q')
      ? new Map((await embedLib.semanticSearch(url.searchParams.get('q'), { limit: 400 })).map(x => [x.id, x.score]))
      : null,
    limit: Math.min(Number(url.searchParams.get('limit')) || 48, 200), offset: Number(url.searchParams.get('offset')) || 0,
  })],
  ['GET', /^\/api\/embed\/status$/, async () => ({ ...embedLib.embedStats(), ...(await embedLib.available()) })],
  ['GET', /^\/api\/facets$/, () => ({
    facets: facetDefs().map(f => ({ key: f.key, name: f.name, multi: !!f.multi, values: f.values.map(v => ({ code: v.code, name: v.name })) })),
    counts: store.facetCounts(),
  })],
  ['GET', /^\/api\/cases\/(\d+)$/, (req, m) => store.getCase(m[1]) || Promise.reject(Object.assign(new Error('案例不存在'), { status: 404 }))],
  ['POST', /^\/api\/cases$/, async req => {
    const created = store.createCase({ source: 'user', ...casePayload(await readJson(req)) });
    drive.syncCaseNow(created.id);
    // 规则归类对穿搭、版式这类图常判错，新加的条目立刻在后台看图重归一次
    labelCaseSoon(created.id);
    return { ...created, autotag: 'pending' };
  }],
  ['PUT', /^\/api\/cases\/(\d+)$/, async (req, m) => {
    const body = await readJson(req);
    const old = store.getCaseRow(m[1]);
    const updated = store.updateCase(m[1], casePayload(body));
    if (old?.image_path?.startsWith('images/user/') && (body.image || body.image_remove)) {
      fs.rmSync(path.join(DATA, old.image_path), { force: true });
    }
    drive.syncCaseNow(updated.id);
    return updated;
  }],
  ['DELETE', /^\/api\/cases\/(\d+)$/, (req, m) => { store.deleteCase(m[1]); return { ok: true }; }],
  ['POST', /^\/api\/cases\/(\d+)\/favorite$/, (req, m) => {
    const c = store.getCaseRow(m[1]);
    if (!c) throw Object.assign(new Error('案例不存在'), { status: 404 });
    return store.updateCase(m[1], { favorite: !c.favorite });
  }],
  // 浏览器插件一键收藏：只保存图片/视频链接，自动归类，重复的提示词先提醒
  ['POST', /^\/api\/clip$/, async req => {
    // 自定义请求头会触发跨域预检，普通网页无法借用户浏览器往本地库里提交
    if (req.headers['x-plib-client'] !== 'extension') throw Object.assign(new Error('仅限提示词库插件调用'), { status: 403 });
    const b = await readJson(req);
    const prompt = String(b.prompt || '').trim();
    if (!prompt) throw Object.assign(new Error('提示词不能为空'), { status: 400 });
    const link = u => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null);
    const images = [...new Set([b.image_url, ...(Array.isArray(b.images) ? b.images : [])].map(link).filter(Boolean))];
    const video = link(b.video_url);
    const mediaType = video && b.media_type !== 'image' ? 'video' : 'image';
    if (!b.force) {
      const dup = store.findDuplicatePrompt(prompt);
      if (dup) return { duplicate: true, case: dup };
    }
    const title = String(b.title || '').trim() || prompt.replace(/\s+/g, ' ').slice(0, 30);
    const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，、;；]/)).map(s => String(s).trim()).filter(Boolean);
    const manualCat = /^C\d\d$/.test(String(b.category_code || '')) ? b.category_code : null;
    const cls = classify({ title, tags, prompt, mediaType });
    const category = manualCat || cls.category;
    const subcategory = manualCat ? classifyWithin(manualCat, { title, tags, prompt })?.subcategory || null : cls.subcategory;
    const created = store.createCase({
      source: 'user', title, prompt, model: String(b.model || '').trim() || null, media_type: mediaType, tags,
      image_url: images[0] || null, extra_images: JSON.stringify(images.slice(1)), video_url: video,
      source_url: link(b.source_url), note: String(b.note || '').trim(), favorite: !!b.favorite,
      category_code: category, subcategory, classify_score: manualCat ? null : cls.score, classify_source: manualCat ? 'manual' : 'rule',
    });
    drive.syncCaseNow(created.id);
    // 规则归类只看文字，穿搭、版式这类常判错；后台立刻看图重归一次，插件会轮询拿最终结果
    const autotag = manualCat ? false : (labelCaseSoon(created.id), true);
    return {
      duplicate: false, case: created, autotag,
      category_name: category ? store.getCategory(category)?.name || null : null,
      subcategory_name: subcategory ? subcategoryName(subcategory) : null,
    };
  }],
  // 反推提示词：会调用模型、消耗额度，要求带自定义请求头（网页和插件都会带），避免被其他网站借用
  ['POST', /^\/api\/reverse$/, async req => {
    if (!req.headers['x-plib-client']) throw Object.assign(new Error('请从提示词库网页或插件使用反推功能'), { status: 403 });
    const b = await readJson(req, 160 * 1024 * 1024);
    return runReverse({
      imageSrc: b.image || b.image_url || '', videoSrc: b.video || b.video_url || '',
      targetModel: b.target_model, lang: b.lang, hint: b.hint, frames: b.frames,
      output: b.output || 'auto', detail: b.detail !== false, refine: b.refine,
      modelOverride: b.llm_model || '',
    });
  }],
  ['POST', /^\/api\/reverse\/refine$/, async req => {
    if (!req.headers['x-plib-client']) throw Object.assign(new Error('请从提示词库网页或插件使用反推功能'), { status: 403 });
    const b = await readJson(req, 60 * 1024 * 1024);
    return refineWithGenerated({ id: b.id, imageSrc: b.image || b.image_url || '', lang: b.lang, hint: b.hint , modelOverride: b.llm_model || '' });
  }],
  // ---------- Google 云盘 ----------
  ['GET', /^\/api\/drive\/status$/, async () => {
    const status = { ...gd.publicStatus(), counts: drive.syncCounts(), estimate: drive.estimate(), sync: drive.syncState };
    if (status.connected) {
      try {
        if (!quotaCache || Date.now() - quotaCache.at > 60000) quotaCache = { at: Date.now(), value: (await gd.about()).storageQuota };
        status.quota = quotaCache.value;
      } catch (e) {
        status.error = e.message;
      }
    }
    return status;
  }],
  ['PUT', /^\/api\/drive\/config$/, async req => { requireClient(req); return gd.saveConfig(await readJson(req)); }],
  ['GET', /^\/api\/drive\/auth-url$/, req => { requireClient(req); return { url: gd.authUrl(`http://127.0.0.1:${PORT}/api/drive/callback`) }; }],
  ['POST', /^\/api\/drive\/sync$/, async req => {
    requireClient(req);
    const b = await readJson(req);
    if (b.action === 'stop') { drive.syncState.stopRequested = true; return { ok: true, sync: drive.syncState }; }
    if (drive.syncState.running) throw Object.assign(new Error('同步已经在进行中'), { status: 409 });
    drive.runSync({ concurrency: Number(b.concurrency) || 3, only: b.only || '', log: m => console.log(`[云盘同步] ${m}`) }).catch(e => console.error(`[云盘同步] ${e.message}`));
    await new Promise(r => setTimeout(r, 300));
    return { ok: true, sync: drive.syncState };
  }],
  ['POST', /^\/api\/drive\/disconnect$/, req => { requireClient(req); drive.syncState.stopRequested = true; quotaCache = null; return gd.disconnect(); }],
  ['POST', /^\/api\/auto-tag$/, async req => {
    const b = await readJson(req);
    return autoTag({ title: b.title, prompt: b.prompt, imageDataUrl: b.image });
  }],
  ['GET', /^\/api\/settings$/, () => maskedSettings()],
  ['PUT', /^\/api\/settings$/, async req => {
    const b = await readJson(req);
    const patch = {};
    for (const k of ['llm_base_url', 'llm_model', 'llm_vision_model', 'llm_temperature', 'llm_max_tokens', 'llm_fallback_model',
      'tagger_base_url', 'tagger_model']) if (k in b) patch[k] = String(b[k] ?? '').trim();
    if (b.llm_api_key) patch.llm_api_key = String(b.llm_api_key).trim();
    if (b.tagger_api_key) patch.tagger_api_key = String(b.tagger_api_key).trim();
    if (b.clear_tagger_key) patch.tagger_api_key = '';
    if (b.clear_api_key) patch.llm_api_key = '';
    store.setSettings(patch);
    return maskedSettings();
  }],
  ['POST', /^\/api\/settings\/test$/, () => testConnection()],
  ['POST', /^\/api\/generate$/, async req => {
    const b = await readJson(req);
    return runGeneration({
      imageDataUrl: b.image || null, goal: b.goal, category: b.category, aspectRatio: b.aspect_ratio,
      lang: b.lang, referenceIds: Array.isArray(b.reference_ids) ? b.reference_ids.map(Number) : [],
      targetModel: b.target_model, output: b.output || 'auto', detail: b.detail !== false, refine: b.refine,
      modelOverride: b.llm_model || '',
    });
  }],
  // 模型接口里可用的模型列表，供网页下拉选择（缓存 5 分钟）
  ['GET', /^\/api\/llm-models$/, async () => {
    const s = store.getSettings();
    const base = String(s.llm_base_url || '').replace(/\/+$/, '');
    if (!base) return { models: [], error: '还没有配置模型接口' };
    if (llmModelCache && Date.now() - llmModelCache.at < 300000) return llmModelCache.value;
    try {
      const r = await fetch(`${base}/models`, {
        headers: s.llm_api_key ? { Authorization: `Bearer ${s.llm_api_key}` } : {},
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      const models = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).sort();
      llmModelCache = { at: Date.now(), value: { models, current: s.llm_vision_model || s.llm_model || '' } };
      return llmModelCache.value;
    } catch (e) {
      return { models: [], current: s.llm_vision_model || s.llm_model || '', error: `读取模型列表失败：${e.message}` };
    }
  }],
  ['POST', /^\/api\/generate\/refine$/, async req => {
    if (!req.headers['x-plib-client']) throw Object.assign(new Error('请从提示词库网页使用对比修正'), { status: 403 });
    const b = await readJson(req, 60 * 1024 * 1024);
    return refineGeneration({ id: b.id, imageSrc: b.image || b.image_url || '', lang: b.lang, hint: b.hint , modelOverride: b.llm_model || '' });
  }],
  ['GET', /^\/api\/generations$/, () => store.listGenerations(50)],
  ['GET', /^\/api\/generations\/(\d+)$/, (req, m) => store.getGeneration(m[1]) || Promise.reject(Object.assign(new Error('记录不存在'), { status: 404 }))],
  ['POST', /^\/api\/generations\/(\d+)\/image$/, async (req, m) => {
    const b = await readJson(req, 60 * 1024 * 1024);
    const gen = store.getGeneration(m[1]);
    if (!gen) throw Object.assign(new Error('记录不存在'), { status: 404 });
    let imgPath = null;
    if (b.image) {
      const files = await import('./lib/files.mjs');
      imgPath = files.saveDataUrl(b.image, 'uploads', `gen-${m[1]}`);
    }
    store.getDb().prepare('UPDATE generations SET image_path = ? WHERE id = ?').run(imgPath, Number(m[1]));
    return store.getGeneration(m[1]);
  }],
  ['GET', /^\/api\/bridge\/status$/, async () => {
    const bridge = await import('./lib/web-bridge.mjs');
    return bridge.checkChromeDebugPort();
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname === '/api/drive/callback') {
      const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      let html;
      try {
        const info = await gd.handleCallback(Object.fromEntries(url.searchParams));
        quotaCache = null;
        html = htmlPage('已连接 Google 云盘', `账号：${escHtml(info.user?.emailAddress || '')}。可以关掉这个页面，回到提示词库「设置」点「开始同步」。`);
      } catch (e) {
        html = htmlPage('连接 Google 云盘失败', escHtml(e.message));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (pathname.startsWith('/media/drive/')) return serveDrive(req, res, pathname.slice('/media/drive/'.length));
    if (pathname.startsWith('/api/')) {
      for (const [method, re, handler] of routes) {
        const m = re.exec(pathname);
        if (m && req.method === method) return send(res, 200, await handler(req, m, url));
      }
      return send(res, 404, { error: '接口不存在' });
    }
    if (pathname.startsWith('/files/')) {
      const rel = pathname.slice('/files/'.length);
      const abs = (rel.startsWith('images/') || rel.startsWith('uploads/') || rel.startsWith('media/')) && within(DATA, rel);
      if (!abs) { res.writeHead(403); return res.end('Forbidden'); }
      return serveFile(res, abs);
    }
    const abs = within(PUBLIC, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!abs) { res.writeHead(403); return res.end('Forbidden'); }
    return serveFile(res, abs);
  } catch (e) {
    if (!e.status) console.error(e);
    // 模型接口、云盘等外部服务出错时也记进日志，方便排查
    else if (e.status >= 500) console.error(`[${new Date().toLocaleString('sv')}] ${req.method} ${pathname} → ${e.status} ${String(e.message).slice(0, 300)}`);
    return send(res, e.status || 500, { error: e.message || String(e) });
  }
});

// 检测到系统代理时，以走代理的方式重新启动（Google 云盘需要）
if (!relaunchWithProxy()) {
  store.getDb();
  if (!store.listCategories().length) {
    console.log('数据库为空，请先运行：npm run import');
  }
  server.listen(PORT, HOST, () => console.log(`提示词库已启动：http://${HOST}:${PORT}`));
}
