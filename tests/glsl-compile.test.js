/**
 * GLSL 真机编译校验：用无头 Chromium 内核浏览器起一个真 WebGL2 上下文，
 * 把「每个节点单独成图」的着色器都编译一遍。
 *
 * 这是唯一能证明「节点库里的每一段 GLSL 都合法」的办法——
 * Node 里没法编译 GLSL，纯字符串断言挡不住语法错误。
 *
 * 跑法：node tests/glsl-compile.test.js
 * 找不到浏览器时【跳过】而不是失败（不阻塞离线环境），但会打印提示。
 *
 * @module dsh-shader-workbench/tests/glsl-compile
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_LIBRARY, NODE_BY_TYPE } from '../shared/nodes.js';
import { compileGraph } from '../client/runtime/codegen.js';
import { makeGraph, makeEdge, makeNode, setPassNodes } from '../shared/graph.js';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 浏览器探测用的缓存目录。
 * **必须在工作区内**：沙箱不允许写 %TEMP%，浏览器会因为写不了自己的数据文件而崩。
 */
const PROBE_CACHE_DIR = join(PROJECT, '.cache', 'glsl-probe');
mkdirSync(PROBE_CACHE_DIR, { recursive: true });

/** 浏览器候选路径（按优先级）。 */
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
 * 找一个可用的浏览器。
 * @returns {string|null}
 */
function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 造一张「一个节点单独成图」的图，验证这段 GLSL 本身合法。
 *
 * 处理三类特殊情况：
 *   - output 节点本身就是终点，不参与
 *   - split 是多输出，取它的 x
 *   - texture / bufferSample 需要采样源，单独在下面的多 Pass 用例里验
 *   - group / groupInput 是元节点的一部分：前者的端口和内容都来自 params.graph，
 *     后者只有在组的子图里才有意义（生成时它的表达式由外层喂进来）。
 *     这两者的展开逻辑由 tests/node-registry.test.js 单独覆盖
 * @param {object} def
 * @returns {object|null} 图，或 null（该节点需要别的构造方式）
 */
function graphForNode(def) {
  if (def.terminal) return null;
  // loopIndex 也只在重复组的循环体里有意义
  if (def.type === 'group' || def.type === 'groupInput' || def.type === 'loopIndex') return null;
  const node = makeNode(def.type, 0, 0, {});
  const out = makeNode('output', 300, 0);
  const nodes = [node, out];
  const edges = [];
  const outputPort = def.outputs[0]?.id ?? 'out';
  edges.push(makeEdge(node.id, outputPort, out.id, 'color'));
  const graph = makeGraph({ name: `probe-${def.type}`, nodes, edges });
  setPassNodes(
    graph,
    'image',
    nodes.map((n) => n.id),
  );
  return graph;
}

/**
 * 用浏览器把所有着色器编译一遍。
 *
 * 注意两件事，都是被沙箱和 Windows 逼出来的：
 *   1. **不捕获子进程输出**。沙箱下带管道 stdio 的 spawn 会 EPERM，
 *      所以用固定调试端口，再通过 HTTP 问 CDP 要 ws 地址。
 *   2. 端口要探到空闲为止，避免上一次没退干净。
 *
 * @param {string} browser
 * @param {string[]} sources
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, results:Array<{index:number,ok:boolean,log:string}>, reason?:string}>}
 */
