/**
 * FR-01 浏览器端验证：撤销 / 重做 + 分组框 / 注释。
 *
 * 为什么要放在真浏览器里跑：
 *   - 撤销栈是**快照式**的，它依赖「改动前」那一刻的图长什么样。
 *     快照拍早/拍晚都看不出来，只有真的走一遍「按下 → 拖动 → 松开」才暴露。
 *   - 拖分组框要连带搬走框里的节点，这条逻辑压在 pointermove 里。
 *   - 分组框的**框体**故意不参与命中（否则大框会挡住底下的节点），
 *     只有标题栏能拖 —— 这种「反直觉但必要」的规则必须有测试钉住。
 *
 * 顺带钉住一个真实修过的 bug：空格键以前只置位不清零，
 * 按过一次空格之后左键就永远是平移、再也选不中节点，而且看不出原因。
 *
 * 跑法：node tests/editor-history.test.js
 * 环境跑不了无头浏览器时【跳过】而不是假失败。
 *
 * @module dsh-shader-workbench/tests/editor-history
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';
import { findBrowser, isEnvironmentBlocked, runProbe, startTestServer, cleanCache } from './helpers/browser.mjs';

/**
 * 探针页面。
 *
 * 舞台固定在 (40,30) 的 720×520 里，画布尺寸现取 `getBoundingClientRect`；
 * 所有要点的位置都由页面自己算（`__ed.frameHeaderPos` 等），
 * 测试这边不硬编码任何尺寸常量 —— 节点/分组框的尺寸一改，测试不用跟着改。
 */
const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>editor-history</title>
<style>
  html,body{margin:0;padding:0;background:#111;overflow:hidden}
  #stage{position:absolute;left:40px;top:30px;width:720px;height:520px}
  .swb-editor{display:flex;flex-direction:column;width:100%;height:100%}
  .swb-editor__toolbar{display:flex;gap:6px;flex:0 0 auto;height:28px}
  .swb-editor__main{display:flex;flex:1 1 auto;min-height:0}
  .swb-editor__side{flex:0 0 150px;overflow:auto}
  .swb-editor__stage{position:relative;flex:1 1 auto;min-width:0;min-height:0}
  .swb-editor__canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}
  .swb-iconbtn{width:24px;height:22px}
  .swb-canvas-editor{position:absolute}
