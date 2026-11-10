'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opt = {}) {
  const init = { ...opt, headers: { 'Content-Type': 'application/json', 'X-Plib-Client': 'web' } };
  if (opt.body && typeof opt.body !== 'string') init.body = JSON.stringify(opt.body);
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function copyText(text) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {}
  }
  toast(ok ? '提示词已复制到剪贴板！' : '复制失败，请手动选择复制');
}
function setStatus(el, msg, isErr = false) {
  el.innerHTML = msg;
  el.classList.toggle('err', isErr);
}

// ---------- 状态 ----------
const state = { categories: [], q: '', category: '', subcategory: '', model: '', media: '', source: '', favorite: false, review: false, semantic: false, tier: 1, facets: {}, facetDefs: [], facetCounts: {}, offset: 0, pageSize: 60, editingId: null, pins: [], masters: [] };
const sourceLabel = c => (c.source === 'user' ? '我添加的' : c.source === 'opennana' ? `OpenNana #${c.source_case_id}`
  : c.source === 'github' ? `GitHub 精选 · ${c.source_case_id}` : `canghe #${c.source_case_id}`);
const catName = code => state.categories.find(c => c.code === code)?.name || '';

// ---------- Tabs ----------
function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  state.activeTab = name;
  if (name === 'builder') initPromptPalette();
  if (name === 'templates' && !$('#tpl-body').innerHTML) openTemplate('rules');
  if (name === 'settings') { loadSettings(); loadDrive(); }
  if (name === 'generate') { loadHistory(); loadLlmModels(); }
  if (name === 'reverse') { loadLlmModels('#rev-llm', 'plib_rev_llm'); }
  if (name === 'reverse') loadRevHistory();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
state.activeTab = 'builder';

// ---------- 图片拖放 ----------
function fileToDataUrl(file, maxSide) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const url = fr.result;
      if (file.type === 'image/gif') return resolve(url);
      const im = new Image();
      im.onload = () => {
        const side = Math.max(im.width, im.height);
        if (side <= maxSide) return resolve(url);
        const k = maxSide / side;
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.92));
      };
      im.onerror = () => resolve(url);
      im.src = url;
    };
    fr.readAsDataURL(file);
  });
}

function setupDrop(root, maxSide) {
  const input = root.querySelector('input[type=file]');
  const img = root.querySelector('img');
  const hint = root.querySelector('.drop-hint');
  const clear = root.querySelector('.clear');
  let dataUrl = null;
  let removed = false;
  const show = src => { img.src = src; img.hidden = false; hint.hidden = true; clear.hidden = false; };
  const api = {
    get: () => dataUrl,
    removed: () => removed,
    async setFile(file) {
      if (!file || !file.type.startsWith('image/')) return toast('请选择图片文件');
      dataUrl = await fileToDataUrl(file, maxSide);
      removed = false;
      show(dataUrl);
    },
    setExisting(url) { dataUrl = null; removed = false; if (url) show(url); else api.reset(false); },
    async setFromUrl(url) {
      const blob = await (await fetch(url)).blob();
      await api.setFile(new File([blob], 'image', { type: blob.type }));
    },
    reset(markRemoved = true) {
      dataUrl = null; removed = markRemoved;
      img.hidden = true; img.removeAttribute('src'); hint.hidden = false; clear.hidden = true; input.value = '';
    },
  };
  root.addEventListener('click', e => { if (e.target !== clear) input.click(); });
  input.addEventListener('change', () => api.setFile(input.files[0]));
  root.addEventListener('dragover', e => { e.preventDefault(); root.classList.add('over'); });
  root.addEventListener('dragleave', () => root.classList.remove('over'));
  root.addEventListener('drop', e => { e.preventDefault(); root.classList.remove('over'); api.setFile(e.dataTransfer.files[0]); });
  clear.addEventListener('click', e => { e.stopPropagation(); api.reset(true); });
  return api;
}

const genDrop = setupDrop($('#gen-drop'), 2048);
const addDrop = setupDrop($('#add-drop'), 2560);
document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!item) return;
  if (state.activeTab === 'generate') genDrop.setFile(item.getAsFile());
  else if (state.activeTab === 'add') addDrop.setFile(item.getAsFile());
  else if (state.activeTab === 'reverse') revSetFile(item.getAsFile());
});

// ---------- 统计与类别 ----------
async function loadStats() {
  const s = await api('/api/stats');
  $('#stats').textContent = `共 ${s.total} 条 · 我添加 ${s.user} · 收藏 ${s.favorite} · 生成 ${s.generations} 次`;
  if (s.masters) {
    state.masters = s.masters;
    populateMasterSelect();
  }
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  const chips = $('#cat-chips');
  const total = state.categories.reduce((n, c) => n + c.count, 0);
  chips.innerHTML = `<button class="chip active" data-cat="">全部<small>${total}</small></button>` +
    state.categories.map(c => `<button class="chip" data-cat="${c.code}" title="${esc(c.description)}">${c.code} ${esc(c.name)}<small>${c.count}</small></button>`).join('');
  chips.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    state.category = b.dataset.cat;
    state.subcategory = '';
    loadSubChips();
    loadCases(true);
  }));
  const models = await api('/api/models');
  $('#f-model').innerHTML = '<option value="">全部模型</option>' + models.map(m => `<option value="${esc(m.model)}">${esc(m.model)}（${m.count}）</option>`).join('');
  $('#f-model').value = state.model;
  $('#model-list').innerHTML = models.filter(m => m.model !== '未标注').map(m => `<option value="${esc(m.model)}">`).join('');
  const opts = state.categories.map(c => `<option value="${c.code}">${c.code} ${esc(c.name)}</option>`).join('');
  $('#gen-cat').innerHTML = '<option value="">自动判断</option>' + opts;
  $('#a-cat').innerHTML = '<option value="">未分类</option>' + opts;
  $('#tpl-list').innerHTML = '<button data-tpl="rules">00 总览与通用规则</button>' +
    state.categories.map(c => `<button data-tpl="${c.code}">${c.code} ${esc(c.name)}</button>`).join('');
  $('#tpl-list').querySelectorAll('button').forEach(b => b.addEventListener('click', () => openTemplate(b.dataset.tpl)));
}

async function loadSubChips() {
  const box = $('#sub-chips');
  if (!state.category) { box.hidden = true; box.innerHTML = ''; return; }
  const subs = await api('/api/subcategories?' + new URLSearchParams({ category: state.category, model: state.model, media_type: state.media, source: state.source }));
  box.hidden = !subs.length;
  box.innerHTML = `<button class="chip ${state.subcategory ? '' : 'active'}" data-sub="">全部细分类</button>` +
    subs.map(s => `<button class="chip ${state.subcategory === s.code ? 'active' : ''}" data-sub="${s.code}">${esc(s.name)}<small>${s.count}</small></button>`).join('');
  box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    box.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    state.subcategory = b.dataset.sub;
    loadCases(true);
  }));
}

async function fillSubSelect(category, value = '') {
  const subs = category ? await api('/api/subcategories?category=' + category) : [];
  $('#a-sub').innerHTML = '<option value="">未选择</option>' + subs.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join('');
  $('#a-sub').value = value || '';
}

