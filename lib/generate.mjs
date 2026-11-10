import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './db.mjs';
import { tagFacets } from './facets.mjs';
import { chat, chatJson } from './llm.mjs';
import { saveDataUrl, copyImageFile, fileToDataUrl, relToUrl } from './files.mjs';
import { DATA } from './paths.mjs';
import { grabFrame, grabTiles, materialize, writingGuide, isVideoModel, askVision } from './reverse.mjs';

const LANG = { zh: '中文', en: '英文', both: '中英双语（prompt 写中文版，prompt_en 写英文版）' };
const asArr = v => (Array.isArray(v) ? v : v ? [v] : []);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function resolveLlm() {
  const s = store.getSettings();
  const baseUrl = s.llm_base_url || process.env.PLIB_BASE_URL;
  const apiKey = s.llm_api_key || process.env.PLIB_API_KEY;
  const model = s.llm_model || process.env.PLIB_MODEL;
  if (!baseUrl || !model) {
    throw Object.assign(new Error('还没有配置模型接口：请在网页「设置」页填写 Base URL、API Key 和模型名'), { status: 400 });
  }
  const t = s.llm_temperature;
  return {
    baseUrl, apiKey, model,
    visionModel: s.llm_vision_model || model,
    temperature: t !== undefined && t !== '' ? Number(t) : undefined,
    // 输出上限：留空表示不限制（实测思考型模型带上限更容易被截断）
    maxTokensCap: Number(s.llm_max_tokens) || 0,
    // 备用模型：主模型因内容策略拒绝时自动改用（实测 Gemini 会拒的人像请求，Claude 能正常处理）
    fallbackModel: s.llm_fallback_model || '',
  };
}

function categoryBrief() {
  return store.listCategories().map(c => `${c.code} ${c.name}：${c.description}`).join('\n');
}

/** 没设上限时返回 0（不带 max_tokens），设了就不超过它 */
export const capOf = (llm, want) => (llm.maxTokensCap ? Math.min(want || llm.maxTokensCap, llm.maxTokensCap) : 0);

async function askJson(llm, system, text, imageDataUrl, maxTokens = 4096, modelOverride = '') {
  const content = imageDataUrl
    ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageDataUrl } }]
    : text;
  return chatJson({
    baseUrl: llm.baseUrl, apiKey: llm.apiKey, temperature: llm.temperature, maxTokens: capOf(llm, maxTokens),
    model: modelOverride || (imageDataUrl ? llm.visionModel : llm.model),
    messages: [{ role: 'system', content: system }, { role: 'user', content }],
  });
}

/** 有参考图时发图（全图 + 局部放大），没有参考图时只发文字 */
const ask = (llm, system, text, frames, maxTokens, modelOverride = '') => (frames.length
  ? askVision(llm, system, text, frames, false, maxTokens, modelOverride)
  : askJson(llm, system, text, null, maxTokens, modelOverride));

export async function testConnection() {
  const llm = resolveLlm();
  const reply = await chat({
    baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, maxTokens: 1024,
    messages: [{ role: 'user', content: '只回复两个字母：OK' }],
  });
  return { model: llm.model, reply: reply.slice(0, 100) };
}

function validCategory(code) {
  return code && store.getCategory(String(code).trim().toUpperCase()) ? String(code).trim().toUpperCase() : '';
}

const isTrue = v => v === true || String(v).trim().toLowerCase() === 'true';

// 模型服务会拒绝“真人形象 + 身材暴露描述”强度过高的请求（1 秒内 502），也会在输出过长或网络断流时被上游截断
const isTruncation = e => (e.status === 502 || e.status === 500 || e.status === 503 || e.status === 429) || /truncation|upstream stream ended|timeout|timed out|ECONNRESET/i.test(e.message || '');

