// 后台：右键菜单、快捷键，以及代网页里的面板调用本地提示词库接口
const DEFAULT_SERVER = 'http://127.0.0.1:5178';

async function serverBase() {
  const { server } = await chrome.storage.sync.get('server');
  return (server || DEFAULT_SERVER).replace(/\/+$/, '');
}

async function api(path, { method = 'GET', body } = {}) {
  const base = await serverBase();
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Plib-Client': 'extension' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`连不上本地提示词库（${base}），请先运行 prompt-library/start.sh`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'plib-selection', title: '把选中的文字作为提示词加入提示词库', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'plib-image', title: '把这张图片加入提示词库', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'plib-video', title: '把这个视频加入提示词库', contexts: ['video'] });
    chrome.contextMenus.create({ id: 'plib-page', title: '打开提示词库收藏面板', contexts: ['page', 'link'] });
  });
});

async function openPanel(tab, payload = {}) {
  if (!tab?.id) return;
  const msg = { type: 'plib-open', ...payload };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // 安装插件前就打开的网页还没有注入面板，这里补注入一次
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      console.warn('这个页面不允许插件打开面板', e);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const payload = { selection: info.selectionText || '' };
  if (info.menuItemId === 'plib-image') payload.image = info.srcUrl;
  if (info.menuItemId === 'plib-video') payload.video = info.srcUrl;
  openPanel(tab, payload);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-panel') openPanel(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'plib-api') {
    api(msg.path, msg).then(data => sendResponse({ ok: true, data }), e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'plib-open-active') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => openPanel(tab));
    return false;
  }
  return false;
});
