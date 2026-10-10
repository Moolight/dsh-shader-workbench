/**
 * 浏览器测试夹具：给几个「必须真浏览器才能验」的测试共用。
 *
 * 这个文件把三件被沙箱和 Windows 逼出来的脏活收在一处：
 *   1. **不捕获子进程输出**。沙箱下带管道 stdio 的 spawn 会 EPERM，
 *      所以用固定调试端口，再通过 HTTP 问 CDP 要 ws 地址。
 *   2. **用户数据目录必须落在工作区内**。`%TEMP%` 被沙箱拦着写不了，
 *      浏览器写不了 Local State 会直接崩（退出码 0x80000003）。
 *   3. **端口要探到空闲**，避免上一次没退干净。
 *
 * @module dsh-shader-workbench/tests/helpers/browser
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根目录。 */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** 测试产生的临时目录（工作区内，沙箱才允许写）。 */
export const CACHE_ROOT = join(PROJECT_ROOT, '.cache');

/** 浏览器候选路径，按优先级。 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * 找一个可用的 Chromium 内核浏览器。
 * @returns {string|null}
 */
export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 探一个空闲端口。
 * @returns {Promise<number>}
 */
export async function pickFreePort() {
  const net = await import('node:net');
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * 浏览器退出码是不是「环境把它搞崩了」。
 *
 * 0x80000003 / -2147483645：受限沙箱下 Edge 的 mojo 通道被拒，直接崩。
 * @param {number} code
 * @returns {boolean}
 */
export function isEnvCode(code) {
  return code === -2147483645 || code === 2147483651 || code === 3221225477 || code === 0xc0000003;
}

/**
 * 从失败原因判断是不是环境限制（该跳过而不是假失败）。
 * @param {object} outcome
 * @returns {boolean}
 */
export function isEnvironmentBlocked(outcome) {
  if (outcome?.envBlocked) return true;
  const reason = String(outcome?.reason ?? '');
  if (reason.includes('0x80000003') || reason.includes('-2147483645') || reason.includes('2147483651')) return true;
  return reason.includes('EPERM') || reason.includes('拒绝访问');
}

/**
 * 起一个本地静态 + 路由服务。
 *
 * @param {object} opts
 * @param {string} opts.html 根路径返回的 HTML
 * @param {Array<{prefix:string, handler:(req:any,res:any)=>any}>} [opts.routes] 前缀路由
 * @returns {Promise<{server:any, port:number, url:string, requests:string[], close:()=>Promise<void>}>}
 */
export async function startTestServer({ html, routes = [] }) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(url);
    if (url === '/' || url.startsWith('/index.html')) {
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) });
      return res.end(body);
    }
    for (const route of routes) {
      if (url.startsWith(route.prefix)) return route.handler(req, res);
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * 在真浏览器里跑一个探针页面，并把页面上的全局变量取回来。
 *
 * 探针页面的约定：
 *   - 建一个 `window.<globalName>` 对象，里面至少有 `stage` 字段
 *   - 完成后把 `stage` 置为 `'done'`；失败置为 `'failed'` 并往 `errors` 里塞原因
 *   - `onStage` 可以在中间态介入（比如派发输入事件）
 *
 * @param {object} opts
 * @param {string} opts.browser 浏览器可执行文件
 * @param {string} opts.url 打开的页面
 * @param {string} [opts.globalName] 页面上的全局变量名，缺省 `__probe`
 * @param {string} [opts.cacheName] 用户数据目录名（工作区内）
 * @param {string[]} [opts.args] 额外的浏览器参数
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.windowSize] 形如 `1920,1180`
 * @param {(stage:string, send:Function, api:object) => Promise<void>|void} [opts.onStage]
 *   每轮轮询拿到 stage 时调用；可用来在中间态发 CDP 命令
 * @param {(stage:string) => boolean} [opts.isTerminal]
 * @param {number} [opts.pollMs]
 * @returns {Promise<{ok:boolean, value?:any, consoleErrors?:string[], reason?:string, envBlocked?:boolean}>}
 */
export async function runProbe({
  browser,
  url,
  globalName = '__probe',
  cacheName = 'probe',
  args = [],
  timeoutMs = 60000,
  windowSize,
  onStage = null,
  isTerminal = (stage) => stage === 'done' || String(stage).startsWith('failed'),
  pollMs = 250,
}) {
  const cacheDir = join(CACHE_ROOT, cacheName);
  mkdirSync(cacheDir, { recursive: true });
  const port = await pickFreePort();
  const userDataDir = join(cacheDir, `run-${port}`);
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=Translate,MediaRouter',
      ...(windowSize ? [`--window-size=${windowSize}`] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...args,
      url,
    ],
    // 关键：不接管道。接了就 EPERM。
    { stdio: 'ignore' },
  );

  let killed = false;
  const cleanup = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill();
    } catch {
      // ignore
    }
    setTimeout(() => {
      rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }, 1500);
  };

  const deadline = Date.now() + timeoutMs;
  try {
    let target = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        return { ok: false, envBlocked: isEnvCode(child.exitCode), reason: `浏览器退出（code ${child.exitCode}）` };
      }
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find(
          (t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && t.url.startsWith('http'),
        );
        if (target) break;
      } catch {
        // 还没起来，重试
      }
      await sleep(150);
    }
    if (!target) return { ok: false, reason: `等 CDP 端口超时（${timeoutMs} ms）` };
    return await attachAndPoll({
      wsUrl: target.webSocketDebuggerUrl,
      globalName,
      deadline,
      onStage,
      isTerminal,
      pollMs,
      childAlive: () => child.exitCode === null || child.exitCode === undefined,
    });
  } finally {
    cleanup();
  }
}

