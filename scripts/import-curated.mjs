// 导入 GitHub 上开源许可的高质量提示词仓库（只存提示词文字，图片/视频只保存链接）
// 用法：node --disable-warning=ExperimentalWarning scripts/import-curated.mjs [--refresh] [--only youmind,evolink,...]
// 可重复运行：按 source='github' + 条目键更新，保留收藏、备注和手动归类；与库里已有提示词重复的条目会跳过
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA } from '../lib/paths.mjs';
import * as store from '../lib/db.mjs';
import { classify, taxonomy } from '../lib/classify.mjs';

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const ONLY = (() => { const i = args.indexOf('--only'); return i === -1 ? null : new Set(String(args[i + 1] || '').split(',')); })();
const CACHE = path.join(DATA, 'sources', 'github');
fs.mkdirSync(CACHE, { recursive: true });
const HEADERS = { 'User-Agent': 'personal-prompt-library' };
const MIN_PROMPT_CHARS = 40;

async function getText(url, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      const text = await r.text();
      fs.writeFileSync(file, text);
      return text;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
}
const raw = (repo, p) => `https://raw.githubusercontent.com/${repo}/HEAD/${p}`;
const cacheKey = (repo, p) => `${repo.replace('/', '__')}__${p.replace(/\//g, '_')}`;
const getRepoFile = (repo, p) => getText(raw(repo, p), cacheKey(repo, p));

async function findRepoPath(repo, basename) {
  const tree = JSON.parse(await getText(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, cacheKey(repo, 'tree.json')));
  const hit = (tree.tree || []).find(t => t.type === 'blob' && path.basename(t.path) === basename);
  if (!hit) throw new Error(`${repo} 里找不到 ${basename}`);
  return hit.path;
}

// ---------- Markdown 解析工具 ----------
function splitBlocks(md, headingRe) {
  const lines = md.split('\n');
  const blocks = [];
  let h2 = '';
  let cur = null;
  let inFence = false;
  for (const line of lines) {
    // 代码块里的 # 标题属于提示词内容，不能当作分段
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || /^\s*```/.test(line)) { if (cur) cur.lines.push(line); continue; }
    if (/^## /.test(line)) { h2 = line.replace(/^## /, '').replace(/^[^\p{L}\p{N}]+/u, '').trim(); if (cur) { blocks.push(cur); cur = null; } continue; }
    const m = headingRe.exec(line);
    if (m) { if (cur) blocks.push(cur); cur = { m, section: h2, lines: [] }; continue; }
    if (/^### /.test(line)) { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks.map(b => ({ ...b, body: b.lines.join('\n') }));
}
function codeAfter(body, markerRe) {
  const lines = body.split('\n');
  let i = 0;
  if (markerRe) { i = lines.findIndex(l => markerRe.test(l)); if (i === -1) return ''; }
  const start = lines.findIndex((l, k) => k >= i && /^\s*```/.test(l));
  if (start === -1) return '';
  const end = lines.findIndex((l, k) => k > start && /^\s*```\s*$/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}
function sectionText(body, startRe) {
  const lines = body.split('\n');
  const i = lines.findIndex(l => startRe.test(l));
  if (i === -1) return '';
  const out = [];
  for (const l of lines.slice(i + 1)) { if (/^####|^\*\*|^```/.test(l)) break; out.push(l); }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