async function compileInBrowser(browser, sources, timeoutMs = 45000) {
  const port = await pickFreePort();
  // 用户数据目录必须落在**工作区内**：DSH 的文件沙箱拦住了 %TEMP% 的写入，
  // 浏览器写不了 Local State 之类的文件会直接崩（退出码 0x80000003）。
  const userDataDir = join(PROBE_CACHE_DIR, `run-${port}`);
  await rmDir(userDataDir);
  await mkdir(userDataDir, { recursive: true });
  const htmlPath = join(userDataDir, 'probe.html');
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
      `<canvas id="c" width="8" height="8"></canvas></body></html>`,
    'utf8',
  );

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=Translate,MediaRouter',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      htmlPath,
    ],
    // 关键：不接管道。接了就 EPERM。
    { stdio: 'ignore', detached: false },
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
      void rmDir(userDataDir);
    }, 1200);
  };

  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  try {
    // 等 CDP 起来
    let version = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        return { ok: false, results: [], reason: `浏览器提前退出（code ${child.exitCode}）` };
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(150);
    }
    if (!version) return { ok: false, results: [], reason: `等 CDP 端口超时（${timeoutMs} ms）` };

    // 找页面 target
    let page = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
        if (page) break;
      } catch {
        // 重试
      }
      await sleep(150);
    }
    if (!page) return { ok: false, results: [], reason: '没找到可调试的页面 target' };

    // 连上了 ws 也可能马上崩（受限沙箱下 Edge 的 mojo 通道会被拒），
    // 所以探针之前先确认进程还活着
    if (child.exitCode !== null && child.exitCode !== undefined) {
      return { ok: false, results: [], reason: `浏览器提前退出（code ${child.exitCode}）` };
    }

    const outcome = await runProbe(page.webSocketDebuggerUrl, sources, deadline - Date.now());
    if (!outcome.ok) return { ok: false, results: [], reason: outcome.reason };
    return { ok: true, results: outcome.results, renderer: outcome.renderer, vendor: outcome.vendor };
  } finally {
    console.log(`[glsl] 浏览器探测耗时 ${Date.now() - started} ms`);
    cleanup();
  }
}

/**
 * 删目录，失败不抛（Windows 上浏览器经常还没松手）。
 * @param {string} dir
 */
async function rmDir(dir) {
  try {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // ignore
  }
}

/**
 * 通过一个页面的 CDP ws 地址跑编译探针。
 * @param {string} wsUrl
 * @param {string[]} sources
 * @param {number} budgetMs
 * @returns {Promise<{ok:boolean, reason?:string, results?:object[], renderer?:string, vendor?:string}>}
 */
function runProbe(wsUrl, sources, budgetMs) {
  return new Promise((resolvePromise) => {
    let ws;
    const done = (value) => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
      resolvePromise(value);
    };

    const timer = setTimeout(() => done({ ok: false, reason: `探针执行超时（${budgetMs} ms）` }), Math.max(5000, budgetMs));

    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      clearTimeout(timer);
      return resolvePromise({ ok: false, reason: `CDP 连接失败：${error.message}` });
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

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      done({ ok: false, reason: 'CDP websocket 出错' });
    });

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
          const expression = buildProbeExpression(sources);
          const outcome = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          clearTimeout(timer);
          if (outcome.exceptionDetails) {
            return done({ ok: false, reason: `页面里执行出错：${outcome.exceptionDetails.text}` });
          }
          const value = outcome.result?.value;
          if (!value || value.fatal) return done({ ok: false, reason: `WebGL2 不可用：${value?.fatal ?? '未知'}` });
          return done({ ok: true, results: value.results, renderer: value.renderer, vendor: value.vendor });
        } catch (error) {
          clearTimeout(timer);
          return done({ ok: false, reason: `CDP 流程出错：${error.message}` });
        }
      },
      { once: true },
    );
  });
}

/**
 * 生成浏览器里那段编译探针的源码。
 * @param {string[]} sources
 * @returns {string}
 */
function buildProbeExpression(sources) {
  return `(async () => {
    const sources = ${JSON.stringify(sources)};
    const canvas = document.getElementById('c') || document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) return { fatal: '拿不到 webgl2 上下文' };
    const vsSource = '#version 300 es\\nprecision highp float;\\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      return { fatal: 'vertex shader: ' + gl.getShaderInfoLog(vs) };
    }
    const results = sources.map((source, index) => {
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, source);
      gl.compileShader(fs);
      const compiled = !!gl.getShaderParameter(fs, gl.COMPILE_STATUS);
      const compileLog = compiled ? '' : (gl.getShaderInfoLog(fs) || '');
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      const linked = !!gl.getProgramParameter(program, gl.LINK_STATUS);
      const linkLog = linked ? '' : (gl.getProgramInfoLog(program) || '');
      gl.deleteProgram(program);
      gl.deleteShader(fs);
      return { index, ok: compiled && linked, log: [compileLog, linkLog].filter(Boolean).join(' | ') };
    });
    return { results, renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR) };
  })()`;
}

