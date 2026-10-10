/**
 * 编辑器交互验证：用**真 CDP 输入通道**拖节点、连端口，再断言图真的变了。
 *
 * 为什么需要这个测试：逻辑层已经验过（`canConnect`、`_wouldCycle` 有单测），
 * 但「按下 → 拖动 → 松开」这条链路上还压着一堆只在浏览器里才会暴露的东西：
 *   - `pointerdown/pointermove/pointerup` 有没有真的绑上
 *   - `setPointerCapture` 会不会抛
 *   - 命中测试用的世界坐标换算对不对（画布在页面里的偏移有没有算进去）
 *   - 端口位置与画出来的位置是不是一致
 *
 * 这个测试把「拖拽手感」里**能自动化的部分**（功能正确性）拿下；
 * 剩下的主观手感仍需人眼。
 *
 * 跑法：node tests/editor-interaction.test.js
 * 环境跑不了无头浏览器时【跳过】而不是假失败。
 *
 * @module dsh-shader-workbench/tests/editor-interaction
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';
import { findBrowser, isEnvironmentBlocked, runProbe, startTestServer, cleanCache } from './helpers/browser.mjs';

/**
 * 探针页面。
 *
 * 把 NodeEditor 单独挂起来（不套整个工作台），这样鼠标坐标好算：
 * 画布居中放在 800×600 的舞台里，位置由 `getBoundingClientRect` 现取，
 * 测试驱动通过页面暴露的 `__ed.portPos()` / `__ed.headerPos()` 拿视口坐标。
 */
