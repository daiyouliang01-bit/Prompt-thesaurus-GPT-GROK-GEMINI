// 反推提示词：看图片或视频（自动抽帧），逆向分析画面，再按目标模型的写法写出能复现它的提示词
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from './db.mjs';
import { tagFacets } from './facets.mjs';
import { chatJson } from './llm.mjs';
import { saveDataUrl, relToUrl } from './files.mjs';
import { resolveLlm, capOf, softenBody } from './generate.mjs';
import { DATA } from './paths.mjs';

const exec = promisify(execFile);
const MAX_BYTES = 300 * 1024 * 1024;
const LANG = { zh: '中文', en: '英文', both: '中英双语（prompt 写中文版，prompt_en 写英文版）' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const asArr = v => (Array.isArray(v) ? v : v ? [v] : []);

function findBin(name) {
  const candidates = [process.env[`PLIB_${name.toUpperCase()}`], `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  return candidates.find(p => p && fs.existsSync(p)) || name;
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

async function ff(bin, args) {
  try {
    return await exec(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('没有找到 ffmpeg，请先安装：brew install ffmpeg', 500);
    throw fail(`处理媒体文件失败：${String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`);
  }
}

// ---------- 读取素材 ----------
const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/x-m4v': 'm4v',
};
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i;
const kindOf = (mime, name) => (/^video\//.test(mime) || VIDEO_EXT.test(name) ? 'video' : /^image\//.test(mime) || IMAGE_EXT.test(name) ? 'image' : '');

// 下载用 curl：Node 自带的 fetch 不走代理，而很多海外图片/视频站点需要经过本机代理（如 Clash 的 127.0.0.1:7890）
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
let systemProxy;
async function detectSystemProxy() {
  if (systemProxy !== undefined) return systemProxy;
  systemProxy = '';
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) return systemProxy; // curl 会自己读环境变量
  if (process.platform !== 'darwin') return systemProxy;
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--proxy']);
    const get = k => new RegExp(`\\b${k}\\s*:\\s*(\\S+)`).exec(stdout)?.[1];
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) systemProxy = `http://${get('HTTPSProxy')}:${get('HTTPSPort') || 80}`;
    else if (get('SOCKSEnable') === '1' && get('SOCKSProxy')) systemProxy = `socks5h://${get('SOCKSProxy')}:${get('SOCKSPort') || 1080}`;
  } catch { /* 读不到系统代理就直连 */ }
  return systemProxy;
}

/** 下载到 file，返回 Content-Type（不含参数，小写） */
export async function download(url, file) {
  const proxy = await detectSystemProxy();
  const args = ['-sSL', '--fail', '--compressed', '-m', '240', '--max-filesize', String(MAX_BYTES), '-A', UA, '-e', `${new URL(url).origin}/`, '-o', file, '-w', '%{content_type}'];
  if (proxy) args.push('-x', proxy, '--noproxy', 'localhost,127.0.0.1,::1');
  args.push(url);
  try {
    const { stdout } = await exec(findBin('curl'), args, { maxBuffer: 1024 * 1024 });
    return String(stdout || '').split(';')[0].trim().toLowerCase();
  } catch (e) {
    if (e.code === 'ENOENT') throw fail('没有找到 curl，无法下载链接里的文件', 500);
    if (e.code === 63) throw fail('文件超过 300MB，请先压缩或截取片段');
    const msg = String(e.stderr || e.message).trim().replace(/^curl: \(\d+\)\s*/, '');
    throw fail(`下载失败：${msg || '网络错误'}${proxy ? '' : '（如果这个网站需要代理，请确认代理软件已开启）'}`, 502);
  }
}

/** 把 data URL / 网络链接 / 本地路径（仅命令行）落成临时文件 */
export async function materialize(src, dir, { allowLocal, name }) {
  src = String(src || '').trim();
  const data = /^data:([\w/+.-]+);base64,(.+)$/s.exec(src);
  if (data) {
    const file = path.join(dir, `${name}.${EXT_BY_MIME[data[1]] || 'bin'}`);
    fs.writeFileSync(file, Buffer.from(data[2], 'base64'));
    return { file, kind: kindOf(data[1], file), source: '上传的文件' };
  }
  if (/^https?:\/\//i.test(src)) {
    const urlPath = new URL(src).pathname;
    const tmp = path.join(dir, `${name}.download`);
    const mime = await download(src, tmp);
    if (mime === 'text/html') throw Object.assign(fail('这是网页地址，不是图片或视频文件本身'), { pageLink: true });
    const file = path.join(dir, `${name}.${EXT_BY_MIME[mime] || urlPath.match(/\.(\w{2,4})$/)?.[1] || 'bin'}`);
    fs.renameSync(tmp, file);
    return { file, kind: kindOf(mime, urlPath), source: src };
  }
  if (!allowLocal) throw fail('请上传文件，或填写以 http(s) 开头的链接');
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) throw fail(`找不到文件：${src}`);
  return { file: abs, kind: kindOf('', abs), source: abs };
}

async function probe(file) {
  const { stdout } = await ff(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout || '{}');
  const s = j.streams?.[0] || {};
  return { width: Number(s.width) || 0, height: Number(s.height) || 0, duration: Number(j.format?.duration) || 0 };
}

export async function grabFrame(file, dir, name, t, maxSide) {
  const out = path.join(dir, `${name}.jpg`);
  const args = ['-y', '-v', 'error'];
  if (t > 0) args.push('-ss', t.toFixed(2));
  args.push('-i', file, '-frames:v', '1', '-vf', `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', out);
  await ff(FFMPEG, args);
  if (!fs.existsSync(out)) throw fail('没能从文件里读出画面');
  return `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
}

/** 精细模式：把图片切成 4 块互相重叠的局部并放大，让模型看清服装结构、饰品、文字等小细节 */
export async function grabTiles(file, dir) {
  const out = [];
  for (const [label, cx, cy] of [['左上', 0, 0], ['右上', 1, 0], ['左下', 0, 1], ['右下', 1, 1]]) {
    const f = path.join(dir, `tile${cx}${cy}.jpg`);
    const vf = `crop=iw*0.58:ih*0.58:${cx ? 'iw*0.42' : '0'}:${cy ? 'ih*0.42' : '0'},scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease`;
    try {
      await ff(FFMPEG, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '3', f]);
    } catch { continue; }
    if (fs.existsSync(f)) out.push({ t: 0, label: `${label}局部放大`, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}` });
  }
  return out;
}

function ratioName(w, h) {
  if (!w || !h) return '';
  const r = w / h;
  const list = [['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['2:3', 2 / 3], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:2', 1.5], ['16:9', 16 / 9], ['21:9', 21 / 9]];
  return list.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0];
}

async function loadMedia({ imageSrc, videoSrc, frames, allowLocal, detail }, dir) {
  let item = null;
  let notice = '';
  if (videoSrc) {
    try {
      item = await materialize(videoSrc, dir, { allowLocal, name: 'video' });
      item.kind ||= 'video';
    } catch (e) {
      if (!imageSrc) throw e.pageLink ? fail('视频链接是网页地址，不是视频文件。请复制 .mp4 直链，或把视频下载后上传') : e;
      notice = `视频本身没有取到（${e.message}），已改用封面图反推，动作和运镜是根据画面推测的`;
    }
  }
  if (!item && imageSrc) {
    try {
      item = await materialize(imageSrc, dir, { allowLocal, name: 'image' });
    } catch (e) {
      throw e.pageLink ? fail('图片链接是网页地址，请在图片上右键“复制图片地址”后再试') : e;
    }
    item.kind ||= 'image';
  }
  if (!item) throw fail('请提供图片或视频');

  const info = await probe(item.file);
  if (!info.width) throw fail('读不出画面，文件可能损坏，或不是图片/视频');
  const isVideo = item.kind === 'video' && info.duration > 0.3;
  const list = [];
  if (isVideo) {
    const count = Math.min(Math.max(Number(frames) || 8, 2), 16);
    for (let i = 0; i < count; i++) {
      const t = Math.min((info.duration * (i + 0.5)) / count, Math.max(info.duration - 0.1, 0));
      list.push({ t: Number(t.toFixed(1)), dataUrl: await grabFrame(item.file, dir, `f${i}`, t, 768) });
    }
  } else {
    list.push({ t: 0, label: '全图', dataUrl: await grabFrame(item.file, dir, 'still', 0, detail ? 2048 : 1536) });
    if (detail) list.push(...await grabTiles(item.file, dir));
  }
  return {
    type: isVideo ? 'video' : 'image', videoFallback: !!notice, notice, source: item.source,
    width: info.width, height: info.height, aspect: ratioName(info.width, info.height),
    duration: isVideo ? Number(info.duration.toFixed(1)) : 0, frames: list,
  };
}

// ---------- 目标模型的写法 ----------
const IMAGE_GUIDE = '通用图像模型：自然语言分段描述，按“主体 → 外貌与身材 → 服装配饰 → 姿态动作 → 表情眼神 → 场景道具 → 光线 → 镜头与构图 → 色调风格与质感 → 画面文字（逐字加引号） → 禁止项”组织，每项写到可以照着复现。';
const VIDEO_GUIDE = '视频模型：先写整体设定（风格、画幅、时长、画质），再写角色与场景的固定描述（保持前后一致），然后按时间码分镜，例如 [00:00-00:03] 景别与运镜 + 人物动作（幅度、速度、方向）+ 表情的面部细节 + 光线或场景变化 + 声音/台词。动作和运镜写具体可执行的物理描述，不写抽象形容。';
const MODEL_GUIDES = [
  [/midjourney|\bmj\b|niji/i, 'Midjourney：英文。先用一句话写主体与画面，再用逗号分隔的短语补充外观、场景、光线、镜头、风格、材质；末尾加参数，如 --ar 16:9 --style raw。不要写成长篇解释。'],
  [/stable\s*diffusion|sdxl|\bsd\b|flux|pony|illustrious|noob/i, 'Stable Diffusion / FLUX：英文，逗号分隔的标签式短语，重要元素靠前，可用 (关键词:1.2) 加权；另外单独给 negative prompt。FLUX 可以写成自然语言长句。'],
  [/seedance|veo|sora|可灵|kling|海螺|hailuo|即梦|jimeng|runway|pika|万相|\bwan\b|vidu|omni|视频/i, VIDEO_GUIDE],
  [/nano\s*banana|gemini|imagen/i, 'Nano Banana / Gemini：自然语言完整段落或分段清单，逐项写清主体、外貌、服装、动作、场景、光线、镜头、风格、画面文字与禁止项，细节具体可执行；需要保持人物一致时写明“使用上传的参考图保持人物长相”。'],
  [/gpt|chatgpt|dall|image\s*2/i, 'GPT Image：自然语言结构化长提示词，可以分段或用清单，逐项写清主体、外貌、服装、姿态、场景、光线、镜头参数、色彩、质感、画面文字（逐字加引号）和禁止项。'],
];
const COMPOSITION_NOTE = '无论哪种写法，都要写清“构图与朝向”：主体在画面中的位置（左/中/右、上/下，占画面多大）、身体和脸分别朝向画面左侧还是右侧、哪一侧身体对着镜头、躯干前倾或扭转的角度；主要道具分别在画面哪个位置。左右一律以观看者看到的画面为准。画面文字写清载体（挂轴、屏风、灯笼、招牌，或后期叠加的标题字）、位置、相对大小和字体。';
export function writingGuide(target, videoStyle) {
  const hit = MODEL_GUIDES.find(([re]) => re.test(target || ''));
  // 目标选了视频模型、但这次是出图时，仍按图像写法写
  const guide = hit && !(hit[1] === VIDEO_GUIDE && !videoStyle) ? hit[1] : videoStyle ? VIDEO_GUIDE : IMAGE_GUIDE;
  return `${guide}\n${COMPOSITION_NOTE}`;
}
export const isVideoModel = target => /seedance|veo|sora|可灵|kling|海螺|hailuo|runway|pika|万相|\bwan\b|vidu|omni|视频/i.test(target || '');

// ---------- 调用模型 ----------
// 上游在输出很长时可能被截断（中英双语要写两份提示词）：自动改成单语言、较短输出重试一次
const isTruncation = e => e.status === 502 && /truncation|upstream stream ended/i.test(e.message || '');
export async function askVisionWithFallback(llm, system, buildText, frames, isVideo, maxTokens, lang) {
  const variants = [
    { lang, soften: false },
    ...(lang === 'both' ? [{ lang: 'zh', soften: false }] : []),
    { lang, soften: true },
    ...(llm.fallbackModel ? [{ lang, soften: false, model: llm.fallbackModel }] : []),
  ];
  let lastError = null;
  for (const [i, v] of variants.entries()) {
    try {
      const text = v.soften ? softenBody(buildText(v.lang)) : buildText(v.lang);
      return await askVision(llm, system, text, frames, isVideo, i ? 0 : maxTokens, v.model);
    } catch (e) {
      lastError = e;
      if (!isTruncation(e) || i === variants.length - 1) break;
      const next = variants[i + 1];
      console.warn(`[反推] 第 ${i + 1} 次被模型服务拒绝，${next.model ? `改用备用模型 ${next.model}` : `降级重试（语言 ${next.lang}${next.soften ? '，措辞温和化' : ''}）`}`);
    }
  }
  throw lastError;
}

export async function askVision(llm, system, text, frames, isVideo, maxTokens, modelOverride = '') {
  const content = [{ type: 'text', text }];
  for (const f of frames) {
    if (isVideo) content.push({ type: 'text', text: `第 ${f.t} 秒的画面：` });
    else if (f.label) content.push({ type: 'text', text: `【${f.label}】` });
    content.push({ type: 'image_url', image_url: { url: f.dataUrl } });
  }
  return chatJson({
    baseUrl: llm.baseUrl, apiKey: llm.apiKey, temperature: llm.temperature, maxTokens: capOf(llm, maxTokens), model: modelOverride || llm.visionModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
  });
}

const validCategory = code => {
  const c = String(code || '').trim().toUpperCase();
  return c && store.getCategory(c) ? c : '';
};

const formatReferences = refs => refs.map(r => `#${r.id} ${r.title}（${r.category_code || ''} / ${r.model || ''}）
提示词：
${(r.prompt || '').slice(0, 1500)}`).join('\n\n---\n\n');

const SYSTEM_ANALYZE = '你是 AI 图像/视频提示词逆向工程专家。你的任务是仔细观察给定的画面，把还原它所需的全部信息客观、具体地整理出来。只输出一个 JSON 对象，不要任何其他文字。';
const SYSTEM_COMPOSE = '你是提示词工程师。根据对素材的逆向分析、目标模型的写法要求、提示词库的模板和真实案例，写出能复现这张图片或这段视频的提示词。必须忠实于画面，不添加画面里没有的元素；所有占位符都要替换成具体内容。只输出一个 JSON 对象，不要任何其他文字。';

function analyzeText({ mediaLine, hint, videoStyle }) {
  return `【模板库类别】
${store.listCategories().map(c => `${c.code} ${c.name}：${c.description}`).join('\n')}

【素材】${mediaLine}
【用户补充说明】${hint || '无'}

请逐项仔细观察，写到别人只看文字就能画出几乎一样的画面。人物外貌和身材用客观的物理描述（形状、比例、位置），不用抽象评价。看不清或无法确定的写进 uncertain，不要编造。
左右一律以观看者看到的画面为准，先判断清楚人物面朝画面哪一侧、哪一侧身体对着镜头，这是最容易弄反的地方。
如果附有【局部放大】图：用【全图】判断整体构图、朝向和位置，用局部图看清服装结构、饰品、文字、道具和皮肤等细节。

输出 JSON：
{
  "target_category": "最匹配的类别编号，如 C01${videoStyle ? '；视频填 C16' : ''}",
  "secondary_categories": ["可同时参考的类别编号"],
  "subtype": "最接近的子类型，如：雨夜街拍人像",
  "keywords": ["6-12 个中文检索关键词：画面类型、风格、主体、场景、镜头"],
  "aspect_ratio": "画幅，如 9:16",
  "overall": "一句话概括画面${videoStyle ? '或视频' : ''}内容",
  "subject": "主体：数量、年龄感、性别、外貌五官、发型发色、身材比例",
  "clothing": "服装与配饰总述：款式、材质、颜色、穿着状态",
  "clothing_pieces": ["逐件写服装结构，每件一条：领口与肩部（是否露肩、挂在手臂上的位置）、袖型与袖长、衣长（是否露腰、露到哪里）、腰线高低、裙或裤的长度、开衩的位置与高度、面料透明度、花纹与刺绣、流苏等配件"],
  "pose_action": "姿态、手势、动作，逐个部位写：躯干前倾或扭转的角度、头部转向与倾斜、两只手臂和手分别在做什么、腿的站姿与重心${videoStyle ? '（写出动作过程与幅度）' : ''}",
  "composition": "构图：主体在画面中的位置（左/中/右、上/下）和占比，身体的哪一部分出画；主要道具和前景、背景物体分别在画面哪个位置",
  "orientation": "朝向：身体面朝画面左侧/右侧/正对镜头/背对镜头，脸朝向哪里，哪一侧身体对着镜头，视线看向哪里",
  "expression": "表情与眼神的面部细节",
  "scene": "场景、环境、道具、前景与背景",
  "lighting": "光源方向、光质软硬、色温、明暗对比",
  "camera": "机位按四项写：拍摄锚点与相机高度（相对脸部中心/胸口/脚部等同高、高于还是低于）、人物方位（正面/三分之二侧面/侧面/背面）、镜头朝向（水平正对/向下俯拍/向上仰拍）、景别与人物在画面中的占比；再补充焦段感、景深、构图${videoStyle ? '、运镜方式' : ''}",
  "color_style": "色调与调色、媒介与画风（照片/插画/3D 等）、质感与颗粒",
  "text_in_image": ["画面上的文字，逐字；没有则为空数组"],
  "text_items": [{"text": "逐字", "position": "在画面哪里", "carrier": "载体：挂轴/屏风/灯笼/招牌/后期叠加标题字等", "size": "相对画面的大小", "style": "字体与颜色"}],
  "render_style": "成像风格：真实照片 / 摄影棚写真 / AI 超写实渲染 / 插画等，以及清晰度、锐度、磨皮程度",
  "palette": "主要颜色及大致占比",
  "shots": [${videoStyle ? '{"time": "00:00-00:03", "shot": "景别", "camera_move": "运镜", "action": "动作", "expression": "表情变化", "change": "光线/场景变化"}' : ''}],
  "audio_guess": "${videoStyle ? '可能的声音、音乐或台词，无法判断写空字符串' : ''}",
  "uncertain": ["看不清或无法确定的地方"]
}`;
}

function composeText({ target, guide, cat, refs, analysis, media, lang, hint, videoStyle }) {
  const rules = store.getDoc('rules')?.content || '';
  return `【目标模型与写法】${target || '未指定（按通用写法）'}
${guide}

【通用规则】
${rules.slice(0, 8000)}

【类别模板：${cat.code} ${cat.name}】
${(cat.template_md || '（该类别没有模板，按目标模型写法组织）').slice(0, 16000)}

【最相关的参考案例（真实提示词）】
${formatReferences(refs) || '（无）'}

【对素材的逆向分析】
${JSON.stringify(analysis, null, 2)}

【用户补充说明】${hint || '无'}

【输出要求】
- 语言：${LANG[lang] || LANG.zh}（Midjourney、Stable Diffusion 等只认英文的模型，prompt 用英文写）
- 画幅：${media.aspect || analysis.aspect_ratio || '按画面判断'}${videoStyle && media.duration ? `\n- 时长：约 ${media.duration} 秒，分镜时间码要覆盖整段` : ''}
- 忠实复现：主体外貌、服装、姿态、场景、光线、镜头、色调、质感都写到能复现的程度；人物外貌与身材用客观物理描述。
- 人物画面的机位不要只写“低机位”“平视”这类标签，要写清拍摄锚点与相机高度、人物方位、镜头朝向和景别（人物在画面里多大、看到哪一段身体），焦段只作补充。
- 画面上出现的文字逐字写出并加引号，写清载体、位置和大小（背景里的小字不要写成醒目的标题字）。
- 必须包含构图与朝向：主体位置、面朝画面哪一侧、道具位置；服装按逐件结构写（衣长、是否露腰、腰线高低、开衩位置等），不要用“改良古装”“性感服饰”这类笼统说法代替。
- 借鉴参考案例的写法技巧，但内容以素材为准，不照抄无关内容。

输出 JSON：
{
  "title": "10 字左右的中文标题",
  "prompt": "最终提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "避免项/负面提示词",
  "params": { "aspect_ratio": "", "duration": "", "style": "" },
  "template_used": "使用的写法或模板名称",
  "reference_case_ids": [借鉴到的案例编号数字],
  "explanation": ["反推的关键判断，3-5 条"],
  "tips": ["生成出来不像时怎么调，2-4 条"]
}`;
}

/**
 * 反推流程：读取素材（视频自动抽帧）→ 逆向分析 → 检索模板与案例 → 按目标模型写法写提示词 → 记入生成历史
 */
export async function runReverse({ imageSrc = '', videoSrc = '', targetModel = '', lang = 'zh', hint = '', frames = 8, allowLocal = false, output = 'auto', detail = true, refine, modelOverride = '' } = {}) {
  const doRefine = refine ?? detail;
  if (!imageSrc && !videoSrc) throw fail('请上传图片或视频，或填写链接');
  const llm = resolveLlm();
  // 本次临时换模型（不改设置里的默认模型）
  if (modelOverride) Object.assign(llm, { model: modelOverride, visionModel: modelOverride, fallbackModel: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-reverse-'));
  try {
    const media = await loadMedia({ imageSrc, videoSrc, frames, allowLocal, detail }, dir);
    const isVideo = media.type === 'video';
    const target = String(targetModel || '').trim();
    // 用途：视频素材或明确选了“出视频”才用分镜写法；图片选了视频模型时默认仍按出图写
    const videoStyle = isVideo || media.videoFallback || output === 'video';
    const notices = [media.notice];
    if (!videoStyle && isVideoModel(target)) notices.push(`目标模型「${target}」是视频模型，这张图片已按出图写法反推；要写图生视频提示词，请把用途选成“出视频”`);
    const notice = notices.filter(Boolean).join('；');
    const mediaLine = isVideo
      ? `视频，时长约 ${media.duration} 秒，画面 ${media.width}×${media.height}（约 ${media.aspect}），按时间顺序均匀抽取了 ${media.frames.length} 帧，每帧前标注了时间`
      : `${media.videoFallback ? '视频的封面图（没能取到视频本身，动作和运镜需要根据画面合理推测）' : '图片'}，${media.width}×${media.height}（约 ${media.aspect}）`;

    const analysis = await askVision(llm, SYSTEM_ANALYZE, analyzeText({ mediaLine, hint, videoStyle }), media.frames, isVideo, 8192);
    const catCode = (videoStyle && store.getCategory('C16') ? 'C16' : '') || validCategory(analysis.target_category) || 'C01';
    const cat = store.getCategory(catCode);
    const { facets: wantFacets } = tagFacets({
      title: analysis.subtype || '',
      tags: asArr(analysis.keywords).join(','),
      prompt: JSON.stringify(analysis).slice(0, 4000),
    });
    const refs = store.retrieveReferences({
      keywords: [...asArr(analysis.keywords), analysis.subtype || ''],
      category: catCode, secondary: asArr(analysis.secondary_categories).map(validCategory).filter(Boolean), limit: 5,
      facets: wantFacets,
    });
    const composeFrames = isVideo ? media.frames.filter((_, i) => i % 2 === 0) : media.frames;
    const result = await askVisionWithFallback(llm, SYSTEM_COMPOSE,
      l => composeText({ target, guide: writingGuide(target, videoStyle), cat, refs, analysis, media, lang: l, hint, videoStyle }),
      composeFrames, isVideo, 16384, lang);

    // 自检：模型对照原图逐项核对草稿，修正遗漏和写错的地方
    if (doRefine && result.prompt) {
      try {
        const review = await askVision(llm, SYSTEM_REVIEW,
          reviewText({ target, guide: writingGuide(target, videoStyle), draft: result, lang }),
          isVideo ? composeFrames : media.frames, isVideo, 16384);
        if (String(review.prompt || '').trim()) {
          const draft = result.prompt;
          Object.assign(result, {
            prompt: review.prompt, prompt_en: review.prompt_en || result.prompt_en,
            negative: review.negative || result.negative, draft_prompt: draft, review: asArr(review.issues),
          });
        }
      } catch (e) {
        notices.push(`自检这一步失败，结果是未自检的草稿（${e.message.slice(0, 80)}）`);
      }
    }

    const thumb = saveDataUrl(media.frames[0].dataUrl, 'uploads');
    const references = refs.map(r => ({
      id: r.id, title: r.title, image: r.image, category_code: r.category_code, subtype: r.subtype,
      source: r.source, pinned: false, prompt_snippet: (r.prompt || '').replace(/\s+/g, ' ').slice(0, 120),
    }));
    const reverseInfo = {
      media_type: media.type, width: media.width, height: media.height, aspect: media.aspect, duration: media.duration,
      frames: media.frames.length, target_model: target || '通用', source: media.source,
      output: videoStyle ? 'video' : 'image', detail: !!detail, refined: !!result.review, round: 1,
      notice: notices.filter(Boolean).join('；'),
    };
    const id = store.saveGeneration({
      goal: `【反推】${result.title || analysis.overall || ''}`.slice(0, 80), image_path: thumb, category_code: catCode,
      analysis: { ...analysis, reverse: reverseInfo }, references, result, model: llm.visionModel,
    });
    return {
      id, image: relToUrl(thumb), category: { code: cat.code, name: cat.name }, analysis, references, result,
      media: { ...reverseInfo, frames: media.frames }, notice: reverseInfo.notice,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 自检与对比修正 ----------
const SYSTEM_REVIEW = '你是严格的提示词审校。对照原图逐项核对提示词草稿，找出遗漏、写错、写得太笼统而会导致生成结果不像原图的地方，然后输出修订后的完整提示词。只输出一个 JSON 对象，不要任何其他文字。';
const SYSTEM_COMPARE = '你是 AI 生图对比修正专家。第一张是要复现的原图，第二张是用当前提示词生成的结果。你要找出两张图不一致的地方，判断提示词哪里没写清或写错，然后输出修正后的完整提示词。只输出一个 JSON 对象，不要任何其他文字。';
const CHECK_ITEMS = `1. 构图与朝向：主体在画面的位置和占比；身体、脸面朝画面左侧还是右侧（以观看者为准）；哪一侧身体对着镜头；正面/侧面/背面有没有判断错
2. 姿态：躯干前倾或扭转的角度、头部、两只手臂和手、腿与重心
3. 服装结构：逐件核对衣长（是否露腰）、领口与肩部、袖型、腰线高低、裙长、开衩位置与高度、透明度、花纹
4. 发型与饰品
5. 表情与眼神：睁眼还是闭眼、嘴角、视线看向哪里
6. 道具与场景：每样东西的位置，前景和背景
7. 画面文字：逐字、载体、位置、相对大小（背景小字不能写成醒目的标题字）
8. 光线：光源位置、冷暖、明暗
9. 机位与景别：相机高度、方位、镜头朝向、景别
10. 成像风格与质感`;

function reviewText({ target, guide, draft, lang }) {
  return `【目标模型与写法】${target || '未指定（按通用写法）'}
${guide}

【提示词草稿】
${draft.prompt}
${draft.negative ? `\n【避免项草稿】\n${draft.negative}` : ''}

请对照附图，按下面清单逐项核对草稿：
${CHECK_ITEMS}

要求：
- 只根据画面判断，不添加画面里没有的东西；没问题的部分保留原写法。
- 修订后的提示词必须完整（不是只写修改的部分），保持目标模型的写法，语言：${LANG[lang] || LANG.zh}。
- 描述要具体到可以复现：用画面位置、朝向、角度、长度等客观描述代替笼统形容词。

输出 JSON：
{
  "issues": [{"item": "核对项", "problem": "草稿的问题", "fix": "怎么改的"}],
  "prompt": "修订后的完整提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "修订后的避免项"
}`;
}

function compareText({ target, guide, prompt, negative, lang, hint, compact = 0 }) {
  // compact 1：截短当前提示词；2：把身材、暴露相关措辞改温和（模型服务的内容策略会拒绝这类请求）
  if (compact >= 1) prompt = String(prompt || '').slice(0, 1200);
  if (compact >= 2) { prompt = softenBody(prompt); negative = softenBody(negative); hint = softenBody(hint); }
  return `【目标模型与写法】${target || '未指定（按通用写法）'}
${guide}

【当前提示词】
${prompt}
${negative ? `\n【当前避免项】\n${negative}` : ''}

【用户补充说明】${hint || '无'}

请对比【原图】和【生成结果】，按下面清单找出所有不一致的地方，按对“像不像”的影响从大到小排列：
${CHECK_ITEMS}

修正要求：
- 生成结果已经和原图一致的部分，提示词保持不变。
- 不一致的地方，改成更具体、更不容易被误解的描述（位置、朝向、角度、长度、大小等客观描述）；模型反复忽略的要点可以提前到提示词前部，并在避免项里写明不要出现的错误（例如“不要背对镜头”“文字不要做成大标题叠字”）。
- 输出完整的提示词，保持目标模型的写法，语言：${LANG[lang] || LANG.zh}。

输出 JSON：
{
  "differences": [{"aspect": "核对项", "original": "原图是什么样", "generated": "生成结果是什么样", "fix": "提示词怎么改"}],
  "prompt": "修正后的完整提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "修正后的避免项",
  "tips": ["如果还不像，下一步可以怎么调，1-3 条"]
}`;
}

/** 对比修正：上传用反推提示词生成的图，和原图对比后修正提示词，保存为一条新的反推记录 */
export async function refineWithGenerated({ id, imageSrc = '', lang = '', hint = '', allowLocal = false, modelOverride = '' } = {}) {
  const row = store.getDb().prepare('SELECT * FROM generations WHERE id = ?').get(Number(id));
  if (!row) throw fail('找不到这条反推记录', 404);
  const analysis = JSON.parse(row.analysis_json || '{}');
  const prev = JSON.parse(row.result_json || '{}');
  const references = JSON.parse(row.references_json || '[]');
  const info = analysis.reverse;
  if (!info) throw fail('只有反推记录可以对比修正');
  if (!row.image_path || !fs.existsSync(path.join(DATA, row.image_path))) throw fail('这条记录的原图已经不在了，请重新反推');
  if (!imageSrc) throw fail('请上传用这条提示词生成的图片');
  const llm = resolveLlm();
  if (modelOverride) Object.assign(llm, { model: modelOverride, visionModel: modelOverride, fallbackModel: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-refine-'));
  try {
    const original = await grabFrame(path.join(DATA, row.image_path), dir, 'original', 0, 1280);
    const item = await materialize(imageSrc, dir, { allowLocal, name: 'generated' });
    const generated = await grabFrame(item.file, dir, 'generated-still', 0, 1280);
    const videoStyle = info.media_type === 'video' || info.output === 'video';
    const target = info.target_model === '通用' ? '' : info.target_model || '';
    const outLang = lang || (prev.prompt_en ? 'both' : 'zh');
    const frames = [{ t: 0, label: '原图（要复现的目标）', dataUrl: original }, { t: 0, label: '生成结果（用当前提示词生成的）', dataUrl: generated }];
    // 被模型服务拒绝时逐步瘦身重试：原样 → 单语言 → 截短当前提示词
    const variants = [
      { lang: outLang, compact: 0 },
      ...(outLang === 'zh' ? [] : [{ lang: 'zh', compact: 0 }]),
      { lang: 'zh', compact: 1 }, { lang: 'zh', compact: 2 },
      ...(llm.fallbackModel ? [{ lang: outLang, compact: 0, model: llm.fallbackModel }] : []),
    ];
    let r = null;
    for (const [i, v] of variants.entries()) {
      try {
        r = await askVision(llm, SYSTEM_COMPARE, compareText({
          target, guide: writingGuide(target, videoStyle), prompt: prev.prompt || '', negative: prev.negative, lang: v.lang, hint, compact: v.compact,
        }), frames, false, 0, v.model);
        break;
      } catch (e) {
        if (!isTruncation(e) || i === variants.length - 1) throw e;
        console.warn(`[反推·对比修正] 第 ${i + 1} 次被模型服务拒绝，缩减请求后重试（语言 ${v.lang}，精简级别 ${v.compact}）`);
      }
    }
    if (!String(r.prompt || '').trim()) throw fail('模型没有给出修正后的提示词，请重试', 502);
    const result = {
      ...prev, prompt: r.prompt, prompt_en: r.prompt_en || (outLang === 'zh' ? '' : prev.prompt_en), negative: r.negative || prev.negative,
      previous_prompt: prev.prompt, review: asArr(r.differences), tips: asArr(r.tips).length ? r.tips : prev.tips,
    };
    const compareImage = saveDataUrl(generated, 'uploads');
    const round = (Number(info.round) || 1) + 1;
    const reverseInfo = { ...info, refined_from: row.id, round, compare_image: compareImage, notice: '' };
    const newId = store.saveGeneration({
      goal: `【反推】${String(prev.title || '').replace(/（第\d+轮修正）$/, '')}（第${round}轮修正）`.slice(0, 80),
      image_path: row.image_path, category_code: row.category_code, analysis: { ...analysis, reverse: reverseInfo },
      references, result, model: llm.visionModel,
    });
    const cat = store.getCategory(row.category_code) || { code: row.category_code || '', name: '' };
    return {
      id: newId, image: relToUrl(row.image_path), category: { code: cat.code, name: cat.name }, analysis, references, result,
      media: { ...reverseInfo, frames: [{ t: 0, label: '原图', dataUrl: original }, { t: 0, label: '生成结果', dataUrl: generated }] },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
