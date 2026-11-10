// Google 云盘：OAuth 授权（桌面应用 + PKCE）、上传、读取。只申请 drive.file 权限，只能访问本应用创建的文件
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import * as store from './db.mjs';

const AUTH_URL = process.env.PLIB_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.PLIB_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API = (process.env.PLIB_GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ROOT_NAME = '提示词库媒体';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const netError = e => fail(`连不上 Google（${e.cause?.code || e.message}），请确认代理软件已开启`, 502);

function cfg() {
  const s = store.getSettings();
  return {
    clientId: s.gdrive_client_id || '', clientSecret: s.gdrive_client_secret || '', refreshToken: s.gdrive_refresh_token || '',
    email: s.gdrive_email || '', folders: { root: s.gdrive_root_id || '', images: s.gdrive_images_id || '', videos: s.gdrive_videos_id || '' },
  };
}
export const isConnected = () => { const c = cfg(); return !!(c.clientId && c.refreshToken); };

export function publicStatus() {
  const c = cfg();
  return {
    configured: !!c.clientId, connected: !!(c.clientId && c.refreshToken), email: c.email,
    client_id_hint: c.clientId ? `${c.clientId.slice(0, 14)}…` : '', folder_id: c.folders.root,
  };
}

/** 保存 OAuth 凭据：可以分别填客户端 ID 和密钥，也可以粘贴下载的凭据 JSON */
export function saveConfig({ client_id, client_secret, json } = {}) {
  if (json && String(json).trim()) {
    let j;
    try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw fail('凭据 JSON 格式不对，请粘贴下载的完整 JSON 文件内容'); }
    if (j.web) throw fail('这是「Web 应用」类型的凭据，请重新创建「桌面应用」类型的 OAuth 客户端');
    const c = j.installed || j;
    client_id = c.client_id;
    client_secret = c.client_secret;
  }
  const old = cfg();
  client_id = String(client_id || old.clientId).trim();
  client_secret = String(client_secret || old.clientSecret).trim();
  if (!/\.apps\.googleusercontent\.com$/.test(client_id)) throw fail('客户端 ID 应该以 .apps.googleusercontent.com 结尾');
  if (!client_secret) throw fail('请填写客户端密钥');
  const patch = { gdrive_client_id: client_id, gdrive_client_secret: client_secret };
  if (old.clientId && old.clientId !== client_id) {
    Object.assign(patch, { gdrive_refresh_token: '', gdrive_email: '', gdrive_root_id: '', gdrive_images_id: '', gdrive_videos_id: '' });
  }
  store.setSettings(patch);
  token = null;
  return publicStatus();
}