</style>
</head><body>
<div id="stage"></div>
<script type="module">
window.__ed = { stage: 'boot', errors: [], events: [] };
try {
  const { NodeEditor } = await import('/plugins/dsh-shader-workbench/module/panel/index.js');
  const { makeGraph, makeNode, setPassNodes } = await import('/plugins/dsh-shader-workbench/shared/graph.js');
  const { compileGraph } = await import('/plugins/dsh-shader-workbench/module/runtime/codegen.js');

  // 最小可编译的图：uv → output
  const uv = makeNode('uv', 0, 0);
  const out = makeNode('output', 320, 0);
  const graph = makeGraph({ name: 'history', nodes: [uv, out], edges: [] });
  setPassNodes(graph, 'image', [uv.id, out.id]);
  graph.edges = [{
    id: 'e_seed',
    from: { node: uv.id, port: 'out' },
    to: { node: out.id, port: 'color' },
  }];

  const events = [];
  const editor = new NodeEditor({
    graph,
    pass: 'image',
    onChange: (g, meta) => {
      events.push({ reason: meta && meta.reason, nodes: g.nodes.length, frames: ((g.passes[0] || {}).frames || []).length });
      window.__ed.events = events.slice(-40);
    },
  });
  document.getElementById('stage').appendChild(editor.root);
  editor.renderLibrary('');
  editor.syncPassTabs();
  editor.resetView();              // 固定视图：view = {x:40, y:40, zoom:1}

  const rect = () => editor.canvas.getBoundingClientRect();
  /** 世界坐标 → 视口坐标（和 portPosition 同一套算法，免得两处各算一遍） */
  const viewport = (wx, wy) => {
    const s = editor.toScreen(wx, wy);
    const r = rect();
    return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
  };
  const findFrame = (id) => editor.frames().find((f) => f.id === id);

  window.__ed.ids = { uv: uv.id, out: out.id };
  window.__ed.canvasRect = () => {
    const r = rect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  // ── 图快照 ──
  window.__ed.snapshot = () => ({
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y })),
    edges: graph.edges.map((e) => e.from.node + '.' + e.from.port + '→' + e.to.node + '.' + e.to.port),
    passNodes: (graph.passes[0] || {}).graph || [],
  });
  window.__ed.frames = () => editor.frames().map((f) => ({
    id: f.id, kind: f.kind, x: f.x, y: f.y, w: f.w, h: f.h,
    title: f.title, text: f.text, color: f.color,
  }));
  /** 存盘时落进材质文件的那份数据（装饰件必须在这里面，不然重开就没了） */
  window.__ed.persistedFrames = () =>
    JSON.parse(JSON.stringify(((graph.passes || []).find((p) => p.name === 'image') || {}).frames || []));
  window.__ed.nodePos = (id) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? { x: n.x, y: n.y } : null;
  };

  // ── 撤销栈 ──
  window.__ed.hist = () => ({
    past: editor.history.past.length,
    future: editor.history.future.length,
    canUndo: editor.canUndo(),
    canRedo: editor.canRedo(),
    undoLabel: editor.undoLabel(),
    redoLabel: editor.redoLabel(),
  });
  window.__ed.undo = () => editor.undo();
  window.__ed.redo = () => editor.redo();
  window.__ed.undoTitle = () => (editor._undoBtn ? editor._undoBtn.title : null);

  // ── 几何 ──
  window.__ed.portPos = (nodeId, dir, portId) => editor.portPosition(nodeId, dir, portId);
  window.__ed.headerPos = (nodeId) => editor.nodeHeaderPosition(nodeId);
  /** 分组框标题栏中心（刻意取 y+8：稳稳落在 22px 的标题栏里，又避开右下角把手） */
  window.__ed.frameHeaderPos = (id) => {
    const f = findFrame(id);
    return f ? viewport(f.x + f.w / 2, f.y + 8) : null;
  };
  /** 分组框右下角缩放把手（把手边长 14，取内缩 4 像素处） */
  window.__ed.frameHandlePos = (id) => {
    const f = findFrame(id);
    return f ? viewport(f.x + f.w - 4, f.y + f.h - 4) : null;
  };
  /** 注释正文中心（拖注释用） */
  window.__ed.noteBodyPos = (id) => {
    const f = findFrame(id);
    return f ? viewport(f.x + f.w / 2, f.y + f.h / 2) : null;
  };
  /** 分组框**框体**内部的一点（这里必须命中不到框，留给框选） */
  window.__ed.frameBodyPos = (id) => {
    const f = findFrame(id);
    return f ? viewport(f.x + f.w / 2, f.y + f.h - 30) : null;
  };

  window.__ed.hitAt = (x, y) => {
    const world = editor.toWorld(x, y);
    const hit = editor.hitTest(world.x, world.y);
    return {
      world,
      kind: hit ? hit.kind : null,
      nodeType: hit && hit.node ? hit.node.type : null,
      frameId: hit && hit.frame ? hit.frame.id : null,
    };
  };
  window.__ed.statusText = () => (editor._status ? editor._status.textContent : null);
  window.__ed.spaceDown = () => editor._spaceDown === true;

  // ── 命令式操作（不走鼠标的那些） ──
  window.__ed.addNode = (type, x, y) => {
    const n = editor.addNode(type, x, y);
    return n ? n.id : null;
  };
  window.__ed.addFrame = (kind, cx, cy) => editor.addFrame(kind, cx, cy).id;
  window.__ed.setFrameTitle = (id, title) => editor.updateFrame(id, { title }, '改分组框标题');
  window.__ed.deleteFrame = (id) => editor.deleteFrame(id);
  window.__ed.selectFrame = (id) => { editor.selectFrame(id); return editor.selectedFrame; };
  window.__ed.selectNodesInFrame = (id) => {
    const f = findFrame(id);
    return f ? editor.selectNodesInFrame(f) : -1;
  };
  window.__ed.closeInlineEdit = () => { editor._closeInlineEdit(); return true; };
  window.__ed.selection = () => [...editor.selection];
  window.__ed.selectedFrame = () => editor.selectedFrame;

  // ── 装饰件不该影响代码生成 ──
  window.__ed.compileCode = () => {
    const r = compileGraph(graph, 'image', { uniforms: {} });
    return r.ok ? r.code : '/* FAILED: ' + r.errors.map((e) => e.message).join('; ') + ' */';
  };

  editor.canvas.focus();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__ed.stage = 'ready';
} catch (error) {
  window.__ed.stage = 'failed';
  window.__ed.errors.push(String((error && error.stack) || error));
}
</script>
</body></html>`;

const browser = findBrowser();

const workspace = new Workspace(`${(await import('node:os')).tmpdir()}/shader-wb-history-${Date.now()}/ws`);
await workspace.init();
const pluginRoute = createRoute({ getWorkspace: () => workspace, version: 'history' });
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
 * 模拟一次完整的拖拽：按下 → 分步移动 → 松开。
 *
 * 分步移动是必须的：位置在 `pointermove` 里更新，只发「按下 + 直接松开」不会产生位移。
 *
 * @param {Function} send CDP send
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {{steps?:number, button?:'left'|'right'}} [opts]
 */
async function drag(send, from, to, opts = {}) {
  const steps = opts.steps ?? 6;
  const button = opts.button ?? 'left';
  const mouse = (type, x, y) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : button,
      buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'mouse',
    });

  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouse('mouseMoved', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
  }
  await mouse('mouseReleased', to.x, to.y);
  await new Promise((r) => setTimeout(r, 140));
}

/**
 * 按一下再松开某个键（走真输入通道）。
 * @param {Function} send CDP send
 * @param {string} key
 * @param {{code:string, vk:number, text?:string}} meta
 */
async function tapKey(send, key, meta) {
  const base = { key, code: meta.code, windowsVirtualKeyCode: meta.vk, nativeVirtualKeyCode: meta.vk };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: meta.text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await new Promise((r) => setTimeout(r, 60));
}

test('撤销/重做：拖拽一步一撤、空操作不入栈、redo 被新改动截断', async (t) => {
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过编辑器撤销验证');
    return;
  }

  const collected = {};
  let ready = false;

  const outcome = await runProbe({
    browser,
    url: server.url,
    globalName: '__ed',
    cacheName: 'editor-history-undo',
    windowSize: '900,700',
    onStage: async (stage, send) => {
      if (stage !== 'ready' || ready) return;
      ready = true;

      const ids = await evaluate(send, 'window.__ed.ids');
      const geom = await evaluate(send, 'window.__ed.canvasRect()');
      collected.geom = { rect: geom, ids };
      const { uv } = ids;

      // ① 刚开机：撤销栈是空的，undo() 该返回 false 而不是抛
      collected.hist0 = await evaluate(send, 'window.__ed.hist()');
      collected.undoOnEmpty = await evaluate(send, 'window.__ed.undo()');

      // ② 真鼠标拖节点 → 应该正好产生 1 步
      const header = await evaluate(send, `window.__ed.headerPos(${JSON.stringify(uv)})`);
      collected.posBefore = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(uv)})`);
      await drag(send, header, { x: header.x + 90, y: header.y + 50 });
      collected.posAfterDrag = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(uv)})`);
      collected.histAfterDrag = await evaluate(send, 'window.__ed.hist()');
      collected.undoTitle = await evaluate(send, 'window.__ed.undoTitle()');

      // ③ 点一下节点（不拖）：改的是选择，不该占一步撤销
      const header2 = await evaluate(send, `window.__ed.headerPos(${JSON.stringify(uv)})`);
      await drag(send, header2, { x: header2.x, y: header2.y }, { steps: 2 });
      collected.histAfterClick = await evaluate(send, 'window.__ed.hist()');

      // ④ 撤销 → 位置回到拖动前
      collected.undo1 = await evaluate(send, 'window.__ed.undo()');
      collected.posAfterUndo = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(uv)})`);
      collected.histAfterUndo = await evaluate(send, 'window.__ed.hist()');

      // ⑤ 重做 → 又回到拖完的位置
      collected.redo1 = await evaluate(send, 'window.__ed.redo()');
      collected.posAfterRedo = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(uv)})`);
      collected.histAfterRedo = await evaluate(send, 'window.__ed.hist()');

      // ⑥ 撤销之后再做新改动：redo 栈必须被清空（老分支不该还能重做回来）
      await evaluate(send, 'window.__ed.undo()');
      collected.histBeforeNewEdit = await evaluate(send, 'window.__ed.hist()');
      const newId = await evaluate(send, `window.__ed.addNode('palette', 420, 260)`);
      collected.newNodeId = newId;
      collected.histAfterNewEdit = await evaluate(send, 'window.__ed.hist()');

      // ⑦ 新增节点也能撤掉
      await evaluate(send, 'window.__ed.undo()');
      collected.nodesAfterUndoAdd = await evaluate(send, 'window.__ed.snapshot()');

      collected.events = await evaluate(send, 'window.__ed.events');
      await send('Runtime.evaluate', {
        expression: `window.__ed.results = ${JSON.stringify(collected)}; window.__ed.stage = 'done'; true`,
        returnByValue: true,
      });
    },
  });

  if (!outcome.ok) {
    if (isEnvironmentBlocked(outcome)) {
      console.log(`[history] 环境限制，跳过：${outcome.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${outcome.reason}），跳过撤销验证`);
      return;
    }
    assert.fail(`浏览器流程失败：${outcome.reason}\n控制台：\n${(outcome.consoleErrors ?? []).join('\n')}`);
  }

  const ed = outcome.value;
  if (ed.stage === 'failed') assert.fail(`探针失败：\n${(ed.errors ?? []).join('\n')}`);
  assert.ok(ed.results, '探针没有回传结果（stage 可能没到 ready）');
  const r = ed.results;
  const uvId = r.geom.ids.uv;

  console.log('[history] 拖前位置 =', JSON.stringify(r.posBefore));
  console.log('[history] 拖后位置 =', JSON.stringify(r.posAfterDrag));
  console.log('[history] 拖后撤销栈 =', JSON.stringify(r.histAfterDrag));
  console.log('[history] 点一下后撤销栈 =', JSON.stringify(r.histAfterClick));
  console.log('[history] 撤销后 =', JSON.stringify(r.posAfterUndo), JSON.stringify(r.histAfterUndo));
  console.log('[history] 重做后 =', JSON.stringify(r.posAfterRedo), JSON.stringify(r.histAfterRedo));
  console.log('[history] 新改动后 =', JSON.stringify(r.histAfterNewEdit));
  console.log('[history] 事件 =', JSON.stringify(r.events));

  // 画布得有尺寸，否则所有坐标都是 0，这测试等于没跑
  assert.ok(r.geom.rect.width > 100, `画布宽度太小：${r.geom.rect.width}`);
  assert.ok(r.geom.rect.height > 100, `画布高度太小：${r.geom.rect.height}`);

  // ① 空栈
  assert.equal(r.hist0.canUndo, false, '刚开机不该能撤销');
  assert.equal(r.hist0.canRedo, false, '刚开机不该能重做');
  assert.equal(r.undoOnEmpty, false, '空栈撤销该返回 false');

  // ② 拖一次 = 正好一步
  assert.equal(r.posAfterDrag.x - r.posBefore.x, 90, `横向位移不对：${r.posBefore.x} → ${r.posAfterDrag.x}`);
  assert.equal(r.posAfterDrag.y - r.posBefore.y, 50, `纵向位移不对：${r.posBefore.y} → ${r.posAfterDrag.y}`);
  assert.equal(r.histAfterDrag.past, 1, `拖一次该只留一步：${JSON.stringify(r.histAfterDrag)}`);
  assert.equal(r.histAfterDrag.undoLabel, '移动节点', `撤销标签不对：${r.histAfterDrag.undoLabel}`);
  assert.match(String(r.undoTitle), /撤销：移动节点/, `按钮 title 该说明撤什么：${r.undoTitle}`);

  // ③ 只点不拖：不该占一步
  assert.equal(
    r.histAfterClick.past,
    1,
    `「点一下不改图」不该入栈：${JSON.stringify(r.histAfterClick)}`,
  );

  // ④ 撤销：位置精确回退
  assert.equal(r.undo1, true, '有历史时撤销该返回 true');
  assert.deepEqual(r.posAfterUndo, r.posBefore, `撤销后位置该回到拖前：${JSON.stringify(r.posAfterUndo)}`);
  assert.equal(r.histAfterUndo.past, 0, '撤销后 past 该空了');
  assert.equal(r.histAfterUndo.future, 1, '撤销后 future 该有一步');

  // ⑤ 重做：位置精确前进
  assert.equal(r.redo1, true, '有 future 时重做该返回 true');
  assert.deepEqual(r.posAfterRedo, r.posAfterDrag, `重做后位置该回到拖后：${JSON.stringify(r.posAfterRedo)}`);
  assert.equal(r.histAfterRedo.past, 1, '重做后 past 该回填');

  // ⑥ 撤销后新改动 → future 清空
  assert.equal(r.histBeforeNewEdit.future, 1, '撤销后该留着 future');
  assert.equal(r.histAfterNewEdit.future, 0, '新改动该把 redo 分支截断');
  assert.ok(r.histAfterNewEdit.past >= 1, '新改动该入栈');

  // ⑦ 新增节点撤销后，节点真的没了
  assert.ok(
    !r.nodesAfterUndoAdd.nodes.some((n) => n.id === r.newNodeId),
    `撤销后新增的节点该消失：${JSON.stringify(r.nodesAfterUndoAdd.nodes.map((n) => n.type))}`,
  );

  assert.deepEqual(ed.errors ?? [], [], `页面里有异常：${JSON.stringify(ed.errors)}`);
});

test('分组框/注释：拖框带节点、缩放、标题、删除可撤销、且不影响代码生成', async (t) => {
  if (!browser) {
    t.skip('找不到 Chromium 内核浏览器，跳过分组框验证');
    return;
  }

  const collected = {};
  let ready = false;

  const outcome = await runProbe({
    browser,
    url: server.url,
    globalName: '__ed',
    cacheName: 'editor-history-frames',
    windowSize: '900,700',
    onStage: async (stage, send) => {
      if (stage !== 'ready' || ready) return;
      ready = true;

      const ids = await evaluate(send, 'window.__ed.ids');
      const uv = ids.uv;

      // 准备：在分组框将要覆盖的区域里放一个节点，用来验证「拖框带节点」
      const insideId = await evaluate(send, `window.__ed.addNode('palette', 40, 120)`);
      collected.insideId = insideId;
      collected.insideBefore = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(insideId)})`);

      // ① 新建分组框：中心放在 (160,170) → 框体 (-20,60)-(340,280)
      //    刻意让标题栏（y 60~82）**不压**任何节点，否则命中测试会先给节点
      const frameId = await evaluate(send, 'window.__ed.addFrame("frame", 160, 170)');
      collected.frameId = frameId;
      collected.framesAfterAdd = await evaluate(send, 'window.__ed.frames()');
      collected.persistedAfterAdd = await evaluate(send, 'window.__ed.persistedFrames()');
      collected.codeBeforeFrames = await evaluate(send, 'window.__ed.compileCode()');
      collected.histAfterAddFrame = await evaluate(send, 'window.__ed.hist()');

      // ② 命中测试：标题栏该命中 frame-header；框体内部该**穿透**（留给框选）
      const headerPos = await evaluate(send, `window.__ed.frameHeaderPos(${JSON.stringify(frameId)})`);
      const bodyPos = await evaluate(send, `window.__ed.frameBodyPos(${JSON.stringify(frameId)})`);
      collected.hitHeader = await evaluate(send, `window.__ed.hitAt(${headerPos.x}, ${headerPos.y})`);
      collected.hitBody = await evaluate(send, `window.__ed.hitAt(${bodyPos.x}, ${bodyPos.y})`);

      // ③ 拖标题栏 → 框和框里的节点一起走
      await drag(send, headerPos, { x: headerPos.x + 70, y: headerPos.y + 40 });
      collected.framesAfterDrag = await evaluate(send, 'window.__ed.frames()');
      collected.insideAfterDrag = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(insideId)})`);
      collected.histAfterDrag = await evaluate(send, 'window.__ed.hist()');

      // ④ 撤销 → 框和节点都回原位
      await evaluate(send, 'window.__ed.undo()');
      collected.framesAfterUndo = await evaluate(send, 'window.__ed.frames()');
      collected.insideAfterUndo = await evaluate(send, `window.__ed.nodePos(${JSON.stringify(insideId)})`);
      await evaluate(send, 'window.__ed.redo()');   // 回到拖完的状态，方便接着测缩放

      // ⑤ 缩放：先选中（把手只在选中时出现），再拖右下角
      await evaluate(send, `window.__ed.selectFrame(${JSON.stringify(frameId)})`);
      const handlePos = await evaluate(send, `window.__ed.frameHandlePos(${JSON.stringify(frameId)})`);
      collected.hitHandle = await evaluate(send, `window.__ed.hitAt(${handlePos.x}, ${handlePos.y})`);
      const beforeResize = await evaluate(send, 'window.__ed.frames()');
      collected.sizeBeforeResize = { w: beforeResize[0].w, h: beforeResize[0].h };
      await drag(send, handlePos, { x: handlePos.x + 60, y: handlePos.y + 40 });
      const afterResize = await evaluate(send, 'window.__ed.frames()');
      collected.sizeAfterResize = { w: afterResize[0].w, h: afterResize[0].h };
      await evaluate(send, 'window.__ed.undo()');
      const undoneResize = await evaluate(send, 'window.__ed.frames()');
      collected.sizeAfterUndo = { w: undoneResize[0].w, h: undoneResize[0].h };

      // ⑥ 改标题 + 撤销
      await evaluate(send, `window.__ed.setFrameTitle(${JSON.stringify(frameId)}, '光照部分')`);
      collected.titleAfterEdit = (await evaluate(send, 'window.__ed.frames()'))[0].title;
      await evaluate(send, 'window.__ed.undo()');
      collected.titleAfterUndo = (await evaluate(send, 'window.__ed.frames()'))[0].title;

      // ⑦ 选中框内节点（分组框最有用的动作）
      collected.selectedInFrame = await evaluate(send, `window.__ed.selectNodesInFrame(${JSON.stringify(frameId)})`);

      // ⑧ 注释：新建 → 落盘 → 撤销
      const noteId = await evaluate(send, 'window.__ed.addFrame("note", 460, 380)');
      collected.noteId = noteId;
      await evaluate(send, 'window.__ed.closeInlineEdit()');   // 别让就地编辑框抢走后面的按键
      collected.framesWithNote = await evaluate(send, 'window.__ed.frames()');
      collected.persistedWithNote = await evaluate(send, 'window.__ed.persistedFrames()');
      await evaluate(send, 'window.__ed.undo()');
      collected.framesAfterUndoNote = await evaluate(send, 'window.__ed.frames()');

      // ⑨ 删除分组框 → 撤销要能连标题/配色一起复活
      await evaluate(send, `window.__ed.deleteFrame(${JSON.stringify(frameId)})`);
      collected.framesAfterDelete = await evaluate(send, 'window.__ed.frames()');
      await evaluate(send, 'window.__ed.undo()');
      collected.framesAfterUndoDelete = await evaluate(send, 'window.__ed.frames()');

      // ⑩ 装饰件不该进代码生成
      collected.codeAfterFrames = await evaluate(send, 'window.__ed.compileCode()');

      // ⑪ 空格键回归：按一下再松开，必须清掉「平移模式」
      await evaluate(send, 'window.__ed.closeInlineEdit()');
      await send('Runtime.evaluate', { expression: 'document.querySelector(".swb-editor__canvas").focus(); true' });
      collected.spaceBefore = await evaluate(send, 'window.__ed.spaceDown()');
      await tapKey(send, ' ', { code: 'Space', vk: 32, text: ' ' });
      collected.spaceAfter = await evaluate(send, 'window.__ed.spaceDown()');

      await send('Runtime.evaluate', {
        expression: `window.__ed.results = ${JSON.stringify(collected)}; window.__ed.stage = 'done'; true`,
        returnByValue: true,
      });
    },
  });

  if (!outcome.ok) {
    if (isEnvironmentBlocked(outcome)) {
      console.log(`[frames] 环境限制，跳过：${outcome.reason}`);
      t.skip(`本机沙箱跑不了无头浏览器（${outcome.reason}），跳过分组框验证`);
      return;
    }
    assert.fail(`浏览器流程失败：${outcome.reason}\n控制台：\n${(outcome.consoleErrors ?? []).join('\n')}`);
  }

  const ed = outcome.value;
  if (ed.stage === 'failed') assert.fail(`探针失败：\n${(ed.errors ?? []).join('\n')}`);
  assert.ok(ed.results, '探针没有回传结果（stage 可能没到 ready）');
  const r = ed.results;

  console.log('[frames] 新建后 =', JSON.stringify(r.framesAfterAdd));
  console.log('[frames] 落盘 =', JSON.stringify(r.persistedAfterAdd));
  console.log('[frames] hitHeader =', JSON.stringify(r.hitHeader));
  console.log('[frames] hitBody   =', JSON.stringify(r.hitBody));
  console.log('[frames] hitHandle =', JSON.stringify(r.hitHandle));
  console.log('[frames] 拖后 =', JSON.stringify(r.framesAfterDrag), '框内节点 =', JSON.stringify(r.insideAfterDrag));
  console.log('[frames] 缩放 =', JSON.stringify(r.sizeBeforeResize), '→', JSON.stringify(r.sizeAfterResize), '撤销后', JSON.stringify(r.sizeAfterUndo));
  console.log('[frames] 标题 =', JSON.stringify(r.titleAfterEdit), '撤销后', JSON.stringify(r.titleAfterUndo));

  // ① 新建后：模型里有、落盘里也有（重开材质才不会丢）
  assert.equal(r.framesAfterAdd.length, 1, `该有 1 个分组框：${JSON.stringify(r.framesAfterAdd)}`);
  assert.equal(r.framesAfterAdd[0].kind, 'frame', '类型该是 frame');
  assert.equal(r.framesAfterAdd[0].id, r.frameId, 'id 该对得上');
  assert.equal(r.persistedAfterAdd.length, 1, `分组框该进 passes[].frames：${JSON.stringify(r.persistedAfterAdd)}`);
  assert.equal(r.persistedAfterAdd[0].id, r.frameId, '落盘的 id 该对得上');
  assert.ok(r.histAfterAddFrame.past >= 1, '新建分组框该占一步撤销');

  // ② 命中规则：标题栏命中框，框体穿透
  assert.equal(r.hitHeader.kind, 'frame-header', `标题栏该命中 frame-header：${JSON.stringify(r.hitHeader)}`);
  assert.equal(r.hitBody.kind, null, `框体内部不该被框挡住（要留给框选）：${JSON.stringify(r.hitBody)}`);

  // ③ 拖标题栏：框走 (+70,+40)，框里的节点同步走
  const dragged = r.framesAfterDrag[0];
  const origin = r.framesAfterAdd[0];
  assert.equal(dragged.x - origin.x, 70, `框横向位移不对：${origin.x} → ${dragged.x}`);
  assert.equal(dragged.y - origin.y, 40, `框纵向位移不对：${origin.y} → ${dragged.y}`);
  assert.equal(
    r.insideAfterDrag.x - r.insideBefore.x,
    70,
    `框内节点该跟着走：${JSON.stringify(r.insideBefore)} → ${JSON.stringify(r.insideAfterDrag)}`,
  );
  assert.equal(r.insideAfterDrag.y - r.insideBefore.y, 40, '框内节点纵向该跟着走');
  assert.equal(r.histAfterDrag.past, r.histAfterAddFrame.past + 1, '拖框该只占一步');

  // ④ 撤销：框和节点都回原位
  assert.equal(r.framesAfterUndo[0].x, origin.x, `撤销后框该回原位：${r.framesAfterUndo[0].x}`);
  assert.equal(r.framesAfterUndo[0].y, origin.y, '撤销后框该回原位（纵）');
  assert.deepEqual(r.insideAfterUndo, r.insideBefore, '撤销后框内节点该回原位');

  // ⑤ 缩放
  assert.equal(r.hitHandle.kind, 'frame-resize', `把手该命中 frame-resize：${JSON.stringify(r.hitHandle)}`);
  assert.equal(r.sizeAfterResize.w - r.sizeBeforeResize.w, 60, `宽度增量不对：${JSON.stringify(r.sizeAfterResize)}`);
  assert.equal(r.sizeAfterResize.h - r.sizeBeforeResize.h, 40, `高度增量不对：${JSON.stringify(r.sizeAfterResize)}`);
  assert.deepEqual(r.sizeAfterUndo, r.sizeBeforeResize, `缩放该能撤销：${JSON.stringify(r.sizeAfterUndo)}`);

  // ⑥ 标题可改可撤
  assert.equal(r.titleAfterEdit, '光照部分', `标题没改上：${r.titleAfterEdit}`);
  assert.notEqual(r.titleAfterUndo, '光照部分', `撤销后标题该退回去：${r.titleAfterUndo}`);

  // ⑦ 选中框内节点
  assert.ok(r.selectedInFrame >= 1, `框内该能选中节点，实际 ${r.selectedInFrame}`);

  // ⑧ 注释
  assert.equal(r.framesWithNote.length, 2, `该有 1 框 + 1 注释：${JSON.stringify(r.framesWithNote.map((f) => f.kind))}`);
  assert.equal(r.framesWithNote.find((f) => f.id === r.noteId).kind, 'note', '注释 kind 该是 note');
  assert.equal(r.persistedWithNote.length, 2, `注释也该落盘：${JSON.stringify(r.persistedWithNote)}`);
  assert.ok(
    !r.framesAfterUndoNote.some((f) => f.id === r.noteId),
    `撤销后注释该消失：${JSON.stringify(r.framesAfterUndoNote)}`,
  );

  // ⑨ 删框可撤销（且要连标题一起回来）
  assert.ok(!r.framesAfterDelete.some((f) => f.id === r.frameId), '删除后框该没了');
  const revived = r.framesAfterUndoDelete.find((f) => f.id === r.frameId);
  assert.ok(revived, `撤销删除后框该复活：${JSON.stringify(r.framesAfterUndoDelete)}`);
  assert.equal(revived.title, r.titleAfterUndo, '复活的框该带着原来的标题');

  // ⑩ 装饰件不进代码生成：加框前后 GLSL 必须一字不差
  assert.equal(
    r.codeAfterFrames,
    r.codeBeforeFrames,
    '分组框/注释不该影响生成的 GLSL —— 它们是编辑器层的装饰件，不是图节点',
  );

  // ⑪ 空格键回归：按下后进入平移模式，松开必须退出
  assert.equal(r.spaceBefore, false, '初始不该处于平移模式');
  assert.equal(r.spaceAfter, false, '松开空格后必须退出平移模式（否则左键永远在平移、再也选不中节点）');

  assert.deepEqual(ed.errors ?? [], [], `页面里有异常：${JSON.stringify(ed.errors)}`);
});
