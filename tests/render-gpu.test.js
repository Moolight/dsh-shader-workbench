/**
 * GPU 回读验证：把渲染结果真的读回来对像素。
 *
 * 为什么需要这个测试：前面那些测试只能证明「着色器编译通过」，
 * 证明不了「画出来的东西是对的」。这个文件用 `gl.readPixels` 读实际像素，
 * 覆盖三块之前只有代码、没有验证的能力：
 *
 *   1. **iChannel0-3 纹理绑定** —— 绑一张纯色图，采样出来必须是那个颜色；
 *      解绑后必须回落到兜底灰（32,32,32），而不是黑。
 *   2. **多 Pass 反馈** —— BufferA 写绿色，image Pass 采样它必须拿到绿色。
 *      这验证的是 FBO 双缓冲乒乓与「上一帧」语义。
 *   3. **iMouse 交互** —— 用真 CDP 输入通道在画布上移动鼠标，
 *      读回来的像素必须编码出那个位置。
 *
 * 跑法：node tests/render-gpu.test.js
 * 环境跑不了无头浏览器时【跳过】而不是假失败。
 *
 * @module dsh-shader-workbench/tests/render-gpu
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';
import { findBrowser, isEnvironmentBlocked, runProbe, startTestServer, dispatchMouse, cleanCache } from './helpers/browser.mjs';

/** 画布边长（CSS 与后备缓冲都是这个值，dpr=1 时相等）。 */
const SIZE = 128;

/** 兜底纹理的颜色：setChannel 解绑时用的 1x1 中灰。 */
const FALLBACK = [32, 32, 32];

/**
 * 探针页面。
 *
 * 做法：不启动 rAF 循环，手动 `render()` 若干帧，每步 `readPixels` 取中心像素。
 * 每一步都把结果写进 `window.__gpu.steps`，测试这边逐条断言。
 */
const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>gpu</title>
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}canvas{display:block;width:${SIZE}px;height:${SIZE}px}</style>
</head><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
window.__gpu = { stage: 'boot', steps: [], errors: [] };
const push = (name, data) => window.__gpu.steps.push({ name, ...data });

