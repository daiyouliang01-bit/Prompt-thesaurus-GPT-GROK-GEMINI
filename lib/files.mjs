import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './paths.mjs';

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function newName(ext) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
}

/** 把 data URL 保存到 data/<subdir>/，返回相对 data 目录的路径 */
export function saveDataUrl(dataUrl, subdir = 'images/user') {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('图片格式不支持，仅支持 png / jpg / webp / gif'), { status: 400 });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const dir = path.join(DATA, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = newName(ext);
  fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
  return `${subdir}/${name}`;
}

/** 复制本地图片文件到 data/<subdir>/，返回相对路径 */
export function copyImageFile(absPath, subdir = 'images/user') {
  const ext = path.extname(absPath).slice(1).toLowerCase().replace('jpeg', 'jpg');
  if (!MIME_BY_EXT[ext]) throw new Error(`不支持的图片格式：${ext}`);
  const dir = path.join(DATA, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const name = newName(ext);
  fs.copyFileSync(absPath, path.join(dir, name));
  return `${subdir}/${name}`;
}

export function fileToDataUrl(absPath) {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的图片格式：${ext}`);
  return `data:${mime};base64,${fs.readFileSync(absPath).toString('base64')}`;
}

export function relToUrl(rel) {
  return rel ? '/files/' + rel.split(path.sep).map(encodeURIComponent).join('/') : '';
}
