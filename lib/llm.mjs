/** OpenAI 兼容的 /chat/completions 调用 */
const MAX_RETRY_TOKENS = 32768;

export async function chat({ baseUrl, apiKey, model, messages, temperature, maxTokens = 4096, timeoutMs = 240000 }) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  const fail = msg => Object.assign(new Error(msg), { status: 502 });

  let limit = maxTokens;
  let sendLimit = true;
  let sendTemp = true;
  for (let attempt = 0; attempt < 4; attempt++) {
    // 有的模型服务会拒绝内容完全相同的重复请求（1 秒内返回 502）：每次带一个无害的随机标记，避免撞上去重
    const stamped = messages.map((m, i) => (i === 0 && typeof m.content === 'string'
      ? { ...m, content: `${m.content}\n(request-id: ${Math.random().toString(36).slice(2, 10)}${attempt ? `-r${attempt}` : ''})` }
      : m));
    const body = { model, messages: stamped };
    if (sendLimit && limit) body.max_tokens = limit; // limit 为 0 表示不限制输出长度（思考型模型更稳）
    if (sendTemp && temperature !== undefined && !Number.isNaN(temperature)) body.temperature = temperature;

    // 排查用：设置 PLIB_DUMP_REQUEST=文件路径 可以把发给模型的请求体存下来
    if (process.env.PLIB_DUMP_REQUEST) {
      const fs = await import('node:fs');
      const meta = { model, maxTokens: body.max_tokens ?? null, messages: messages.map(m => ({
        role: m.role,
        text: Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n').length : String(m.content).length,
        images: Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0,
      })) };
      fs.appendFileSync(process.env.PLIB_DUMP_REQUEST, `${JSON.stringify(meta)}\n`);
      // 需要完整正文时：PLIB_DUMP_BODY=文件路径（图片只记录长度，避免文件过大）
      if (process.env.PLIB_DUMP_BODY) {
        const safe = messages.map(m => ({
          role: m.role,
          content: Array.isArray(m.content)
            ? m.content.map(p => (p.type === 'image_url' ? { type: 'image_url', bytes: p.image_url.url.length } : p))
            : m.content,
        }));
        fs.writeFileSync(process.env.PLIB_DUMP_BODY, JSON.stringify({ model, max_tokens: body.max_tokens ?? null, messages: safe }, null, 1));
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw fail(`无法连接模型接口 ${url}：${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // 有的接口不接受或限制 max_tokens，去掉这个参数再试一次
      if (sendLimit && res.status === 400 && /max_tokens|max_completion_tokens|maximum/i.test(text)) { sendLimit = false; continue; }
      // 有些模型（如 claude-sonnet-5）已经不接受 temperature，去掉重试一次
      if (sendTemp && res.status === 400 && /temperature/i.test(text)) { sendTemp = false; continue; }
      // 限流、网关错误、上游断流（常见于本地代理转发大请求）：退避后重试
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw fail(`模型接口返回 ${res.status}：${text.slice(0, 600)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch { throw fail(`模型接口返回的不是 JSON：${text.slice(0, 300)}`); }
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    const out = Array.isArray(content) ? content.map(p => (typeof p === 'string' ? p : p.text || '')).join('') : content;
    // 思考型模型（如 Gemini 3、o 系列）会先用掉输出额度去思考，额度不够时正文为空或被截断：放大额度重试
    if (choice?.finish_reason === 'content_filter') {
      console.warn('[提示词库] 模型的安全过滤截断了输出（content_filter）');
      if (!String(out || '').trim()) throw fail('模型的安全过滤拦截了这次请求：换一张暴露度低一些的图，或把提示词里的相关描述改温和一些再试');
    }
    const truncated = /length|max/i.test(String(choice?.finish_reason || ''));
    if (truncated && sendLimit && limit && limit < MAX_RETRY_TOKENS) {
      limit = Math.min(limit * 4, MAX_RETRY_TOKENS);
      continue;
    }
    if (typeof out === 'string' && out.trim()) return out;
    if (truncated) throw fail('模型的输出长度不够：思考型模型会先消耗大量 token，请换一个非思考模型，或在模型服务里调低思考强度');
    throw fail(`模型没有返回内容：${text.slice(0, 300)}`);
  }
  throw fail('模型接口多次重试后仍没有返回内容');
}

/**
 * 调用模型并解析 JSON：解析失败时先本地修复，仍失败再请模型把自己的回复修正成合法 JSON（只发文字，不再重发图片）
 */
export async function chatJson(opts) {
  let reply = await chat(opts);
  if (strictJson(reply)) return strictJson(reply);
  // 能修复但结尾不完整，多半是输出被截断了：放大输出上限整体重试一次，拿到完整结果再用
  if (extractJson(reply) && !/[}\]]\s*(```)?\s*$/.test(reply.trim())) {
    try {
      const again = await chat({ ...opts, maxTokens: Math.max((opts.maxTokens || 4096) * 2, 16384) });
      if (strictJson(again)) return strictJson(again);
      if (again.length > reply.length) reply = again;
    } catch { /* 重试失败就用修复后的结果 */ }
  }
  // 格式错误（例如字符串里有没转义的引号）时，本地修复可能只保住前半截：先请模型把原文完整修成合法 JSON
  try {
    const fixed = await chat({
      ...opts,
      maxTokens: Math.max(opts.maxTokens || 4096, 8192),
      messages: [
        { role: 'system', content: '你是 JSON 修复工具。把用户给出的格式错误或不完整的 JSON 修正为一个合法的 JSON 对象：字符串里的双引号要转义，保留原有的全部字段和内容，缺失的字段按上下文合理补全或留空。只输出 JSON，不要任何其他文字。' },
        { role: 'user', content: String(reply).slice(0, 60000) },
      ],
    });
    if (strictJson(fixed)) return strictJson(fixed);
  } catch { /* 修复请求失败就用本地修复 */ }
  const json = extractJson(reply);
  if (json) return json;
  throw Object.assign(new Error(`模型没有返回可解析的 JSON：${reply.slice(0, 300)}`), { status: 502 });
}

/** 不做修复的解析：只接受完整合法的 JSON */
function strictJson(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const tryParse = t => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return tryParse(s) || (fence && tryParse(fence[1].trim())) || (a !== -1 && b > a ? tryParse(s.slice(a, b + 1)) : null);
}

/** 从模型回复中提取 JSON 对象（兼容 ```json 代码块与 <think> 前缀） */
export function extractJson(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const tryParse = t => { try { return JSON.parse(t); } catch { return null; } };
  let j = tryParse(s);
  if (j) return j;
  const fence = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(s);
  if (fence && (j = tryParse(fence[1].trim()) || tryParse(repairJson(fence[1])))) return j;
  const a = s.indexOf('{');
  if (a === -1) return null;
  const b = s.lastIndexOf('}');
  if (b > a && (j = tryParse(s.slice(a, b + 1)))) return j;
  return tryParse(repairJson(s.slice(a)));
}

/** 修复模型常见的 JSON 毛病：字符串里的原始换行/制表符、结尾多余逗号、输出被截断时缺少的引号和括号 */
export function repairJson(raw) {
  let s = String(raw || '').trim();
  const start = s.indexOf('{');
  if (start === -1) return s;
  s = s.slice(start);
  let out = '';
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { stack.pop(); out += ch; if (!stack.length) break; continue; }
    out += ch;
  }
  if (esc) out = out.slice(0, -1);
  if (inStr) out += '"';
  // 截断在键名或冒号之后时，补一个空值
  out = out.replace(/,\s*"[^"]*"\s*$/, '').replace(/:\s*$/, ': null');
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out.replace(/,\s*([}\]])/g, '$1');
}
