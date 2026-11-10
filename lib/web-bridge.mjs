// 网页版 AI 实时直连桥接 (Web AI Relay via CDP / Headless Daemon)
// 控制本地已登录的真实网页版会话，实现提示词自动输入、流式生成和实时图片捕获
import http from 'node:http';

let activeBrowser = null;

export async function checkChromeDebugPort() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      return { available: true, browser: data.Browser || 'Chrome' };
    }
  } catch {}
  return { available: false, error: 'Chrome 调试端口 9222 未开启' };
}

export function generateDirectUrls(promptText) {
  const q = String(promptText || '').trim();
  return {
    chatgpt: `https://chatgpt.com/?q=${encodeURIComponent('Create an image:\n\n' + q)}`,
    gemini: `https://gemini.google.com/app?text=${encodeURIComponent('Generate image:\n\n' + q)}`
  };
}