// ---------- 授权 ----------
const pending = new Map();
export function authUrl(redirectUri) {
  const c = cfg();
  if (!c.clientId) throw fail('请先保存 Google OAuth 客户端凭据');
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  pending.set(state, { verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw netError(e);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(fail(`Google 授权失败：${j.error_description || j.error || res.status}`, 502), { code: j.error });
  return j;
}

let token = null;
async function accessToken(force = false) {
  if (!force && token && token.exp > Date.now()) return token.value;
  const c = cfg();
  if (!c.refreshToken) throw fail('还没有连接 Google 云盘');
  try {
    const t = await tokenRequest({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' });
    token = { value: t.access_token, exp: Date.now() + ((Number(t.expires_in) || 3600) - 60) * 1000 };
    return token.value;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      store.setSettings({ gdrive_refresh_token: '' });
      throw fail('Google 云盘授权已失效（在测试状态下的应用 7 天会过期），请重新连接', 401);
    }
    throw e;
  }
}

export async function handleCallback({ code, state, error } = {}) {
  if (error) throw fail(`授权没有完成：${error}`);
  const p = pending.get(state);
  if (!p) throw fail('授权已过期，请回到提示词库重新点「连接 Google 云盘」');
  pending.delete(state);
  const c = cfg();
  const t = await tokenRequest({
    code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: p.redirectUri,
    grant_type: 'authorization_code', code_verifier: p.verifier,
  });
  if (!t.refresh_token) throw fail('Google 没有返回长期授权。请到 Google 账号「安全性 → 第三方应用」里移除本应用，再重新连接');
  store.setSettings({ gdrive_refresh_token: t.refresh_token });
  token = { value: t.access_token, exp: Date.now() + ((Number(t.expires_in) || 3600) - 60) * 1000 };
  const info = await about();
  store.setSettings({ gdrive_email: info.user?.emailAddress || '' });
  await ensureFolders();
  return info;
}

export function disconnect() {
  store.setSettings({ gdrive_refresh_token: '', gdrive_email: '' });
  token = null;
  return publicStatus();
}

// ---------- 接口调用 ----------
/** 调用 Drive 接口：自动带授权、401 时刷新令牌、限流和服务端错误时退避重试 */
export async function driveFetch(url, init = {}, { raw = false } = {}) {
  const full = /^https?:/.test(url) ? url : `${API}${url}`;
  let force = false;
  for (let attempt = 0; ; attempt++) {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${await accessToken(force)}` };
    force = false;
    let res;
    try {
      res = await fetch(full, { ...init, headers, signal: AbortSignal.timeout(init.timeout || 120000) });
    } catch (e) {
      if (attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      throw netError(e);
    }
    if (res.status === 401 && attempt === 0) { force = true; continue; }
    const rateLimited = res.status === 429 || res.status >= 500
      || (res.status === 403 && /rate ?limit/i.test(await res.clone().text().catch(() => '')));
    if (rateLimited && attempt < 5) { await sleep(1500 * 2 ** attempt); continue; }
    if (raw) return res;
    const text = await res.text();
    if (!res.ok) throw fail(`Google 云盘返回 ${res.status}：${text.slice(0, 300)}`, res.status === 404 ? 404 : 502);
    return text ? JSON.parse(text) : {};
  }
}

export const about = () => driveFetch('/drive/v3/about?fields=user(emailAddress,displayName),storageQuota');

async function findOrCreateFolder(name, parentId) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false${parentId ? ` and '${parentId}' in parents` : ''}`;
  const found = await driveFetch(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10&spaces=drive`);
  if (found.files?.length) return found.files[0].id;
  const created = await driveFetch('/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  return created.id;
}

/** 云盘里的目录：提示词库媒体 / images、videos；被删除或移到回收站时重新创建 */
export async function ensureFolders() {
  const c = cfg();
  if (c.folders.root && c.folders.images && c.folders.videos) {
    try {
      const f = await driveFetch(`/drive/v3/files/${encodeURIComponent(c.folders.root)}?fields=id,trashed`);
      if (!f.trashed) return c.folders;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const root = await findOrCreateFolder(ROOT_NAME);
  const images = await findOrCreateFolder('images', root);
  const videos = await findOrCreateFolder('videos', root);
  store.setSettings({ gdrive_root_id: root, gdrive_images_id: images, gdrive_videos_id: videos });
  return { root, images, videos };
}

/** 断点续传式上传（一次性发送整个文件），失败时整体重试 */
export async function uploadFile(file, { name, mime, parentId, appProperties }) {
  const size = fs.statSync(file).size;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const init = await driveFetch('/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
        body: JSON.stringify({ name, parents: [parentId], appProperties }),
      }, { raw: true });
      if (!init.ok) throw fail(`创建上传失败（${init.status}）：${(await init.text()).slice(0, 200)}`, init.status);
      const location = init.headers.get('location');
      if (!location) throw fail('Google 没有返回上传地址', 502);
      let res;
      try {
        res = await fetch(location, {
          method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(size) },
          body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half',
          signal: AbortSignal.timeout(Math.round(Math.max(180000, size / 10))),
        });
      } catch (e) {
        if (e.name === 'TimeoutError') throw fail('上传超时', 504);
        throw e instanceof TypeError || e.cause ? netError(e) : e;
      }
      const text = await res.text();
      if (!res.ok) throw fail(`上传失败（${res.status}）：${text.slice(0, 200)}`, res.status);
      return JSON.parse(text);
    } catch (e) {
      lastError = e;
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable || attempt === 3) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** 读取云盘文件内容（支持 Range，用于视频拖动进度） */
export function openMedia(driveId, range) {
  return driveFetch(`/drive/v3/files/${encodeURIComponent(driveId)}?alt=media`, {
    headers: range ? { Range: range } : {}, timeout: 600000,
  }, { raw: true });
}