function cardHtml(c) {
  const thumb = c.image
    ? `<div class="thumb" style="background-image:url('${esc(c.image)}')">
         ${c.favorite ? '<span class="fav">★</span>' : ''}
         ${(c.image_count || (c.images || []).length + 1) > 1 ? `<span class="imgn">${c.image_count || (c.images || []).length + 1} 图</span>` : ''}
       </div>`
    : '';
  const tags = (c.tags ? (Array.isArray(c.tags) ? c.tags : String(c.tags).split(',')) : [])
    .map(t => String(t).trim()).filter(Boolean).slice(0, 3);

  return `<div class="card" data-id="${c.id}">
    ${thumb}
    <div class="card-inner">
      <div class="card-header">
        <div class="card-title" title="${esc(c.title)}">${esc(c.title)}</div>
        <div class="card-meta">
          ${c.quality_tier === 1 ? '<span class="tier-pill">⭐️ 标杆</span>' : '<span class="stat-pill">🔥 92</span>'}
        </div>
      </div>
      ${c.prompt_snippet ? `<div class="card-quote">${esc(c.prompt_snippet)}</div>` : ''}
      ${c.analysis ? `<div class="card-desc">${esc(c.analysis.slice(0, 110))}</div>` : ''}
      <div class="card-footer">
        <div class="card-tags">
          ${c.category_code ? `<span class="tag">${c.category_code} ${esc(catName(c.category_code))}</span>` : ''}
          ${c.media_type === 'video' ? '<span class="tag video">▶ 视频</span>' : ''}
          ${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="card-actions">
          <button class="copy-icon-btn" data-copy-id="${c.id}" title="复制提示词">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

async function loadCases(reset = false) {
  if (reset) state.offset = 0;
  const params = new URLSearchParams({
    q: state.q, category: state.category, subcategory: state.subcategory,
    model: state.model, media_type: state.media, source: state.source,
    favorite: state.favorite ? '1' : '', review: state.review ? '1' : '',
    tier: state.tier ? String(state.tier) : '',
    semantic: state.semantic && state.q ? '1' : '',
    limit: state.pageSize, offset: state.offset
  });
  for (const [key, codes] of Object.entries(state.facets)) if (codes.length) params.set('f_' + key, codes.join(','));
  const r = await api('/api/cases?' + params);
  const html = r.items.map(cardHtml).join('');
  if (reset) grid.innerHTML = html; else grid.insertAdjacentHTML('beforeend', html);
  state.offset += r.items.length;
  $('#result-info').textContent = state.semantic && state.q
    ? `按意思搜「${state.q}」：相似度最高的 ${r.total} 条，按相关度排序`
    : `找到 ${r.total} 条${state.q ? `（关键词：${state.q}）` : ''}`;
  $('#more').hidden = state.offset >= r.total;
}

$('#grid').addEventListener('click', async e => {
  const copyBtn = e.target.closest('.copy-icon-btn');
  if (copyBtn) {
    e.stopPropagation();
    const cid = copyBtn.dataset.copyId;
    try {
      const c = await api('/api/cases/' + cid);
      await copyText(c.prompt || '');
    } catch (err) {
      toast('获取提示词失败');
    }
    return;
  }
  const card = e.target.closest('.card');
  if (card) openCase(card.dataset.id);
});
$('#more').addEventListener('click', () => loadCases(false));
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); loadCases(true); }, 250); });
$('#f-tier1')?.addEventListener('change', e => { state.tier = e.target.checked ? 1 : 0; loadCases(true); });
$('#f-source').addEventListener('change', e => { state.source = e.target.value; loadSubChips(); loadCases(true); });
$('#f-model').addEventListener('change', e => { state.model = e.target.value; loadSubChips(); loadCases(true); });
$('#f-media').addEventListener('change', e => { state.media = e.target.value; loadSubChips(); loadCases(true); });
$('#f-fav').addEventListener('change', e => { state.favorite = e.target.checked; loadCases(true); });
$('#f-review').addEventListener('change', e => { state.review = e.target.checked; loadCases(true); });
$('#f-sem').addEventListener('change', e => { state.semantic = e.target.checked; loadCases(true); });

function populateMasterSelect() {
  const sel = $('#gen-master-preset');
  if (!sel || !state.masters?.length) return;
  sel.innerHTML = '<option value="">（可选）注入大师光学与东方美学参数</option>' +
    state.masters.map(m => `<option value="${m.id}">${esc(m.name)} · ${esc(m.era || '')}（${esc(m.category)}）</option>`).join('');
  sel.onchange = e => {
    const m = state.masters.find(x => x.id === e.target.value);
    if (m && m.prompt_snippet) {
      const cur = $('#gen-goal').value;
      if (!cur.includes(m.prompt_snippet)) {
        $('#gen-goal').value = (cur ? cur.trim() + '\n\n' : '') + `【注入美学风格: ${m.name}】\n${m.prompt_snippet}`;
        toast(`已注入 ${m.name} 风格参数`);
      }
    }
  };
}

async function loadMasters() {
  populateMasterSelect();
}
async function loadEmbedStatus() {
  try {
    const r = await api('/api/embed/status');
    if (r.ok && r.done > 0) {
      $('#f-sem-wrap').hidden = false;
      $('#f-sem-wrap').title = `本地语义检索：${r.model}，已算 ${r.done}/${r.total} 条`;
    }
  } catch { /* 没装就不显示 */ }
}

// ---------- 受控多维标签筛选 ----------
async function loadFacets() {
  const r = await api('/api/facets');
  state.facetDefs = r.facets;
  state.facetCounts = r.counts || {};
  renderFacetPanel();
}

function renderFacetPanel() {
  const panel = $('#facet-panel');
  panel.innerHTML = state.facetDefs.map(f => {
    const vals = f.values
      .map(v => ({ ...v, n: state.facetCounts[v.code] || 0 }))
      .filter(v => v.n > 0)
      .sort((a, b) => b.n - a.n);
    if (!vals.length) return '';
    const chips = vals.map(v => {
      const on = (state.facets[f.key] || []).includes(v.code);
      return `<button class="chip${on ? ' on' : ''}" data-facet="${f.key}" data-code="${v.code}">${v.name}<span class="n">${v.n}</span></button>`;
    }).join('');
    return `<div class="facet-row"><span class="facet-name">${f.name}</span><div class="chips">${chips}</div></div>`;
  }).join('');
}

function renderActiveFacets() {
  const box = $('#facet-active');
  const items = [];
  for (const [key, codes] of Object.entries(state.facets)) {
    const f = state.facetDefs.find(x => x.key === key);
    for (const code of codes) {
      const v = f?.values.find(x => x.code === code);
      if (v) items.push(`<button class="chip on" data-facet="${key}" data-code="${code}">${f.name}：${v.name} ✕</button>`);
    }
  }
  box.innerHTML = items.length ? items.join('') + '<button class="chip clear" data-clear="1">清除全部</button>' : '';
  box.hidden = !items.length;
}

function toggleFacet(key, code) {
  const cur = state.facets[key] || [];
  state.facets[key] = cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code];
  if (!state.facets[key].length) delete state.facets[key];
  renderFacetPanel();
  renderActiveFacets();
  loadCases(true);
}

$('#facet-toggle').addEventListener('click', () => {
  const panel = $('#facet-panel');
  panel.hidden = !panel.hidden;
  $('#facet-toggle').classList.toggle('on', !panel.hidden);
});
$('#facet-panel').addEventListener('click', e => {
  const b = e.target.closest('[data-facet]');
  if (b) toggleFacet(b.dataset.facet, b.dataset.code);
});
$('#facet-active').addEventListener('click', e => {
  if (e.target.closest('[data-clear]')) { state.facets = {}; renderFacetPanel(); renderActiveFacets(); loadCases(true); return; }
  const b = e.target.closest('[data-facet]');
  if (b) toggleFacet(b.dataset.facet, b.dataset.code);
});

/** 详情里按维度展示受控标签，点一下就按这个标签筛选 */
function facetChipsHtml(raw) {
  if (!raw) return '';
  let f;
  try { f = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }
  const rows = state.facetDefs.map(def => {
    const codes = f[def.key] || [];
    if (!codes.length) return '';
    const chips = codes.map(code => {
      const v = def.values.find(x => x.code === code);
      return v ? `<button class="chip" data-facet="${def.key}" data-code="${code}">${esc(v.name)}</button>` : '';
    }).join('');
    return chips ? `<div class="facet-row"><span class="facet-name">${esc(def.name)}</span><div class="chips">${chips}</div></div>` : '';
  }).filter(Boolean).join('');
  return rows ? `<div class="facet-panel detail-facets">${rows}</div>` : '';
}

// ---------- 详情弹窗 ----------
const modal = $('#modal');
let modalCloseTimer;
function openModal() {
  clearTimeout(modalCloseTimer);
  modal.classList.remove('closing');
  modal.hidden = false;
}
function closeModal() {
  modal.classList.add('closing');
  clearTimeout(modalCloseTimer);
  modalCloseTimer = setTimeout(() => {
    modal.hidden = true;
    modal.classList.remove('closing');
  }, 200);
}
modal.querySelector('.modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
modal.addEventListener('click', e => {
  const th = e.target.closest('.gthumb');
  if (th) {
    const img = $('#detail-img');
    if (img) { img.src = th.dataset.src; img.dataset.full = th.dataset.src; }
    modal.querySelectorAll('.gthumb').forEach(x => x.classList.toggle('on', x === th));
    return;
  }
  if (e.target.id === 'detail-img' || e.target.classList.contains('detail-img')) {
    openLightbox(e.target.dataset.full || e.target.src);
    return;
  }
  const b = e.target.closest('.facet-panel [data-facet]');
  if (!b) return;
  closeModal();
  $('#facet-panel').hidden = false;
  $('#facet-toggle').classList.add('on');
  toggleFacet(b.dataset.facet, b.dataset.code);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const lb = $('#img-lightbox');
    if (lb && !lb.hidden) closeLightbox();
    else closeModal();
  }
});

const lightbox = $('#img-lightbox');
const lightboxImg = $('#lightbox-img');
let lightboxCloseTimer;

function openLightbox(src) {
  if (!src) return;
  clearTimeout(lightboxCloseTimer);
  lightboxImg.src = src;
  lightbox.classList.remove('closing');
  lightbox.hidden = false;
}

function closeLightbox() {
  if (!lightbox) return;
  clearTimeout(lightboxCloseTimer);
  lightbox.classList.add('closing');
  lightboxCloseTimer = setTimeout(() => {
    lightbox.hidden = true;
    lightbox.classList.remove('closing');
    if (lightboxImg) lightboxImg.src = '';
  }, 220);
}

$('#img-lightbox')?.addEventListener('click', e => {
  if (e.target === lightbox || e.target.closest('.lightbox-close') || e.target.closest('.lightbox-wrap')) {
    closeLightbox();
  }
});
async function openCase(id) {
  const c = await api('/api/cases/' + id);
  const isVideo = c.media_type === 'video' || !!c.video_url;
  const hasMedia = !!(c.image || c.video_url);
  $('#modal-body').innerHTML = `<div class="detail ${hasMedia ? '' : 'noimg'}">
    ${hasMedia ? `<div class="detail-left">
      ${isVideo
        ? `<div class="detail-video-wrap">
             <video controls playsinline preload="metadata" poster="${esc(c.image || '')}" src="${esc(c.video || c.video_url)}"></video>
             <p class="muted small" style="margin-top:8px;text-align:center;">${String(c.video || '').startsWith('/media/drive/') ? '视频存于云盘' : '在线视频'} · <a href="${esc(c.video_url)}" target="_blank" rel="noopener">打开原链接 ↗</a></p>
           </div>`
        : `<div class="detail-img-wrap"><img class="detail-img" id="detail-img" src="${esc(c.image)}" alt="" data-full="${esc(c.image)}"></div>`
      }
      ${!isVideo && (c.images || []).length ? `<div class="extra-imgs">
        <p class="muted small">共 ${(c.images || []).length + 1} 张图，点缩略图切换</p>
        ${[c.image, ...c.images].filter(Boolean).map((u, i) => `<img class="gthumb${i === 0 ? ' on' : ''}" src="${esc(u)}" alt="" data-src="${esc(u)}">`).join('')}
      </div>` : ''}
    </div>` : ''}
    <div class="detail-right">
      <h2>${esc(c.title)}</h2>
      <div class="badges">
        ${c.media_type === 'video' ? '<span class="badge video">▶ 视频</span>' : ''}
        ${c.category_code ? `<span class="badge">${c.category_code} ${esc(catName(c.category_code))}</span>` : ''}
        ${c.subcategory_name ? `<span class="badge">${esc(c.subcategory_name)}</span>` : ''}
        ${c.model ? `<span class="badge model">${esc(c.model)}</span>` : ''}
        ${c.subtype ? `<span class="badge light">${esc(c.subtype)}</span>` : ''}
        ${c.classify_source === 'rule' ? '<span class="badge light" title="由关键词规则自动归类，可点编辑修改">自动归类</span>' : ''}
        <span class="badge ${c.source === 'user' ? 'user' : 'light'}">${esc(sourceLabel(c))}</span>
      </div>
      <div class="twin-fileboxes">
        <div class="filebox">
          <div class="filebox-header">
            <span class="filebox-title">📄 提示词内容</span>
            <button data-act="copy" class="filebox-copy-btn">复制提示词</button>
          </div>
          <div class="filebox-body">
            <pre class="filebox-prompt-text">${esc(c.prompt)}</pre>
          </div>
        </div>

        <div class="filebox">
          <div class="filebox-header">
            <span class="filebox-title">🏷️ 受控维度标签</span>
            <span class="filebox-hint">${c.tags ? esc(c.tags) : '多维受控标签'}</span>
          </div>
          <div class="filebox-body">
            ${facetChipsHtml(c.facets)}
            ${c.tags ? `<p class="muted small" style="margin:6px 0 0;">关键词：${esc(c.tags)}</p>` : ''}
          </div>
        </div>
      </div>
      ${c.analysis ? `<div class="section-h">结构分析</div><div class="analysis">${esc(c.analysis)}</div>` : ''}
      ${c.raw_tags ? `<p class="muted small">来源标签：${esc(c.raw_tags)}</p>` : ''}
      ${Number(c.needs_review) ? '<p class="muted small">⚠ 自动归类把握不大，已列入待确认</p>' : ''}
      ${c.note ? `<p class="muted">备注：${esc(c.note)}</p>` : ''}
      ${c.source_url ? `<p><a href="${esc(c.source_url)}" target="_blank" rel="noopener">查看来源</a></p>` : ''}
      <div class="actions">
        <button data-act="fav">${c.favorite ? '★ 取消收藏' : '☆ 收藏'}</button>
        <button data-act="use">用它的写法生成</button>
        <button data-act="edit">编辑</button>
        <button data-act="del" class="danger">删除</button>
      </div>
    </div>
  </div>`;
  openModal();
  $('#modal-body').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    try {
      if (act === 'copy') copyText(c.prompt);
      if (act === 'fav') { await api(`/api/cases/${c.id}/favorite`, { method: 'POST' }); await openCase(c.id); loadCases(true); loadStats(); }
      if (act === 'use') { addPin(c); closeModal(); switchTab('generate'); }
      if (act === 'edit') { closeModal(); editCase(c); }
      if (act === 'del') {
        if (!confirm(`确定删除「${c.title}」吗？此操作不可撤销。`)) return;
        await api('/api/cases/' + c.id, { method: 'DELETE' });
        closeModal(); toast('已删除'); loadCases(true); loadCategories(); loadStats();
      }
    } catch (e) { toast(e.message); }
  }));
}

// ---------- 添加 / 编辑 ----------
const addFields = { title: '#a-title', prompt: '#a-prompt', category_code: '#a-cat', subcategory: '#a-sub', subtype: '#a-subtype', model: '#a-model', tags: '#a-tags', analysis: '#a-analysis', source_url: '#a-url', note: '#a-note' };
$('#a-cat').addEventListener('change', e => fillSubSelect(e.target.value));

function resetAddForm() {
  state.editingId = null;
  Object.values(addFields).forEach(sel => { $(sel).value = ''; });
  $('#a-fav').checked = false;
  addDrop.reset(false);
  $('#add-heading').textContent = '添加提示词到库';
  setStatus($('#a-status'), '');
}

async function editCase(c) {
  resetAddForm();
  state.editingId = c.id;
  await fillSubSelect(c.category_code, c.subcategory);
  for (const [k, sel] of Object.entries(addFields)) $(sel).value = c[k] || '';
  $('#a-fav').checked = !!c.favorite;
  addDrop.setExisting(c.image);
  $('#add-heading').textContent = `编辑 #${c.id}`;
  switchTab('add');
}

