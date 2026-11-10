// 网页内：悬浮按钮 + 收藏面板 + 识别提示词及其关联的图片/视频
(() => {
  if (window.top !== window || window.__plibClipperLoaded) return;
  window.__plibClipperLoaded = true;

  const send = msg => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) return reject(new Error('插件刚更新过，请刷新这个网页后再试'));
        if (res?.ok) resolve(res.data);
        else reject(new Error(res?.error || '未知错误'));
      });
    } catch {
      reject(new Error('插件刚更新过，请刷新这个网页后再试'));
    }
  });
  const api = (path, opts = {}) => send({ type: 'plib-api', path, ...opts });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    [hidden] { display: none !important; }
    button { font: inherit; cursor: pointer; }
    .fab { position: fixed; right: 16px; top: 62%; width: 42px; height: 42px; border-radius: 50%; border: none;
      background: #d9480f; color: #fff; font-size: 15px; font-weight: 700; box-shadow: 0 4px 14px rgba(0,0,0,.28);
      z-index: 2147483646; opacity: .85; transition: opacity .15s, transform .15s; touch-action: none; user-select: none; }
    .fab:hover { opacity: 1; transform: scale(1.07); }
    .panel { position: fixed; right: 16px; top: 16px; bottom: 16px; width: 390px; max-width: calc(100vw - 32px);
      background: #fff; color: #1f2328; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.3);
      display: flex; flex-direction: column; z-index: 2147483647; font-size: 13px; overflow: hidden; transition: opacity .15s; }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eee; }
    header b { font-size: 14px; }
    .status { font-size: 12px; color: #888; flex: 1; }
    .status.ok { color: #2b8a3e; }
    .status.err { color: #c92a2a; }
    .x { border: none; background: none; font-size: 22px; line-height: 1; color: #888; padding: 0 4px; }
    .body { padding: 12px 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; color: #555; font-size: 12px; }
    input, textarea, select { font: inherit; font-size: 13px; color: #1f2328; background: #fff; border: 1px solid #d0d7de;
      border-radius: 6px; padding: 6px 8px; width: 100%; }
    textarea { resize: vertical; min-height: 150px; line-height: 1.5; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #ffd8c2; border-color: #d9480f; }
    .line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: #555; font-size: 12px; }
    .grow { flex: 1; }
    .small { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 3px 8px; font-size: 12px; color: #1f2328; }
    .small:hover { background: #eaeef2; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
    .thumb { position: relative; width: 76px; height: 76px; border-radius: 6px; background: #f1f3f5 center / cover no-repeat; border: 1px solid #e5e7eb; }
    .thumb .rm { position: absolute; top: -7px; right: -7px; width: 20px; height: 20px; border-radius: 50%; border: none;
      background: #333; color: #fff; font-size: 13px; line-height: 20px; padding: 0; }
    .thumb .tag { position: absolute; left: 3px; bottom: 3px; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; padding: 0 4px; border-radius: 3px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .chk { flex-direction: row; align-items: center; gap: 6px; color: #333; font-size: 13px; }
    .chk input { width: auto; }
    .src { color: #999; font-size: 11px; word-break: break-all; }
    footer { padding: 10px 14px; border-top: 1px solid #eee; display: flex; align-items: center; gap: 8px; }
    .msg { flex: 1; font-size: 12px; color: #555; line-height: 1.45; }
    .msg.ok { color: #2b8a3e; }
    .msg.err { color: #c92a2a; }
    .msg .small { margin-top: 4px; }
    .primary { border: none; background: #d9480f; color: #fff; border-radius: 6px; padding: 8px 14px; font-weight: 600; white-space: nowrap; }
    .primary:disabled { opacity: .6; cursor: default; }
    .hl { position: fixed; pointer-events: none; border: 3px solid #d9480f; background: rgba(217,72,15,.12); border-radius: 4px; z-index: 2147483645; }
    .flash.media { border-color: #1971c2; background: rgba(25,113,194,.12); }
    .tip { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 8px 16px;
      border-radius: 20px; font-size: 13px; z-index: 2147483647; pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
  `;

  const HTML = `
    <button class="fab" title="加入提示词库（Alt+Shift+Y）">词</button>
    <div class="panel" hidden>
      <header><b>加入提示词库</b><span class="status"></span><button class="x" data-act="close" title="关闭">×</button></header>
      <div class="body">
        <label>
          <span class="line"><span class="grow">提示词（先选中网页上的文字，会自动填入）</span>
            <button class="small" data-act="detect">从页面识别</button>
            <button class="small" data-act="reverse" title="让 AI 看选中的图片或视频，反推出提示词（需要在提示词库设置里配置视觉模型）">AI 反推</button></span>
          <textarea name="prompt" placeholder="选中、识别或粘贴提示词"></textarea>
        </label>
        <label>标题<input name="title" placeholder="留空则取提示词开头"></label>
        <div>
          <div class="line" style="margin-bottom:6px"><span class="grow">图片 / 视频（只保存链接）</span>
            <button class="small" data-act="pick">点选页面上的图片或视频</button></div>
          <div class="thumbs"></div>
          <input name="imageUrl" placeholder="或粘贴图片链接后按回车" style="margin-top:6px">
          <input name="video" placeholder="视频链接（可选，mp4 或视频所在网页）" style="margin-top:6px">
        </div>
        <div class="grid">
          <label>模型<input name="model" list="plib-models" placeholder="如 Seedance 2.0"><datalist id="plib-models"></datalist></label>
          <label>类别<select name="category"><option value="">自动归类</option></select></label>
        </div>
        <label>标签<input name="tags" placeholder="用逗号分隔，可选"></label>
        <label>备注<input name="note" placeholder="可选"></label>
        <label class="chk"><input type="checkbox" name="favorite"> 同时加入收藏</label>
        <div class="src"></div>
      </div>
      <footer><div class="msg"></div><button class="primary" data-act="save">加入提示词库</button></footer>
    </div>
    <div class="hl" hidden></div>
    <div class="tip" hidden>点击图片或视频即可选中（按住 Shift 可连续选多个，Esc 退出）</div>
  `;

  const host = document.createElement('plib-clipper');
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}</style>${HTML}`;
  document.documentElement.appendChild(host);
  // 在面板里打字时，不让网页自己的快捷键响应
  for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, e => e.stopPropagation());

  const $ = s => root.querySelector(s);
  const field = name => root.querySelector(`[name="${name}"]`);
  const fab = $('.fab');
  const panel = $('.panel');
  const hl = $('.hl');
  const tip = $('.tip');
  const state = {
    media: [], candidates: [], candIdx: -1, metaLoaded: false, picking: false,
    lastSel: '', lastSelAt: 0, lastSelEl: null,
    titleAuto: false, modelAuto: false, videoAuto: false,
    // promptSource：auto 自动识别（会跟随页面和滚动更新）/ chosen 点过「换一段」/ manual 手动选中、输入或 AI 反推
    promptSource: '', capturedHref: '', currentEl: null, lastHref: location.href, pageToken: 0,
  };

  const setStatus = (text, cls = '') => { const s = $('.status'); s.textContent = text; s.className = `status ${cls}`; };
  function showMsg(text, cls = '', extraHtml = '') {
    const m = $('.msg');
    m.className = `msg ${cls}`;
    m.innerHTML = esc(text) + (extraHtml ? `<br>${extraHtml}` : '');
  }

  // ---------- 悬浮按钮 ----------
  async function applyFabSetting() {
    const { showFab = true, hiddenSites = [], fabTop } = await chrome.storage.sync.get(['showFab', 'hiddenSites', 'fabTop']);
    fab.hidden = !showFab || hiddenSites.includes(location.hostname);
    if (typeof fabTop === 'number') fab.style.top = `${Math.min(Math.max(fabTop, 8), innerHeight - 50)}px`;
  }
  applyFabSetting().catch(() => {});
  chrome.storage.onChanged.addListener(() => applyFabSetting().catch(() => {}));

  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    const t = String(sel || '').trim();
    if (!t) return;
    const node = sel.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el || el === host) return;
    state.lastSel = t;
    state.lastSelAt = Date.now();
    state.lastSelEl = el;
  });

  let drag = null;
  fab.addEventListener('mousedown', e => e.preventDefault()); // 点按钮时保留网页上的选中文字
  fab.addEventListener('pointerdown', e => {
    drag = { y: e.clientY, top: fab.getBoundingClientRect().top, moved: false };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) fab.style.top = `${Math.min(Math.max(drag.top + dy, 8), innerHeight - 50)}px`;
  });
  fab.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) chrome.storage.sync.set({ fabTop: parseInt(fab.style.top, 10) });
    else if (panel.hidden) openPanel();
    else closePanel();
  });

  // ---------- 识别：提示词文本 ----------
  const PROMPT_WORD = /prompt|提示词|提示語|咒语|描述词/i;
  // 行首的“提示词（欢迎返图）：”“Prompt:”“中文提示词：”之类的标签
  const LABEL_RE = /(?:^|\n)[ \t]*[#*>【\[「📝✍️👇⬇️\-\s]*(?:正向|中文|英文|完整|视频|图片|生图|图像|原始)?[ \t]*(?:提示词|提示語|咒语|positive prompt|prompts?)[ \t]*(?:[（(][^）)\n]{0,24}[）)])?[ \t]*[】\]」*]*[ \t]*[:：]/iu;
  // 单独成行的“📝 Prompt”“提示词”标题
  const LABEL_LINE_RE = /(?:^|\n)[ \t]*[#*>【\[「📝✍️👇⬇️\-\s]*(?:提示词|提示語|prompts?)[ \t]*[】\]」*👇⬇️]*[ \t]*(?=\n)/iu;
  const VOCAB = [
    '镜头', '光线', '光影', '打光', '构图', '背景', '前景', '景深', '分辨率', '画面', '风格', '质感', '色调', '氛围', '比例', '横版', '竖版',
    '特写', '全身', '半身', '写实', '电影感', '超写实', '胶片', '颗粒', '柔光', '逆光', '侧光', '仰拍', '俯拍', '广角', '长焦', '机位', '运镜',
    '皮肤', '五官', '发型', '服装', '姿态', '表情', '纹理', '材质', '主体', '场景', '不要', '禁止', '避免', '秒', '分镜',
    '8k', '4k', '16:9', '9:16', '3:4', '4:3', '1:1', '--ar', '--v', 'cinematic', 'lighting', 'lens', 'shot', 'depth of field', 'bokeh',
    'photorealistic', 'realistic', 'ultra', 'detailed', 'style', 'composition', 'background', 'foreground', 'close-up', 'wide angle',
    '35mm', '50mm', '85mm', 'render', 'aspect ratio', 'camera', 'film grain', 'negative prompt', 'no text', 'watermark', 'portrait',
    'scene', 'atmosphere', 'texture', 'skin', 'outfit', 'pose', 'soft light', 'golden hour', 'high contrast', 'shallow', 'editorial',
  ];
  const CHROME_SEL = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';
  const MODEL_PATTERNS = [
    [/gpt[\s-]*image[\s-]*2\.5/i, 'GPT Image 2.5'], [/gpt[\s-]*image[\s-]*2(?!\.\d)/i, 'GPT Image 2'], [/gpt[\s-]*image/i, 'GPT Image'],
    [/nano[\s-]*banana[\s-]*pro/i, 'Nano Banana Pro'], [/nano[\s-]*banana[\s-]*2/i, 'Nano Banana 2'], [/nano[\s-]*banana/i, 'Nano Banana'],
    [/seedance[\s-]*2\.5/i, 'Seedance 2.5'], [/seedance[\s-]*2(\.0)?/i, 'Seedance 2.0'], [/seedream[\s-]*5/i, 'Seedream 5.0'], [/seedream[\s-]*4/i, 'Seedream 4.0'],
    [/midjourney|\bmj[\s-]?v\d/i, 'Midjourney'], [/即梦|jimeng|dreamina/i, '即梦'], [/可灵|kling/i, '可灵'], [/veo[\s-]*3/i, 'Veo 3'],
    [/sora[\s-]*2/i, 'Sora 2'], [/海螺|hailuo|minimax/i, '海螺'], [/flux/i, 'FLUX'], [/grok/i, 'Grok'], [/chatgpt|gpt-?4o/i, 'ChatGPT'],
  ];

  // data-plib-site="x" 用于本地按 X 页面结构做测试
  const IS_X = /(^|\.)(x|twitter)\.com$/.test(location.hostname) || document.documentElement.dataset.plibSite === 'x';
  function xFocalArticle() {
    if (!IS_X) return null;
    const id = /\/status\/(\d+)/.exec(location.pathname)?.[1];
    if (!id) return null;
    for (const a of document.querySelectorAll('article')) {
      if (a.querySelector(`a[href*="/status/${id}"] time`)) return a;
    }
    return null;
  }

  const xAuthor = article => (article?.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href') || '').toLowerCase();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(check, timeout) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) if (check()) return true;
    return false;
  }
  // X 的长帖会被折叠。“显示更多”是就地展开的按钮，识别前先点开（只点按钮，不点会跳转页面的链接）
  async function expandXTruncated() {
    const buttons = [...document.querySelectorAll('article button[data-testid="tweet-text-show-more-link"]')]
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.bottom > -innerHeight && r.top < innerHeight * 3; })
      .slice(0, 6);
    if (!buttons.length) return false;
    const before = location.href;
    buttons.forEach(b => b.click());
    await sleep(800);
    if (location.href !== before) await waitFor(() => xFocalArticle()?.querySelector('[data-testid="tweetText"]'), 4000);
    return true;
  }

  const CODE_BLOCK = '[data-testid="markdown-code-block"]'; // X 长文里的代码块，第一行是语言标记（如 text）
  const textOf = el => {
    const t = ((el.tagName === 'TEXTAREA' ? el.value : el.innerText) || '').replace(/\r/g, '').trim();
    return el.matches?.(CODE_BLOCK) ? t.replace(/^(text|plaintext|txt|prompt|markdown|md|json|yaml|bash|shell)\s*\n/i, '').trim() : t;
  };
  const ARTICLE_BODY = '[data-testid="twitterArticleRichTextView"]';
  function articleHeading(el) {
    const body = el.closest(ARTICLE_BODY);
    if (!body) return '';
    const heads = [...body.querySelectorAll('h1, h2, h3')].filter(h => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const title = document.querySelector('[data-testid="twitter-article-title"]')?.innerText.trim() || '';
    const head = heads.length ? heads[heads.length - 1].innerText.trim() : '';
    return head || title;
  }
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cleanTail = s => s
    .replace(/\n\s*(显示更多|显示原文|翻译帖子|Show more|Translate post)\s*$/i, '')
    .replace(/(\n\s*(#[^\s#]+\s*)+)+$/u, '')
    .trim();

  /** 把一段文字拆成“标签前的说明”和“提示词正文” */
  function splitPrompt(raw) {
    const text = String(raw || '').replace(/\r/g, '');
    const m = LABEL_RE.exec(text) || LABEL_LINE_RE.exec(text);
    if (!m) return { prompt: cleanTail(text), before: '', labeled: false };
    const prompt = cleanTail(text.slice(m.index + m[0].length));
    return { prompt, before: text.slice(0, m.index).trim(), labeled: prompt.length >= 20 };
  }
  function guessTitle(before) {
    const line = String(before || '').split('\n').map(s => s.trim()).find(s => s && !/^(#\S+\s*)+$/.test(s) && !/^https?:\/\//.test(s));
    return line ? line.replace(/[。.:：!！,，\s]+$/u, '').slice(0, 40) : '';
  }
  function detectModel(text) {
    for (const [re, name] of MODEL_PATTERNS) if (re.test(text)) return name;
    return '';
  }
  function ancestorDepth(from, target) {
    let depth = 0;
    for (let x = from; x && depth <= 10; x = x.parentElement, depth++) if (x.contains(target)) return depth;
    return Infinity;
  }
  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim().length >= 12) return true;
    return false;
  }
  // 行内拆分的文字（多个 span）向上合并成完整的一段
  function liftBlock(el) {
    const special = el.closest(`[data-testid="tweetText"], ${CODE_BLOCK}, pre, textarea`);
    if (special) return special;
    let cur = el;
    for (let i = 0; i < 4; i++) {
      const p = cur.parentElement;
      if (!p || /^(BODY|HTML|MAIN|ARTICLE)$/.test(p.tagName)) break;
      if (p.textContent.trim().length > cur.textContent.trim().length * 1.2 + 10) break;
      cur = p;
    }
    return cur;
  }
  function labelBefore(el) {
    const prev = [el.previousElementSibling, el.parentElement?.previousElementSibling];
    return prev.some(p => p && p.textContent.trim().length <= 30 && PROMPT_WORD.test(p.textContent));
  }

  function scoreCandidate(el, raw, near, focal) {
    const { prompt, before, labeled } = splitPrompt(raw);
    if (prompt.length < 20 || /^(https?:\/\/\S+\s*)+$/.test(prompt)) return null;
    const lower = prompt.toLowerCase();
    let score = Math.min(prompt.length, 1500) / 100;
    const hits = VOCAB.filter(w => lower.includes(w)).length;
    score += Math.min(hits * 5, 45);
    if (!labeled && prompt.length < 80 && hits < 2) score -= 30; // 很短又不像提示词，例如“提示词发评论区了”
    const seps = (prompt.match(/[,，、;；]/g) || []).length;
    if (prompt.length >= 60 && seps / prompt.length >= 0.02) score += 10;
    if (labeled) score += 60;
    else if (labelBefore(el)) score += 45;
    const attr = `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''} ${el.getAttribute('data-testid') || ''}`;
    if (/prompt/i.test(attr)) score += 35;
    if (/^(PRE|CODE|TEXTAREA)$/.test(el.tagName)) score += 12;
    if (el.matches(CODE_BLOCK)) score += 30;
    else if (el.closest(ARTICLE_BODY)) score -= 30; // 长文正文是讲解，提示词一般放在代码块里
    if (el.closest(CHROME_SEL)) score -= 80;
    if (el.closest('main, article, [role="main"]')) score += 8;
    if (focal) {
      const art = el.closest('article');
      if (focal.contains(el)) score += 40;
      else if (art && xAuthor(art) && xAuthor(art) === xAuthor(focal)) score += 35; // 楼主在评论区补发的提示词
      else score += art ? -40 : -10;
    }
    if (IS_X && el.closest('article div[role="link"]')) score -= 50; // 引用帖里的文字通常是被截断的

    // 屏幕上正在看的内容优先：可见、越靠近屏幕中央分越高
    const r = el.getBoundingClientRect();
    const visTop = Math.max(r.top, 0);
    const visBottom = Math.min(r.bottom, innerHeight);
    if (visBottom > visTop) {
      const center = (visTop + visBottom) / 2;
      score += 20 + 20 * (1 - Math.abs(center - innerHeight / 2) / (innerHeight / 2));
      score += 10 * Math.min((visBottom - visTop) / Math.max(Math.min(r.height, innerHeight), 1), 1);
    } else {
      const away = Math.min(Math.abs(r.top - innerHeight), Math.abs(r.bottom)) / innerHeight;
      score -= Math.min(40, 10 + away * 10);
    }
    const nearBody = near?.closest?.(ARTICLE_BODY);
    if (nearBody && nearBody.contains(el)) {
      // X 长文里所有提示词和图片都在同一个容器，按先后顺序找这张图对应的那段提示词：图片前面最近的一段，没有就取后面第一段
      const blocks = [...nearBody.querySelectorAll(CODE_BLOCK)];
      const before = blocks.filter(b => b.compareDocumentPosition(near) & Node.DOCUMENT_POSITION_FOLLOWING);
      const owner = before[before.length - 1] || blocks.find(b => near.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      score += owner === el ? 120 : -20;
    } else if (near) {
      const d = ancestorDepth(near, el);
      // 从图片出发时，同一张卡片里的文字要明显优先于隔壁卡片
      score += d <= 8 ? 120 - d * 25 : -30;
    }
    return { el, raw, t: prompt, before: before || articleHeading(el), labeled, score };
  }

  function collectCandidates(near = null) {
    const focal = xFocalArticle();
    const seen = new Set();
    const out = [];
    const nodes = document.querySelectorAll(`pre, code, textarea, blockquote, p, li, td, div, span, section, [data-testid="tweetText"], ${CODE_BLOCK}`);
    let n = 0;
    for (const node of nodes) {
      if (++n > 15000) break;
      if (node === host) continue;
      const special = /^(PRE|CODE|TEXTAREA)$/.test(node.tagName) || node.matches(`[data-testid="tweetText"], ${CODE_BLOCK}, [class*="prompt" i], [id*="prompt" i]`);
      if (!special) {
        const len = node.textContent.length;
        if (len < 30 || len > 20000 || !hasOwnText(node)) continue;
      }
      const el = liftBlock(node);
      if (seen.has(el)) continue;
      seen.add(el);
      const raw = textOf(el);
      if (raw.length < 30 || raw.length > 20000 || !visible(el)) continue;
      const c = scoreCandidate(el, raw, near, focal);
      if (c) out.push(c);
    }
    out.sort((a, b) => b.score - a.score);
    const uniq = [];
    for (const c of out) {
      if (uniq.some(u => u.t === c.t || u.el.contains(c.el) || c.el.contains(u.el))) continue;
      uniq.push(c);
      if (uniq.length >= 8) break;
    }
    return uniq;
  }

  // ---------- 识别：与提示词关联的图片 / 视频 ----------
  const SKIP_IMG = /profile_images|avatar|emoji|favicon|\/icons?\/|logo|badge|sprite|placeholder/i;
  function mediaIn(container) {
    const out = [];
    const keys = new Set();
    for (const el of container.querySelectorAll('img, video')) {
      const r = el.getBoundingClientRect();
      if (el.tagName === 'VIDEO') {
        const url = el.currentSrc || el.src || el.querySelector('source')?.src || '';
        const key = url || el.poster;
        if ((r.width < 80 && !el.poster) || !key || keys.has(key)) continue;
        keys.add(key);
        out.push({ kind: 'video', url, poster: el.poster, el });
        continue;
      }
      if (el.closest('[data-testid="videoPlayer"], video, [data-testid*="avatar" i], [class*="avatar" i]')) continue;
      const url = el.currentSrc || el.src || '';
      if (!/^https?:/i.test(url) || SKIP_IMG.test(url) || keys.has(url)) continue;
      const w = r.width || el.naturalWidth;
      const h = r.height || el.naturalHeight;
      if (w < 100 || h < 80) continue;
      keys.add(url);
      out.push({ kind: 'image', url, el });
    }
    return out;
  }
  // X：一条帖子里可能嵌着引用帖（div[role=link]），文字、图片和帖子链接要分清属于哪一条
  function xUnit(el) {
    const article = el.closest('article');
    const quote = el.closest('div[role="link"]');
    const isQuote = !!quote && !!article?.contains(quote);
    const unit = isQuote ? quote : article;
    const own = node => isQuote || !node.closest('div[role="link"]');
    const statusHref = [...unit.querySelectorAll('a[href*="/status/"]')].filter(own).map(a => a.getAttribute('href'))[0] || '';
    const base = /^\/[^/]+\/status\/\d+/.exec(statusHref)?.[0];
    const id = /\/status\/(\d+)/.exec(statusHref)?.[1];
    const media = mediaIn(unit).filter(m => {
      if (!own(m.el)) return false;
      const href = m.el.closest('a[href*="/status/"]')?.getAttribute('href');
      return !href || !id || href.includes(`/status/${id}`);
    });
    return { unit, media, permalink: base ? new URL(base, location.origin).href : location.href };
  }
  function rectDist(a, b) {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.hypot(dx, dy);
  }
  function relatedMedia(textEl) {
    if (!textEl || !document.contains(textEl)) return [];
    // X 长文：一篇里有多段提示词，配图取这段提示词之后、下一段提示词之前的图片；没有就取它前面最近的一张
    const body = textEl.closest(ARTICLE_BODY);
    if (body) {
      const block = textEl.closest(CODE_BLOCK) || textEl;
      const seq = [...body.querySelectorAll(`${CODE_BLOCK}, [data-testid="tweetPhoto"] img`)];
      let at = seq.indexOf(block);
      if (at === -1) at = seq.findIndex(x => block.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) - 1;
      const isImg = x => x.tagName === 'IMG';
      const after = [];
      for (let i = at + 1; i < seq.length && isImg(seq[i]); i++) after.push(seq[i]);
      let picks = after.slice(0, 4);
      if (!picks.length) picks = seq.slice(0, Math.max(at, 0)).filter(isImg).slice(-1);
      return picks.filter(i => /^https?:/i.test(i.currentSrc || i.src))
        .map(i => ({ kind: 'image', url: i.currentSrc || i.src, el: i, pageUrl: location.href }));
    }
    if (IS_X && textEl.closest('article')) {
      let u = xUnit(textEl);
      const art = textEl.closest('article');
      const focal = xFocalArticle();
      // 楼主把提示词发在评论区时，图片和视频在主帖里
      if (!u.media.length && focal && art !== focal && xAuthor(art) && xAuthor(art) === xAuthor(focal)) {
        u = xUnit(focal.querySelector('[data-testid="tweetText"]') || focal);
      }
      return u.media.slice(0, 8).map(m => ({ ...m, pageUrl: u.permalink }));
    }
    // 向上找到第一个含图片/视频的容器；容器里如果还有别的提示词，只保留离当前提示词最近的媒体
    const rivals = state.candidates.filter(c => c.score >= 45 && c.el !== textEl && !c.el.contains(textEl) && !textEl.contains(c.el));
    let node = textEl;
    for (let depth = 0; node && !/^(BODY|HTML)$/.test(node.tagName) && depth < 9; depth++, node = node.parentElement) {
      let media = mediaIn(node);
      if (!media.length) continue;
      const inside = rivals.filter(c => node.contains(c.el));
      if (inside.length) {
        const own = textEl.getBoundingClientRect();
        media = media.filter(m => {
          const mr = m.el.getBoundingClientRect();
          const d0 = rectDist(mr, own);
          return inside.every(c => rectDist(mr, c.el.getBoundingClientRect()) >= d0);
        });
      }
      return media.slice(0, 8);
    }
    return [];
  }

  // ---------- 面板 ----------
  async function loadMeta() {
    try {
      await api('/api/stats');
      setStatus('已连接本地库', 'ok');
      if (state.metaLoaded) return;
      const [models, cats] = await Promise.all([api('/api/models'), api('/api/categories')]);
      $('#plib-models').innerHTML = models.filter(m => m.model !== '未标注').map(m => `<option value="${esc(m.model)}">`).join('');
      field('category').innerHTML = '<option value="">自动归类</option>'
        + cats.map(c => `<option value="${esc(c.code)}">${esc(c.code)} ${esc(c.name)}</option>`).join('');
      state.metaLoaded = true;
    } catch (e) {
      setStatus('未连接', 'err');
      showMsg(e.message, 'err');
    }
  }

  async function openPanel(p = {}) {
    panel.hidden = false;
    loadMeta();
    $('.src').textContent = `来源：${location.href}`;
    state.lastHref = location.href;
    // 面板里还是别的页面自动识别的内容：清掉，按当前页面重新识别
    if (state.capturedHref && state.capturedHref !== location.href && state.promptSource !== 'manual') clearForNewPage();
    if (!field('model').value) {
      const { lastModel } = await chrome.storage.local.get('lastModel');
      if (lastModel) { field('model').value = lastModel; state.modelAuto = true; }
    }
    const liveSel = String(getSelection() || '').trim();
    const recentSel = Date.now() - state.lastSelAt < 20000 ? state.lastSel : '';
    const selText = String(p.selection || '').trim() || liveSel || recentSel;

    if (p.image || p.video) {
      const el = findElementBySrc(p.image || p.video);
      addMedia({ kind: p.video ? 'video' : 'image', url: p.image || p.video, el });
      renderThumbs();
      if (!selText && el) { await runDetect({ near: el, auto: true }); field('prompt').focus(); return; }
    }
    if (selText.length >= 2) {
      applySelection(selText, state.lastSelEl);
    } else if (!field('prompt').value.trim()) {
      await runDetect({ auto: true });
    }
    field('prompt').focus();
  }
  function closePanel() { stopPick(); clearFlash(); panel.hidden = true; }
  function setPrompt(text, source = 'manual') {
    field('prompt').value = text;
    state.promptSource = text ? source : '';
    state.capturedHref = text ? location.href : '';
    if (source !== 'auto' && source !== 'chosen') state.currentEl = null;
  }

  function clearForNewPage() {
    setPrompt('', '');
    if (state.titleAuto) { field('title').value = ''; state.titleAuto = false; }
    field('video').value = '';
    Object.assign(state, { media: [], candidates: [], candIdx: -1, currentEl: null, videoAuto: false });
    renderThumbs();
    clearFlash();
    $('[data-act="detect"]').textContent = '从页面识别';
  }

  // X 这类单页应用切换帖子时不会刷新页面：等新内容渲染出来
  async function waitForPage() {
    await sleep(800);
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (IS_X && /\/status\//.test(location.pathname)) {
        if (xFocalArticle()?.querySelector(`[data-testid="tweetText"], ${ARTICLE_BODY}`)) return;
      } else if (collectCandidates().some(c => c.score >= 45)) return;
      await sleep(500);
    }
  }

  async function onPageChanged() {
    state.candidates = [];
    clearFlash();
    if (panel.hidden || state.picking) return;
    $('.src').textContent = `来源：${location.href}`;
    if (state.promptSource === 'manual' && field('prompt').value.trim()) {
      showMsg('页面已切换，面板里还是上一个页面的内容', 'err', '<button class="small" data-act="redetect">清空并识别当前页面</button>');
      return;
    }
    clearForNewPage();
    showMsg('页面已切换，正在识别当前页面…');
    const token = ++state.pageToken;
    await waitForPage();
    if (token !== state.pageToken || panel.hidden || location.href !== state.lastHref) return;
    await runDetect({ auto: true });
    if (!field('prompt').value.trim()) showMsg('当前页面没有识别到提示词，可以选中文字，或点「从页面识别」');
  }

  // 滚动停下后，如果屏幕中央换成了另一段提示词，就跟着切换（手动改过或点选过图片后不再跟随）
  async function followViewport() {
    if (panel.hidden || state.picking || state.promptSource !== 'auto' || state.media.some(m => !m.auto)) return;
    const cands = collectCandidates();
    const best = cands[0];
    if (!best || best.score < 45) return;
    const cur = state.currentEl && document.contains(state.currentEl) ? cands.find(c => c.el === state.currentEl) : null;
    if (best.el === state.currentEl || (cur && best.score - cur.score < 15)) return;
    state.candidates = cands;
    state.candIdx = -1;
    state.candHref = location.href;
    await runDetect({ auto: true, reuse: true });
    if (state.currentEl === best.el) showMsg('已跟随屏幕切换到当前看到的提示词；不对可以点「换一段」', 'ok');
  }

  function applySelection(text, selEl) {
    const { prompt, before } = splitPrompt(text);
    setPrompt(prompt.length >= 20 ? prompt : text, 'manual');
    let context = before;
    if (selEl && document.contains(selEl)) {
      const block = liftBlock(selEl);
      context = `${before}\n${splitPrompt(textOf(block)).before}`;
      state.candidates = collectCandidates(block);
      setAutoFields(context, text);
      replaceAutoMedia(relatedMedia(block));
      flash([block, ...state.media.filter(m => m.el).map(m => m.el)]);
    } else {
      setAutoFields(context, text);
    }
  }

  function setAutoFields(before, text) {
    const title = guessTitle(before);
    if (title && (!field('title').value.trim() || state.titleAuto)) { field('title').value = title; state.titleAuto = true; }
    const model = detectModel(`${before}\n${String(text).slice(0, 300)}\n${document.title}`);
    if (model && (!field('model').value.trim() || state.modelAuto)) { field('model').value = model; state.modelAuto = true; }
  }

  function replaceAutoMedia(list) {
    state.media = state.media.filter(m => !m.auto);
    if (state.videoAuto) { field('video').value = ''; state.videoAuto = false; }
    for (const m of list) addMedia(m, true);
    renderThumbs();
  }

  async function runDetect({ near = null, auto = false, reuse = false } = {}) {
    const stale = !state.candidates.length || state.candHref !== location.href || state.candidates.some(c => !document.contains(c.el));
    if ((auto || near || stale) && !reuse) {
      if (IS_X) await expandXTruncated();
      state.candidates = collectCandidates(near);
      state.candIdx = -1;
      state.candHref = location.href;
    }
    const btn = $('[data-act="detect"]');
    const best = state.candidates[0];
    if (!best || (auto && best.score < 45)) {
      if (!auto) showMsg('没在页面上找到像提示词的文字，请手动选中或粘贴', 'err');
      return;
    }
    state.candIdx = (state.candIdx + 1) % state.candidates.length;
    const c = state.candidates[state.candIdx];
    // 页面文字可能已经变了（例如刚展开了“显示更多”），按元素当前的文字重新拆分
    const fresh = textOf(c.el);
    if (fresh && fresh !== c.raw) {
      const sp = splitPrompt(fresh);
      Object.assign(c, { raw: fresh, t: sp.prompt, before: sp.before, labeled: sp.labeled });
    }
    setPrompt(c.t, auto || near ? 'auto' : 'chosen');
    state.currentEl = c.el;
    setAutoFields(c.before, c.raw);
    const media = relatedMedia(c.el);
    replaceAutoMedia(media);
    btn.textContent = state.candidates.length > 1 ? `换一段（${state.candIdx + 1}/${state.candidates.length}）` : '重新识别';
    const folded = IS_X && c.el.closest('article')?.querySelector('a[data-testid="tweet-text-show-more-link"]');
    showMsg(folded
      ? '这条帖子被折叠了，识别到的只是开头。请点帖子里的「显示更多」打开全文，再点「重新识别」'
      : `已识别提示词${media.length ? `和 ${media.length} 个关联的图片/视频` : ''}（页面上已框出）；不对可以点「换一段」`, folded ? 'err' : 'ok');
    flash([c.el, ...media.map(m => m.el)], !auto);
  }

  // 在页面上框出识别到的提示词（橙色）和图片/视频（蓝色）
  let flashTimer = 0;
  function clearFlash() { root.querySelectorAll('.flash').forEach(x => x.remove()); }
  function flash(els, scroll = false) {
    const list = els.filter(el => el && document.contains(el));
    if (!list.length) return;
    clearFlash();
    if (scroll) list[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      clearFlash();
      list.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const d = document.createElement('div');
        d.className = `hl flash${i ? ' media' : ''}`;
        Object.assign(d.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
        root.appendChild(d);
      });
      clearTimeout(flashTimer);
      flashTimer = setTimeout(clearFlash, 1800);
    }, scroll ? 450 : 0);
  }

  // ---------- 图片 / 视频 ----------
  function findElementBySrc(src) {
    for (const el of document.querySelectorAll('img, video, source')) {
      if (el.currentSrc === src || el.src === src || el.poster === src) return el.tagName === 'SOURCE' ? el.parentElement : el;
    }
    return null;
  }
  function betterImageUrl(u) {
    try {
      const url = new URL(u);
      if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) { url.searchParams.set('name', 'large'); return url.href; }
    } catch { /* 保持原链接 */ }
    return u;
  }
  function pushImage(url, tag = '', auto = false) {
    const existing = state.media.find(x => x.url === url);
    if (existing) { if (!auto) existing.auto = false; return; }
    state.media.push({ url, tag, auto });
  }
  function renderThumbs() {
    const cssUrl = u => u.replace(/["'()\\\s]/g, c => encodeURIComponent(c));
    $('.thumbs').innerHTML = state.media.map((x, i) => `<div class="thumb" title="${esc(x.url)}" style="background-image:url('${cssUrl(x.url)}')">`
      + `${x.tag || x.auto ? `<span class="tag">${esc(x.tag || '识别')}</span>` : ''}<button class="rm" data-rm="${i}" title="移除">×</button></div>`).join('');
  }
  function addMedia(m, auto = false) {
    if (m.kind === 'video') {
      const direct = /^https?:/i.test(m.url || '') && !/^blob:/i.test(m.url);
      const url = direct ? m.url : (m.pageUrl || location.href);
      if (!auto || !field('video').value.trim()) {
        field('video').value = url;
        state.videoAuto = auto;
        if (!direct && !auto) showMsg('这个视频是流媒体播放的，已改为保存视频所在网页的链接');
      }
      if (/^https?:/i.test(m.poster || '')) pushImage(m.poster, '封面', auto);
    } else {
      if (!/^https?:/i.test(m.url || '')) { if (!auto) showMsg('这张图片是网页内嵌的数据，没有可以保存的链接', 'err'); return; }
      pushImage(betterImageUrl(m.url), '', auto);
    }
    const last = state.media[state.media.length - 1];
    if (last && m.el && !last.el) last.el = m.el;
  }

  function mediaAtPoint(x, y) {
    const els = document.elementsFromPoint(x, y).filter(el => el !== host).slice(0, 12);
    for (const el of els) {
      if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return { kind: 'image', url: el.currentSrc || el.src, el };
      if (el.tagName === 'VIDEO') {
        const pageUrl = IS_X && el.closest('article') ? xUnit(el).permalink : undefined;
        return { kind: 'video', url: el.currentSrc || el.src || el.querySelector('source')?.src || '', poster: el.poster, el, pageUrl };
      }
      const m = /url\(["']?(https?:[^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
      if (m && el.getBoundingClientRect().width >= 60) return { kind: 'image', url: m[1], el };
    }
    return null;
  }
  const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick'];
  function onPickMove(e) {
    const m = mediaAtPoint(e.clientX, e.clientY);
    if (!m) { hl.hidden = true; return; }
    const r = m.el.getBoundingClientRect();
    Object.assign(hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    hl.hidden = false;
  }
  function onPickBlock(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const m = mediaAtPoint(e.clientX, e.clientY);
    if (!e.shiftKey) stopPick();
    if (!m) { showMsg('这里没有识别到图片或视频', 'err'); return; }
    addMedia(m);
    renderThumbs();
    if (!field('prompt').value.trim()) runDetect({ near: m.el, auto: true });
  }
  function onPickKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopPick(); }
  }
  function startPick() {
    if (state.picking) return;
    state.picking = true;
    clearFlash();
    panel.style.opacity = '.3';
    panel.style.pointerEvents = 'none';
    tip.hidden = false;
    addEventListener('mousemove', onPickMove, true);
    for (const t of BLOCKED) addEventListener(t, onPickBlock, true);
    addEventListener('keydown', onPickKey, true);
  }
  function stopPick() {
    if (!state.picking) return;
    state.picking = false;
    panel.style.opacity = '';
    panel.style.pointerEvents = '';
    tip.hidden = true;
    hl.hidden = true;
    removeEventListener('mousemove', onPickMove, true);
    for (const t of BLOCKED) removeEventListener(t, onPickBlock, true);
    removeEventListener('keydown', onPickKey, true);
  }

  // ---------- AI 反推 ----------
  async function reverseWithAi() {
    const video = field('video').value.trim();
    const image = (state.media.find(m => m.tag !== '封面') || state.media[0])?.url || '';
    if (!image && !video) return showMsg('先点选页面上的图片或视频（或右键图片选“加入提示词库”），再用 AI 反推', 'err');
    const btn = $('[data-act="reverse"]');
    btn.disabled = true;
    const started = Date.now();
    const tick = setInterval(() => showMsg(`AI 正在${video ? '抽帧看视频' : '看图'}并反推提示词…（${Math.round((Date.now() - started) / 1000)} 秒）`), 500);
    try {
      // 视频链接可能是网页地址（比如 X 帖子），服务端取不到视频时会自动改用封面图
      const r = await api('/api/reverse', {
        method: 'POST',
        body: { video_url: video, image_url: image, target_model: field('model').value.trim(), lang: 'zh' },
      });
      clearInterval(tick);
      const res = r.result || {};
      setPrompt(res.prompt || res.prompt_en || '');
      if (res.title && (!field('title').value.trim() || state.titleAuto)) { field('title').value = res.title; state.titleAuto = true; }
      const keywords = Array.isArray(r.analysis?.keywords) ? r.analysis.keywords.join(', ') : '';
      if (keywords && !field('tags').value.trim()) field('tags').value = keywords;
      const code = r.category?.code;
      if (code && !field('category').value && [...field('category').options].some(o => o.value === code)) field('category').value = code;
      const mark = `AI 反推（写法：${r.media?.target_model || '通用'}）`;
      if (!field('note').value.includes('AI 反推')) field('note').value = [field('note').value.trim(), mark].filter(Boolean).join(' · ');
      showMsg(`反推完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒${r.notice ? `。${r.notice}` : ''}。确认后点「加入提示词库」`, 'ok');
    } catch (e) {
      clearInterval(tick);
      showMsg(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 保存 ----------
  function resetForm() {
    for (const n of ['prompt', 'title', 'imageUrl', 'video', 'tags', 'note']) field(n).value = '';
    field('category').value = '';
    field('favorite').checked = false;
    Object.assign(state, { media: [], candidates: [], candIdx: -1, titleAuto: false, videoAuto: false, promptSource: '', capturedHref: '', currentEl: null });
    renderThumbs();
    $('[data-act="detect"]').textContent = '从页面识别';
  }
  async function save(force = false) {
    const prompt = field('prompt').value.trim();
    if (!prompt) return showMsg('请先填入提示词', 'err');
    const video = field('video').value.trim();
    if (video && !/^https?:/i.test(video)) return showMsg('视频链接需要以 http:// 或 https:// 开头', 'err');
    const body = {
      title: field('title').value.trim(), prompt, images: state.media.map(x => x.url),
      video_url: video || null, media_type: video ? 'video' : 'image', model: field('model').value.trim(),
      category_code: field('category').value, tags: field('tags').value, note: field('note').value.trim(),
      favorite: field('favorite').checked, source_url: location.href, force,
    };
    const btn = $('[data-act="save"]');
    btn.disabled = true;
    showMsg('正在保存…');
    try {
      const r = await api('/api/clip', { method: 'POST', body });
      if (r.duplicate) {
        showMsg(`库里已经有相同的提示词：#${r.case.id}「${r.case.title}」`, 'err', '<button class="small" data-act="force">仍然加入</button>');
        return;
      }
      if (body.model) chrome.storage.local.set({ lastModel: body.model });
      resetForm();
      const label = c => `${c.category_name || '未分类'}${c.subcategory_name ? ` / ${c.subcategory_name}` : ''}`;
      if (r.autotag) {
        showMsg(`已加入 #${r.case.id} · ${label(r)}（正在按图重新归类…）`, 'ok');
        waitAutoTag(r.case.id, label(r));
      } else {
        showMsg(`已加入 #${r.case.id} · ${label(r)}`, 'ok');
      }
      setStatus('已连接本地库', 'ok');
    } catch (e) {
      showMsg(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /** 规则归类先返回，AI 看图归类几十秒后才出结果：轮询到有结果就把提示更新掉 */
  async function waitAutoTag(id, ruleLabel) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      let c;
      try { c = await api(`/api/cases/${id}`); } catch { continue; }
      if (c && c.classify_source === 'ai') {
        const now = `${c.category_code || '未分类'} ${c.subcategory_name || ''}`.trim();
        const changed = now !== ruleLabel;
        showMsg(`已加入 #${id} · ${now}${changed ? '（AI 看图归类，已修正）' : ''}`, 'ok');
        return;
      }
    }
    showMsg(`已加入 #${id} · ${ruleLabel}（AI 归类没赶上，稍后由后台批量处理）`, 'ok');
  }

  root.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { state.media.splice(Number(rm.dataset.rm), 1); renderThumbs(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closePanel();
    else if (act === 'detect') runDetect();
    else if (act === 'redetect') { clearForNewPage(); runDetect({ auto: true }).then(() => { if (!field('prompt').value.trim()) showMsg('当前页面没有识别到提示词，可以选中文字，或点「从页面识别」'); }); }
    else if (act === 'reverse') reverseWithAi();
    else if (act === 'pick') startPick();
    else if (act === 'save') save(false);
    else if (act === 'force') save(true);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePanel();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(false);
  });
  field('prompt').addEventListener('input', () => { state.promptSource = field('prompt').value.trim() ? 'manual' : ''; state.capturedHref = location.href; });
  field('title').addEventListener('input', () => { state.titleAuto = false; });
  field('model').addEventListener('input', () => { state.modelAuto = false; });
  field('video').addEventListener('input', () => { state.videoAuto = false; });
  field('imageUrl').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const u = field('imageUrl').value.trim();
    if (/^https?:/i.test(u)) { pushImage(u); renderThumbs(); field('imageUrl').value = ''; showMsg(''); }
    else showMsg('请粘贴以 http:// 或 https:// 开头的图片链接', 'err');
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'plib-open') openPanel(msg);
  });

  // 监听单页应用的网址变化（X、小红书等切换内容不刷新页面）
  const checkUrl = () => {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    onPageChanged();
  };
  setInterval(checkUrl, 600);
  addEventListener('popstate', checkUrl);

  let scrollTimer = 0;
  addEventListener('scroll', () => {
    if (panel.hidden) return;
    clearFlash();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { followViewport().catch(() => {}); }, 700);
  }, { passive: true, capture: true });
})();
