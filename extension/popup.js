const $ = s => document.querySelector(s);
const DEFAULT_SERVER = 'http://127.0.0.1:5178';
const send = msg => new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || '未知错误' })));

async function refreshStatus() {
  const el = $('#status');
  const r = await send({ type: 'plib-api', path: '/api/stats' });
  if (r.ok) {
    const total = r.data?.total ?? r.data?.cases;
    el.textContent = total != null ? `已连接 · 库里共 ${total} 条` : '已连接本地提示词库';
    el.className = 'status ok';
  } else {
    el.textContent = r.error;
    el.className = 'status err';
  }
}

async function init() {
  const { showFab = true, hiddenSites = [], server = DEFAULT_SERVER } = await chrome.storage.sync.get(['showFab', 'hiddenSites', 'server']);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let site = '';
  try { site = /^https?:/.test(tab?.url || '') ? new URL(tab.url).hostname : ''; } catch { site = ''; }

  $('#showFab').checked = showFab;
  $('#siteName').textContent = site || '此网站';
  $('#hideSite').checked = !!site && hiddenSites.includes(site);
  $('#hideSite').disabled = !site;
  $('#server').value = server;
  refreshStatus();

  $('#showFab').addEventListener('change', e => chrome.storage.sync.set({ showFab: e.target.checked }));
  $('#hideSite').addEventListener('change', async e => {
    const { hiddenSites: list = [] } = await chrome.storage.sync.get('hiddenSites');
    const next = e.target.checked ? [...new Set([...list, site])] : list.filter(h => h !== site);
    chrome.storage.sync.set({ hiddenSites: next });
  });
  $('#openPanel').addEventListener('click', () => { send({ type: 'plib-open-active' }); window.close(); });
  $('#openLib').addEventListener('click', async () => {
    const { server: base = DEFAULT_SERVER } = await chrome.storage.sync.get('server');
    chrome.tabs.create({ url: base });
  });
  $('#saveServer').addEventListener('click', async () => {
    const v = $('#server').value.trim().replace(/\/+$/, '');
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v)) {
      $('#status').textContent = '地址需要是 http://127.0.0.1:端口 或 http://localhost:端口';
      $('#status').className = 'status err';
      return;
    }
    await chrome.storage.sync.set({ server: v });
    refreshStatus();
  });
}

init();