$('#a-reset').addEventListener('click', resetAddForm);

$('#a-save').addEventListener('click', async () => {
  const body = {};
  for (const [k, sel] of Object.entries(addFields)) body[k] = $(sel).value.trim();
  body.favorite = $('#a-fav').checked;
  if (addDrop.get()) body.image = addDrop.get();
  else if (addDrop.removed()) body.image_remove = true;
  const btn = $('#a-save');
  btn.disabled = true;
  try {
    const c = state.editingId
      ? await api('/api/cases/' + state.editingId, { method: 'PUT', body })
      : await api('/api/cases', { method: 'POST', body });
    toast(state.editingId ? '已保存修改' : `已加入库：#${c.id}`);
    resetAddForm();
    await Promise.all([loadCategories(), loadStats()]);
    loadCases(true);
  } catch (e) { setStatus($('#a-status'), e.message, true); }
  finally { btn.disabled = false; }
});

$('#a-auto').addEventListener('click', async () => {
  const btn = $('#a-auto');
  const prompt = $('#a-prompt').value.trim();
  if (!prompt) return setStatus($('#a-status'), '请先填写提示词', true);
  btn.disabled = true;
  setStatus($('#a-status'), '<span class="spinner"></span>AI 正在归类与分析…');
  try {
    const r = await api('/api/auto-tag', { method: 'POST', body: { title: $('#a-title').value.trim(), prompt, image: addDrop.get() } });
    if (!$('#a-title').value.trim()) $('#a-title').value = r.title;
    if (r.category_code) { $('#a-cat').value = r.category_code; await fillSubSelect(r.category_code); }
    $('#a-subtype').value = r.subtype || $('#a-subtype').value;
    $('#a-tags').value = r.tags || $('#a-tags').value;
    $('#a-analysis').value = r.analysis || $('#a-analysis').value;
    setStatus($('#a-status'), '已自动填写，请检查后保存。');
  } catch (e) { setStatus($('#a-status'), e.message, true); }
  finally { btn.disabled = false; }
});

// ---------- 智能生成 ----------
function renderPins() {
  $('#gen-pins').innerHTML = state.pins.map(p => `<span class="badge">必参考 #${p.id} ${esc(p.title)}<button data-unpin="${p.id}">×</button></span>`).join('');
  $('#gen-pins').querySelectorAll('[data-unpin]').forEach(b => b.addEventListener('click', () => {
    state.pins = state.pins.filter(p => String(p.id) !== b.dataset.unpin);
    renderPins();
  }));
}
function addPin(c) {
  if (!state.pins.some(p => p.id === c.id)) state.pins.push({ id: c.id, title: c.title });
  renderPins();
}

const asList = v => (Array.isArray(v) ? v : (v ? [v] : []));

function formatAnalysisDisplay(a) {
  if (!a || !Object.keys(a).length) return '<div class="muted">暂无分析数据</div>';
  const reqs = asList(a.key_requirements || a.preserve);
  const forbids = asList(a.forbid);
  const keywords = asList(a.keywords);
  return `
    <div class="analysis-grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:10px;margin-bottom:8px;">
      <div style="background:var(--bg);padding:10px 12px;border-radius:6px;border:1px solid var(--border-light);">
        <b style="color:var(--emerald-600,#10b981);font-size:12px;">🎯 核心需求与保留要素：</b>
        <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--ink-secondary);">
          ${reqs.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join('') || '<li>按画面同类复刻</li>'}
        </ul>
      </div>
      <div style="background:var(--bg);padding:10px 12px;border-radius:6px;border:1px solid var(--border-light);">
        <b style="color:#ef4444;font-size:12px;">🚫 负面约束与禁止项：</b>
        <ul style="margin:4px 0 0;padding-left:18px;font-size:12px;color:var(--ink-secondary);">
          ${forbids.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join('') || '<li>无特殊禁止</li>'}
        </ul>
      </div>
    </div>
    ${keywords.length ? `<div style="margin-bottom:8px;font-size:12px;"><b style="color:var(--ink-muted);">🏷️ 提炼关键词：</b>${keywords.map(k => `<span class="tag" style="margin:2px 3px;">${esc(k)}</span>`).join('')}</div>` : ''}
    <details style="margin-top:6px;font-size:12px;"><summary style="cursor:pointer;color:var(--muted);font-weight:600;">展开查看底层分析 JSON</summary><pre class="prompt small" style="margin-top:6px;">${esc(JSON.stringify(a, null, 2))}</pre></details>
  `;
}