function imagesIn(body, base = '') {
  const urls = [];
  for (const m of body.matchAll(/<img[^>]*?src="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let u = m[1] || m[2];
    if (/shields\.io|badge|avatar|logo/i.test(u)) continue;
    if (!/^https?:/.test(u)) { if (!base) continue; u = base + u.replace(/^\.?\//, ''); }
    urls.push(u);
  }
  return [...new Set(urls)];
}
function videosIn(body) {
  const urls = [];
  for (const m of body.matchAll(/https?:\/\/[^\s)"'<>]+?\.(?:mp4|mov|webm)(?:\?[^\s)"'<>]*)?/gi)) urls.push(m[0]);
  for (const m of body.matchAll(/^\s*(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)\s*$/gm)) urls.push(m[1]);
  return [...new Set(urls)];
}
const slug = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80);
const fillArgs = p => p.replace(/\{argument name="[^"]*" default="([^"]*)"\}/g, '$1').replace(/\{argument name=\\"[^"]*\\" default=\\"([^"]*)\\"\}/g, '$1');

// ---------- 各来源适配 ----------
const ADAPTERS = [];
const adapter = (id, meta, fn) => ADAPTERS.push({ id, ...meta, fn });

function youmind(id, repo, model, mediaType) {
  adapter(id, { repo, license: 'CC BY 4.0', label: 'YouMind 精选' }, async () => {
    const md = await getRepoFile(repo, 'README.md');
    // 前几条带 "No. N:" 编号的是精选，后面是不带编号的新近条目，两种格式都要解析
    return splitBlocks(md, /^### (?:No\. (\d+): )?(.+)$/).filter(b => /^#### .*Prompt/m.test(b.body)).map(b => {
      const watch = /\((https:\/\/youmind\.com\/[^)]*[?&]id=(\d+))\)/.exec(b.body);
      const author = /\*\*Author:\*\* \[([^\]]+)\]\(([^)]+)\)/.exec(b.body);
      const src = /\*\*Source:\*\* \[[^\]]*\]\(([^)]+)\)/.exec(b.body);
      const vids = videosIn(b.body);
      const imgs = imagesIn(b.body);
      return {
        key: `${id}:${watch?.[2] || b.m[1] || slug(b.m[2])}`, title: b.m[2].trim(), prompt: fillArgs(codeAfter(b.body, /^#### .*Prompt/)),
        description: sectionText(b.body, /^#### .*Description/) || /^> (.+)$/m.exec(b.body)?.[1] || '', model, mediaType,
        images: imgs, video: vids[0] || null, author: author?.[1], sourceUrl: src?.[1] || author?.[2],
        tags: /Featured/.test(b.body) ? ['精选'] : [], section: '',
        extraNote: mediaType === 'video' && !vids.length && watch ? `视频在线观看：${watch[1]}` : '',
      };
    });
  });
}
youmind('youmind-nbp', 'YouMind-OpenLab/awesome-nano-banana-pro-prompts', 'Nano Banana Pro', 'image');
youmind('youmind-gi2', 'YouMind-OpenLab/awesome-gpt-image-2', 'GPT Image 2', 'image');
youmind('youmind-sd2', 'YouMind-OpenLab/awesome-seedance-2-prompts', 'Seedance 2.0', 'video');

adapter('evolink', { repo: 'EvoLinkAI/awesome-gpt-image-2-API-and-Prompts', license: 'CC0 1.0', label: 'EvoLink GPT Image 2 案例' }, async () => {
  const md = await getRepoFile('EvoLinkAI/awesome-gpt-image-2-API-and-Prompts', 'README.md');
  return splitBlocks(md, /^### Case (\d+): \[(.+?)\]\((.+?)\)(?: \(by \[@?(.+?)\]\((.+?)\)\))?/).map(b => ({
    key: `evolink:${b.m[1]}:${slug(b.m[2])}`, title: b.m[2], prompt: codeAfter(b.body, /^\*\*Prompt/),
    model: 'GPT Image 2', mediaType: 'image', images: imagesIn(b.body), video: null,
    author: b.m[4], sourceUrl: b.m[3], tags: [], section: b.section.replace(/ Cases$/, ''),
  }));
});

function zerolu(id, repo, model, mediaType, pickLast = false) {
  adapter(id, { repo, license: 'MIT', label: 'ZeroLu 精选' }, async () => {
    const md = await getRepoFile(repo, 'README.md');
    return splitBlocks(md, /^### (?!Sponsor)(.+)$/).filter(b => /^\*\*Prompt/m.test(b.body)).map(b => {
      const title = b.m[1].replace(/^[\d.]+\s*/, '').trim();
      const imgs = imagesIn(b.body);
      const sourceLine = b.body.split('\n').find(l => /Source/.test(l)) || '';
      const links = [...sourceLine.matchAll(/\((https?:\/\/[^)]+)\)/g)].map(x => x[1]);
      const author = /@([\w]+)/.exec(sourceLine)?.[1];
      return {
        key: `${id}:${slug(title)}`, title, prompt: codeAfter(b.body, /^\*\*Prompt/),
        description: /^\*([^*].*?)\*\s*$/m.exec(b.body)?.[1] || '', model, mediaType,
        images: pickLast ? imgs.slice(-1) : imgs, video: mediaType === 'video' ? videosIn(b.body)[0] || null : null,
        author, sourceUrl: links.find(u => /x\.com|twitter\.com/.test(u)) || links[0] || `https://github.com/${repo}`,
        tags: [], section: b.section.replace(/^\d+\.\s*/, ''),
      };
    });
  });
}
zerolu('zerolu-nbp', 'ZeroLu/awesome-nanobanana-pro', 'Nano Banana Pro', 'image');
zerolu('zerolu-gi', 'ZeroLu/awesome-gpt-image', 'GPT Image 2', 'image', true);
zerolu('zerolu-sd2', 'ZeroLu/awesome-seedance', 'Seedance 2.0', 'video');