try {
  const { ShaderToy } = await import('/plugins/dsh-shader-workbench/module/runtime/index.js');

  const canvas = document.getElementById('c');
  const toy = new ShaderToy(canvas, { scale: 1, speed: 0 });
  toy.config.playing = false;   // 时间不推进，画面才可复现

  // ── 极小的图构造器（不依赖 shared，免得测的是别的东西）──────
  const node = (id, type, params) => ({ id, type, x: 0, y: 0, params: params || {} });
  const edge = (a, ap, b, bp) => ({ id: 'e_' + a + '_' + ap + '_' + b + '_' + bp, from: { node: a, port: ap }, to: { node: b, port: bp } });
  const graph = (nodes, edges, passes) => ({
    id: 'g', name: 't', version: 1, nodes, edges, uniforms: [],
    passes: (passes || [{ name: 'image', graph: nodes.map(n => n.id) }]),
    metadata: { version: '0', tags: [] },
  });

  /** 纯色源画布。 */
  const solid = (r, g, b) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    ctx.fillRect(0, 0, 64, 64);
    return c;
  };

  /** 读画布正中心一个像素（readPixels 是自下而上的，要翻 y）。 */
  const readCenter = () => {
    const gl = toy.gl;
    const buf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(${SIZE / 2}, ${SIZE / 2}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2], a: buf[3] };
  };

  /** 渲若干帧再读（多 Pass 需要至少两帧才能采到 Buffer 的「上一帧」）。 */
  const renderAndRead = (frames) => {
    for (let i = 0; i < (frames || 1); i++) toy.render(0);
    return readCenter();
  };

  const use = (g, label) => {
    const res = toy.setGraph(g, {});
    if (!res.ok) {
      throw new Error(label + ' 编译失败：' + JSON.stringify(res.errors.map(e => e.message ?? e)));
    }
    return res;
  };

  window.__gpu.gl = {
    renderer: toy.gl.getParameter(toy.gl.RENDERER),
    floatBuffers: toy.floatBuffersOk,
    size: { w: canvas.width, h: canvas.height },
  };

  // 每一步都必须**先渲一帧再读**：readPixels 读的是当前后备缓冲，
  // 只切了 program 不 draw 的话读到的是没被写过的 (0,0,0,0)。
  const capture = (name, frames) => push(name, renderAndRead(frames ?? 1));

  // ═══════════ 1) iChannel0 绑定纯红 ═══════════
  toy.setChannel('iChannel0', solid(255, 0, 0));
  use(graph(
    [node('tex', 'texture', { channel: 'iChannel0' }), node('out', 'output')],
    [edge('tex', 'out', 'out', 'color')],
  ), 'sample-iChannel0');
  capture('iChannel0=red');

  // ═══════════ 2) 解绑后必须回落到兜底灰 ═══════════
  toy.setChannel('iChannel0', null);
  use(graph(
    [node('tex2', 'texture', { channel: 'iChannel0' }), node('out2', 'output')],
    [edge('tex2', 'out', 'out2', 'color')],
  ), 'sample-iChannel0-unbound');
  capture('iChannel0=unbound');

  // ═══════════ 3) 槽位互不串台：红在 iChannel3 ═══════════
  toy.setChannel('iChannel3', solid(255, 0, 0));
  use(graph(
    [node('tex3', 'texture', { channel: 'iChannel3' }), node('out3', 'output')],
    [edge('tex3', 'out', 'out3', 'color')],
  ), 'sample-iChannel3');
  capture('iChannel3=red');

  use(graph(
    [node('tex4', 'texture', { channel: 'iChannel0' }), node('out4', 'output')],
    [edge('tex4', 'out', 'out4', 'color')],
  ), 'sample-iChannel0-while-3-bound');
  capture('iChannel0=still-unbound');

  // ═══════════ 4) 换源不泄漏、且新源生效 ═══════════
  toy.setChannel('iChannel3', solid(0, 0, 255));   // 换源
  use(graph(
    [node('tex5', 'texture', { channel: 'iChannel3' }), node('out5', 'output')],
    [edge('tex5', 'out', 'out5', 'color')],
  ), 'sample-iChannel3-replaced');
  capture('iChannel3=blue');

  // ═══════════ 5) 多 Pass：BufferA 写绿，image 采样它 ═══════════
  {
    const bufRgb = node('bufrgb', 'rgb', { color: [0, 1, 0] });
    const bufOut = node('bufout', 'output');
    const sampler = node('bufsample', 'bufferSample', { buffer: 'BufferA' });
    const imgOut = node('imgout', 'output');
    const g = graph(
      [bufRgb, bufOut, sampler, imgOut],
      [edge('bufrgb', 'out', 'bufout', 'color'), edge('bufsample', 'out', 'imgout', 'color')],
      [
        { name: 'image', graph: ['bufsample', 'imgout'] },
        { name: 'BufferA', graph: ['bufrgb', 'bufout'] },
      ],
    );
    use(g, 'multi-pass');
    push('bufferA=green', renderAndRead(3));
    push('passes', { list: toy.stats().passes });
  }

  // ═══════════ 6) iMouse：等外部派发输入后再渲 ═══════════
  // 用 mouseUV 节点：iMouse.zw / iResolution.xy → 像素编码出鼠标位置
  use(graph(
    [node('muv', 'mouseUV'), node('mout', 'output')],
    [edge('muv', 'out', 'mout', 'color')],
  ), 'mouseUV');
  toy.attachMouse();

  // 把渲染与读像素暴露给测试驱动：等外部派发完输入事件后再调它们
  window.__gpu.renderOnce = () => toy.render(0);
  window.__gpu.readCenter = () => {
    const gl = toy.gl;
    const buf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(${SIZE / 2}, ${SIZE / 2}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2], a: buf[3] };
  };
  /** 测试驱动调用：渲一帧、读中心像素、记一步。 */
  window.__gpu.capture = (name) => {
    window.__gpu.renderOnce();
    push(name, window.__gpu.readCenter());
  };

  window.__gpu.stage = 'awaiting-input';
} catch (error) {
  window.__gpu.stage = 'failed';
  window.__gpu.errors.push(String((error && error.stack) || error));
}
</script>
</body></html>`;

const browser = findBrowser();

// 起服务：静态页面 + 插件的真路由（面板 import 与纹理字节都走它）
const workspace = new Workspace(`${(await import('node:os')).tmpdir()}/shader-wb-gpu-${Date.now()}/ws`);
await workspace.init();
const pluginRoute = createRoute({ getWorkspace: () => workspace, version: 'gpu' });
const server = await startTestServer({
  html: PROBE_HTML,
  routes: [{ prefix: API_PREFIX, handler: (req, res) => pluginRoute.handler(req, res) }],
});

after(async () => {
  await server.close();
  await cleanCache();
});

/**
 * 断言一个读回来的像素接近期望值。
 * @param {{r:number,g:number,b:number,a:number}} pixel
 * @param {number[]} expected
 * @param {string} what
 * @param {number} [tolerance]
 */
function expectPixel(pixel, expected, what, tolerance = 6) {
  const actual = [pixel.r, pixel.g, pixel.b];
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${what}：通道 ${'rgb'[i]} 期望 ${expected[i]}±${tolerance}，实际 ${actual[i]}（完整像素 ${JSON.stringify(pixel)}）`,
    );
  }
}