function renderGeneration(g) {
  const r = g.result || {};
  const a = g.analysis || {};
  const gi = a.generation || {};
  const el = $('#gen-result');
  el.innerHTML = `
    ${gi.notice ? `<div class="notice">${esc(gi.notice)}</div>` : ''}
    <div class="badges">
      <span class="badge">${esc(g.category.code)} ${esc(g.category.name)}</span>
      ${a.subtype ? `<span class="badge light">${esc(a.subtype)}</span>` : ''}
      ${a.task_type ? `<span class="badge light">${esc(a.task_type)}</span>` : ''}
      ${gi.target_model ? `<span class="badge model">写法：${esc(gi.target_model)}${gi.output === 'video' ? ' · 出视频' : ''}</span>` : ''}
      ${gi.person_mode ? '<span class="badge user">人物保持</span>' : ''}
      ${gi.round > 1 ? `<span class="badge user">第 ${esc(gi.round)} 轮修正</span>` : ''}
      ${r.template_used ? `<span class="badge light">模板：${esc(r.template_used)}</span>` : ''}
    </div>
    ${asList(r.review).length ? `<div class="section-h">${gi.refined_from ? `对比生成结果发现的问题（第 ${esc(gi.round)} 轮修正）` : 'AI 自检修正了什么'}</div><ul class="plain">${asList(r.review).map(x => `<li>${esc(issueText(x))}</li>`).join('')}</ul>` : ''}
    
    <div class="section-h">生成提示词 <button data-copy="prompt">复制</button></div>
    <pre class="prompt">${esc(r.prompt || '')}</pre>

    <div class="compare" style="margin-top: 14px;">
      <p class="muted">上传用这条提示词生成的图，AI 会对照你的需求${g.image ? '和参考图' : ''}找出问题并修正提示词，可以反复多轮。</p>
      <div class="row"><label>生成结果图片<input type="file" accept="image/*" class="cmp-file"></label><label>或填生成图链接<input class="cmp-url" placeholder="https://…"></label></div>
      <label>补充说明（可选）<input class="cmp-hint" placeholder="例如：脸不像、腿被拉长了、鞋子颜色不对"></label>
      <button class="primary cmp-btn" type="button">对比并修正提示词</button>
      <div class="status cmp-status"></div>
    </div>
    <div class="actions" style="margin: 12px 0 16px;">
      <button data-act="save">保存到我的库</button>
      <button data-act="again">基于此重新生成</button>
      <button type="button" class="btn-direct-gpt" style="background:#10b981;color:#fff;border-color:#10b981;">⚡ 网页版 ChatGPT 直接出图</button>
      <button type="button" class="btn-direct-gemini" style="background:#38bdf8;color:#0f172a;border-color:#0284c7;">🎨 网页版 Gemini 直接出图</button>
    </div>

    <!-- 紧跟在下方：图片与需求分析 -->
    <div class="section-h">图片与需求分析</div>
    <div class="gen-analysis-box">${formatAnalysisDisplay(a)}</div>

    ${r.prompt_en ? `<div class="section-h">English <button data-copy="prompt_en">复制</button></div><pre class="prompt">${esc(r.prompt_en)}</pre>` : ''}
    ${r.negative ? `<div class="section-h">避免项 <button data-copy="negative">复制</button></div><pre class="prompt small">${esc(r.negative)}</pre>` : ''}
    ${asList(r.explanation).length ? `<div class="section-h">为什么这样写</div><ul class="plain">${asList(r.explanation).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${asList(r.tips).length ? `<div class="section-h">不满意时可以调整</div><ul class="plain">${asList(r.tips).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="section-h">参考的案例</div>
    <div class="refs">${g.references.map(c => cardHtml({ ...c, prompt_snippet: '' })).join('') || '<span class="muted">无</span>'}</div>`;
  el.querySelector('.cmp-btn').addEventListener('click', async () => {
    const status = el.querySelector('.cmp-status');
    const file = el.querySelector('.cmp-file').files[0];
    const url = el.querySelector('.cmp-url').value.trim();
    if (!file && !/^https?:\/\//i.test(url)) return setStatus(status, '请上传生成的图片，或填写以 http 开头的图片链接', true);
    const btn = el.querySelector('.cmp-btn');
    btn.disabled = true;
    const started = Date.now();
    const tick = setInterval(() => setStatus(status, `<span class="spinner"></span>正在对照需求${g.image ? '和参考图' : ''}检查生成结果 → 修正提示词…（${Math.round((Date.now() - started) / 1000)} 秒）`), 500);
    try {
      const body = { id: g.id, lang: $('#gen-lang').value, hint: el.querySelector('.cmp-hint').value.trim() };
      if (file) body.image = await fileToDataUrl(file, 2048);
      else body.image_url = url;
      const next = await api('/api/generate/refine', { method: 'POST', body });
      renderGeneration(next);
      setStatus($('#gen-status'), `对比修正完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
      loadHistory();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setStatus(status, e.message, true);
    } finally {
      clearInterval(tick);
      btn.disabled = false;
    }
  });
  el.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(r[b.dataset.copy] || '')));
  el.querySelectorAll('.refs .card').forEach(card => card.addEventListener('click', () => openCase(card.dataset.id)));
  el.querySelector('.btn-direct-gpt')?.addEventListener('click', () => {
    const prompt = r.prompt || r.prompt_en || '';
    if (!prompt) return toast('无提示词内容');
    window.open(`https://chatgpt.com/?q=${encodeURIComponent('Create a realistic image based on the following detailed prompt:\n\n' + prompt)}`, '_blank', 'noopener,noreferrer');
  });
  el.querySelector('.btn-direct-gemini')?.addEventListener('click', () => {
    const prompt = r.prompt || r.prompt_en || '';
    if (!prompt) return toast('无提示词内容');
    window.open(`https://gemini.google.com/app?text=${encodeURIComponent('Generate an image based on the following prompt:\n\n' + prompt)}`, '_blank', 'noopener,noreferrer');
  });
  el.querySelector('[data-act=save]').addEventListener('click', async () => {
    resetAddForm();
    $('#a-title').value = (g.goal || r.template_used || '生成的提示词').slice(0, 30);
    $('#a-cat').value = g.category.code || '';
    $('#a-subtype').value = a.subtype || '';
    $('#a-tags').value = asList(a.keywords).join(', ');
    $('#a-analysis').value = asList(r.explanation).join('\n');
    $('#a-note').value = `由智能生成 #${g.id} 保存`;
    if (g.image) await addDrop.setFromUrl(g.image).catch(() => {});
    switchTab('add');
    setStatus($('#a-status'), '已带入生成结果。建议把配图换成最终出图的效果图，再保存。');
  });
  el.querySelector('[data-act=again]').addEventListener('click', () => {
    $('#gen-goal').value = g.goal || '';
    $('#gen-cat').value = g.category.code || '';
    if (gi.target_model) $('#gen-model').value = gi.target_model === '通用' ? '' : gi.target_model;
    if (gi.output) $('#gen-output').value = gi.output;
    if (g.image) genDrop.setFromUrl(g.image).catch(() => {});
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

$('#gen-btn').addEventListener('click', async () => {
  const goal = $('#gen-goal').value.trim();
  const image = genDrop.get();
  if (!goal && !image) return setStatus($('#gen-status'), '请至少上传参考图或填写想要的效果', true);
  const btn = $('#gen-btn');
  btn.disabled = true;
  const started = Date.now();
  const detail = $('#gen-detail').checked;
  const originalText = btn.innerHTML;

  const tick = setInterval(() => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    btn.innerHTML = `⏱️ 正在生成 (${elapsed}s)...`;
    setStatus($('#gen-status'), `<span class="spinner"></span>${image ? (detail ? '正在分析参考图和局部细节' : '正在分析参考图') : '正在分析需求'} → 检索模板与案例 → 按目标模型写法撰写提示词${detail ? ' → 对照需求自检' : ''}…（${elapsed} 秒）`);
  }, 100);

  try {
    const g = await api('/api/generate', { method: 'POST', body: {
      image, goal, category: $('#gen-cat').value, aspect_ratio: $('#gen-ar').value.trim(),
      lang: $('#gen-lang').value, reference_ids: state.pins.map(p => p.id),
      target_model: $('#gen-model').value.trim(), output: $('#gen-output').value, detail,
      llm_model: $('#gen-llm').value,
    } });
    renderGeneration(g);
    setStatus($('#gen-status'), `完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`);
    loadHistory(); loadStats();
  } catch (e) {
    setStatus($('#gen-status'), e.message, true);
  } finally {
    clearInterval(tick);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
});
function openAiDrawer(provider, promptText) {
  const drawer = $('#ai-drawer');
  if (!drawer) return;
  const isGpt = provider === 'chatgpt';
  $('#ai-drawer-provider-icon').textContent = isGpt ? '⚡' : '🎨';
  $('#ai-drawer-provider-name').textContent = isGpt ? 'ChatGPT 网页版直连生图' : 'Google Gemini 网页版直连生图';
  $('#ai-drawer-current-prompt').textContent = promptText;

  const finalPrompt = isGpt
    ? `Create a realistic image based on the following detailed prompt:\n\n${promptText}`
    : `Generate an image based on the following prompt:\n\n${promptText}`;

  const targetUrl = isGpt
    ? `https://chatgpt.com/?q=${encodeURIComponent(finalPrompt)}`
    : `https://gemini.google.com/app?text=${encodeURIComponent(finalPrompt)}`;

  $('#ai-drawer-external-link').onclick = () => window.open(targetUrl, '_blank', 'noopener,noreferrer');
  $('#ai-drawer-launch-btn').onclick = () => {
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    toast(`正在唤起 ${isGpt ? 'ChatGPT' : 'Gemini'} 官方网页版...`);
  };
  $('#ai-drawer-prompt-copy').onclick = () => copyText(promptText);

  drawer.hidden = false;
}

$('#ai-drawer-close-btn')?.addEventListener('click', () => {
  $('#ai-drawer').hidden = true;
});

$('#btn-draw-gpt')?.addEventListener('click', () => {
  const cur = $('#gen-goal').value.trim();
  if (!cur) return toast('请先输入或生成想要画的提示词');
  openAiDrawer('chatgpt', cur);
});

$('#btn-draw-gemini')?.addEventListener('click', () => {
  const cur = $('#gen-goal').value.trim();
  if (!cur) return toast('请先输入或生成想要画的提示词');
  openAiDrawer('gemini', cur);
});

$('#pp-btn-web-gpt')?.addEventListener('click', () => {
  const cur = $('#pp-prompt-output').value.trim();
  if (!cur) return toast('调色盘中还没有组装提示词');
  openAiDrawer('chatgpt', cur);
});

$('#pp-btn-web-gemini')?.addEventListener('click', () => {
  const cur = $('#pp-prompt-output').value.trim();
  if (!cur) return toast('调色盘中还没有组装提示词');
  openAiDrawer('gemini', cur);
});

async function openGenerationModal(id) {
  try {
    const g = await api('/api/generations/' + id);
    const r = g.result || {};
    const a = g.analysis || {};
    const gi = a.generation || {};
    const thumbImg = g.image || g.reference_image || '';
    const goalText = (g.goal || '').trim();
    const shortTitle = goalText.length > 36 ? goalText.slice(0, 36) + '...' : (goalText || '历史生成记录 #' + g.id);
    const showFullGoal = goalText.length > 36;

    $('#modal-body').innerHTML = `
      <div class="detail ${thumbImg ? '' : 'noimg'}">
        ${thumbImg ? `<div class="detail-left">
          <img class="detail-img" src="${esc(thumbImg)}" alt="" data-full="${esc(thumbImg)}">
          <p class="muted small" style="margin-top:8px;text-align:center;">${g.image ? '📷 用户提供的参考原图' : '⚡ 标杆参考氛围图'}</p>
        </div>` : ''}
        <div class="detail-right">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
            <h2>${esc(shortTitle)}</h2>
            <span class="hist-id-pill" style="font-size:12px;padding:2px 8px;">#${g.id}</span>
          </div>
          ${showFullGoal ? `<div style="background:var(--bg);padding:8px 12px;border-radius:6px;border:1px solid var(--border-light);margin:6px 0 10px;font-size:12px;color:var(--ink-secondary);line-height:1.5;"><b>用户原始目标：</b>${esc(goalText)}</div>` : ''}
          <div class="badges" style="margin-bottom:12px;">
            <span class="badge">${esc(g.category?.code || 'C01')} ${esc(g.category?.name || '人像')}</span>
            <span class="hist-time" style="font-size:12px;color:var(--muted);margin-left:auto;">${esc(g.created_at || '')}</span>
          </div>

          <div class="section-h">生成提示词 <button data-act="copy">复制</button></div>
          <pre class="prompt">${esc(r.prompt || '')}</pre>

          <!-- 紧跟在提示词框下面：图片与需求分析 -->
          <div class="section-h">图片与需求分析</div>
          <div class="gen-analysis-box">${formatAnalysisDisplay(a)}</div>

          ${r.prompt_en ? `<div class="section-h">English <button data-act="copy_en">复制</button></div><pre class="prompt">${esc(r.prompt_en)}</pre>` : ''}
          ${r.negative ? `<div class="section-h">避免项</div><pre class="prompt small">${esc(r.negative)}</pre>` : ''}

          <div class="actions" style="margin-top:18px;">
            <button data-act="use_again" class="primary">⚡ 载入工作台重新编辑</button>
            <button data-act="copy_all">📋 复制提示词</button>
            <button data-act="direct_gpt" style="background:#10b981;color:#fff;border-color:#10b981;">⚡ 网页版 ChatGPT 出图</button>
            <button data-act="direct_gemini" style="background:#38bdf8;color:#0f172a;border-color:#0284c7;">🎨 网页版 Gemini 出图</button>
          </div>
        </div>
      </div>
    `;
    openModal();
    $('#modal-body').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      const prompt = r.prompt || r.prompt_en || '';
      if (act === 'copy' || act === 'copy_all') copyText(prompt);
      if (act === 'copy_en') copyText(r.prompt_en || '');
      if (act === 'direct_gpt') {
        window.open(`https://chatgpt.com/?q=${encodeURIComponent('Create a realistic image based on the following detailed prompt:\n\n' + prompt)}`, '_blank', 'noopener,noreferrer');
      }
      if (act === 'direct_gemini') {
        window.open(`https://gemini.google.com/app?text=${encodeURIComponent('Generate an image based on the following prompt:\n\n' + prompt)}`, '_blank', 'noopener,noreferrer');
      }
      if (act === 'use_again') {
        closeModal();
        renderGeneration(g);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }));
  } catch (err) {
    toast('读取记录失败: ' + err.message);
  }
}

async function loadHistory() {
  const list = await api('/api/generations');
  $('#gen-history').innerHTML = list.map(g => {
    const thumbImg = g.image || g.reference_image || g.result_image || '';
    const hasCustomImg = !!g.image;
    const thumb = thumbImg
      ? `<div class="hist-card-thumb" style="background-image:url('${esc(thumbImg)}')">
           <span class="hist-thumb-badge">${hasCustomImg ? '📷 参考图' : '⚡ 标杆氛围图'}</span>
         </div>`
      : `<div class="hist-card-thumb none"><span>无参考图</span></div>`;
    return `<div class="hist-card" data-id="${g.id}">
      ${thumb}
      <div class="hist-card-body">
        <div class="hist-card-header">
          <div class="hist-card-title">${esc(g.goal || '（无标题目标）')}</div>
          <span class="hist-id-pill">#${g.id}</span>
        </div>
        <div class="hist-card-meta">
          <span class="tag">${esc(g.category?.code || 'C01')} ${esc(g.category?.name || '人像')}</span>
          <span class="hist-time">${esc(g.created_at || '')}</span>
        </div>
        ${g.prompt_snippet ? `<div class="hist-card-quote">${esc(g.prompt_snippet)}</div>` : ''}
        <div class="hist-card-actions">
          <button class="hist-copy-btn" data-hist-id="${g.id}">📋 复制</button>
          <button class="hist-paste-btn" data-hist-id="${g.id}">🖼 贴入效果图</button>
          <button class="hist-load-btn" data-hist-id="${g.id}">⚡ 详情弹窗</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<span class="muted">还没有生成记录。</span>';

  $('#gen-history').querySelectorAll('.hist-card').forEach(h => {
    h.addEventListener('click', async e => {
      if (e.target.closest('.hist-paste-btn')) {
        e.stopPropagation();
        const cid = h.dataset.id;
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imgType = item.types.find(t => t.startsWith('image/'));
            if (imgType) {
              const blob = await item.getType(imgType);
              const reader = new FileReader();
              reader.onload = async () => {
                await api(`/api/generations/${cid}/image`, { method: 'POST', body: { image: reader.result } });
                toast(`已成功为 #${cid} 关联生成效果图！`);
                loadHistory();
              };
              reader.readAsDataURL(blob);
              return;
            }
          }
          toast('剪贴板中没有图片，请先在生图网页右键「复制图片」后重试');
        } catch (err) {
          const url = prompt('请输入生成的图片链接或 DataURL:');
          if (url) {
            await api(`/api/generations/${cid}/image`, { method: 'POST', body: { image: url } });
            toast(`已关联效果图！`);
            loadHistory();
          }
        }
        return;
      }
      if (e.target.closest('.hist-copy-btn')) {
        e.stopPropagation();
        try {
          const detail = await api('/api/generations/' + h.dataset.id);
          const prompt = detail.result?.prompt || detail.result?.prompt_en || '';
          await copyText(prompt);
        } catch { toast('复制失败'); }
        return;
      }
      // 点击卡片主体或“⚡ 详情弹窗”按钮，触发带有毛玻璃淡入淡出动效的详情模态框！
      openGenerationModal(h.dataset.id);
    });
  });
}