adapter('zerolu-sd25', { repo: 'ZeroLu/awesome-seedance-2.5', license: 'MIT', label: 'ZeroLu 精选' }, async () => {
  const list = JSON.parse(await getRepoFile('ZeroLu/awesome-seedance-2.5', 'data/community-x-seedance-cases.json'));
  return (Array.isArray(list) ? list : []).filter(it => it.source?.promptStatus === 'complete').map(it => {
    const fb = it.prompt?.fallback || {};
    return {
      key: `zerolu-sd25:${it.id}`, title: it.title?.fallback?.zh || it.title?.fallback?.en || it.id,
      prompt: fb[it.prompt?.originalLanguage] || fb.en || fb.zh || '', model: 'Seedance 2.5', mediaType: 'video',
      images: it.media?.images || [], video: it.readmeVideoUrl || it.media?.videos?.[0] || null,
      author: it.source?.author?.username, sourceUrl: it.source?.tweetUrl, tags: [], section: it.category,
    };
  });
});

adapter('atlas-sd25', { repo: 'AtlasCloudAI/awesome-seedance-2.5-prompts-skills', license: 'CC BY 4.0', label: 'AtlasCloud Seedance 2.5' }, async () => {
  const list = JSON.parse(await getRepoFile('AtlasCloudAI/awesome-seedance-2.5-prompts-skills', 'data/prompts.json'));
  // 只收官方与社区精选；X 抓取条目自身标注为低/中置信度，不收
  return list.filter(it => it.featured || ['official', 'community'].includes(it.source_platform)).map(it => ({
    key: `atlas-sd25:${it.id}`, title: it.title, prompt: it.prompt, description: it.description,
    model: 'Seedance 2.5', mediaType: 'video',
    images: (it.reference_images || []).filter(u => typeof u === 'string' && /^https?:/.test(u)),
    video: /^https?:/.test(it.video_url || '') ? it.video_url : null,
    author: it.author_name, sourceUrl: it.source_link, tags: it.featured ? ['精选'] : [], section: it.category,
  }));
});

adapter('meigen', { repo: 'jau123/MeiGen-AI-Design-MCP', license: 'MIT', label: 'MeiGen 热门榜' }, async () => {
  const list = JSON.parse(await getRepoFile('jau123/MeiGen-AI-Design-MCP', 'data/trending-prompts.json'));
  const MODELS = { nanobanana: 'Nano Banana', gptimage: 'GPT Image' };
  // 质量门槛：原帖点赞 ≥ 300
  return list.filter(it => Number(it.likes) >= 300).map(it => ({
    key: `meigen:${it.id}`, title: (it.prompt || '').split('\n')[0].slice(0, 40), prompt: it.prompt,
    model: MODELS[it.model] || it.model, mediaType: 'image', images: it.images?.length ? it.images : [it.image].filter(Boolean),
    video: null, author: it.author, sourceUrl: it.source_url, tags: it.categories || [], section: (it.categories || [])[0] || '',
    extraNote: `点赞 ${it.likes} · 浏览 ${it.views}`,
  }));
});