/**
 * 探一个空闲端口。
 * @returns {Promise<number>}
 */
async function pickFreePort() {
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
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 浏览器探测的结果判定：是真的编译失败，还是环境根本跑不了浏览器。
 *
 * 已知的环境性失败（要**跳过**而不是判失败）：
 *   - 退出码 0x80000003 / -2147483645：Edge 在受限沙箱下 mojo 通道被拒，直接崩
 *   - spawn EPERM：沙箱不允许派生子进程
 * @param {{ok:boolean, reason?:string}} outcome
 * @returns {boolean} 是否属于环境限制
 */
function isEnvironmentBlocked(outcome) {
  const reason = String(outcome?.reason ?? '');
  if (reason.includes('0x80000003') || reason.includes('-2147483645') || reason.includes('2147483651')) return true;
  if (reason.includes('EPERM') || reason.includes('拒绝访问')) return true;
  return false;
}

/**
 * 统一跑一次浏览器验证，处理「环境跑不了」与「真的编译不过」两种情况。
 * @param {object} t node:test 的上下文
 * @param {string[]} sources
 * @param {string[]} names
 * @returns {Promise<object|null>} 成功时返回结果；跳过时返回 null
 */
async function verifySources(t, sources, names) {
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过真机 GLSL 校验');
    return null;
  }
  const result = await compileInBrowser(browser, sources);
  if (!result.ok) {
    if (isEnvironmentBlocked(result)) {
      console.log(`[glsl] 环境限制，跳过真机校验：${result.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${result.reason}），跳过真机 GLSL 校验`);
      return null;
    }
    assert.fail(`浏览器编译流程失败：${result.reason}`);
  }
  console.log(`[glsl] 渲染器：${result.vendor} / ${result.renderer}`);
  const failures = result.results.filter((r) => !r.ok).map((r) => `节点/Pass ${names[r.index]}：${r.log}`);
  console.log(`[glsl] 编译探针：${sources.length} 个，失败 ${failures.length} 个`);
  assert.deepEqual(failures, [], `有 GLSL 编译不过：\n${failures.join('\n')}`);
  return result;
}

const browser = findBrowser();

test('节点库里的每个节点生成的 GLSL 都能在真 WebGL2 里编译通过', async (t) => {
  // 组装探针：每个节点一张图
  const probes = [];
  for (const def of NODE_LIBRARY) {
    const graph = graphForNode(def);
    if (!graph) continue;
    const compiled = compileGraph(graph, 'image', {});
    assert.equal(compiled.ok, true, `${def.type} 的代码生成失败：${JSON.stringify(compiled.errors)}`);
    probes.push({ type: def.type, code: compiled.code });
  }
  assert.ok(probes.length > 25, `探针太少（${probes.length}），节点库可能没加载全`);
  await verifySources(
    t,
    probes.map((p) => p.code),
    probes.map((p) => p.type),
  );
});