// ---------- 本次生成使用的模型 ----------
async function loadLlmModels(selector = '#gen-llm', storeKey = 'plib_gen_llm') {
  const sel = $(selector);
  if (!sel || sel.dataset.loaded) return;
  let data;
  try { data = await api('/api/llm-models'); } catch (e) { data = { models: [], error: e.message }; }
  const saved = localStorage.getItem(storeKey) || '';
  const label = data.current ? `按设置里的默认模型（${data.current}）` : '按设置里的默认模型';
  sel.innerHTML = `<option value="">${esc(label)}</option>`
    + (data.models || []).map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  if (saved && (data.models || []).includes(saved)) sel.value = saved;
  if (data.models?.length) sel.dataset.loaded = '1';
  if (data.error && selector === '#gen-llm') setStatus($('#gen-status'), data.error, true);
}
$('#gen-llm').addEventListener('change', e => localStorage.setItem('plib_gen_llm', e.target.value));
$('#rev-llm')?.addEventListener('change', e => localStorage.setItem('plib_rev_llm', e.target.value));

// ---------- 反推提示词 ----------
const rev = { dataUrl: null, kind: '' };
const revDrop = $('#rev-drop');
const revInput = revDrop.querySelector('input[type=file]');
const revImg = revDrop.querySelector('img');
const revVideo = revDrop.querySelector('video');
const revClear = revDrop.querySelector('.clear');
const revHint = revDrop.querySelector('.drop-hint');

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(file);
  });
}
function revReset() {
  rev.dataUrl = null;
  rev.kind = '';
  revImg.hidden = true; revImg.removeAttribute('src');
  if (revVideo.src) URL.revokeObjectURL(revVideo.src);
  revVideo.hidden = true; revVideo.removeAttribute('src');
  revHint.hidden = false; revClear.hidden = true; revInput.value = '';
}
async function revSetFile(file) {
  if (!file) return;
  if (file.type.startsWith('image/')) {
    revReset();
    rev.kind = 'image';
    rev.dataUrl = await fileToDataUrl(file, 2048);
    revImg.src = rev.dataUrl; revImg.hidden = false;
  } else if (file.type.startsWith('video/')) {
    if (file.size > 100 * 1024 * 1024) return toast('视频超过 100MB，请先压缩或截取片段');
    revReset();
    rev.kind = 'video';
    rev.dataUrl = await readDataUrl(file);
    revVideo.src = URL.createObjectURL(file); revVideo.hidden = false;
  } else {
    return toast('请选择图片或视频文件');
  }
  revHint.hidden = true; revClear.hidden = false;
}
revDrop.addEventListener('click', e => { if (e.target !== revClear && e.target !== revVideo) revInput.click(); });
revInput.addEventListener('change', () => revSetFile(revInput.files[0]));
revDrop.addEventListener('dragover', e => { e.preventDefault(); revDrop.classList.add('over'); });
revDrop.addEventListener('dragleave', () => revDrop.classList.remove('over'));
revDrop.addEventListener('drop', e => { e.preventDefault(); revDrop.classList.remove('over'); revSetFile(e.dataTransfer.files[0]); });
revClear.addEventListener('click', e => { e.stopPropagation(); revReset(); });

function shotsTable(shots) {
  const list = asList(shots).filter(s => s && typeof s === 'object');
  if (!list.length) return '';
  const cols = [['time', '时间'], ['shot', '景别'], ['camera_move', '运镜'], ['action', '动作'], ['expression', '表情'], ['change', '变化']];
  return `<div class="section-h">分镜（逆向分析）</div><div class="tablewrap"><table class="shots">
    <tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr>
    ${list.map(s => `<tr>${cols.map(c => `<td>${esc(s[c[0]] || '')}</td>`).join('')}</tr>`).join('')}
  </table></div>`;
}

function issueText(x) {
  if (!x || typeof x !== 'object') return String(x ?? '');
  const head = x.aspect || x.item || '';
  const body = x.original || x.expected || x.generated
    ? `${x.expected ? '应为' : '原图'}：${x.expected || x.original || '-'}；生成：${x.generated || '-'}` : (x.problem || '');
  return `${head ? `${head}：` : ''}${body}${x.fix ? ` → ${x.fix}` : ''}`;
}

function renderReverse(g) {
  const r = g.result || {};
  const a = g.analysis || {};
  const m = g.media || a.reverse || {};
  const params = r.params && typeof r.params === 'object' ? Object.entries(r.params).filter(([, v]) => v) : [];
  const el = $('#rev-result');
  el.innerHTML = `
    ${m.notice ? `<div class="notice">${esc(m.notice)}</div>` : ''}
    <div class="badges">
      <span class="badge">${esc(g.category.code)} ${esc(g.category.name)}</span>
      <span class="badge ${m.media_type === 'video' ? 'video' : 'light'}">${m.media_type === 'video' ? `视频 ${esc(m.duration)} 秒 · ${esc(m.frames?.length ?? m.frames ?? '')} 帧` : '图片'}</span>
      ${m.aspect ? `<span class="badge light">${esc(m.aspect)}</span>` : ''}
      <span class="badge model">写法：${esc(m.target_model || '通用')}</span>
    </div>
    ${Array.isArray(m.frames) && m.frames.length ? `<div class="frames">${m.frames.map(f => `<figure><img src="${f.dataUrl}" alt=""><figcaption>${esc(f.label || (m.media_type === 'video' ? `${f.t}s` : ''))}</figcaption></figure>`).join('')}</div>`
      : g.image ? `<div class="frames"><figure><img src="${esc(g.image)}" alt=""></figure></div>` : ''}
    ${r.title ? `<h3 style="margin:10px 0 0">${esc(r.title)}</h3>` : ''}
    ${a.overall ? `<div class="muted">${esc(a.overall)}</div>` : ''}
    <div class="section-h">提示词 <button data-copy="prompt">复制</button></div>
    <pre class="prompt">${esc(r.prompt || '')}</pre>
    ${r.prompt_en ? `<div class="section-h">English <button data-copy="prompt_en">复制</button></div><pre class="prompt">${esc(r.prompt_en)}</pre>` : ''}
    ${r.negative ? `<div class="section-h">避免项 <button data-copy="negative">复制</button></div><pre class="prompt small">${esc(r.negative)}</pre>` : ''}
    ${params.length ? `<div class="badges" style="margin-top:8px">${params.map(([k, v]) => `<span class="badge light">${esc(k)}：${esc(v)}</span>`).join('')}</div>` : ''}
    ${shotsTable(a.shots)}
    ${asList(r.review).length ? `<div class="section-h">${m.refined_from ? `对比生成结果发现的差异（第 ${esc(m.round)} 轮修正）` : 'AI 自检修正了什么'}</div><ul class="plain">${asList(r.review).map(x => `<li>${esc(issueText(x))}</li>`).join('')}</ul>` : ''}
    ${asList(r.explanation).length ? `<div class="section-h">反推依据</div><ul class="plain">${asList(r.explanation).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${asList(a.uncertain).length ? `<div class="section-h">不确定的地方</div><ul class="plain">${asList(a.uncertain).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${asList(r.tips).length ? `<div class="section-h">生成出来不像时</div><ul class="plain">${asList(r.tips).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="section-h">参考的案例</div>
    <div class="refs">${(g.references || []).map(c => cardHtml({ ...c, prompt_snippet: '' })).join('') || '<span class="muted">无</span>'}</div>
    <details style="margin-top:12px"><summary>完整的画面分析</summary><pre class="prompt small">${esc(JSON.stringify(a, null, 2))}</pre></details>
    ${m.media_type !== 'video' ? `<div class="section-h">生成出来不像？</div>
    <div class="compare">
      <p class="muted">上传用这条提示词生成的图，AI 会对比原图找出差异并修正提示词，可以反复多轮。</p>
      <div class="row"><label>生成结果图片<input type="file" accept="image/*" class="cmp-file"></label><label>或填生成图链接<input class="cmp-url" placeholder="https://…"></label></div>
      <button class="primary cmp-btn" type="button">对比并修正提示词</button>
      <div class="status cmp-status"></div>
    </div>` : ''}
    <div class="actions"><button data-act="save">保存到我的库</button></div>`;
  el.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(r[b.dataset.copy] || '')));
  el.querySelectorAll('.refs .card').forEach(card => card.addEventListener('click', () => openCase(card.dataset.id)));
  el.querySelector('.cmp-btn')?.addEventListener('click', async () => {
    const status = el.querySelector('.cmp-status');
    const file = el.querySelector('.cmp-file').files[0];
    const url = el.querySelector('.cmp-url').value.trim();
    if (!file && !/^https?:\/\//i.test(url)) return setStatus(status, '请上传生成的图片，或填写以 http 开头的图片链接', true);
    const btn = el.querySelector('.cmp-btn');
    btn.disabled = true;
    const started = Date.now();
    const tick = setInterval(() => setStatus(status, `<span class="spinner"></span>正在对比原图与生成结果 → 修正提示词…（${Math.round((Date.now() - started) / 1000)} 秒）`), 500);
    try {
      const body = { id: g.id, lang: $('#rev-lang').value };
      if (file) body.image = await fileToDataUrl(file, 2048);
      else body.image_url = url;
      const next = await api('/api/reverse/refine', { method: 'POST', body });
      renderReverse(next);
      setStatus($('#rev-status'), `对比修正完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
      loadRevHistory();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setStatus(status, e.message, true);
    } finally {
      clearInterval(tick);
      btn.disabled = false;
    }
  });
  el.querySelector('[data-act=save]').addEventListener('click', async () => {
    resetAddForm();
    $('#a-title').value = (r.title || '反推的提示词').slice(0, 40);
    $('#a-prompt').value = r.prompt_en && r.prompt ? `${r.prompt}\n\n---\n${r.prompt_en}` : (r.prompt || r.prompt_en || '');
    $('#a-cat').value = g.category.code || '';
    $('#a-subtype').value = a.subtype || '';
    $('#a-model').value = m.target_model && m.target_model !== '通用' ? m.target_model : '';
    $('#a-tags').value = asList(a.keywords).join(', ');
    $('#a-analysis').value = asList(r.explanation).join('\n');
    $('#a-url').value = /^https?:/.test(m.source || '') ? m.source : '';
    $('#a-note').value = `由 AI 反推 #${g.id} 生成`;
    if (g.image) await addDrop.setFromUrl(g.image).catch(() => {});
    switchTab('add');
    setStatus($('#a-status'), '已带入反推结果，确认后点保存。');
  });
}