/** 被拒时逐级降级重试：原样 → 单语言 → 温和化措辞 → 备用模型 */
export async function askWithFallback(llm, system, buildText, frames, maxTokens, lang, label = '提示词库') {
  const isUpstreamFailure = e => /upstream stream ended|truncation|ECONNRESET|timeout/i.test(e.message || '') || e.status === 502 || e.status === 503 || e.status === 429;
  const variants = [
    { lang, soften: false },
    ...(lang === 'both' ? [{ lang: 'zh', soften: false }] : []),
    { lang, soften: true },
    // 最后一招：换备用模型，原样重试（实测最有效）
    ...(llm.fallbackModel ? [{ lang, soften: false, model: llm.fallbackModel }] : []),
  ];
  let lastError = null;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    try {
      const text = v.soften ? softenBody(buildText(v.lang)) : buildText(v.lang);
      return await ask(llm, system, text, frames, i ? 0 : maxTokens, v.model);
    } catch (e) {
      lastError = e;
      if (!isTruncation(e) || i === variants.length - 1) break;
      // 如果是上游直接断流或接口502/429，且配了备用模型，跳过无意义的温和化重试，优先直接转备用模型
      if (isUpstreamFailure(e) && llm.fallbackModel && !v.model) {
        const fbIdx = variants.findIndex(x => x.model === llm.fallbackModel);
        if (fbIdx > i) {
          i = fbIdx - 1;
        }
      }
      const next = variants[i + 1];
      if (next) {
        console.warn(`[${label}] 第 ${i + 1} 次请求失败（${e.message.slice(0, 80)}），${next.model ? `改用备用模型 ${next.model}` : `降级重试（语言 ${next.lang}${next.soften ? '，措辞温和化' : ''}）`}`);
      }
    }
  }
  if (isTruncation(lastError)) {
    throw fail(`模型接口返回异常（${lastError.message.slice(0, 150)}）。可直接在下方「本次用哪个模型写」切换到 DeepSeek 或 Qwen 等更稳定的模型再试。`, 502);
  }
  throw lastError;
}

// ---------- 写法补充 ----------
const PERSON_GUIDE = `【人物保持与改造的写法】用户要保留参考图里的人物（保留长相、五官、身材、同一个人，或在这个人基础上换装、换场景）时：
1. 开头写明“使用上传的参考图作为唯一人物参考”。
2. 写身份锁定清单：脸型、五官形状与比例、肤色、发型发色与发际线、年龄感，以及身高比例、肩宽、胸腰臀比例、腿长比例、体型，都用客观物理描述，并写明“与参考图完全一致，不美化、不重新设计脸、不瘦脸、不拉长腿、不改变身体比例”。
3. 分三段写清：保留什么（身份与身体）、改变什么（按用户需求改的服装、场景、光线、动作，逐项写具体）、禁止什么（换脸、五官变化、身体比例变形、四肢拉长、多余手指、塑料皮肤等）。
4. 身材描写只用来把身体锁定成参考图的样子，不要写出与参考图不同的夸张身材；想突出身材时靠服装剪裁、姿态和光影，不靠改变身体比例。
5. 机位优先平视或接近平视、中长焦人像视角，避免广角贴近和低机位仰拍造成身体变形；写清拍摄锚点、方位、镜头朝向和景别。
6. 服装按逐件结构写（款式、长度、领口、腰线、面料、颜色、穿着状态），鞋和配饰单独写。
7. “使用上传的参考图作为唯一人物参考”和“与参考图完全一致”这类锁定语句是出图时配合上传参考图用的，必须保留，不要为了写成纯画面描述而删掉。`;

const I2V_GUIDE = '【图生视频的写法】写明使用上传的参考图作为首帧或人物参考，人物长相、身材和服装全程与参考图一致；按时间码分镜；动作幅度小而具体（写清方向、距离、速度），表情写面部肌肉等物理细节，避免大幅度动作导致人物变形。';