adapter('jamez-4o', { repo: 'jamez-bondos/awesome-gpt4o-images', license: 'CC BY 4.0', label: 'GPT-4o 案例集' }, async () => {
  const repo = 'jamez-bondos/awesome-gpt4o-images';
  const md = await getRepoFile(repo, 'README.md');
  return splitBlocks(md, /^### 案例 (\d+)：(.+?)(?: \(by \[@?([^\]]+)\]\(([^)]+)\)\))?\s*$/).map(b => ({
    key: `jamez-4o:${b.m[1]}`, title: b.m[2].trim(), prompt: codeAfter(b.body, /^\*\*提示词/),
    model: 'GPT-4o', mediaType: 'image', images: imagesIn(b.body, `https://raw.githubusercontent.com/${repo}/HEAD/`), video: null,
    author: b.m[3], sourceUrl: /\[原文链接\]\(([^)]+)\)/.exec(b.body)?.[1] || b.m[4], tags: [], section: '',
  }));
});

adapter('cclank', { repo: 'cclank/lanshu-awesome-ai-video-kit', license: 'MIT', label: '蓝书 AI 视频提示词' }, async () => {
  const repo = 'cclank/lanshu-awesome-ai-video-kit';
  const data = JSON.parse(await getRepoFile(repo, await findRepoPath(repo, 'all-prompts.json')));
  const MODELS = {
    'seedance-2.0': 'Seedance 2.0', 'happyhorse-1.0': 'Happy Horse 1.0', 'kling-3.0': '可灵 3.0', 'sora-2': 'Sora 2', 'veo-3': 'Veo 3',
    'hailuo-02': '海螺 02', 'hunyuan-video': '混元视频', 'jimeng-3': '即梦 3.0', 'pika-2.5': 'Pika 2.5', 'runway-gen4': 'Runway Gen-4',
    'wan-2.5': '通义万相 2.5', 'gemini-omni': 'Gemini Omni', 'cogvideox-5b': 'CogVideoX', 'higgsfield-soul': 'Higgsfield Soul',
    'ltx-video': 'LTX Video', 'mochi-1': 'Mochi 1',
  };
  // 只收官方与官方合作平台发布的样板提示词
  return (data.prompts || []).filter(it => ['official', 'official-platform'].includes(it.source?.tier)).map(it => ({
    key: `cclank:${it.id}`, title: it.title, prompt: it.prompt, description: it.notes || '',
    model: MODELS[it.model] || it.model, mediaType: 'video', images: [], video: null,
    author: it.source?.name, sourceUrl: it.source?.url, tags: it.tags || [], section: it.category,
  }));
});

adapter('lich-ad', { repo: 'LichAmnesia/awesome-ad-video-prompts', license: 'CC BY 4.0', label: '广告视频提示词' }, async () => {
  const repo = 'LichAmnesia/awesome-ad-video-prompts';
  const data = JSON.parse(await getRepoFile(repo, 'prompts.json'));
  return (data.sections || []).flatMap(s => (s.prompts || []).map(it => ({
    key: `lich-ad:${it.slug}`, title: it.title, prompt: it.prompt, model: '通用视频', mediaType: 'video',
    images: [], video: null, author: 'LichAmnesia', sourceUrl: `https://github.com/${repo}`,
    tags: [...(it.tags || []), it.aspect, it.duration].filter(Boolean), section: s.key,
  })));
});

// ---------- X 帖子来源：只收人物与影视剧本类 ----------
// renoise-ai 的两个仓库按 X 帖子存档，带作者、原帖链接、视频和封面（CC BY 4.0）
const PEOPLE_DRAMA_TAGS = new Set([
  'Portrait & Fashion', 'Portrait', 'Fashion', 'Story', 'Drama', 'Sitcom', 'Wuxia', 'Historical',
  'Retro Film', 'Heartwarming', 'Twist', 'MV', 'Music & Dance', 'Talking Head', 'Dialogue',
]);
const PEOPLE_DRAMA_TEXT = /短剧|剧本|台词|对白|人物|角色|女主|男主|人像|写真|screenplay|dialogue|monologue|protagonist|character|actress|short film|mini[- ]?drama|storyboard/i;
const keepPeopleDrama = (tags, text) => tags.some(t => PEOPLE_DRAMA_TAGS.has(t)) || PEOPLE_DRAMA_TEXT.test(text.slice(0, 1500));