$('#rev-btn').addEventListener('click', async () => {
  const url = $('#rev-url').value.trim();
  if (!rev.dataUrl && !url) return setStatus($('#rev-status'), '请上传图片或视频，或者填写链接', true);
  if (url && !rev.dataUrl && !/^https?:\/\//i.test(url)) return setStatus($('#rev-status'), '链接需要以 http:// 或 https:// 开头', true);
  const body = {
    target_model: $('#rev-model').value.trim(), lang: $('#rev-lang').value, hint: $('#rev-hint').value.trim(), frames: Number($('#rev-frames').value),
    output: $('#rev-output').value, detail: $('#rev-detail').checked,
    llm_model: $('#rev-llm')?.value || '',
  };
  if (rev.dataUrl) body[rev.kind] = rev.dataUrl;
  else if (/\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i.test(url)) body.video_url = url;
  else body.image_url = url; // 服务端会按下载到的文件类型自动判断是图片还是视频
  const btn = $('#rev-btn');
  btn.disabled = true;
  const started = Date.now();
  const video = rev.kind === 'video' || body.video_url;
  const tick = setInterval(() => setStatus($('#rev-status'), `<span class="spinner"></span>${video ? '正在抽帧 → 看视频' : body.detail ? '正在看全图和局部放大图' : '正在看图'} → 逆向分析 → 检索模板与案例 → 撰写提示词${body.detail ? ' → 对照原图自检' : ''}…（${Math.round((Date.now() - started) / 1000)} 秒）`), 500);
  try {
    const g = await api('/api/reverse', { method: 'POST', body });
    renderReverse(g);
    setStatus($('#rev-status'), `完成，用时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    loadRevHistory(); loadStats();
  } catch (e) {
    setStatus($('#rev-status'), e.message, true);
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
});

async function loadRevHistory() {
  const list = (await api('/api/generations')).filter(g => String(g.goal || '').startsWith('【反推】'));
  $('#rev-history').innerHTML = list.map(g => `<div class="hist" data-id="${g.id}">
    <div class="thumb" style="${g.image ? `background-image:url('${esc(g.image)}')` : ''}"></div>
    <div><div class="t">${esc(g.goal.replace('【反推】', '') || '（无标题）')}</div>
    <div class="s">${esc(g.category.code || '')} ${esc(g.category.name || '')} · ${esc(g.created_at)}</div>
    <div class="s">${esc(g.prompt_snippet)}</div></div></div>`).join('') || '<span class="muted">还没有反推记录。</span>';
  $('#rev-history').querySelectorAll('.hist').forEach(h => h.addEventListener('click', async () => {
    renderReverse(await api('/api/generations/' + h.dataset.id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

// ---------- 模板（简易 Markdown 渲染） ----------
function mdInline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const cat = /^(C\d\d)_/.exec(href);
    return cat ? `<a href="#" data-tpl="${cat[1]}">${text}</a>` : `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  });
  return s;
}

function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const isBlockStart = l => /^(```|#{1,6}\s|\||>|\s*([-*]|\d+\.)\s|---+\s*$)/.test(l);
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<div class="codewrap"><button class="copy-code">复制</button><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
    } else if (/^#{1,6}\s/.test(l)) {
      const n = l.match(/^#+/)[0].length;
      html += `<h${n}>${mdInline(l.slice(n).trim())}</h${n}>`; i++;
    } else if (/^---+\s*$/.test(l)) {
      html += '<hr>'; i++;
    } else if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      html += '<div class="tablewrap"><table>' + rows.map((r, idx) => {
        if (idx === 1 && /^[\s|:-]+$/.test(r)) return '';
        const tag = idx === 0 ? 'th' : 'td';
        return '<tr>' + cells(r).map(c => `<${tag}>${mdInline(c)}</${tag}>`).join('') + '</tr>';
      }).join('') + '</table></div>';
    } else if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${buf.map(mdInline).join('<br>')}</blockquote>`;
    } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s/, ''));
      html += (ordered ? '<ol>' : '<ul>') + buf.map(b => `<li>${mdInline(b)}</li>`).join('') + (ordered ? '</ol>' : '</ul>');
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      html += `<p>${buf.map(mdInline).join('<br>')}</p>`;
    }
  }
  return html;
}

async function openTemplate(key) {
  const doc = key === 'rules' ? await api('/api/docs/rules') : await api('/api/categories/' + key);
  const body = $('#tpl-body');
  body.innerHTML = renderMarkdown(key === 'rules' ? doc?.content : doc.template_md);
  document.querySelectorAll('#tpl-list button').forEach(b => b.classList.toggle('active', b.dataset.tpl === key));
  window.scrollTo({ top: 0 });
}

$('#tpl-body').addEventListener('click', e => {
  const copy = e.target.closest('.copy-code');
  if (copy) return copyText(copy.nextElementSibling.textContent);
  const link = e.target.closest('a[data-tpl]');
  if (link) { e.preventDefault(); openTemplate(link.dataset.tpl); }
});

// ---------- 设置 ----------
async function loadSettings() {
  const s = await api('/api/settings');
  $('#s-base').value = s.llm_base_url;
  $('#s-model').value = s.llm_model;
  $('#s-vmodel').value = s.llm_vision_model;
  $('#s-temp').value = s.llm_temperature;
  $('#s-maxtok').value = s.llm_max_tokens || '';
  $('#s-fallback').value = s.llm_fallback_model || '';
  $('#s-key').value = '';
  $('#s-key-hint').textContent = s.llm_api_key_set ? `已保存的 Key：${s.llm_api_key_hint}` : '尚未保存 API Key';
  $('#s-tbase').value = s.tagger_base_url || '';
  $('#s-tmodel').value = s.tagger_model || '';
  $('#s-tkey').value = '';
  $('#s-tkey-hint').textContent = s.tagger_api_key_set ? `已保存的 Key：${s.tagger_api_key_hint}` : '尚未保存（留空则批量标注沿用上面的主接口）';
}

$('#s-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: {
      llm_base_url: $('#s-base').value, llm_api_key: $('#s-key').value, llm_model: $('#s-model').value,
      llm_vision_model: $('#s-vmodel').value, llm_temperature: $('#s-temp').value, llm_max_tokens: $('#s-maxtok').value, llm_fallback_model: $('#s-fallback').value,
      tagger_base_url: $('#s-tbase').value, tagger_api_key: $('#s-tkey').value, tagger_model: $('#s-tmodel').value,
    } });
    await loadSettings();
    setStatus($('#s-status'), '已保存。');
  } catch (e) { setStatus($('#s-status'), e.message, true); }
});

$('#s-test').addEventListener('click', async () => {
  setStatus($('#s-status'), '<span class="spinner"></span>测试中…');
  try {
    const r = await api('/api/settings/test', { method: 'POST' });
    setStatus($('#s-status'), `连接成功：${r.model} 回复「${r.reply}」`);
  } catch (e) { setStatus($('#s-status'), e.message, true); }
});