const SYSTEM_ANALYZE = '你是 AI 图像/视频提示词工程专家，负责分析用户的参考图和目标，拆清楚要保留什么、要改变什么，并把需求归类到提示词模板库的类别中。只输出一个 JSON 对象，不要任何其他文字。';
const SYSTEM_COMPOSE = '你是 AI 图像/视频提示词工程师。必须基于提供的【目标模型与写法】【通用规则】【类别模板】【参考案例】为用户写出可以直接使用的高质量提示词。模板中的【】是填空位，必须全部替换为具体内容，最终提示词里不能残留任何填空占位符。只输出一个 JSON 对象，不要任何其他文字。';
const SYSTEM_REVIEW = '你是严格的提示词审校。对照用户需求（和参考图，如果有）逐项核对提示词草稿，找出没有满足需求、保留项锁定不够、写错或写得太笼统的地方，然后输出修订后的完整提示词。只输出一个 JSON 对象，不要任何其他文字。';
const SYSTEM_COMPARE = '你是 AI 生图对比修正专家。你要对照用户需求和参考图，找出生成结果不符合预期的地方，判断提示词哪里没写清或写错，然后输出修正后的完整提示词。只输出一个 JSON 对象，不要任何其他文字。';

// ---------- 第一步：分析参考图与目标 ----------
async function analyzeInput(llm, { frames, goal, category, aspectRatio, target, output }) {
  const hasImage = frames.length > 0;
  const text = `【模板库类别】
${categoryBrief()}

【用户想要达成的效果】
${goal || '（用户没有写，请根据参考图推断最可能想要的效果：复刻同类风格的画面）'}

【用户额外指定】类别：${category || '无'}；画幅：${aspectRatio || '未指定'}；目标模型：${target || '未指定'}；用途：${output === 'video' ? '出视频（图生视频）' : output === 'image' ? '出图' : '自动判断'}
${hasImage ? '参考图见附件：【参考图全图】用来判断整体构图、朝向和人物；【局部放大】用来看清五官、服装结构、饰品和文字。左右一律以观看者看到的画面为准。' : '用户没有提供参考图。'}

请输出 JSON：
{
  "image_description": "对参考图的客观详细描述：画面类型、主体、风格、构图、光线、色彩、材质、画面上的文字（无图则为空字符串）",
  "task_type": "从零生成 | 以参考图为基础改造（出图时需要上传参考图） | 仅借鉴参考图的风格或构图",
  "person_mode": "是否需要保留参考图里的人物（保留长相、五官、身材、同一个人，或在这个人基础上换装换景），填 true 或 false",
  "identity_lock": "需要保留人物时：脸型、五官形状与比例、肤色、发型发色与发际线、年龄感的客观物理描述；否则为空字符串",
  "body_lock": "需要保留人物时：身高比例、肩宽、胸腰臀比例、腿长比例、体型的客观物理描述；否则为空字符串",
  "composition": "参考图的构图与朝向：主体位置与占比，身体和脸面朝画面哪一侧，机位（拍摄锚点与相机高度、方位、镜头朝向、景别）；无图为空字符串",
  "clothing_pieces": ["参考图里的服装逐件结构：款式、长度、领口、腰线、面料、颜色；无图为空数组"],
  "text_items": ["参考图上的文字：逐字 + 载体 + 位置 + 大小；没有则为空数组"],
  "preserve": ["必须保留的内容（来自需求与参考图）"],
  "change": ["需要改变的内容，每条写具体"],
  "forbid": ["必须避免的问题"],
  "conflicts": ["需求与参考图冲突的地方，以及按需求怎么处理（例如参考图是夜景但需求要白天：光线和环境全部按白天重写）"],
  "output_hint": "这次更适合出图还是出视频，填 image 或 video",
  "target_category": "最匹配的类别编号，如 C06",
  "secondary_categories": ["可同时参考的其他类别编号"],
  "subtype": "该类别中最接近的子类型名称",
  "keywords": ["用于检索案例的关键词，6-12 个，中文为主，覆盖画面类型、风格、主体、用途、构图，如：水墨、城市海报、S型构图"],
  "aspect_ratio": "建议画幅，如 9:16",
  "key_requirements": ["用户目标中必须满足的要点"],
  "text_in_image": ["需要出现在画面上的文字，没有则为空数组"]
}`;
  return askWithFallback(llm, SYSTEM_ANALYZE, () => text, frames, 8192, 'zh', '需求分析');
}