function ensureTarball(repo, name, keepPrefix) {
  const dir = path.join(CACHE, name);
  // --refresh 时重新下载并解压，保证每日更新能拿到新增的帖子
  if (REFRESH && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return dir;
  const tgz = path.join(CACHE, `${name}.tgz`);
  if (!fs.existsSync(tgz) || REFRESH) {
    execFileSync(findCurl(), ['-sSL', '--fail', '-m', '900', '-o', tgz, `https://codeload.github.com/${repo}/tar.gz/HEAD`], { stdio: 'inherit' });
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['xzf', tgz, '-C', dir, '--strip-components=1', ...(keepPrefix ? [`*/${keepPrefix}`] : [])], { stdio: 'inherit' });
  return dir;
}
const findCurl = () => ['/usr/bin/curl', '/opt/homebrew/bin/curl'].find(p => fs.existsSync(p)) || 'curl';

function renoise(id, repo, dirName, model) {
  adapter(id, { repo, license: 'CC BY 4.0', label: 'X 帖子存档（renoise-ai）' }, async () => {
    let dir = path.join(CACHE, dirName, 'prompts');
    if (REFRESH || !fs.existsSync(dir)) dir = path.join(ensureTarball(repo, dirName, 'data/prompts'), 'data', 'prompts');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const tags = Array.isArray(d.tags) ? d.tags : [];
      const content = String(d.content || '');
      if (!['en', 'zh'].includes(d.language) || !keepPeopleDrama(tags, content)) continue;
      const handle = /x\.com\/([^/?#]+)/.exec(d.author?.link || '')?.[1];
      out.push({
        key: `${id}:${d.id}`, title: String(d.title || '').replace(/…$/, '').slice(0, 60), prompt: content,
        model, mediaType: 'video', images: d.thumbnail ? [d.thumbnail] : [], video: d.videoUrl || null,
        author: handle || d.author?.name, sourceUrl: d.sourceLink, tags, section: tags[0] || '',
      });
    }
    return out;
  });
}
renoise('x-seedance2', 'renoise-ai/awesome-seedance-prompts', 'awesome-seedance-prompts', 'Seedance 2.0');
renoise('x-seedance25', 'renoise-ai/awesome-seedance-2-5-prompts', 'awesome-seedance-2-5-prompts', 'Seedance 2.5');

adapter('learnprompt', { repo: 'LearnPrompt/awesome-seedance', license: 'MIT', label: 'LearnPrompt 验证案例' }, async () => {
  const list = JSON.parse(await getRepoFile('LearnPrompt/awesome-seedance', 'data/cases.json'));
  const items = Array.isArray(list) ? list : list.cases || [];
  return items.filter(it => String(it.promptFull || '').length >= 80).map(it => ({
    key: `learnprompt:${it.slug}`, title: it.title || it.titleEn || it.slug, prompt: it.promptFull,
    description: it.summary || it.summaryEn || '', model: (it.models || [])[0] || 'Seedance 2.0', mediaType: 'video',
    images: it.posterUrl ? [it.posterUrl] : [], video: it.mediaUrl || null,
    author: it.creator, sourceUrl: it.sourceUrl, tags: (it.tags || []).filter(t => !/^(source-|trial-|query-|author-display:|auto-approved|prompt-public)/.test(t)),
    section: it.category || '', extraNote: [it.heatScore ? `热度 ${it.heatScore}` : '', it.evidenceLevel].filter(Boolean).join(' · '),
  }));
});

function youmindSkill(id, file, label) {
  adapter(id, { repo: 'YouMind-OpenLab/ai-image-prompts-skill', license: 'MIT', label: `YouMind ${label}` }, async () => {
    const list = JSON.parse(await getRepoFile('YouMind-OpenLab/ai-image-prompts-skill', `references/${file}.json`));
    return (Array.isArray(list) ? list : []).map(it => ({
      key: `${id}:${it.id}`, title: it.title || '', prompt: String(it.content || ''), description: it.description || '',
      // 这套提示词标注为“不挑模型”，各家图像模型都能用
      model: '通用图像', mediaType: 'image', images: (it.sourceMedia || []).filter(u => /^https?:/.test(u)), video: null,
      sourceUrl: 'https://github.com/YouMind-OpenLab/ai-image-prompts-skill', tags: [label],
      section: label, extraNote: it.needReferenceImages ? '需要上传参考图' : '',
    }));
  });
}
youmindSkill('youmind-portrait', 'profile-avatar', '人像');
youmindSkill('youmind-storyboard', 'comic-storyboard', '分镜');

// ---------- 导入 ----------
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 400);
const db = store.getDb();
const seen = new Set();
for (const r of db.prepare("SELECT prompt FROM cases WHERE source != 'github'").all()) {
  for (const part of String(r.prompt).split(/【[^】\n]{1,20}】\n/)) { const k = norm(part); if (k.length >= MIN_PROMPT_CHARS) seen.add(k); }
}
const findExisting = db.prepare("SELECT id, classify_source FROM cases WHERE source = 'github' AND source_case_id = ?");

const tax = taxonomy();
tax.categories.forEach((c, ci) => c.subs.forEach((s, si) => store.upsertSubcategory({ code: s.code, category_code: c.code, name: s.name, sort: ci * 100 + si })));

const report = [];
const byModel = new Map();
const byCat = new Map();
for (const a of ADAPTERS) {
  if (ONLY && !ONLY.has(a.id)) continue;
  const row = { id: a.id, total: 0, short: 0, dup: 0, created: 0, updated: 0 };
  let items;
  try { items = await a.fn(); } catch (e) { console.error(`✗ ${a.id}: ${e.message}`); continue; }
  row.total = items.length;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const prompt = String(it.prompt || '').trim();
      const k = norm(prompt);
      if (k.length < MIN_PROMPT_CHARS) { row.short++; continue; }
      if (seen.has(k)) { row.dup++; continue; }
      seen.add(k);
      const images = (it.images || []).filter(Boolean);
      const cls = classify({ title: it.title, tags: it.tags || [], prompt, mediaType: it.mediaType });
      const data = {
        source: 'github', source_case_id: it.key, title: String(it.title || '').slice(0, 120) || it.key, prompt,
        model: it.model, media_type: it.mediaType, tags: it.tags || [], original_category: it.section || '',
        image_path: null, image_url: images[0] || null, extra_images: JSON.stringify(images.slice(1)),
        video_url: it.video || null, source_url: it.sourceUrl || `https://github.com/${a.repo}`,
        analysis: it.description || '',
      };
      const note = [`${a.label}（github.com/${a.repo}，${a.license}）`, it.author ? `作者 ${String(it.author).startsWith('@') ? '' : '@'}${it.author}` : '', it.extraNote || ''].filter(Boolean).join(' · ');
      const existing = findExisting.get(it.key);
      if (!existing || !['manual', 'ai'].includes(existing.classify_source)) {
        Object.assign(data, { category_code: cls.category, subcategory: cls.subcategory, classify_score: cls.score, classify_source: 'rule' });
      }
      if (existing) { store.updateCase(existing.id, data); row.updated++; }
      else { store.createCase({ ...data, note }); row.created++; }
      byModel.set(it.model, (byModel.get(it.model) || 0) + 1);
      byCat.set(data.category_code || cls.category || '未分类', (byCat.get(data.category_code || cls.category || '未分类') || 0) + 1);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  report.push(row);
  console.log(`${a.id}: 候选 ${row.total}，新增 ${row.created}，更新 ${row.updated}，与库内重复跳过 ${row.dup}，过短跳过 ${row.short}`);
}
console.log('按模型：', [...byModel.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join('，'));
console.log('按类别：', [...byCat.entries()].sort().map(([k, v]) => `${k} ${v}`).join('，'));