test('iChannel0-3 绑定、解绑回落、多 Pass 反馈、iMouse 交互都能从像素上读出来', async (t) => {
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过 GPU 回读验证');
    return;
  }

  // 鼠标要落在画布 (32,32) 处：画布在页面左上角且 CSS 尺寸等于后备缓冲，
  // 所以视口坐标 == 画布像素坐标。
  const MOUSE = { x: 32, y: 32 };
  let mouseDispatched = false;

  const outcome = await runProbe({
    browser,
    url: server.url,
    globalName: '__gpu',
    cacheName: 'render-gpu',
    windowSize: '400,400',
    onStage: async (stage, send) => {
      if (stage !== 'awaiting-input' || mouseDispatched) return;
      mouseDispatched = true;
      await dispatchMouse(send, MOUSE.x, MOUSE.y, 'mouseMoved');
      // 派发完再让页面渲一帧、读像素，然后把 stage 推到终止态
      await send('Runtime.evaluate', {
        expression: "window.__gpu.capture('mouse-uv'); window.__gpu.stage = 'done'; true",
        awaitPromise: true,
        returnByValue: true,
      });
    },
  });

  if (!outcome.ok) {
    if (isEnvironmentBlocked(outcome)) {
      console.log(`[gpu] 环境限制，跳过：${outcome.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${outcome.reason}），跳过 GPU 回读验证`);
      return;
    }
    assert.fail(`浏览器流程失败：${outcome.reason}\n控制台：\n${(outcome.consoleErrors ?? []).join('\n')}`);
  }

  const gpu = outcome.value;
  if (gpu.stage === 'failed') {
    assert.fail(`探针失败：\n${(gpu.errors ?? []).join('\n')}`);
  }

  const step = (name) => {
    const found = (gpu.steps ?? []).find((s) => s.name === name);
    assert.ok(found, `探针里没有产出步骤 ${name}（实际有：${(gpu.steps ?? []).map((s) => s.name).join(', ')}）`);
    return found;
  };

  console.log('[gpu] 环境 =', JSON.stringify(gpu.gl));
  for (const s of gpu.steps ?? []) {
    console.log(`[gpu] ${s.name.padEnd(28)} ${JSON.stringify({ r: s.r, g: s.g, b: s.b, a: s.a })}`);
  }

  // 分辨率对上
  assert.equal(gpu.gl.size.w, SIZE, '画布宽度不对');
  assert.equal(gpu.gl.size.h, SIZE, '画布高度不对');

  // 1) iChannel0 绑纯红 → 采样出来必须是红
  expectPixel(step('iChannel0=red'), [255, 0, 0], 'iChannel0 绑红图后采样');

  // 2) 解绑 → 兜底灰，不是黑
  expectPixel(step('iChannel0=unbound'), FALLBACK, 'iChannel0 解绑后应回落到兜底灰');
  assert.ok(
    step('iChannel0=unbound').r > 0,
    '解绑后是纯黑说明没走兜底纹理（采样了空纹理）',
  );

  // 3) 红绑在 iChannel3，只有 iChannel3 出红；iChannel0 仍应是灰
  expectPixel(step('iChannel3=red'), [255, 0, 0], 'iChannel3 绑红图后采样');
  expectPixel(step('iChannel0=still-unbound'), FALLBACK, 'iChannel0 没绑，不该被 iChannel3 的图串台');

  // 4) 换源：红 → 蓝，新源生效（同时验证旧纹理被释放而不是叠加）
  expectPixel(step('iChannel3=blue'), [0, 0, 255], 'iChannel3 换源后采样');

  // 5) 多 Pass：BufferA 写绿，image 采样它应拿到绿（「上一帧」语义要渲两帧以上）
  expectPixel(step('bufferA=green'), [0, 255, 0], 'BufferA → image 的多 Pass 反馈');
  assert.ok(step('passes').list.includes('BufferA'), `渲染器里没有 BufferA：${JSON.stringify(step('passes'))}`);
  assert.ok(step('passes').list.includes('image'), `渲染器里没有 image：${JSON.stringify(step('passes'))}`);

  // 6) iMouse：鼠标移到 (32,32)，画布 128×128
  //    iMouse.zw = [32, 128-32] = [32, 96] → uv = [0.25, 0.75] → 像素 (64, 191)
  expectPixel(step('mouse-uv'), [Math.round(0.25 * 255), Math.round(0.75 * 255), 0], 'iMouse 位置编码', 4);
});
