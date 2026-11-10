// 基于细分类词典的规则分类器：标题/标签权重高，提示词开头次之，全文最低；最后用组合规则纠偏
import fs from 'node:fs';
import path from 'node:path';
import { SEED } from './paths.mjs';
import { tagFacets, subjectOf } from './facets.mjs';

let TAX;
let COMPILED;

export function taxonomy() {
  if (!TAX) TAX = JSON.parse(fs.readFileSync(path.join(SEED, 'taxonomy.json'), 'utf8'));
  return TAX;
}

const norm = s => String(s || '').toLowerCase();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ASCII 关键词按单词边界匹配，避免 "oc" 命中 "chocolate"；中文按子串匹配 */
function matcher(kw) {
  const k = norm(kw);
  if (/^[\x00-\x7f]+$/.test(k)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(k)}($|[^a-z0-9])`);
    return s => re.test(s);
  }
  return s => s.includes(k);
}

// 这些词几乎每条提示词都有，命中了也说明不了类别，权重压到四分之一
const GENERIC = new Set(['摄影', '照片', '图片', '画面', '背景', '高清', '细节', '质感', '写实', '真实', '光线', '构图', '人物', '场景',
  'photo', 'photography', 'image', 'picture', 'scene', 'background', 'detail', 'realistic', 'high quality', '4k', '8k', 'lighting', 'composition']);

function compiled() {
  if (COMPILED) return COMPILED;
  COMPILED = taxonomy().categories.map(cat => ({
    ...cat,
    subs: cat.subs.map(sub => ({
      ...sub,
      matchers: sub.kw.map(k => ({ raw: k, test: matcher(k), weight: (0.6 + Math.min([...norm(k)].length, 8) / 10) * (GENERIC.has(norm(k)) ? 0.25 : 1) })),
    })),
  }));
  return COMPILED;
}

export function subcategoryName(code) {
  for (const c of taxonomy().categories) for (const s of c.subs) if (s.code === code) return s.name;
  return '';
}

const has = (text, words) => words.some(w => matcher(w)(text));

const TRANSFORM_WORDS = ['转绘', '重绘', '改图', '转换成', '转化为', '变成', '照片转', '把照片', '将照片', '参考图转', 'transform the photo', 'turn this photo', 'turn the photo', 'transform the uploaded', 'transform the subject', 'redraw', 'convert this photo', 'convert the photo', 'recreate this image', 'turn me into', 'transform me', 'transform this'];
// 必须同时出现“照片/上传/参考图”这类输入图线索，才判定为照片改造
const PHOTO_WORDS = ['照片', '上传', '参考图', '原图', '附图', 'photo', 'uploaded', 'reference image', 'attached image', 'input image', 'this image', 'selfie'];
const STYLE_CATS = new Set(['C03', 'C04', 'C02']);
const PORTRAIT_TITLE = /人像|写真|自拍|抓拍|随拍|街拍|肖像|美女|少女|女性|女孩|女生|男士|男性|模特|女友|全身像|半身像|portrait|selfie/;
// “摄影 / photo / 快照”太通用（护肤品摄影、云朵摄影也命中），只有同时出现人物词才算人像信号
const PHOTO_TITLE = /摄影|快照|photo|photography/;
const PERSON_TITLE = /人|女|男|模特|portrait|selfie|woman|man|girl|boy|model/;
const NON_PORTRAIT_TITLE = /海报|插画|漫画|动漫|二次元|转绘|照片转|图鉴|信息图|手办|盲盒|设定|logo|图标|地图|模型|包装|广告|详情页|界面|截图|分镜|3d|q版|卡通|手绘|水彩|油画|纸雕|拼贴|对比|九宫格|宫格|游戏/;
const HISTORY_WORDS = ['皇帝', '古人', '李白', '苏轼', '杜甫', '三国', '唐朝', '宋朝', '明朝', '清朝', '秦始皇', '武则天', '朱元璋', '诸葛亮', '曹操', '玄武门', '王安石'];

// 主体维对大类的硬约束：ban 的大类直接踢掉，prefer 的大类加权
const SUBJECT_BIAS = {
  'SB-person':    { prefer: ['C01', 'C02', 'C05', 'C14'], ban: [] },
  'SB-group':     { prefer: ['C01', 'C02', 'C12'], ban: [] },
  'SB-character': { prefer: ['C04', 'C03', 'C12'], ban: [] },
  'SB-animal':    { prefer: ['C03', 'C02'], ban: ['C01'] },
  'SB-product':   { prefer: ['C07', 'C08'], ban: ['C01'] },
  'SB-food':      { prefer: ['C07', 'C08'], ban: ['C01'] },
  'SB-arch':      { prefer: ['C13'], ban: ['C01'] },
  'SB-landscape': { prefer: ['C02', 'C13'], ban: ['C01'] },
  'SB-vehicle':   { prefer: ['C07', 'C02'], ban: ['C01'] },
  'SB-text':      { prefer: ['C06', 'C09', 'C15'], ban: ['C01'] },
  'SB-ui':        { prefer: ['C10', 'C11', 'C08'], ban: ['C01'] },
  'SB-abstract':  { prefer: ['C03', 'C06'], ban: ['C01'] },
};

function applySubject(ranked, subject) {
  const bias = SUBJECT_BIAS[subject];
  if (!bias || !ranked.length) return ranked;
  // 主体明确不是人时踢掉人像大类；踢光了就保持原样，别把条目弄成未分类
  let out = ranked.filter(r => !bias.ban.includes(r.code));
  if (!out.length) return ranked;
  out = out.map(r => (bias.prefer.includes(r.code) ? { ...r, total: r.total * 1.6, rule: `主体为${subject}` } : r));
  return out.sort((a, b) => b.total - a.total);
}

function applyRules(ranked, { T, P, subject }) {
  if (!ranked.length) return ranked;
  const text = `${T} ${P}`;
  const pick = code => ranked.find(r => r.code === code);
  const promote = (code, subcategory, reason) => {
    const found = pick(code);
    const entry = found ? { ...found, best: { ...found.best, subcategory: subcategory || found.best.subcategory } } : { code, best: { subcategory, hits: [reason], score: 1 }, total: 1 };
    entry.rule = reason;
    return [entry, ...ranked.filter(r => r.code !== code)];
  };

  // 1) 标题明确写了“海报”，且不是产品广告/信息图/电影以外的强类别时，归海报
  if (/海报|poster/.test(T) && !['C06', 'C07', 'C11', 'C14'].includes(ranked[0].code)) {
    ranked = promote('C06', null, '标题含海报');
  }
  // 2) 上传照片/参考图 + 风格转换动词 → 照片改造
  const head = P.slice(0, 400);
  const transformIntent = (has(T, TRANSFORM_WORDS) && has(T, PHOTO_WORDS))
    || (has(head, TRANSFORM_WORDS) && has(head, PHOTO_WORDS) && !/插画|海报/.test(T.replace(/照片转.*/, '')));
  if (transformIntent && (STYLE_CATS.has(ranked[0].code) || ranked[0].code === 'C01')) {
    const sub = has(text, ['手办', 'figure', 'figurine', 'toy', '盲盒']) ? 'C05-02' : 'C05-01';
    ranked = promote('C05', sub, '照片风格转换');
  }
  // 3) 历史人物 + 社交截图 → 历史国风
  if (ranked[0].code === 'C10' && has(T, HISTORY_WORDS)) ranked = promote('C14', 'C14-01', '历史人物社交梗');
  // 3.5) 标题是人像摄影（写真/人像/自拍/抓拍/美女…），而最高分类别只是被正文里的道具或场景词带偏 → 写实人像
  const portraitTitle = PORTRAIT_TITLE.test(T) || (PHOTO_TITLE.test(T) && PERSON_TITLE.test(T));
  const subjectBansPortrait = (SUBJECT_BIAS[subject]?.ban || []).includes('C01');
  if (ranked[0].code !== 'C01' && portraitTitle && !NON_PORTRAIT_TITLE.test(T) && !subjectBansPortrait) {
    ranked = promote('C01', pick('C01')?.best.subcategory || 'C01-03', '标题为人像摄影');
  }
  // 4) 标题是“XX风格/XX画/插画”而最高分是产品类且只因正文里提到商品 → 插画
  if (ranked[0].code === 'C07' && /插画|画风|工笔|水彩|油画|漫画/.test(T) && !/广告|包装|产品/.test(T)) {
    const alt = pick('C03') || pick('C14');
    if (alt) ranked = promote(alt.code, alt.best.subcategory, '标题为画种');
  }
  return ranked;
}

/** 已知大类时，只在该大类内挑选最匹配的子类（用于给人工归类过的案例补细分类） */
export function classifyWithin(categoryCode, { title = '', tags = '', prompt = '' }) {
  const cat = compiled().find(c => c.code === categoryCode);
  if (!cat) return null;
  const T = norm(title), G = norm(Array.isArray(tags) ? tags.join(' ') : tags), P = norm(prompt), head = P.slice(0, 400);
  let best = null;
  for (const sub of cat.subs) {
    let score = 0;
    for (const m of sub.matchers) {
      let h = 0;
      if (T && m.test(T)) h += 6;
      if (G && m.test(G)) h += 4;
      if (head && m.test(head)) h += 2;
      else if (P && m.test(P)) h += 1;
      score += h * m.weight;
    }
    if (score > 0 && (!best || score > best.score)) best = { subcategory: sub.code, score };
  }
  return best;
}

/**
 * @returns {{category:string|null, subcategory:string|null, score:number, hits:string[], alternatives:object[], rule?:string}}
 */
export function classify({ title = '', tags = '', prompt = '', mediaType = 'image' }) {
  const T = norm(title);
  const G = norm(Array.isArray(tags) ? tags.join(' ') : tags);
  const P = norm(prompt);
  const head = P.slice(0, 400);

  const subs = [];
  for (const cat of compiled()) {
    if ((mediaType === 'video') !== (cat.media === 'video')) continue;
    for (const sub of cat.subs) {
      const bodyWeight = sub.bodyWeight ?? 1;
      let score = 0;
      const hits = [];
      for (const m of sub.matchers) {
        let h = 0;
        if (T && m.test(T)) h += 6;
        if (G && m.test(G)) h += 4;
        if (head && m.test(head)) h += 2 * bodyWeight;
        else if (P && m.test(P)) h += 1 * bodyWeight;
        if (h) { score += h * m.weight; hits.push(m.raw); }
      }
      if (score > 0) subs.push({ category: cat.code, subcategory: sub.code, score: score * (sub.boost || 1), hits });
    }
  }

  const byCat = new Map();
  for (const s of subs) {
    const arr = byCat.get(s.category) || [];
    arr.push(s);
    byCat.set(s.category, arr);
  }
  let ranked = [...byCat.entries()].map(([code, arr]) => {
    arr.sort((a, b) => b.score - a.score);
    return { code, best: arr[0], total: arr[0].score + (arr[1] ? arr[1].score * 0.35 : 0) };
  }).sort((a, b) => b.total - a.total);

  const subject = subjectOf(tagFacets({ title, tags, prompt }).facets);
  if (mediaType !== 'video') ranked = applySubject(ranked, subject);
  ranked = applyRules(ranked, { T, P, subject });

  if (!ranked.length && mediaType !== 'video' && (PORTRAIT_TITLE.test(T) || (PHOTO_TITLE.test(T) && PERSON_TITLE.test(T))) && !(SUBJECT_BIAS[subject]?.ban || []).includes('C01')) {
    return { category: 'C01', subcategory: 'C01-03', score: 0.5, margin: 0.5, hits: [], rule: '标题为人像摄影', alternatives: [] };
  }
  if (!ranked.length) {
    const fallback = taxonomy().categories.find(c => (mediaType === 'video') === (c.media === 'video'));
    return { category: mediaType === 'video' ? fallback.code : null, subcategory: null, score: 0, hits: [], alternatives: [] };
  }
  const top = ranked[0];
  const second = ranked[1]?.total || 0;
  return {
    category: top.code,
    subcategory: top.best.subcategory,
    score: Math.round(top.total * 10) / 10,
    margin: Math.round((top.total - second) * 10) / 10,
    hits: top.best.hits,
    rule: top.rule,
    subject,
    alternatives: ranked.slice(1, 3).map(r => ({ category: r.code, subcategory: r.best.subcategory, score: Math.round(r.total * 10) / 10 })),
  };
}