function formatReferences(refs) {
  return refs.map(r => `#${r.id} ${r.title}（${r.category_code || ''} / ${r.subtype || ''}${r.model ? ` / ${r.model}` : ''}${r.source === 'user' ? ' / 用户收藏' : ''}）
分析：${(r.analysis || '').slice(0, 500)}
提示词：
${(r.prompt || '').slice(0, 1800)}`).join('\n\n---\n\n');
}

// ---------- 第二步：按目标模型写法、模板与案例写提示词 ----------
function composeText({ goal, analysis, cat, personTemplate, refs, aspectRatio, lang, target, guide, videoStyle, personMode }) {
  const rules = store.getDoc('rules')?.content || '';
  return `【目标模型与写法】${target || '未指定（按 GPT Image 类自然语言结构化写法）'}
${guide}
${personMode ? `\n${PERSON_GUIDE}\n` : ''}${videoStyle ? `\n${I2V_GUIDE}\n` : ''}
【通用规则】
${rules.slice(0, 12000)}

【类别模板：${cat.code} ${cat.name}】
${(cat.template_md || '（该类别没有模板，按目标模型写法组织）').slice(0, 18000)}
${personTemplate ? `\n【人像模板参考：C01 写实摄影人像】\n${personTemplate.slice(0, 8000)}\n` : ''}
【最相关的参考案例（真实高分提示词）】
${formatReferences(refs) || '（无）'}

【对用户输入的分析】
${JSON.stringify(analysis, null, 2)}

【用户目标】
${goal || '（未填写，按分析结果复刻参考图的同类画面）'}

【输出要求】
- 语言：${LANG[lang] || LANG.zh}（Midjourney、Stable Diffusion 等只认英文的模型，prompt 用英文写）
- 画幅：${aspectRatio || analysis.aspect_ratio || '按模板建议'}
- 若任务需要以参考图为基础，提示词开头写明“使用上传的参考图……”，并写清保留什么、改变什么、禁止什么。
- 若只是借鉴参考图，把参考图里值得借鉴的风格、构图、光线、配色具体写进提示词（不要写“参考附图”）。
- 结构遵循目标模型的写法，以及模板的结构公式与最匹配的子类型模板；借鉴参考案例的写法技巧，但不要照抄无关内容。
- 用户需求里的每个要点都要落实成具体描述；需求与参考图冲突时以需求为准，不残留参考图里被要求改掉的内容。
- 构图与机位写清拍摄锚点、方位、镜头朝向和景别；服装逐件写结构。
- 画面上出现的文字逐字写出并加引号，写清载体、位置和大小。
- 负面/避免项写进 negative；如果模板习惯写进正文，正文里也保留。

输出 JSON：
{
  "prompt": "最终提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "避免项/负面提示词",
  "params": { "aspect_ratio": "", "duration": "", "style": "" },
  "template_used": "使用的模板或子类型名称",
  "reference_case_ids": [借鉴到的案例编号数字],
  "explanation": ["为什么这样写，3-5 条"],
  "tips": ["出图不满意时可以调整的方向，2-4 条"]
}`;
}

const needsSubset = a => ({
  key_requirements: a.key_requirements, preserve: a.preserve, change: a.change, forbid: a.forbid, conflicts: a.conflicts,
  identity_lock: a.identity_lock, body_lock: a.body_lock, text_in_image: a.text_in_image,
});