// ---------- Google 云盘 ----------
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)}${u[i]}`;
}

async function loadDrive() {
  clearTimeout(loadDrive.timer);
  let s;
  try {
    s = await api('/api/drive/status');
  } catch (e) {
    $('#drive-status').textContent = e.message;
    return;
  }
  const c = s.counts || {};
  const n = (k, st) => c[k]?.[st]?.n || 0;
  const row = (k, label, total) => `<tr><td>${label}</td><td>${n(k, 'done')}（${fmtBytes(c[k]?.done?.bytes)}）</td><td>${n(k, 'pending') + n(k, 'uploading')}</td><td>${n(k, 'failed')}</td><td>${n(k, 'skipped')}</td><td>${total}</td></tr>`;
  const quota = s.quota ? `已用 ${fmtBytes(s.quota.usage)} / 共 ${s.quota.limit ? fmtBytes(s.quota.limit) : '不限'}` : '-';
  const sync = s.sync || {};
  $('#d-client-id').placeholder = s.client_id_hint ? `已保存：${s.client_id_hint}（留空表示不修改）` : 'xxxx.apps.googleusercontent.com';
  $('#drive-status').innerHTML = !s.configured ? '<p class="muted">还没有保存凭据：按上面的步骤创建后粘贴进来。</p>'
    : !s.connected ? '<p class="muted">凭据已保存，还没有连接：点「连接 Google 云盘」，在弹出的 Google 页面登录并允许。</p>'
    : `<p>已连接：<b>${esc(s.email)}</b>　云盘空间：${quota}${s.folder_id ? `　<a href="https://drive.google.com/drive/folders/${esc(s.folder_id)}" target="_blank" rel="noopener">打开云盘文件夹</a>` : ''}</p>
      ${s.error ? `<p class="status err">${esc(s.error)}</p>` : ''}
      <div class="tablewrap"><table class="shots"><tr><th></th><th>已上传</th><th>等待</th><th>失败</th><th>跳过</th><th>库里约</th></tr>
      ${row('image', '图片', s.estimate?.images ?? '-')}${row('video', '视频', s.estimate?.videos ?? '-')}</table></div>
      <p class="muted">${sync.running ? '<span class="spinner"></span>' : ''}${esc(sync.message || '还没有同步过')}${sync.processed ? `（本次处理 ${sync.processed}：上传 ${sync.uploaded}，共 ${fmtBytes(sync.bytes)}，跳过 ${sync.skipped}，失败 ${sync.failed}）` : ''}</p>`;
  $('#d-connect').disabled = !s.configured;
  $('#d-connect').textContent = s.connected ? '重新连接' : '连接 Google 云盘';
  $('#d-disconnect').hidden = !s.connected;
  $('#d-sync').disabled = !s.connected || sync.running;
  $('#d-stop').disabled = !sync.running;
  if (s.connected) state.driveWaiting = false;
  if (state.activeTab === 'settings' && (sync.running || state.driveWaiting)) loadDrive.timer = setTimeout(loadDrive, 3000);
}

$('#d-save').addEventListener('click', async () => {
  try {
    await api('/api/drive/config', { method: 'PUT', body: {
      client_id: $('#d-client-id').value.trim(), client_secret: $('#d-client-secret').value.trim(), json: $('#d-json').value.trim(),
    } });
    $('#d-client-secret').value = '';
    $('#d-json').value = '';
    setStatus($('#d-msg'), '凭据已保存，下一步点「连接 Google 云盘」。');
    loadDrive();
  } catch (e) { setStatus($('#d-msg'), e.message, true); }
});
$('#d-connect').addEventListener('click', async () => {
  try {
    const { url } = await api('/api/drive/auth-url');
    window.open(url, '_blank', 'noopener');
    state.driveWaiting = true;
    setStatus($('#d-msg'), '已打开 Google 授权页面：登录并允许后，这里会自动显示连接结果。');
    loadDrive.timer = setTimeout(loadDrive, 3000);
  } catch (e) { setStatus($('#d-msg'), e.message, true); }
});
$('#d-disconnect').addEventListener('click', async () => {
  if (!confirm('断开后不再读取和上传云盘文件（云盘里已上传的文件不会删除）。确定断开吗？')) return;
  try { await api('/api/drive/disconnect', { method: 'POST' }); setStatus($('#d-msg'), '已断开。'); loadDrive(); }
  catch (e) { setStatus($('#d-msg'), e.message, true); }
});
$('#d-sync').addEventListener('click', async () => {
  try { await api('/api/drive/sync', { method: 'POST', body: { action: 'start' } }); setStatus($('#d-msg'), '已开始同步，可以关掉这个页面，同步会在后台继续。'); loadDrive(); }
  catch (e) { setStatus($('#d-msg'), e.message, true); }
});
$('#d-stop').addEventListener('click', async () => {
  try { await api('/api/drive/sync', { method: 'POST', body: { action: 'stop' } }); setStatus($('#d-msg'), '正在暂停：当前正在传的文件传完后停止。'); loadDrive(); }
  catch (e) { setStatus($('#d-msg'), e.message, true); }
});

// ==========================================================================
// 可视化提示词调色盘 (IMGPrompt 模式: 像挑颜料一样挑提示词)
// ==========================================================================
let fetchLiveCases = async () => {};

function initPromptPalette() {
  const dict = window.PIGMENT_DICTIONARY || [];
  if (!dict.length) return;

  const stats = window.PIGMENT_STATS;
  const statsEl = $('#pp-dict-stats');
  if (statsEl && stats) {
    statsEl.textContent = `${(stats.totalCases / 10000).toFixed(1)} 万条案例 · ${dict.length} 维 · ${stats.pigments} 标签`
      + (stats.fresh ? ` · ${stats.fresh} 新词` : '');
  }

  let subIdx = 0;
  let catIdx = 0;

  const subBox = $('#pp-subject-pills');
  const catBox = $('#pp-category-pills');
  const tagBox = $('#pp-pigment-tags');
  const promptBox = $('#pp-prompt-output');
  const wordCount = $('#pp-word-count');

  let liveSearchTimer;
  fetchLiveCases = async function(queryText) {
    const listEl = $('#pp-live-cases-list');
    const tagLabelEl = $('#pp-live-matched-tag');
    const countEl = $('#pp-live-matched-count');
    if (!listEl) return;

    const q = (queryText || '').trim();
    if (tagLabelEl) tagLabelEl.textContent = q ? (q.length > 20 ? q.slice(0, 20) + '...' : q) : 'RECOMMENDED / 精选';

    // Cache-First: 如果是默认精选且有缓存，立即秒级直出
    if (!q || q === '新中式') {
      const cached = sessionStorage.getItem('plib_live_cases_cache');
      if (cached && listEl.children.length === 0) {
        try {
          const cData = JSON.parse(cached);
          if (cData.html) {
            listEl.innerHTML = cData.html;
            if (countEl && cData.total) countEl.textContent = `${cData.total.toLocaleString()} 条标杆`;
          }
        } catch {}
      }
    }

    try {
      const isSemantic = $('#pp-live-semantic-chk')?.checked;
      const params = new URLSearchParams({
        q, tier: '1', limit: '10'
      });
      if (isSemantic && q) params.set('semantic', '1');
      const r = await api('/api/cases?' + params);
      if (countEl) countEl.textContent = `${r.total.toLocaleString()} 条标杆`;
      if (!r.items || !r.items.length) {
        listEl.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">暂无匹配的黄金案例，请尝试其他关键词</div>';
        return;
      }
      const renderedHtml = r.items.map(c => {
        const thumb = c.image
          ? `<div class="live-case-thumb" style="background-image:url('${esc(c.image)}')"></div>`
          : '<div class="live-case-thumb none"><span>无配图</span></div>';
        const simBadge = c._sim != null
          ? `<span class="live-sim-badge" style="display:inline-block; font-size:10.5px; font-weight:800; color:var(--blue); background:var(--blue-soft); padding:1px 6px; border-radius:4px; margin-bottom:4px;">🎯 ${(c._sim * 100).toFixed(0)}% 意境吻合</span>`
          : '';
        return `
          <div class="live-case-item" data-id="${c.id}">
            ${thumb}
            <div class="live-case-body">
              ${simBadge}
              <div class="live-case-title" title="${esc(c.title)}">${esc(c.title)}</div>
              ${c.prompt_snippet ? `<div class="live-case-snippet">${esc(c.prompt_snippet)}</div>` : ''}
              <div class="live-case-footer">
                <button type="button" class="live-import-btn" data-id="${c.id}">⚡ 导入参数</button>
                <button type="button" class="live-view-btn" data-id="${c.id}">查看详情 →</button>
              </div>
            </div>
          </div>
        `;
      }).join('');
      listEl.innerHTML = renderedHtml;
      if (!isSemantic && (!q || q === '新中式')) {
        try { sessionStorage.setItem('plib_live_cases_cache', JSON.stringify({ html: renderedHtml, total: r.total })); } catch {}
      }
    } catch (err) {
      listEl.innerHTML = `<div class="muted" style="padding:16px;color:#ef4444;">拉取案例失败: ${esc(err.message)}</div>`;
    }
  }

  function triggerLiveSearch(text) {
    clearTimeout(liveSearchTimer);
    liveSearchTimer = setTimeout(() => fetchLiveCases(text), 200);
  }

  // 中栏案例操作事件
  $('#pp-live-cases-list')?.addEventListener('click', async e => {
    const impBtn = e.target.closest('.live-import-btn');
    if (impBtn) {
      e.stopPropagation();
      try {
        const c = await api('/api/cases/' + impBtn.dataset.id);
        const cur = promptBox.value.trim();
        promptBox.value = cur ? `${cur}, ${c.prompt || ''}` : (c.prompt || '');
        updateWordCount();
        toast(`已导入 #${c.id} 的完整参数`);
      } catch { toast('导入失败'); }
      return;
    }
    const viewBtn = e.target.closest('.live-view-btn');
    const item = e.target.closest('.live-case-item');
    if (viewBtn || item) {
      const cid = viewBtn ? viewBtn.dataset.id : item.dataset.id;
      if (cid) openCase(cid);
    }
  });

  const selectedTags = new Map(); // enLower -> { zh, en }
  const fixedBar = $('#pp-fixed-tags-bar');

  function renderFixedTags() {
    if (!fixedBar) return;
    if (selectedTags.size === 0) {
      fixedBar.innerHTML = '<span class="pp-fixed-empty-hint">📌 已选固定标签（点选左侧标签在此动态显示中英文）</span>';
      return;
    }
    fixedBar.innerHTML = Array.from(selectedTags.values()).map(t => `
      <div class="pp-fixed-tag-chip" data-en="${esc(t.en)}" data-zh="${esc(t.zh)}">
        <span class="chip-dot"></span>
        <span class="chip-zh">${esc(t.zh)}</span>
        <span class="chip-sep">·</span>
        <span class="chip-en">${esc(t.en)}</span>
        <button type="button" class="chip-close" data-en="${esc(t.en)}" title="移除此标签">✕</button>
      </div>
    `).join('');

    fixedBar.querySelectorAll('.chip-close').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const en = btn.dataset.en;
        const enLower = en.toLowerCase();
        selectedTags.delete(enLower);
        let cur = promptBox.value.trim();
        const regex = new RegExp(`(^|,\\s*)${en.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(,\\s*|$)`, 'gi');
        cur = cur.replace(regex, '$1').replace(/^,\s*|,\s*$/g, '').trim();
        promptBox.value = cur;
        updateWordCount();
      });
    });
  }

  function updateWordCount() {
    const val = promptBox.value.trim();
    wordCount.textContent = val ? val.length : '0';
    const textLower = val.toLowerCase();
    for (const [k] of selectedTags.entries()) {
      if (!textLower.includes(k)) {
        selectedTags.delete(k);
      }
    }
    renderFixedTags();
    syncTagHighlights();
  }

  function syncTagHighlights() {
    const text = promptBox.value.toLowerCase();
    tagBox.querySelectorAll('.pp-tag-item').forEach(el => {
      const token = (el.dataset.en || '').toLowerCase();
      const on = !!(token && text.includes(token));
      el.classList.toggle('on', on);
      if (on) {
        el.style.backgroundColor = '#1f2328';
        el.style.color = '#ffffff';
        el.style.borderColor = '#1f2328';
      } else {
        el.style.backgroundColor = '';
        el.style.color = '';
        el.style.borderColor = '';
      }
    });
  }
  const fmtCount = n => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));

  function renderStep1() {
    subBox.innerHTML = dict.map((s, idx) => `
      <div class="pp-pill ${idx === subIdx ? 'active' : ''}" data-idx="${idx}" title="${esc(s.name)}：本库 ${fmtCount(s.count)} 条案例">
        ${esc(s.name)}<span class="pp-pill-count">${fmtCount(s.count)}</span>
      </div>
    `).join('');

    subBox.querySelectorAll('.pp-pill').forEach(el => {
      el.addEventListener('click', () => {
        subIdx = Number(el.dataset.idx);
        catIdx = 0;
        renderStep1();
        renderStep2();
        renderStep3();
      });
    });
  }

  function renderStep2() {
    const sub = dict[subIdx];
    if (!sub) return;
    catBox.innerHTML = (sub.categories || []).map((c, idx) => `
      <div class="pp-pill-sub ${idx === catIdx ? 'active' : ''}" data-idx="${idx}" title="${esc(c.name)}：本库 ${fmtCount(c.count)} 条案例">
        ${esc(c.name)}<span class="pp-pill-count">${fmtCount(c.count)}</span>
      </div>
    `).join('');

    catBox.querySelectorAll('.pp-pill-sub').forEach(el => {
      el.addEventListener('click', () => {
        catIdx = Number(el.dataset.idx);
        renderStep2();
        renderStep3();
      });
    });
  }

  function togglePromptTag(el) {
    const en = el.dataset.en;
    const zh = el.dataset.zh || '';
    let cur = promptBox.value.trim();
    const curLower = cur.toLowerCase();
    const enLower = en.toLowerCase();

    if (curLower.includes(enLower)) {
      const regex = new RegExp(`(^|,\\s*)${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,\\s*|$)`, 'gi');
      cur = cur.replace(regex, '$1').replace(/^,\s*|,\s*$/g, '').trim();
      el.classList.remove('on');
      selectedTags.delete(enLower);
    } else {
      cur = cur ? `${cur}, ${en}` : en;
      el.classList.add('on');
      selectedTags.set(enLower, { zh, en });
    }
    promptBox.value = cur;
    updateWordCount();
    promptBox.focus();
    triggerLiveSearch(zh || en);
  }

  function bindTagClicks(scope) {
    scope.querySelectorAll('.pp-tag-item').forEach(el => {
      el.addEventListener('mousedown', e => e.preventDefault());
      el.addEventListener('click', e => {
        e.preventDefault();
        try { if (window.getSelection) window.getSelection().removeAllRanges(); } catch {}
        togglePromptTag(el);
      });
    });
  }

  // 语料新词候选：词表尚未收录、但从本库语料里挖出来、且明显集中在当前维度的标签
  function renderFreshTags() {
    const bar = $('#pp-fresh-tags');
    if (!bar) return;
    const sub = dict[subIdx];
    const list = sub?.freshTags || [];
    if (!list.length) { bar.innerHTML = ''; bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `
      <div class="pp-section-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>语料新词候选 NEEDS VOCAB</span>
        <span class="pp-live-hint">词表还没收录，点选可直接用</span>
      </div>
      <div class="pp-pigments-grid">${list.map(f => {
        const enLower = (f.en || '').toLowerCase();
        const on = !!enLower && promptBox.value.toLowerCase().includes(enLower);
        return `
          <div class="pp-tag-item pp-tag-fresh ${on ? 'on' : ''}" data-en="${esc(f.en)}" data-zh="${esc(f.zh)}"
               title="${esc(f.zh)} · ${esc(f.en)}｜本库 ${fmtCount(f.count)} 条案例，多与「${esc(f.cat || '')}」同现（提升 ${f.lift}×）">
            <span class="pp-fresh-badge">新</span>
            <span class="pp-zh">${esc(f.zh)}</span>
            <span class="pp-tag-count">${fmtCount(f.count)}</span>
          </div>`;
      }).join('')}</div>`;
    bindTagClicks(bar);
  }

  function renderStep3() {
    const sub = dict[subIdx];
    const cat = sub?.categories?.[catIdx];
    if (!cat) return;

    const text = promptBox.value.toLowerCase();
    tagBox.innerHTML = (cat.pigments || []).map(p => {
      const enLower = p.en.toLowerCase();
      const on = text.includes(enLower);
      const inline = on ? 'style="background-color:#1f2328;color:#ffffff;border-color:#1f2328;"' : '';
      return `
        <div class="pp-tag-item ${on ? 'on' : ''}" ${inline} data-en="${esc(p.en)}" data-zh="${esc(p.zh)}" title="${esc(p.zh)} · ${esc(p.en)}｜本库 ${fmtCount(p.count)} 条案例">
          <span class="pp-tag-dot${p.controlled ? ' controlled' : ''}"></span>
          <span class="pp-zh">${esc(p.zh)}</span>
          <span class="pp-tag-count">${fmtCount(p.count)}</span>
        </div>
      `;
    }).join('');

    bindTagClicks(tagBox);
    renderFreshTags();
  }
  $('#pp-act-quality')?.addEventListener('click', () => {
    const cur = promptBox.value.trim();
    promptBox.value = cur ? `${cur}, 8k resolution, photorealistic, highly detailed, raw photo` : '8k resolution, photorealistic, highly detailed, raw photo';
    updateWordCount();
  });

  $('#pp-act-negative')?.addEventListener('click', () => {
    toast('常用负面词：ugly, deformed, disfigured, poor anatomy, extra limbs, bad eyes, blurry');
  });

  $('#pp-act-ai')?.addEventListener('click', () => {
    const cur = promptBox.value.trim();
    if (!cur) return toast('请先挑选或输入提示词');
    switchTab('generate');
    $('#gen-goal').value = cur;
    toast('已导入到智能扩写工作台');
  });

  $('#pp-act-clear')?.addEventListener('click', () => {
    promptBox.value = '';
    selectedTags.clear();
    updateWordCount();
  });

  $('#pp-btn-copy')?.addEventListener('click', async () => {
    const val = promptBox.value.trim();
    if (!val) return toast('提示词内容为空');
    await copyText(val);
    toast('提示词已复制到剪贴板！');
  });

  $('#pp-insert-btn')?.addEventListener('click', () => {
    const inp = $('#pp-insert-input');
    const text = inp.value.trim();
    if (!text) return;
    const cur = promptBox.value.trim();
    promptBox.value = cur ? `${cur}, ${text}` : text;
    inp.value = '';
    updateWordCount();
    toast('已插入提示词');
  });

  promptBox.addEventListener('input', () => {
    updateWordCount();
    triggerLiveSearch(promptBox.value.split(',').pop()?.trim());
  });
  // 向量意境搜切换
  $('#pp-live-semantic-chk')?.addEventListener('change', () => {
    const q = promptBox.value.split(',').pop()?.trim() || promptBox.value.trim() || '新中式';
    fetchLiveCases(q);
    toast($('#pp-live-semantic-chk').checked ? '已开启 2.7 万向量意境匹配' : '已切回常规关键词匹配');
  });

  // 多模型方言转换机制
  let currentDialect = 'gpt';
  $$('.pp-dialect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.pp-dialect-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.dialect;
      if (target === currentDialect) return;

      let text = promptBox.value.trim();
      if (!text) {
        currentDialect = target;
        return;
      }

      if (target === 'mj') {
        text = text.replace(/--ar\s+\S+/g, '').replace(/--v\s+\S+/g, '').replace(/--style\s+\S+/g, '').trim();
        text = `${text} --ar 16:9 --v 6.1 --style raw`;
      } else if (target === 'flux') {
        text = text.replace(/--\w+(\s+\S+)?/g, '').trim();
        if (!text.toLowerCase().includes('photorealistic') && !text.toLowerCase().includes('8k')) {
          text = `${text}, cinematic lighting, photorealistic, 8k resolution, highly detailed`;
        }
      } else if (target === 'sdxl') {
        text = text.replace(/--\w+(\s+\S+)?/g, '').trim();
        if (!text.includes('(')) {
          const parts = text.split(/[,，]/).map(p => p.trim()).filter(Boolean);
          if (parts.length > 0) {
            parts[0] = `(${parts[0]}:1.2)`;
            text = parts.join(', ');
          }
        }
      } else if (target === 'gpt') {
        text = text.replace(/--\w+(\s+\S+)?/g, '')
                   .replace(/\(([^:]+):[\d.]+\)/g, '$1')
                   .replace(/,\s*,/g, ',')
                   .trim();
      }

      currentDialect = target;
      promptBox.value = text;
      updateWordCount();
      toast(`已转换并适配 ${btn.textContent} 语法`);
    });
  });

  renderStep1();
  renderStep2();
  renderStep3();
  setTimeout(() => fetchLiveCases('新中式'), 100);
}

