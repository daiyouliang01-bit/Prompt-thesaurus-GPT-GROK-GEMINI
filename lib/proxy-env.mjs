// Node 自带的 fetch 默认不走代理（访问 Google 等海外服务会连不上）。
// 检测到系统代理时，带上 NODE_USE_ENV_PROXY=1 重新启动当前进程，让 fetch 走代理；本机地址不走代理。
import { spawn, execFileSync } from 'node:child_process';

function detectProxy() {
  const env = process.env;
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (fromEnv) return fromEnv;
  if (process.platform !== 'darwin') return '';
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
    const get = k => new RegExp(`\\b${k}\\s*:\\s*(\\S+)`).exec(out)?.[1];
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) return `http://${get('HTTPSProxy')}:${get('HTTPSPort') || 80}`;
    if (get('HTTPEnable') === '1' && get('HTTPProxy')) return `http://${get('HTTPProxy')}:${get('HTTPPort') || 80}`;
  } catch { /* 读不到系统代理就直连 */ }
  return '';
}

/** 返回 true 表示已经交给带代理设置的子进程运行，当前进程只负责等待，调用方不要再继续执行 */
export function relaunchWithProxy() {
  if (process.env.NODE_USE_ENV_PROXY === '1' || process.env.PLIB_NO_RELAUNCH === '1') return false;
  const proxy = detectProxy();
  if (!proxy) return false;
  const noProxy = [process.env.NO_PROXY || process.env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  const child = spawn(process.execPath, [...process.execArgv, '--disable-warning=UNDICI-EHPA', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: {
      ...process.env, NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: process.env.HTTPS_PROXY || proxy, HTTP_PROXY: process.env.HTTP_PROXY || proxy,
      NO_PROXY: noProxy, no_proxy: noProxy,
    },
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return true;
}
