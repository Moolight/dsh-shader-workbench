/**
 * 1080p 性能验收：在真浏览器里把预览画布顶到 1920×1080，
 * 跑几秒采样 rAF 帧率，并验证「页面隐藏时几乎不耗 CPU」。
 *
 * 对应需求书第 10 节的：
 *   - 1080p 预览 ≥ 60 FPS
 *   - 页面隐藏时 CPU 占用 < 1%
 *
 * 跑法：node tests/perf-1080p.test.js
 * 环境跑不了无头浏览器时【跳过】而不是假失败。
 *
 * 注意：无头 + SwiftShader（软件渲染）下的帧率只代表**下限**，
 * 真机有独显时只会更快。所以这里给一个宽松阈值（30 FPS）判定「架构没写错」，
 * 同时把实测值打出来供人工判断。
 *
 * @module dsh-shader-workbench/tests/perf-1080p
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';
import { makeGraph, makeNode, makeEdge, setPassNodes } from '../shared/graph.js';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CACHE_DIR = join(PROJECT, '.cache', 'perf-1080p');
mkdirSync(CACHE_DIR, { recursive: true });

/** 浏览器候选。 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** @returns {string|null} */
function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

/** 采样窗口（毫秒）。 */
const SAMPLE_MS = 3000;

/** 探针页面：把预览画布顶到 1080p，跑两种负载（简单图 / fbm+多 Pass）。 */
const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>perf</title>
<style>
  html,body{margin:0;background:#000;}
  /* 强制 1920x1080 CSS 尺寸：dpr=1 时 canvas 后备缓冲就是 1920x1080 */
  #stage{width:1920px;height:1080px;}
  #stage canvas{display:block;width:100%;height:100%;}
</style>
</head><body>
<div id="stage"><canvas id="c" width="1920" height="1080"></canvas></div>
<script type="module">
window.__perf = { stage: 'boot', errors: [] };
window.addEventListener('unhandledrejection', (e) => window.__perf.errors.push(String(e.reason)));

try {
  const { ShaderToy } = await import('/plugins/dsh-shader-workbench/module/runtime/index.js');
  const canvas = document.getElementById('c');

  // 从服务端取两张图：简单图 与 重负载图（fbm + BufferA 多 Pass）
  const load = async (material) => {
    const r = await fetch('/plugins/dsh-shader-workbench/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'material.read', project: 'perf', material }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(material + ': ' + JSON.stringify(j.error));
    return j.graph;
  };

  const toy = new ShaderToy(canvas, { scale: 1, speed: 1 });
  window.__perf.dpr = window.devicePixelRatio;

  // 尽量拿 GPU 侧的真实耗时。
  // 光量 CPU 侧 performen.now() 没意义：WebGL 的 draw 是异步的，
  // CPU 只是把命令塞进队列（实测 0.03ms），真正的成本在 GPU 上。
  const gl = canvas.getContext('webgl2');
  const timerExt = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  window.__perf.timerExt = !!timerExt;
  window.__perf.glRenderer = gl ? gl.getParameter(gl.RENDERER) : null;

  /**
   * GPU 时间队列。
   *
   * EXT_disjoint_timer_query_webgl2 的结果要等 GPU 干完才可用，
   * 所以这里维护「在飞」的 query 列表，每帧开头回收那些已经 ready 的。
   * 不要用 setTimeout 回收：无头下时钟粒度不可靠。
   */
  const gpuSamples = [];
  const inFlight = [];
  let gpuQueryFailed = 0;

  const pumpGpuQueries = () => {
    if (!timerExt) return;
    for (let i = inFlight.length - 1; i >= 0; i--) {
      const q = inFlight[i];
      try {
        if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
          gl.deleteQuery(q);
          inFlight.splice(i, 1);
          gpuQueryFailed += 1;
          continue;
        }
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
          if (Number.isFinite(ns) && ns > 0) gpuSamples.push(ns / 1e6); // ns → ms
          gl.deleteQuery(q);
          inFlight.splice(i, 1);
        }
      } catch {
        gl.deleteQuery(q);
        inFlight.splice(i, 1);
        gpuQueryFailed += 1;
      }
    }
  };

  // 直接量 render() 的 CPU 耗时；GPU 时间走上面的 query
  let renderMs = [];
  const originalRender = toy.render.bind(toy);
  let timing = false;
  toy.render = (dt) => {
    if (!timing) return originalRender(dt);
    pumpGpuQueries();
    let query = null;
    if (timerExt && inFlight.length < 8) {
      try {
        query = gl.createQuery();
        gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
      } catch {
        query = null;
      }
    }
    const t0 = performance.now();
    const out = originalRender(dt);
    renderMs.push(performance.now() - t0);
    if (query) {
      try {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        inFlight.push(query);
      } catch {
        gl.deleteQuery(query);
        gpuQueryFailed += 1;
      }
    }
    return out;
  };

  const measure = async (material, seconds) => {
    const graph = await load(material);
    const res = toy.setGraph(graph, {});
    if (!res.ok) throw new Error(material + ' 编译失败: ' + JSON.stringify(res.errors.map(e => e.message)));

    // 必须真正启动渲染循环：只调 render() 是测不到东西的
    toy.start();
    // 预热 400ms，把首帧编译/纹理上传的成本排除掉
    await new Promise(r => setTimeout(r, 400));

    renderMs = [];
    gpuSamples.length = 0;
    timing = true;
    const frameStart = toy.frame;
    const t0 = performance.now();
    await new Promise(r => setTimeout(r, seconds * 1000));
    const elapsed = (performance.now() - t0) / 1000;
    timing = false;
    const frames = toy.frame - frameStart;
    // 把在飞的 query 排空
    timing = true;
    for (let i = 0; i < 12; i++) {
      pumpGpuQueries();
      await new Promise(r => setTimeout(r, 40));
      if (inFlight.length === 0) break;
    }
    timing = false;

    const stats = (arr) => {
      if (arr.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0 };
      const sorted = arr.slice().sort((a, b) => a - b);
      const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return {
        n: sorted.length,
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: pick(0.5),
        p95: pick(0.95),
        max: sorted[sorted.length - 1],
      };
    };

    return {
      material,
      fps: frames / elapsed,
      frames,
      elapsed,
      cpu: stats(renderMs),
      gpu: stats(gpuSamples),
      gpuQueryFailed,
      size: { width: canvas.width, height: canvas.height },
      passes: toy.stats().passes,
    };
  };

  window.__perf.simple = await measure('simple', ${SAMPLE_MS / 1000});
  window.__perf.heavy = await measure('heavy', ${SAMPLE_MS / 1000});

  // 页面隐藏时的空转：伪造 document.hidden，数一秒内渲染了多少次（应该是 0）
  const originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  let rendersWhileHidden = 0;
  const beforeHidden = toy.render;
  toy.render = (...args) => { rendersWhileHidden += 1; return beforeHidden(...args); };
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 1000));
  const hiddenElapsed = (performance.now() - t0) / 1000;
  toy.render = beforeHidden;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  window.__perf.hidden = { rendersWhileHidden, elapsed: hiddenElapsed };

  toy.stop();
  window.__perf.stage = 'done';
} catch (error) {
  window.__perf.stage = 'failed';
  window.__perf.errors.push(String((error && error.stack) || error));
}
</script>
</body></html>`;

const browser = findBrowser();

// ─────────────────────── 测试服务 ───────────────────────

const tempRoot = await mkdtemp(join(tmpdir(), 'swb-perf-'));
const workspace = new Workspace(join(tempRoot, 'ws'));
await workspace.init();
await workspace.createProject({ name: 'perf', title: '性能' });

/**
 * 造一张图并落到 perf 项目下。
 * @param {string} material
 * @param {(ctx:object) => {nodes:object[], edges:object[], passes?:object}} build
 */
async function makeMaterial(material, build) {
  await workspace.createMaterial({ project: 'perf', name: material });
  const nodes = [];
  const edges = [];
  const ctx = {
    node: (type, x, y, params) => {
      const n = makeNode(type, x, y, params);
      nodes.push(n);
      return n;
    },
    edge: (a, ap, b, bp) => {
      edges.push(makeEdge(a.id, ap, b.id, bp));
    },
  };
  const spec = build(ctx);
  const graph = makeGraph({ name: material, nodes, edges });
  setPassNodes(
    graph,
    'image',
    nodes.filter((n) => (spec.passes?.image ? spec.passes.image.includes(n) : true)).map((n) => n.id),
  );
  if (spec.passes?.BufferA) setPassNodes(graph, 'BufferA', spec.passes.BufferA.map((n) => n.id));
  await workspace.saveMaterial({ project: 'perf', material, graph });
}

// 简单图：uv → 渐变 → palette → 输出
await makeMaterial('simple', ({ node, edge }) => {
  const uv = node('uv', 0, 0);
  const grad = node('gradient', 220, 0, {});
  const pal = node('palette', 440, 0, {});
  const out = node('output', 660, 0);
  edge(uv, 'out', grad, 'uv');
  edge(grad, 'out', pal, 't');
  edge(pal, 'out', out, 'color');
  return { nodes: [uv, grad, pal, out], edges: [] };
});

// 重负载：fbm 4 层 + 一堆数学 + BufferA 自反馈
await makeMaterial('heavy', ({ node, edge }) => {
  const uv = node('uv', 0, 0);
  const scale = node('scaleP', 200, 0, {});
  const fbm1 = node('fbm', 400, -100, {});
  const fbm2 = node('fbm', 400, 120, {});
  const time = node('time', 400, 260, {});
  const add1 = node('add', 620, 0, {});
  const add2 = node('add', 620, 180, {});
  const mul = node('mul', 840, 90, {});
  const pal = node('palette', 1060, 90, {});
  const bufOut = node('output', 1280, -60);
  const bufSample = node('bufferSample', 200, 400, { buffer: 'BufferA' });
  const mixNode = node('mixNode', 1280, 280, {});
  const imgOut = node('output', 1500, 280);

  edge(uv, 'out', scale, 'p');
  edge(scale, 'out', fbm1, 'uv');
  edge(scale, 'out', fbm2, 'uv');
  edge(fbm1, 'out', add1, 'a');
  edge(fbm2, 'out', add1, 'b');
  edge(time, 'out', add2, 'a');
  edge(add1, 'out', add2, 'b');
  edge(add2, 'out', mul, 'a');
  edge(fbm1, 'out', mul, 'b');
  edge(mul, 'out', pal, 't');
  edge(pal, 'out', bufOut, 'color');
  edge(pal, 'out', mixNode, 'a');
  edge(bufSample, 'out', mixNode, 'b');
  edge(mixNode, 'out', imgOut, 'color');

  return {
    nodes: [uv, scale, fbm1, fbm2, time, add1, add2, mul, pal, bufOut, bufSample, mixNode, imgOut],
    edges: [],
    passes: {
      BufferA: [uv, scale, fbm1, fbm2, time, add1, add2, mul, pal, bufOut],
      image: [bufSample, mixNode, imgOut],
    },
  };
});

const pluginRoute = createRoute({ getWorkspace: () => workspace, version: 'perf' });
const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url.startsWith('/index.html')) {
    const body = Buffer.from(PROBE_HTML, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) });
    return res.end(body);
  }
  if (url.startsWith(API_PREFIX)) return pluginRoute.handler(req, res);
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(tempRoot, { recursive: true, force: true });
});

// ─────────────────────── 浏览器驱动（与 panel-smoke 同一套做法）───────────────────────

/**
 * 探一个空闲端口。
 * @returns {Promise<number>}
 */
async function pickFreePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
  });
}

/**
 * 跑探针页面并取回 window.__perf。
 * @param {string} browserPath
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function runProbe(browserPath, url, timeoutMs = 90000) {
  const port = await pickFreePort();
  const userDataDir = join(CACHE_DIR, `run-${port}`);
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });

  // 不接管道：沙箱下带管道 stdio 的 spawn 会 EPERM
  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1920,1180',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      // ignore
    }
    setTimeout(() => {
      rm(userDataDir, { recursive: true, force: true }).catch(() => {});
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
        target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && t.url.startsWith('http'));
        if (target) break;
      } catch {
        // 重试
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!target) return { ok: false, reason: '没等到可调试的页面 target' };
    return await poll(target.webSocketDebuggerUrl, deadline);
  } finally {
    cleanup();
  }
}

/**
 * 轮询 window.__perf。
 * @param {string} wsUrl
 * @param {number} deadline
 * @returns {Promise<object>}
 */
function poll(wsUrl, deadline) {
  return new Promise((resolvePromise) => {
    let ws;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      resolvePromise(value);
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

    ws.addEventListener(
      'open',
      async () => {
        try {
          await send('Runtime.enable');
          while (Date.now() < deadline) {
            const outcome = await send('Runtime.evaluate', {
              expression: 'JSON.stringify(window.__perf ?? null)',
              returnByValue: true,
            });
            const raw = outcome.result?.value;
            const perf = raw ? JSON.parse(raw) : null;
            if (perf && (perf.stage === 'done' || perf.stage === 'failed')) return finish({ ok: true, value: perf });
            await new Promise((r) => setTimeout(r, 400));
          }
          return finish({ ok: false, reason: '等 __perf 完成超时' });
        } catch (error) {
          return finish({ ok: false, reason: `CDP 流程出错：${error.message}` });
        }
      },
      { once: true },
    );
  });
}

/**
 * 退出码是不是「环境把浏览器搞崩了」。
 * @param {number} code
 * @returns {boolean}
 */
function isEnvCode(code) {
  return code === -2147483645 || code === 2147483651 || code === 3221225477 || code === 0xc0000003;
}

// ─────────────────────── 测试 ───────────────────────

test('1080p 预览帧率与隐藏时空转', async (t) => {
  // 共享 CI runner 没有 GPU，只能走 SwiftShader 软件渲染：1080p 重负载图
  // 3 秒只出得了个位数到二十几帧，帧率阈值在这里没有参考价值。这是**基准**不是
  // 正确性断言，所以 CI 直接跳过；本机（尤其有独显时）跑才有意义。
  if (process.env.CI) {
    t.skip('CI 无 GPU（软件渲染），跳过 1080p 性能基准');
    return;
  }
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过 1080p 性能测试');
    return;
  }

  const outcome = await runProbe(browser, pageUrl);
  if (!outcome.ok) {
    if (outcome.envBlocked || /拒绝访问|EPERM|崩溃/.test(outcome.reason ?? '')) {
      console.log(`[perf] 环境限制，跳过：${outcome.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${outcome.reason}），跳过 1080p 性能测试`);
      return;
    }
    assert.fail(`浏览器流程失败：${outcome.reason}`);
  }

  const perf = outcome.value;
  if (perf.stage !== 'done') {
    assert.fail(`性能探针失败：\n${(perf.errors ?? []).join('\n')}`);
  }

  console.log('[perf] dpr =', perf.dpr, '| GPU =', perf.glRenderer, '| timerQuery =', perf.timerExt);
  for (const key of ['simple', 'heavy']) {
    const r = perf[key];
    console.log(
      `[perf] ${key.padEnd(6)} rAF ${r.fps.toFixed(1)} FPS（${r.frames} 帧 / ${r.elapsed.toFixed(2)}s）· ` +
        `${r.size.width}×${r.size.height} · Pass [${r.passes.join(', ')}]`,
    );
    console.log(
      `[perf] ${key.padEnd(6)} CPU render() 均值 ${r.cpu.mean.toFixed(3)}ms / p95 ${r.cpu.p95.toFixed(3)}ms / 最差 ${r.cpu.max.toFixed(3)}ms（n=${r.cpu.n}）`,
    );
    if (r.gpu.n > 0) {
      console.log(
        `[perf] ${key.padEnd(6)} GPU 均值 ${r.gpu.mean.toFixed(2)}ms / p50 ${r.gpu.p50.toFixed(2)}ms / p95 ${r.gpu.p95.toFixed(2)}ms（n=${r.gpu.n}）`,
      );
    }
  }
  console.log(`[perf] 隐藏 1 秒内渲染次数 = ${perf.hidden.rendersWhileHidden}`);

  // 分辨率必须真的顶到 1920×1080
  assert.equal(perf.simple.size.width, 1920, `简单图分辨率不对：${perf.simple.size.width}`);
  assert.equal(perf.simple.size.height, 1080, `简单图分辨率不对：${perf.simple.size.height}`);
  assert.equal(perf.heavy.size.width, 1920, `重负载图分辨率不对：${perf.heavy.size.width}`);
  assert.equal(perf.heavy.size.height, 1080, `重负载图分辨率不对：${perf.heavy.size.height}`);

  // 多 Pass 真的建起来了
  assert.ok(perf.heavy.passes.includes('BufferA'), `重负载图少了 BufferA：${JSON.stringify(perf.heavy.passes)}`);

  // 渲染循环真的在跑
  assert.ok(perf.simple.frames > 30, `简单图只渲染了 ${perf.simple.frames} 帧，循环没跑起来`);
  assert.ok(perf.heavy.frames > 30, `重负载图只渲染了 ${perf.heavy.frames} 帧，循环没跑起来`);

  // 无头 + SwiftShader 下给宽松阈值；真机有独显只会更快
  assert.ok(perf.simple.fps >= 30, `简单图只有 ${perf.simple.fps.toFixed(1)} FPS，架构有问题`);
  assert.ok(perf.heavy.fps >= 20, `重负载图只有 ${perf.heavy.fps.toFixed(1)} FPS，架构有问题`);

  // 单帧 CPU 耗时不能成为瓶颈（16.7ms 是 60 FPS 的预算）
  assert.ok(perf.simple.cpu.p95 < 8, `简单图 CPU p95 ${perf.simple.cpu.p95.toFixed(3)}ms 偏高`);
  assert.ok(perf.heavy.cpu.p95 < 8, `重负载图 CPU p95 ${perf.heavy.cpu.p95.toFixed(3)}ms 偏高`);

  // GPU 侧数据可用时（真机/支持 timer query 的驱动）按 60 FPS 预算判
  if (perf.simple.gpu.n > 10) {
    assert.ok(
      perf.simple.gpu.p95 < 16.7,
      `简单图 GPU p95 ${perf.simple.gpu.p95.toFixed(2)}ms，超过 60 FPS 的 16.7ms 预算`,
    );
  }
  if (perf.heavy.gpu.n > 10) {
    assert.ok(
      perf.heavy.gpu.p95 < 33.4,
      `重负载图 GPU p95 ${perf.heavy.gpu.p95.toFixed(2)}ms，低于 30 FPS`,
    );
  }

  // 页面隐藏时必须完全不渲染（对应「隐藏时 CPU < 1%」）
  assert.equal(perf.hidden.rendersWhileHidden, 0, `页面隐藏时还渲染了 ${perf.hidden.rendersWhileHidden} 次`);
});