function reviewText({ target, guide, goal, analysis, draft, lang, hasImage, personMode }) {
  return `【目标模型与写法】${target || '未指定（按 GPT Image 类自然语言结构化写法）'}
${guide}

【用户需求】
${goal || '（未填写，按参考图复刻同类画面）'}

【需求分析】
${JSON.stringify(needsSubset(analysis), null, 2)}

【提示词草稿】
${draft.prompt}
${draft.negative ? `\n【避免项草稿】\n${draft.negative}` : ''}

请${hasImage ? '对照附带的参考图和' : '对照'}用户需求，逐项核对草稿：
1. 用户需求的每个要点是否都写进去、写得具体
2. 需要保留的内容（人物身份、五官、身材比例等）是否有完整的锁定描述，是否和参考图一致
3. 需要改变的内容是否写清，有没有残留参考图里被要求改掉的东西（比如要求白天却还写着夜景光线）
4. 构图与机位：拍摄锚点、方位、镜头朝向、景别；有没有容易导致身体变形的写法（广角贴近、低机位仰拍、夸张的身材描写）
5. 服装逐件结构、鞋和配饰
6. 场景、道具、光线
7. 画面文字：逐字、位置、载体、大小
8. 是否符合目标模型的写法，是否残留填空占位符

要求：没问题的部分保留原写法；修订后的提示词必须完整（不是只写修改的部分）；语言：${LANG[lang] || LANG.zh}。${personMode ? `
- 这次要保留参考图里的人物：提示词开头的“使用上传的参考图作为唯一人物参考”、身份和身体的锁定清单、保留/改变/禁止三部分都必须保留，缺了要补上，不能删掉。` : ''}

输出 JSON：
{
  "issues": [{"item": "核对项", "problem": "草稿的问题", "fix": "怎么改的"}],
  "prompt": "修订后的完整提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "修订后的避免项"
}`;
}

/**
 * 模型服务的内容分类器会拒绝“真人女性 + 身材暴露描述”整体强度过高的请求（1 秒内 502）。
 * 实测把这些措辞改温和、长度基本不变就能通过，所以只在被拒后才降级使用。
 */
export function softenBody(text) {
  return String(text || '')
    .replace(/体现(女生|女性|人物)?的?身材(曲线)?/g, '体态优美')
    .replace(/身材曲线|曲线感|凹凸有致|丰满|细腰|纤腰|翘臀|胸型/g, '体态匀称')
    .replace(/露背|露腰|露腿|露肩|裸露|暴露/g, '剪裁利落')
    .replace(/高开叉|开衩至[^，。；\n]{0,6}|开叉至[^，。；\n]{0,6}/g, '裙摆自然')
    .replace(/薄纱半透明|半透明|透视装|轻薄透明/g, '轻盈面料')
    .replace(/性感|妩媚|诱惑/g, '优雅');
}

function compareText({ target, guide, goal, analysis, prompt, negative, lang, hint, hasRef, compact = 0 }) {
  // compact 1：去掉需求要点 JSON；2：再截短当前提示词；3：把身材、暴露相关措辞改温和
  if (compact >= 2) prompt = String(prompt || '').slice(0, 1200);
  if (compact >= 3) { prompt = softenBody(prompt); negative = softenBody(negative); hint = softenBody(hint); goal = softenBody(goal); }
  return `【目标模型与写法】${target || '未指定（按 GPT Image 类自然语言结构化写法）'}
${guide}

【用户需求】
${goal || '（未填写，按参考图复刻同类画面）'}

${compact >= 1 ? '' : `【需求要点】
${JSON.stringify(needsSubset(analysis), null, 2)}

`}【当前提示词】
${prompt}
${negative ? `\n【当前避免项】\n${negative}` : ''}

【用户补充说明】${hint || '无'}

${hasRef ? '附图第一张是【参考图】，第二张是【生成结果】。' : '附图是【生成结果】（这次没有参考图）。'}请对照用户需求${hasRef ? '和参考图' : ''}，找出生成结果不符合预期的地方，按影响从大到小排列：
1. 需求要点有没有做到
2. 需要保留的人物：脸型五官、肤色、发型、身材比例是否与参考图一致，有没有变形（腿被拉长、头身比失调、手指异常等）
3. 需要改变的服装、场景、光线、动作是否按需求改到位
4. 构图与机位、人物朝向
5. 服装结构细节、配饰和鞋
6. 画面文字
7. 画质与质感（塑料皮肤、过度磨皮、AI 感）

修正要求：
- 已经达成的部分，提示词保持不变。
- 没达成的，改成更具体、更不容易被误解的描述；模型反复忽略的要点提前到提示词前部并加强，把出现的错误写进避免项。
- 输出完整的提示词，保持目标模型的写法，语言：${LANG[lang] || LANG.zh}。

输出 JSON：
{
  "differences": [{"aspect": "核对项", "expected": "应该是什么样", "generated": "生成结果是什么样", "fix": "提示词怎么改"}],
  "prompt": "修正后的完整提示词",
  "prompt_en": "英文版（语言要求包含英文时填写，否则为空字符串）",
  "negative": "修正后的避免项",
  "tips": ["如果还不理想，下一步可以怎么调，1-3 条"]
}`;
}