test('多 Pass 图（BufferA + 采样 + 纹理通道）也能编译通过', async (t) => {
  const uv = makeNode('uv', 0, 0);
  const scale = makeNode('scaleP', 200, 0, {});
  const noise = makeNode('fbm', 400, 0, {});
  const time = makeNode('time', 400, 140, {});
  const add = makeNode('add', 600, 60, {});
  const tex = makeNode('texture', 600, 200, { channel: 'iChannel1' });
  const mul = makeNode('mul', 800, 120, {});
  const bufOut = makeNode('output', 1000, 20);
  const bufSample = makeNode('bufferSample', 0, 300, { buffer: 'BufferA' });
  const imgOut = makeNode('output', 400, 300);

  const graph = makeGraph({
    name: 'multi-pass-probe',
    nodes: [uv, scale, noise, time, add, tex, mul, bufOut, bufSample, imgOut],
    edges: [
      makeEdge(uv.id, 'out', scale.id, 'p'),
      makeEdge(scale.id, 'out', noise.id, 'uv'),
      makeEdge(time.id, 'out', add.id, 'a'),
      makeEdge(noise.id, 'out', add.id, 'b'),
      makeEdge(add.id, 'out', mul.id, 'a'),
      makeEdge(tex.id, 'out', mul.id, 'b'),
      makeEdge(mul.id, 'out', bufOut.id, 'color'),
      makeEdge(bufSample.id, 'out', imgOut.id, 'color'),
    ],
  });
  setPassNodes(graph, 'BufferA', [uv.id, scale.id, noise.id, time.id, add.id, tex.id, mul.id, bufOut.id]);
  setPassNodes(graph, 'image', [bufSample.id, imgOut.id]);

  const sources = [];
  const names = [];
  for (const pass of ['image', 'BufferA']) {
    const compiled = compileGraph(graph, pass, {});
    assert.equal(compiled.ok, true, `${pass} 代码生成失败：${JSON.stringify(compiled.errors)}`);
    sources.push(compiled.code);
    names.push(pass);
  }

  // 「新建材质」默认给的那张图也要能编译——用户第一次打开看到的就是它
  const fallback = makeGraph({ name: 'default-graph', nodes: [makeNode('uv', 0, 0)], edges: [] });
  const out = makeNode('output', 240, 0);
  fallback.nodes.push(out);
  fallback.edges.push(makeEdge(fallback.nodes[0].id, 'out', out.id, 'color'));
  setPassNodes(fallback, 'image', fallback.nodes.map((n) => n.id));
  const fallbackCompiled = compileGraph(fallback, 'image', {});
  assert.equal(fallbackCompiled.ok, true, JSON.stringify(fallbackCompiled.errors));
  sources.push(fallbackCompiled.code);
  names.push('default');

  await verifySources(t, sources, names);
});

test('每个节点定义都有可用的默认参数（静态检查，不需要浏览器）', () => {
  for (const def of NODE_LIBRARY) {
    for (const [key, meta] of Object.entries(def.params ?? {})) {
      assert.ok(meta.type, `${def.type}.${key} 缺 type`);
      // graph 这类参数由代码生成专门处理，不参与 GLSL 序列化，不要求有默认值
      if (meta.type !== 'graph') assert.notEqual(meta.value, undefined, `${def.type}.${key} 缺默认值`);
    }
    for (const port of [...def.inputs, ...def.outputs]) {
      assert.ok(port.id, `${def.type} 有端口缺 id`);
      assert.ok(port.type, `${def.type}.${port.id} 缺类型`);
    }
    // terminal 节点必须有输入（output 要吃 color），非 terminal 必须有输出。
    // 例外：**端口由参数决定的元节点**（group 的入/出端口来自 params.graph）
    // 静态定义里就是空的，端口要用 resolvePorts() 现算。
    const dynamicPorts = typeof def.dynamicOut === 'function' && def.type === 'group';
    if (dynamicPorts) continue;
    if (def.terminal) assert.ok(def.inputs.length > 0, `${def.type} 是终点节点但没有输入`);
    else assert.ok(def.outputs.length > 0, `${def.type} 不是终点节点但没有输出`);
  }
});

test('节点库的 type 不重复', () => {
  const seen = new Set();
  for (const def of NODE_LIBRARY) {
    assert.equal(seen.has(def.type), false, `节点类型重复：${def.type}`);
    seen.add(def.type);
    assert.equal(NODE_BY_TYPE.get(def.type), def);
  }
});

void PROJECT;
