// AI 归类打标的共用逻辑：批量脚本（scripts/ai-tag.mjs）和网页/插件的即时归类都用这里
import { chatJson } from './llm.mjs';
import { taxonomy } from './classify.mjs';
import { facetDefs, facetValueName } from './facets.mjs';
import * as store from './db.mjs';

const catList = () => taxonomy().categories.map(c =>
  `${c.code} ${c.name}${c.media === 'video' ? '（视频）' : ''}：${c.subs.map(s => `${s.code} ${s.name}`).join('；')}`).join('\n');
const facetList = () => facetDefs().map(f =>
  `${f.key}（${f.name}${f.multi ? '，可多选，最多3个' : '，只能选1个'}）：${f.values.map(v => `${v.code} ${v.name}`).join('；')}`).join('\n');

const SEARCH_EXTRA = `

另外再输出一个 search 字段：一段 60-120 字的中文检索文本，把这条提示词最终画面的内容摊开写成便于搜索的说法——谁在做什么、在哪、什么情绪氛围、什么视觉特征，并补上用户可能会用的同义说法（例如"孤独感"也写上"落寞、一个人、空旷"）。只写画面相关的词，不要写"提示词""生成"这类元词，不要重复标题原话。
完整输出格式变为：
{"category":"...","subcategory":"...","facets":{...},"confidence":0.85,"reason":"一句话理由","search":"检索文本"}`;

export function systemPrompt({ searchText = false } = {}) {
  return `你是提示词库的分类编辑。读一条 AI 绘图/视频提示词，判断它属于哪个类别，并按受控词表打多维标签。

类别（三层：大类 → 细分类）：
${catList()}

多维标签词表（只能用下面出现过的代码，不要自创）：
${facetList()}

判断原则：
1. 看的是"这条提示词最终会生成什么画面"，不是提示词里提到过什么词。画面里有人时主体就是人，风景、美食、道具只是他所处的环境。
2. 视频类提示词（有镜头运动、时长、分镜描述）用 C16 的细分类。
3. 拿不准的维度就不填，不要硬凑；confidence 反映你的把握（0-1）。
4. 服装穿搭类要分两种：只要配图里**出现真人穿着这套衣服**（哪怕只有其中一张图是真人），就按人像归类（C01 下对应的细分类，主体填真人人像）；只有当全部配图都是平铺单品、版式标注图、没有任何真人出镜时，才归到 C08-03 商品目录/穿搭展示。
5. 只输出 JSON，不要解释文字。

输出格式：
{"category":"C01","subcategory":"C01-03","facets":{"subject":"SB-person","genre":["GN-urban"],"style":["ST-photoreal"],"shot":["SH-cu"],"light":["LT-night"],"color":["CL-cool"],"scene":["SC-street"],"mood":["MD-lonely"]},"confidence":0.85,"reason":"一句话理由"}${searchText ? SEARCH_EXTRA : ''}`;
}

export function validators() {
  return {
    cats: new Map(taxonomy().categories.map(c => [c.code, new Set(c.subs.map(s => s.code))])),
    facets: new Map(facetDefs().map(f => [f.key, { multi: !!f.multi, codes: new Set(f.values.map(v => v.code)) }])),
  };
}

/** 把模型的输出收敛到词表之内，非法代码直接丢掉 */
export function cleanOutput(out) {
  const { cats, facets: fdef } = validators();
  const cat = cats.has(out.category) ? out.category : null;
  const sub = cat && cats.get(cat).has(out.subcategory) ? out.subcategory : null;
  const facets = {};
  for (const [key, raw] of Object.entries(out.facets || {})) {
    const def = fdef.get(key);
    if (!def) continue;
    const codes = (Array.isArray(raw) ? raw : [raw]).filter(c => def.codes.has(c));
    if (codes.length) facets[key] = def.multi ? codes.slice(0, 3) : [codes[0]];
  }
  return {
    cat, sub, facets,
    confidence: Number(out.confidence) || null,
    reason: String(out.reason || '').slice(0, 200),
    search: String(out.search || '').slice(0, 600),
    tags: Object.values(facets).flat().map(facetValueName).filter(Boolean),
  };
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** 下载配图转 data URL（最多 3 张，单张 6MB 以内）；拿不到就当没有图 */
export async function imagesOf(row, { max = 3 } = {}) {
  let extra = [];
  try { extra = JSON.parse(row.extra_images || '[]'); } catch { extra = []; }
  const urls = [row.image_url, ...extra].filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, max);
  const out = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 6 * 1024 * 1024) continue;
      const ext = (u.split('?')[0].split('.').pop() || 'jpg').toLowerCase();
      out.push(`data:${MIME[ext] || 'image/jpeg'};base64,${buf.toString('base64')}`);
    } catch { /* 拿不到图就算了 */ }
  }
  return out;
}