/** 保存参考图并准备发给模型的画面：全图，精细模式再加 4 张局部放大 */
async function prepareReference({ imageDataUrl, imagePath, detail }, dir) {
  let file;
  let savedImage = null;
  if (imagePath) {
    file = path.resolve(imagePath);
    savedImage = copyImageFile(file, 'uploads');
  } else if (imageDataUrl) {
    savedImage = saveDataUrl(imageDataUrl, 'uploads');
    file = path.join(DATA, savedImage);
  } else {
    return { frames: [], savedImage };
  }
  let full;
  try {
    full = await grabFrame(file, dir, 'reference', 0, detail ? 2048 : 1600);
  } catch {
    full = imageDataUrl || fileToDataUrl(file);
  }
  const frames = [{ t: 0, label: '参考图全图', dataUrl: full }];
  if (detail) {
    try {
      frames.push(...(await grabTiles(file, dir)).map(f => ({ ...f, label: `参考图${f.label}` })));
    } catch { /* 切不了局部就只看全图 */ }
  }
  return { frames, savedImage };
}

/**
 * 完整流程：分析（保留/改变/禁止）→ 检索参考案例 → 按目标模型写法写提示词 → 对照需求与参考图自检 → 记录历史
 * image 可以是 data URL（网页）或本地路径（CLI）
 */
