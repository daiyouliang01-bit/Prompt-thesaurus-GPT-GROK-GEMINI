// 受控多维标签：主体/题材/风格/景别机位/光线/色调/场景/情绪用途
// 每个维度有固定取值和中英关键词，避免各来源自由标签互相打架（写实 / Photoreal / 超写实 指同一件事）
import fs from 'node:fs';
import path from 'node:path';
import { SEED } from './paths.mjs';

let FACETS;
let COMPILED;

export function facetDefs() {
  if (!FACETS) FACETS = JSON.parse(fs.readFileSync(path.join(SEED, 'facets.json'), 'utf8'));
  return FACETS.facets;
}

const norm = s => String(s || '').toLowerCase();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ASCII 关键词按单词边界匹配，中文按子串匹配 */
function matcher(kw) {
  const k = norm(kw);
  if (/^[\x00-\x7f]+$/.test(k)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(k)}($|[^a-z0-9])`);
    return s => re.test(s);
  }
  return s => s.includes(k);
}

function compiled() {
  if (COMPILED) return COMPILED;
  COMPILED = facetDefs().map(f => ({
    ...f,
    values: f.values.map(v => ({
      ...v,
      matchers: v.kw.map(k => ({ raw: k, test: matcher(k) })),
      // 排除词：先把这些容易混淆的说法从文本里抹掉再匹配（老虎机 ≠ 老虎，森林绿 ≠ 森林）
      exRe: v.ex?.length ? new RegExp(v.ex.map(escapeRe).join('|'), 'g') : null,
      // 词表长的取值（风景有 22 个词）天然更容易累积分数，按词表长度归一
      norm: 1 / (1 + Math.log2(Math.max(v.kw.length, 8) / 8)),
    })),
  }));
  return COMPILED;
}

/** 维度取值代码 → 中文名，例如 SB-person → 真人人像 */
export function facetValueName(code) {
  for (const f of facetDefs()) for (const v of f.values) if (v.code === code) return v.name;
  return '';
}

export function facetName(key) {
  return facetDefs().find(f => f.key === key)?.name || key;
}

const MULTI_MAX = 3;      // 多值维度最多保留几个
const MIN_SCORE = 3;      // 低于这个分不算命中
const MIN_RATIO = 0.45;   // 多值维度里，次选至少要达到首选的这个比例才一起保留
const PERSON_SUBJECTS = new Set(['SB-person', 'SB-group', 'SB-character']);
const PERSON_PRIORITY = 0.6;  // 人物类主体达到首选这个比例就优先
const BODY_ONLY_SCORE = 9;    // 主体维：标题标签都没提、只在正文里出现，要更多证据才算数

/**
 * 给一条案例打受控标签
 * @returns {{facets: Record<string,string[]>, scores: Record<string,number>}}
 */
export function tagFacets({ title = '', tags = '', prompt = '', analysis = '' }) {
  const T = norm(title);
  const G = norm(Array.isArray(tags) ? tags.join(' ') : tags);
  const A = norm(analysis);
  const P = norm(prompt);
  const head = P.slice(0, 500);

  const facets = {};
  const scores = {};
  for (const f of compiled()) {
    const ranked = [];
    for (const v of f.values) {
      const t = v.exRe ? T.replace(v.exRe, ' ') : T;
      const g = v.exRe ? G.replace(v.exRe, ' ') : G;
      const a = v.exRe ? A.replace(v.exRe, ' ') : A;
      const pFull = v.exRe ? P.replace(v.exRe, ' ') : P;
      const pHead = v.exRe ? pFull.slice(0, 500) : head;
      let headScore = 0;   // 标题/标签命中，不打折
      let bodyScore = 0;   // 正文命中，按词表长度归一（词表长的天然更容易累积）
      let distinct = 0;
      let tier = 3;  // 1=标题命中 2=标签命中 3=只在正文里出现
      for (const m of v.matchers) {
        let h = 0;
        if (t && m.test(t)) { headScore += 5; tier = Math.min(tier, 1); h = 1; }
        if (g && m.test(g)) { headScore += 4; tier = Math.min(tier, 2); h = 1; }
        if (a && m.test(a)) { bodyScore += 3; h = 1; }
        if (pHead && m.test(pHead)) { bodyScore += 2; h = 1; }
        else if (pFull && m.test(pFull)) { bodyScore += 1; h = 1; }
        if (h) distinct++;
      }
      const score = headScore + (bodyScore + Math.max(distinct - 1, 0) * 1.5) * v.norm;
      if (score > 0) ranked.push({ code: v.code, score, tier });
    }
    ranked.sort((a, b) => b.score - a.score);
    // 单选维度（主体/年龄段/画幅）只能有一个答案，猜错代价大，正文孤证要更多证据；
    // 光线/色调/景别这些本来就只写在正文里，不适用这条
    const floor = f.multi ? MIN_SCORE : BODY_ONLY_SCORE;
    let top = ranked.filter(r => r.score >= (r.tier === 3 ? floor : MIN_SCORE));
    if (!top.length) continue;
    // 标题是作者自己写的结论，来源站的标签次之，正文只是细节描述：只取最高一档的命中
    const bestTier = Math.min(...top.map(r => r.tier));
    top = top.filter(r => r.tier === bestTier);
    // 主体维：画面里有人时，人就是主体——风景、美食、场景只是他所处的环境
    if (f.key === 'subject') {
      const person = top.find(r => PERSON_SUBJECTS.has(r.code));
      if (person && person.score >= top[0].score * PERSON_PRIORITY) top = [person, ...top.filter(r => r !== person)];
    }
    const picked = f.multi
      ? top.filter(r => r.score >= top[0].score * MIN_RATIO).slice(0, MULTI_MAX)
      : [top[0]];
    facets[f.key] = picked.map(r => r.code);
    scores[f.key] = Math.round(top[0].score * 10) / 10;
  }
  return { facets, scores };
}

/** 受控标签的中文串，写进 tags 列供现有搜索使用 */
export function facetsToTags(facets) {
  const out = [];
  for (const f of facetDefs()) {
    for (const code of facets[f.key] || []) {
      const n = facetValueName(code);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** 主体维（用于给分类器做硬约束） */
export function subjectOf(facets) {
  return (facets.subject || [])[0] || null;
}

/**
 * 从自然语言搜索词中提取可能对应的受控标签维度（用于意图理解与混合加权检索）
 * @param {string} query 
 * @returns {Record<string, string[]>}
 */
export function extractQueryFacets(query) {
  const q = norm(query);
  if (!q) return {};
  const out = {};
  for (const f of compiled()) {
    const matched = [];
    for (const v of f.values) {
      let hits = 0;
      for (const m of v.matchers) {
        if (m.test(q)) hits++;
      }
      if (hits > 0) matched.push({ code: v.code, hits });
    }
    if (matched.length) {
      matched.sort((a, b) => b.hits - a.hits);
      out[f.key] = matched.slice(0, f.multi ? 2 : 1).map(x => x.code);
    }
  }
  return out;
}