export function userMessage(row) {
  return `标题：${row.title}\n来源标签：${row.raw_tags || row.tags || '（无）'}\n类型：${row.media_type === 'video' ? '视频' : '图片'}\n提示词：\n${String(row.prompt || '').slice(0, 2000)}`;
}

/** 给一条案例打标；models 是模型链，前一个失败就换下一个 */
export async function labelRow(row, { llm, models, vision = false, searchText = false, timeoutMs = 180000 } = {}) {
  const system = systemPrompt({ searchText });
  const text = userMessage(row);
  const pics = vision ? await imagesOf(row) : [];
  const content = pics.length
    ? [{ type: 'text', text: `${text}\n\n下面是这条提示词的成品图，以画面为准判断类别：` },
       ...pics.map(u => ({ type: 'image_url', image_url: { url: u } }))]
    : text;
  let lastError = null;
  for (const model of models) {
    try {
      const out = await chatJson({ ...llm, model, temperature: 0, maxTokens: 0, timeoutMs,
        messages: [{ role: 'system', content: system }, { role: 'user', content }] });
      const c = cleanOutput(out);
      if (!c.cat) throw new Error('模型没给出合法类别');
      return { ...c, model, sawImages: pics.length };
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('没有可用模型');
}

/** 标注结果写进案例；手动归类过的条目不动 */
export function applyLabel(caseId, c) {
  const db = store.getDb();
  const row = db.prepare('select classify_source from cases where id = ?').get(Number(caseId));
  if (!row || row.classify_source === 'manual') return false;
  db.prepare(`update cases set category_code=?, subcategory=?, facets=?, tags=?,
    search_text=coalesce(?, search_text), classify_source='ai', needs_review=0 where id=?`)
    .run(c.cat, c.sub, JSON.stringify(c.facets), c.tags.join(','), c.search || null, Number(caseId));
  return true;
}

/**
 * 读设置里的批量标注接口（没配就用主接口）
 * withFallback：即时归类只发一个请求，主力模型限流时直接用备用模型兜底；
 * 批量任务不加兜底，保证全库是同一套判断口径
 */
export function taggerLlm({ withFallback = false } = {}) {
  const s = store.getSettings();
  const models = String(s.tagger_model || s.llm_model || '').split(',').map(x => x.trim()).filter(Boolean);
  if (withFallback && s.llm_fallback_model && !models.includes(s.llm_fallback_model)) models.push(s.llm_fallback_model);
  return {
    llm: {
      baseUrl: s.tagger_base_url || s.llm_base_url,
      apiKey: s.tagger_api_key || s.llm_api_key,
    },
    models,
  };
}

/** 网页/插件新增条目后立刻在后台看图归类一次，失败就静默放过（批量任务以后还会再标） */
export function labelCaseSoon(caseId) {
  setTimeout(async () => {
    try {
      const row = store.getCaseRow(caseId);
      if (!row || row.classify_source === 'manual') return;
      const { llm, models } = taggerLlm({ withFallback: true });
      if (!llm.baseUrl || !llm.apiKey || !models.length) return;
      const c = await labelRow(row, { llm, models, vision: true, searchText: true });
      if (applyLabel(caseId, c)) {
        console.log(`[自动归类] #${caseId} → ${c.cat}/${c.sub}${c.sawImages ? `（看了 ${c.sawImages} 张图）` : ''}`);
      }
    } catch (e) {
      console.warn(`[自动归类] #${caseId} 失败：${e.message.slice(0, 100)}`);
    }
  }, 50);
}