const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>editor</title>
<style>
  html,body{margin:0;padding:0;background:#111;overflow:hidden}
  #stage{position:absolute;left:40px;top:30px;width:720px;height:520px}
  .swb-editor{display:flex;flex-direction:column;width:100%;height:100%}
  .swb-editor__main{display:flex;flex:1 1 auto;min-height:0}
  .swb-editor__side{flex:0 0 160px;overflow:auto}
  .swb-editor__stage{position:relative;flex:1 1 auto;min-width:0;min-height:0}
  .swb-editor__canvas{display:block;width:100%;height:100%;touch-action:none}
</style>
</head><body>
<div id="stage"></div>
<script type="module">
window.__ed = { stage: 'boot', errors: [], events: [] };
try {
  const { NodeEditor } = await import('/plugins/dsh-shader-workbench/module/panel/index.js');
  const { makeGraph, makeNode, makeEdge, setPassNodes } = await import('/plugins/dsh-shader-workbench/shared/graph.js');

  // 一张最小的图：uv（无输入、1 个输出）→ output（1 个输入、0 个输出）
  const uv = makeNode('uv', 0, 0);
  const out = makeNode('output', 300, 0);
  const seed = makeGraph({ name: 'interaction', nodes: [uv, out], edges: [] });
  setPassNodes(seed, 'image', [uv.id, out.id]);

  const graph = seed;
  const events = [];
  const editor = new NodeEditor({
    graph,
    pass: 'image',
    onChange: (g, meta) => {
      events.push({ reason: meta && meta.reason, nodes: g.nodes.length, edges: g.edges.length });
      window.__ed.events = events.slice(-20);
    },
  });
  document.getElementById('stage').appendChild(editor.root);
  editor.renderLibrary('');
  editor.syncPassTabs();
  editor.resetView();          // 固定视图：view = {x:40, y:40, zoom:1}

  window.__ed.ids = { uv: uv.id, out: out.id };
  window.__ed.portPos = (nodeId, dir, portId) => editor.portPosition(nodeId, dir, portId);
  window.__ed.headerPos = (nodeId) => editor.nodeHeaderPosition(nodeId);
  window.__ed.snapshot = () => ({
    nodes: graph.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y })),
    edges: graph.edges.map(e => ({ from: e.from.node + '.' + e.from.port, to: e.to.node + '.' + e.to.port })),
    passes: graph.passes.map(p => ({ name: p.name, count: (p.graph || []).length })),
  });
  window.__ed.canvasRect = () => {
    const r = editor.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  // ── 插桩：用来定位「连不上线」到底断在哪一步 ──
  window.__ed.debug = [];
  window.__ed.hitAt = (x, y) => {
    const world = editor.toWorld(x, y);
    const hit = editor.hitTest(world.x, world.y);
    return {
      world,
      hit: hit
        ? {
            kind: hit.kind,
            nodeType: hit.node && hit.node.type,
            portId: hit.port && hit.port.id,
            dir: hit.dir,
            index: hit.index,
          }
        : null,
    };
  };
  window.__ed.dragState = () =>
    editor.drag
      ? { kind: editor.drag.kind, fromPort: editor.drag.from && editor.drag.from.port && editor.drag.from.port.id, reject: !!editor.drag.reject }
      : null;
  window.__ed.statusText = () => (editor._status ? editor._status.textContent : null);
  window.__ed.edgeCount = () => graph.edges.length;

  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    editor.canvas.addEventListener(t, (e) => {
      window.__ed.debug.push({
        t,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        pointerId: e.pointerId,
        buttons: e.buttons,
      });
    });
  }
  // setPointerCapture 在某些合成事件下会抛，单独记下来
  const originalCapture = editor.canvas.setPointerCapture.bind(editor.canvas);
  editor.canvas.setPointerCapture = (id) => {
    try {
      originalCapture(id);
      window.__ed.debug.push({ t: 'setPointerCapture:ok', pointerId: id });
    } catch (error) {
      window.__ed.debug.push({ t: 'setPointerCapture:throw', pointerId: id, msg: String(error && error.message) });
    }
  };

  // 等布局稳定后再报 ready，否则 canvas 尺寸可能是 0
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__ed.stage = 'ready';
} catch (error) {
  window.__ed.stage = 'failed';
  window.__ed.errors.push(String((error && error.stack) || error));
}
</script>
</body></html>`;

const browser = findBrowser();

const workspace = new Workspace(`${(await import('node:os')).tmpdir()}/shader-wb-editor-${Date.now()}/ws`);
await workspace.init();
const pluginRoute = createRoute({ getWorkspace: () => workspace, version: 'editor' });
const server = await startTestServer({
  html: PROBE_HTML,
  routes: [{ prefix: API_PREFIX, handler: (req, res) => pluginRoute.handler(req, res) }],
});

after(async () => {
  await server.close();
  await cleanCache();
});

/**
 * 在页面上跑一段脚本并取回 JSON。
 * @param {Function} send CDP send
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function evaluate(send, expression) {
  const outcome = await send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (outcome.exceptionDetails) throw new Error(`页面求值失败：${outcome.exceptionDetails.text}`);
  const raw = outcome.result?.value;
  return raw ? JSON.parse(raw) : null;
}

/**
 * 模拟一次完整的拖拽：按下 → 分几步移动 → 松开。
 *
 * 分步移动很关键：编辑器是在 `pointermove` 里更新位置的，
 * 只发一个「按下 + 直接松开」不会产生任何位移。
 *
 * @param {Function} send CDP send
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {object} [opts]
 * @param {number} [opts.steps]
 * @param {(phase:'afterDown'|'afterMove'|'afterUp') => Promise<void>} [opts.checkpoint] 中途采样钩子
 */
async function drag(send, from, to, opts = {}) {
  const steps = opts.steps ?? 6;
  const mouse = (type, x, y) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'mouse',
    });

  await mouse('mousePressed', from.x, from.y);
  if (opts.checkpoint) await opts.checkpoint('afterDown');
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  if (opts.checkpoint) await opts.checkpoint('afterMove');
  await mouse('mouseReleased', to.x, to.y);
  // 让 pointerup 的处理跑完
  await new Promise((r) => setTimeout(r, 120));
  if (opts.checkpoint) await opts.checkpoint('afterUp');
}

test('真鼠标拖拽能移动节点、连接端口，并正确拒绝重复连接', async (t) => {
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过编辑器交互验证');
    return;
  }

  /** onStage 里采集到的结果，最后一起塞回页面再从返回值取。 */
  const collected = {};
  let ready = false;

  const outcome = await runProbe({
    browser,
    url: server.url,
    globalName: '__ed',
    cacheName: 'editor-interaction',
    windowSize: '900,700',
    onStage: async (stage, send) => {
      if (stage !== 'ready' || ready) return;
      ready = true;

      // 几何与坐标全部由页面自己算，测试这边不硬编码节点尺寸常量
      collected.geom = await evaluate(
        send,
        `({ rect: window.__ed.canvasRect(), ids: window.__ed.ids })`,
      );
      const { ids } = collected.geom;
      /** 每次拖之前**现取**端口坐标——节点被拖走之后旧坐标就失效了。 */
      const portOf = async (nodeId, dir, portId) =>
        evaluate(send, `window.__ed.portPos(${JSON.stringify(nodeId)}, ${JSON.stringify(dir)}, ${JSON.stringify(portId)})`);
      const headerOf = async (nodeId) => evaluate(send, `window.__ed.headerPos(${JSON.stringify(nodeId)})`);

      // ① 拖节点：uv 的标题栏往右下拖 (+80, +60)
      collected.headerAtStart = await headerOf(ids.uv);
      collected.before = await evaluate(send, 'window.__ed.snapshot()');
      await drag(send, collected.headerAtStart, {
        x: collected.headerAtStart.x + 80,
        y: collected.headerAtStart.y + 60,
      });
      collected.afterDrag = await evaluate(send, 'window.__ed.snapshot()');

      // ② 连端口：从 uv.out 拖到 out.color
      //    坐标必须在①之后重取，否则打在被拖空的画布上（踩过）
      collected.ports = {
        out: await portOf(ids.uv, 'out', 'out'),
        in: await portOf(ids.out, 'in', 'color'),
      };
      collected.connectTrace = [];
      const sample = async (phase) => {
        collected.connectTrace.push({
          phase,
          drag: await evaluate(send, 'window.__ed.dragState()'),
          edges: await evaluate(send, 'window.__ed.edgeCount()'),
          status: await evaluate(send, 'window.__ed.statusText()'),
        });
      };
      collected.hitAtOut = await evaluate(
        send,
        `window.__ed.hitAt(${collected.ports.out.x}, ${collected.ports.out.y})`,
      );
      collected.hitAtIn = await evaluate(
        send,
        `window.__ed.hitAt(${collected.ports.in.x}, ${collected.ports.in.y})`,
      );
      await drag(send, collected.ports.out, collected.ports.in, { checkpoint: sample });
      collected.afterConnect = await evaluate(send, 'window.__ed.snapshot()');
      collected.debugLog = await evaluate(send, 'window.__ed.debug.slice(-30)');

      // ③ 重复连同一条：一个输入端口只该有一条来线，第二次应是替换
      const outPortNow = await evaluate(send, `window.__ed.portPos(${JSON.stringify(ids.uv)}, 'out', 'out')`);
      const inPortNow = await evaluate(send, `window.__ed.portPos(${JSON.stringify(ids.out)}, 'in', 'color')`);
      await drag(send, outPortNow, inPortNow);
      collected.afterReconnect = await evaluate(send, 'window.__ed.snapshot()');

      // ④ 再拖一次：验证位移是连续的，不是一次性的
      const headerNow = await headerOf(ids.uv);
      await drag(send, headerNow, { x: headerNow.x - 40, y: headerNow.y - 30 });
      collected.afterSecondDrag = await evaluate(send, 'window.__ed.snapshot()');
      collected.events = await evaluate(send, 'window.__ed.events');
      collected.canvasLive = await evaluate(
        send,
        `({ w: window.__ed.canvasRect().width, h: window.__ed.canvasRect().height })`,
      );

      await send('Runtime.evaluate', {
        expression: `window.__ed.results = ${JSON.stringify(collected)}; window.__ed.stage = 'done'; true`,
        returnByValue: true,
      });
    },
  });

  if (!outcome.ok) {
    if (isEnvironmentBlocked(outcome)) {
      console.log(`[editor] 环境限制，跳过：${outcome.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${outcome.reason}），跳过编辑器交互验证`);
      return;
    }
    assert.fail(`浏览器流程失败：${outcome.reason}\n控制台：\n${(outcome.consoleErrors ?? []).join('\n')}`);
  }

  const ed = outcome.value;
  if (ed.stage === 'failed') {
    assert.fail(`探针失败：\n${(ed.errors ?? []).join('\n')}`);
  }
  assert.ok(ed.results, '探针没有回传结果（stage 可能没到 ready）');

  const r = ed.results;
  const uvId = r.geom.ids.uv;
  const outId = r.geom.ids.out;

  console.log('[editor] 画布尺寸 =', JSON.stringify(r.canvasLive));
  console.log('[editor] 端口坐标 =', JSON.stringify(r.ports));
  console.log('[editor] hitAtOut =', JSON.stringify(r.hitAtOut));
  console.log('[editor] hitAtIn  =', JSON.stringify(r.hitAtIn));
  console.log('[editor] 连线过程 =', JSON.stringify(r.connectTrace));
  console.log('[editor] pointer 日志 =', JSON.stringify(r.debugLog));
  console.log('[editor] 拖前   =', JSON.stringify(r.before));
  console.log('[editor] 拖后   =', JSON.stringify(r.afterDrag));
  console.log('[editor] 连线后 =', JSON.stringify(r.afterConnect));
  console.log('[editor] 重连后 =', JSON.stringify(r.afterReconnect));
  console.log('[editor] 再拖后 =', JSON.stringify(r.afterSecondDrag));
  console.log('[editor] 事件   =', JSON.stringify(r.events));

  // 前置：画布真有尺寸，否则所有坐标都是 0，测试等于没测
  assert.ok(r.canvasLive.w > 100, `画布宽度太小：${r.canvasLive.w}`);
  assert.ok(r.canvasLive.h > 100, `画布高度太小：${r.canvasLive.h}`);

  const nodeOf = (snap, type) => snap.nodes.find((n) => n.type === type);
  const uvBefore = nodeOf(r.before, 'uv');
  const uvAfter = nodeOf(r.afterDrag, 'uv');
  const uvAfterTwo = nodeOf(r.afterSecondDrag, 'uv');
  assert.ok(uvBefore && uvAfter && uvAfterTwo, '快照里找不到 uv 节点');

  // ① 拖节点：位移必须与鼠标位移一致
  assert.equal(uvAfter.x - uvBefore.x, 80, `横向位移不对：${uvBefore.x} → ${uvAfter.x}（期望 +80）`);
  assert.equal(uvAfter.y - uvBefore.y, 60, `纵向位移不对：${uvBefore.y} → ${uvAfter.y}（期望 +60）`);
  assert.ok(
    (r.events ?? []).some((e) => e.reason === 'move-node'),
    `变更回调里没有 move-node：${JSON.stringify(r.events)}`,
  );

  // ② 连端口：多出一条连线，两端对象要对
  assert.equal(r.before.edges.length, 0, `初始不该有连线：${JSON.stringify(r.before.edges)}`);
  assert.equal(r.afterConnect.edges.length, 1, `连线后应该有 1 条：${JSON.stringify(r.afterConnect.edges)}`);
  assert.deepEqual(
    r.afterConnect.edges[0],
    { from: `${uvId}.out`, to: `${outId}.color` },
    `连线两端不对：${JSON.stringify(r.afterConnect.edges[0])}`,
  );
  assert.ok(
    (r.events ?? []).some((e) => e.reason === 'connect'),
    `变更回调里没有 connect：${JSON.stringify(r.events)}`,
  );

  // ③ 重复连同一条：应替换而不是变成两条
  assert.equal(
    r.afterReconnect.edges.length,
    1,
    `重复连线不该变成两条：${JSON.stringify(r.afterReconnect.edges)}`,
  );

  // ④ 第二次拖动：位移依然连续
  assert.equal(uvAfterTwo.x - uvAfter.x, -40, `第二次横向位移不对：${uvAfter.x} → ${uvAfterTwo.x}`);
  assert.equal(uvAfterTwo.y - uvAfter.y, -30, `第二次纵向位移不对：${uvAfter.y} → ${uvAfterTwo.y}`);

  // 全程不该有未捕获异常
  assert.deepEqual(ed.errors ?? [], [], `页面里有异常：${JSON.stringify(ed.errors)}`);
});