/**
 * 连上 CDP 并轮询页面状态。
 * @param {object} opts
 * @returns {Promise<object>}
 */
function attachAndPoll({ wsUrl, globalName, deadline, onStage, isTerminal, pollMs, childAlive }) {
  return new Promise((resolvePromise) => {
    let ws;
    let settled = false;
    const consoleErrors = [];
    const seenStages = new Set();
    const logs = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      resolvePromise({ ...value, consoleErrors, logs });
    };

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      return finish({ ok: false, reason: `CDP 连接失败：${error.message}` });
    }

    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // 先收错误，再处理响应
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        consoleErrors.push(String(d?.exception?.description ?? d?.text ?? ''));
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${msg.params?.type}] ${text}`);
        if (msg.params?.type === 'error') consoleErrors.push(text);
      } else if (msg.method === 'Network.loadingFailed') {
        consoleErrors.push(`request failed: ${msg.params?.errorText ?? '?'}`);
      } else if (msg.method === 'Network.responseReceived') {
        const r = msg.params?.response;
        if (r && r.status >= 400) consoleErrors.push(`HTTP ${r.status} ${r.url}`);
      }

      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.rej(new Error(msg.error.message));
      else entry.res(msg.result);
    });
    ws.addEventListener('error', () => finish({ ok: false, reason: 'CDP websocket 出错' }));

    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });

    /** 在页面里求值并解析 JSON。 */
    const evaluate = async (expression) => {
      const outcome = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (outcome.exceptionDetails) {
        throw new Error(`页面里执行出错：${outcome.exceptionDetails.text}`);
      }
      return outcome.result?.value;
    };

    ws.addEventListener(
      'open',
      async () => {
        try {
          await send('Runtime.enable');
          await send('Network.enable');

          while (Date.now() < deadline) {
            if (!childAlive()) return finish({ ok: false, envBlocked: true, reason: '浏览器中途退出' });

            const raw = await evaluate(`JSON.stringify(window.${globalName} ?? null)`);
            const value = raw ? JSON.parse(raw) : null;
            const stage = value?.stage;

            if (stage && !seenStages.has(stage)) {
              seenStages.add(stage);
              if (onStage) await onStage(stage, send, { evaluate });
            }

            if (stage && isTerminal(stage)) return finish({ ok: true, value });
            await sleep(pollMs);
          }
          return finish({ ok: false, reason: `等 window.${globalName} 完成超时` });
        } catch (error) {
          return finish({ ok: false, reason: `CDP 流程出错：${error.message}` });
        }
      },
      { once: true },
    );
  });
}

/**
 * 在页面里同步求值（给 onStage 用）。
 * @param {string} expression
 * @returns {string}
 */
export function jsonExpr(expression) {
  return `JSON.stringify(${expression})`;
}

/**
 * 读画布中心像素（默认帧缓冲，需要 preserveDrawingBuffer）。
 *
 * 注意 WebGL 的 `readPixels` 是**自下而上**的，所以 y 要翻转。
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [w]
 * @param {number} [h]
 * @returns {string} 一段页面里可求值的表达式，返回 `{r,g,b,a}`
 */
export function readPixelExpr(x, y, w = 1, h = 1) {
  return `(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2');
    const buf = new Uint8Array(${w * h * 4});
    const flippedY = canvas.height - ${y} - ${h};
    gl.readPixels(${x}, flippedY, ${w}, ${h}, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return JSON.stringify({ r: buf[0], g: buf[1], b: buf[2], a: buf[3], raw: Array.from(buf.slice(0, 4)) });
  })()`;
}

/**
 * 在画布上派发一次鼠标移动（走真 CDP 输入通道）。
 * @param {Function} send CDP send
 * @param {number} x
 * @param {number} y
 * @param {'mouseMoved'|'mousePressed'|'mouseReleased'} type
 * @returns {Promise<void>}
 */
export async function dispatchMouse(send, x, y, type = 'mouseMoved') {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

/**
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 清掉整个测试缓存目录。
 * @returns {Promise<void>}
 */
export async function cleanCache() {
  await rm(CACHE_ROOT, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