export async function runGeneration({
  imageDataUrl, imagePath, goal = '', category = '', aspectRatio = '', lang = 'zh', referenceIds = [], refLimit = 6,
  targetModel = '', output = 'auto', detail = true, refine, modelOverride = '',
}) {
  goal = String(goal || '').trim();
  if (!goal && !imageDataUrl && !imagePath) throw fail('请至少提供参考图或想要达成的效果');
  const llm = resolveLlm();
  // 本次生成临时指定的模型（网页上的下拉选择），不改设置里的默认模型
  if (modelOverride) Object.assign(llm, { model: modelOverride, visionModel: modelOverride });
  const doRefine = refine ?? detail;
  const target = String(targetModel || '').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-generate-'));
  try {
    const { frames, savedImage } = await prepareReference({ imageDataUrl, imagePath, detail }, dir);
    const hasImage = frames.length > 0;
    const forced = validCategory(category);
    const analysis = await analyzeInput(llm, { frames, goal, category: forced, aspectRatio, target, output });
    const videoStyle = output === 'video' || (output === 'auto' && (isVideoModel(target) || analysis.output_hint === 'video'));
    const personMode = hasImage && isTrue(analysis.person_mode);
    const catCode = forced || (videoStyle && store.getCategory('C16') ? 'C16' : '') || validCategory(analysis.target_category) || (personMode ? 'C01' : 'C06');
    const cat = store.getCategory(catCode);
    const secondary = asArr(analysis.secondary_categories).map(validCategory).filter(Boolean);

    // 用需求和分析结果反推出维度（主体/光线/场景…），让检索优先拿同维度的案例
    const { facets: wantFacets } = tagFacets({
      title: `${goal} ${analysis.subtype || ''}`,
      tags: asArr(analysis.keywords).join(','),
      prompt: JSON.stringify(analysis).slice(0, 4000),
    });
    const refs = store.retrieveReferences({
      keywords: [...asArr(analysis.keywords), analysis.subtype || ''],
      category: catCode, secondary, limit: refLimit, pinnedIds: referenceIds, facets: wantFacets,
    });

    const guide = writingGuide(target, videoStyle);
    const personTemplate = personMode && catCode !== 'C01' ? store.getCategory('C01')?.template_md || '' : '';
    const result = await askWithFallback(llm, SYSTEM_COMPOSE,
      l => composeText({ goal, analysis, cat, personTemplate, refs, aspectRatio, lang: l, target, guide, videoStyle, personMode }),
      frames.slice(0, 1), 16384, lang);

    const notices = [];
    if (doRefine && result.prompt) {
      try {
        const review = await askWithFallback(llm, SYSTEM_REVIEW,
          l => reviewText({ target, guide, goal, analysis, draft: result, lang: l, hasImage, personMode }), frames, 16384, lang);
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

    const references = refs.map(r => ({
      id: r.id, title: r.title, image: r.image, category_code: r.category_code, subtype: r.subtype,
      source: r.source, pinned: !!r.pinned, prompt_snippet: (r.prompt || '').replace(/\s+/g, ' ').slice(0, 120),
    }));
    const generation = {
      target_model: target || '通用', output: videoStyle ? 'video' : 'image', detail: !!detail, refined: !!result.review,
      round: 1, lang, person_mode: personMode, notice: notices.join('；'), llm_model: llm.visionModel,
    };
    const fullAnalysis = { ...analysis, generation };
    const id = store.saveGeneration({
      goal, image_path: savedImage, category_code: catCode, analysis: fullAnalysis, references, result,
      model: hasImage ? llm.visionModel : llm.model,
    });
    return { id, image: savedImage ? relToUrl(savedImage) : '', category: { code: cat.code, name: cat.name }, analysis: fullAnalysis, references, result };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 对比修正：上传用生成的提示词出的图，对照需求和参考图找差异，修正提示词并保存为新记录（可以多轮） */
export async function refineGeneration({ id, imageSrc = '', lang = '', hint = '', allowLocal = false, modelOverride = '' } = {}) {
  const row = store.getDb().prepare('SELECT * FROM generations WHERE id = ?').get(Number(id));
  if (!row) throw fail('找不到这条生成记录', 404);
  const analysis = JSON.parse(row.analysis_json || '{}');
  if (analysis.reverse) throw fail('这是反推记录，请在「反推提示词」页对比修正');
  const prev = JSON.parse(row.result_json || '{}');
  const references = JSON.parse(row.references_json || '[]');
  if (!imageSrc) throw fail('请上传用这条提示词生成的图片');
  const llm = resolveLlm();
  // 本次临时换模型（不改设置里的默认模型）；换了就不再走原来的备用模型，便于横测
  if (modelOverride) Object.assign(llm, { model: modelOverride, visionModel: modelOverride, fallbackModel: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plib-generate-refine-'));
  try {
    const frames = [];
    const refFile = row.image_path ? path.join(DATA, row.image_path) : '';
    if (refFile && fs.existsSync(refFile)) frames.push({ t: 0, label: '参考图', dataUrl: await grabFrame(refFile, dir, 'reference', 0, 1280) });
    const item = await materialize(imageSrc, dir, { allowLocal, name: 'generated' });
    const generated = await grabFrame(item.file, dir, 'generated-still', 0, 1280);
    frames.push({ t: 0, label: '生成结果（用当前提示词生成的）', dataUrl: generated });

    const gen = analysis.generation || {};
    const target = gen.target_model && gen.target_model !== '通用' ? gen.target_model : '';
    const videoStyle = gen.output === 'video';
    const outLang = lang || gen.lang || (prev.prompt_en ? 'both' : 'zh');
    const kb = frames.reduce((s, f) => s + Math.round(f.dataUrl.length / 1024), 0);
    console.log(`[对比修正] 记录 #${row.id} 语言 ${outLang} 图片 ${frames.length} 张（${kb}KB）`);
    const startedAt = Date.now();
    // 被模型服务拒绝时逐步瘦身重试：原样 → 单语言 → 去掉需求要点 → 再截短当前提示词
    const variants = [
      { lang: outLang, compact: 0 },
      ...(outLang === 'zh' ? [] : [{ lang: 'zh', compact: 0 }]), // 本来就是中文时不重复试一次
      { lang: 'zh', compact: 1 }, { lang: 'zh', compact: 3 },
      ...(llm.fallbackModel ? [{ lang: outLang, compact: 0, model: llm.fallbackModel }] : []),
    ];
    let r = null;
    let lastError = null;
    for (const [i, v] of variants.entries()) {
      try {
        r = await ask(llm, SYSTEM_COMPARE, compareText({
          target, guide: writingGuide(target, videoStyle), goal: row.goal, analysis, prompt: prev.prompt || '',
          negative: prev.negative, lang: v.lang, hint, hasRef: frames.length > 1, compact: v.compact,
        }), frames, 0, v.model);
        break;
      } catch (e) {
        lastError = e;
        if (isTruncation(e) && i < variants.length - 1 && variants[i + 1].model) {
          console.warn(`[对比修正] 第 ${i + 1} 次被拒，改用备用模型 ${variants[i + 1].model}`);
        }
        if (isTruncation(e) && i === variants.length - 1) {
          throw fail('模型服务拒绝了这次请求（多次缩减内容后仍被拒）。常见原因是提示词里身材、服装暴露相关的描述触发了内容策略：把这些措辞改温和一些，或在设置里换一个模型再试', 502);
        }
        if (!isTruncation(e) || i === variants.length - 1) throw e;
        console.warn(`[对比修正] 第 ${i + 1} 次被模型服务拒绝，缩减请求后重试（语言 ${v.lang}，精简级别 ${v.compact}）`);
      }
    }
    if (!r) throw lastError;
    console.log(`[对比修正] 记录 #${row.id} 完成，用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
    if (!String(r.prompt || '').trim()) throw fail('模型没有给出修正后的提示词，请重试', 502);

    const result = {
      ...prev, prompt: r.prompt, prompt_en: r.prompt_en || (outLang === 'zh' ? '' : prev.prompt_en), negative: r.negative || prev.negative,
      previous_prompt: prev.prompt, review: asArr(r.differences), tips: asArr(r.tips).length ? r.tips : prev.tips,
    };
    const generation = { ...gen, refined_from: row.id, round: (Number(gen.round) || 1) + 1, compare_image: saveDataUrl(generated, 'uploads'), notice: '' };
    const fullAnalysis = { ...analysis, generation };
    const newId = store.saveGeneration({
      goal: row.goal, image_path: row.image_path, category_code: row.category_code, analysis: fullAnalysis, references, result,
      model: llm.visionModel,
    });
    const cat = store.getCategory(row.category_code) || { code: row.category_code || '', name: '' };
    return {
      id: newId, image: row.image_path ? relToUrl(row.image_path) : '', category: { code: cat.code, name: cat.name },
      analysis: fullAnalysis, references, result,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 入库时自动归类与分析 */
export async function autoTag({ title = '', prompt = '', imageDataUrl, imagePath }) {
  if (!String(prompt).trim()) throw fail('请先填写提示词');
  const llm = resolveLlm();
  if (imagePath) imageDataUrl = fileToDataUrl(path.resolve(imagePath));
  const system = '你是提示词库管理员，负责给新收录的 AI 生图/视频提示词归类、打标签并做结构分析。只输出一个 JSON 对象。';
  const text = `【模板库类别】
${categoryBrief()}

【待收录的提示词】
标题：${title || '（未填写）'}
${String(prompt).slice(0, 8000)}
${imageDataUrl ? '\n该提示词生成的效果图见附件。' : ''}

输出 JSON：
{
  "title": "简短中文标题（10 字左右；用户已填写则沿用）",
  "category_code": "类别编号，如 C01",
  "subtype": "子类型，如：城市宣传海报·国潮S型",
  "tags": ["5-10 个中文标签：风格、主体、用途、技法"],
  "analysis": "结构要点 + 关键细节 + 可复用技巧，一段话，150 字以内"
}`;
  const j = await askJson(llm, system, text, imageDataUrl, 6000);
  return {
    title: title || j.title || '',
    category_code: validCategory(j.category_code),
    subtype: j.subtype || '',
    tags: Array.isArray(j.tags) ? j.tags.join(', ') : (j.tags || ''),
    analysis: j.analysis || '',
  };
}