// ---------- 外观主题切换 (跟随系统 / 深色 / 白天) ----------
const themeToggleBtn = $('#theme-toggle');
let currentTheme = localStorage.getItem('plib_theme') || 'auto';

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('plib_theme', theme);
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (themeToggleBtn) themeToggleBtn.textContent = '🌙 深色';
  } else if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    if (themeToggleBtn) themeToggleBtn.textContent = '☀️ 白天';
  } else {
    document.documentElement.removeAttribute('data-theme');
    if (themeToggleBtn) themeToggleBtn.textContent = '🌓 自动';
  }
}

themeToggleBtn?.addEventListener('click', () => {
  const next = currentTheme === 'auto' ? 'dark' : currentTheme === 'dark' ? 'light' : 'auto';
  applyTheme(next);
  toast(`外观已切换为：${next === 'dark' ? '🌙 深色模式' : next === 'light' ? '☀️ 白天模式' : '🌓 跟随系统'}`);
});

// ---------- 启动 ----------
(async () => {
  applyTheme(currentTheme);
  initPromptPalette();
  try {
    await loadCategories();
    await Promise.all([loadStats(), loadCases(true), loadFacets(), loadEmbedStatus(), loadMasters()]);
    fetchLiveCases('新中式');
  } catch (e) {
    $('#result-info').textContent = '加载失败：' + e.message;
  }
})();
