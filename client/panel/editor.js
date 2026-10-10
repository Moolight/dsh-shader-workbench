/**
 * 可视化节点编辑器（canvas 自绘，零依赖）。
 *
 * 为什么不引 Rete.js：工作台的核心是「连节点 → 生成 GLSL → 实时预览」，
 * 节点图本身不大。自绘能精确控制渲染节奏、包体和样式，
 * 也不用把一整套依赖树塞进 DSH 插件里。
 *
 * 交互：
 *   左键拖节点体移动 / 拖端口连线 / 空白处框选
 *   中键或空格 + 左键平移，滚轮缩放
 *   Delete 删除选中，Ctrl+D 复制选中
 *   右键出菜单（节点：复制/删除/断开；空白：显示全部节点库）
 *
 * @module dsh-shader-workbench/client/panel/editor
 */

import { button, empty, h, menuItem, popup } from './dom.js';
import { canConnect, conversionKind } from '../../shared/graph.js';
import { NODE_LIBRARY, getNodeDef, resolvePortType, resolvePorts } from '../../shared/nodes.js';

/** 节点尺寸常量。 */
const NODE_WIDTH = 168;
const HEADER_HEIGHT = 26;
const PORT_ROW_HEIGHT = 18;
const PORT_RADIUS = 5;
const BODY_PADDING = 8;

/** 各端口类型的配色。 */
const PORT_COLORS = {
  float: '#9aa4b2',
  vec2: '#4ade80',
  vec3: '#fbbf24',
  vec4: '#f472b6',
};

/** 缩放范围。 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

/**
 * 算一个节点的排版尺寸。
 * @param {object} node
 * @returns {{width:number,height:number,inputs:object[],outputs:object[]}}
 */
export function measureNode(node) {
  const def = getNodeDef(node.type);
  if (!def) return { width: NODE_WIDTH, height: HEADER_HEIGHT, inputs: [], outputs: [] };
  let inputs = def.inputs;
  let outputs = def.outputs;
  if (typeof def.dynamicOut === 'function') outputs = def.dynamicOut(node.params ?? {}, outputs);
  const rows = Math.max(inputs.length, outputs.length);
  return {
    width: NODE_WIDTH,
    height: HEADER_HEIGHT + BODY_PADDING * 2 + rows * PORT_ROW_HEIGHT,
    inputs,
    outputs,
  };
}

/**
 * 某输入端口的画布坐标（相对节点左上角）。
 * @param {number} index
 * @returns {{x:number,y:number}}
 */
function inputPortPos(index) {
  return { x: 0, y: HEADER_HEIGHT + BODY_PADDING + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2 };
}

/**
 * 某输出端口的画布坐标（相对节点左上角）。
 * @param {object} metrics
 * @param {number} index
 * @returns {{x:number,y:number}}
 */
function outputPortPos(metrics, index) {
  return {
    x: metrics.width,
    y: HEADER_HEIGHT + BODY_PADDING + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
  };
}

/**
 * 节点编辑器。
 */
export class NodeEditor {
  /**
   * @param {object} opts
   * @param {object} opts.graph 初始图
   * @param {(graph:object, meta:object) => void} opts.onChange 图变更回调
   * @param {(pass: string) => void} [opts.onPassChange]
   * @param {string} [opts.pass] 当前正在编辑的 Pass
   */
  constructor(opts = {}) {
    this.graph = opts.graph ?? { nodes: [], edges: [], passes: [] };
    this.pass = opts.pass ?? 'image';
    this.onChange = opts.onChange ?? (() => {});
    this.onPassChange = opts.onPassChange ?? (() => {});

    this.view = { x: 40, y: 40, zoom: 1 };
    this.selection = new Set();
    /** 节点库折叠的分类（多级分类：category 里的 / 分层） */
    this.collapsedCats = new Set();
    this.hover = null;
    this.drag = null;
    this.pointer = { x: 0, y: 0 };

    this.root = this._build();
    this.canvas = this.root.querySelector('.swb-editor__canvas');
    this.ctx = this.canvas.getContext('2d');
    this._bindEvents();
    this._resizeObserver = null;
    this._observeResize();
    this.invalidate();
  }

  /**
   * 更新图（外部改了数据源时调用）。
   * @param {object} graph
   * @param {string} [pass]
   */
  setGraph(graph, pass = this.pass) {
    this.graph = graph;
    this.pass = pass;
    // 丢掉已经不存在的选中项
    const ids = new Set(this.visibleNodes().map((n) => n.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    this._syncPassTabs();
    this.invalidate();
  }

  /** 当前 Pass 里的节点。 */
  visibleNodes() {
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (!pass || !Array.isArray(pass.graph)) return this.graph.nodes ?? [];
    const ids = new Set(pass.graph);
    return (this.graph.nodes ?? []).filter((n) => ids.has(n.id));
  }

  /** 当前 Pass 里的连线。 */
  visibleEdges() {
    const ids = new Set(this.visibleNodes().map((n) => n.id));
    return (this.graph.edges ?? []).filter((e) => ids.has(e.from.node) && ids.has(e.to.node));
  }

  /** 图变了：通知外部 + 重画。 */
  _emit(meta = {}) {
    this.onChange(this.graph, { pass: this.pass, ...meta });
    this.invalidate();
  }

  // ─────────────────────── 结构 ───────────────────────

  /** 建 DOM。 */
  _build() {
    const passTabs = h('div.swb-editor__tabs');
    const status = h('div.swb-editor__status');
    const canvas = h('canvas.swb-editor__canvas', { tabindex: '0' });
    const libraryHost = h('div.swb-editor__library');
    const librarySearch = h('input.swb-input', {
      type: 'search',
      placeholder: '搜索节点…',
      on: { input: (e) => this._renderLibrary(e.target.value) },
    });

    const root = h('div.swb-editor', {}, [
      h('div.swb-editor__toolbar', {}, [
        passTabs,
        h('span.swb-toolbar__spacer'),
        status,
      ]),
      h('div.swb-editor__main', {}, [
        h('div.swb-editor__side', {}, [
          h('div.swb-editor__side-head', {}, [
            librarySearch,
            h('button.swb-btn.swb-btn--ghost', {
              type: 'button',
              text: '↻',
              title: '同步节点库（用户节点在 <工作区>/library/nodes/，改完不用重启）',
              on: { click: () => this.onReloadNodes?.() },
            }),
          ]),
          libraryHost,
        ]),
        h('div.swb-editor__stage', {}, [canvas]),
      ]),
    ]);

    this._passTabs = passTabs;
    this._status = status;
    this._libraryHost = libraryHost;
    this._librarySearch = librarySearch;
    return root;
  }

  /** 重量级：重建 Pass 标签。 */
  _syncPassTabs() {
    const passes = (this.graph.passes ?? []).map((p) => p.name);
    const list = passes.length > 0 ? passes : ['image'];
    this._passTabs.replaceChildren(
      ...list.map((name) =>
        h('button.swb-tab', {
          class: name === this.pass ? 'swb-tab--active' : undefined,
          type: 'button',
          text: name,
          title: `编辑 ${name} Pass`,
          on: {
            click: () => {
              this.pass = name;
              this.selection.clear();
              this._syncPassTabs();
              this.onPassChange(name);
              this.invalidate();
            },
          },
        }),
      ),
      h('button.swb-tab.swb-tab--add', {
        type: 'button',
        text: '+ Buffer',
        title: '新增一个 Buffer Pass（A→D，最多四个）',
        on: { click: () => this._addBufferPass() },
      }),
    );
  }

  /** 新增 Buffer Pass。 */
  _addBufferPass() {
    const existing = new Set((this.graph.passes ?? []).map((p) => p.name));
    const next = ['BufferA', 'BufferB', 'BufferC', 'BufferD'].find((n) => !existing.has(n));
    if (!next) {
      this._setStatus('Buffer 已经用满（A–D）', 'error');
      return;
    }
    this.graph.passes = [...(this.graph.passes ?? []), { name: next, graph: [] }];
    this.pass = next;
    this.selection.clear();
    this._syncPassTabs();
    this._emit({ reason: 'add-pass' });
  }

  /**
   * 渲染左侧节点库（公开入口，供外部在 DOM 就绪后显式调用）。
   * @param {string} [filter]
   */
  renderLibrary(filter = '') {
    this.libraryFilter = filter;
    this._renderLibrary(filter);
  }

  /**
   * 重建 Pass 标签（公开入口）。
   */
  syncPassTabs() {
    this._syncPassTabs();
  }

  /** 节点库的一行。 */
  _libItem(node) {
    return h(
      'button.swb-lib-item',
      {
        type: 'button',
        title: node.doc || node.title,
        draggable: 'true',
        on: {
          click: () => this.addNode(node.type),
          dragstart: (e) => {
            e.dataTransfer?.setData('text/swb-node', node.type);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
          },
        },
      },
      [
        h('span.swb-lib-item__title', { text: node.title }),
        h('span.swb-lib-item__type', { text: node.type }),
        // 用户节点标一下来源：它来自 <工作区>/library/nodes/，不是插件自带的
        node.userDefined === true ? h('span.swb-lib-item__badge', { text: '用户' }) : null,
      ],
    );
  }

  /**
   * 重建左侧节点库（**多级分类**）。
   *
   * 分类名可以带斜杠：`category: "例程/傅里叶"` → 面板上就是「例程 → 傅里叶」两级。
   * 层级是纯客户端推出来的，节点定义那边只要写斜杠，不用改任何接口。
   * 默认全展开（别一上来就把东西藏起来），点标题折叠。
   *
   * @param {string} [filter]
   */
  _renderLibrary(filter = '') {
    const needle = String(filter ?? '').trim().toLowerCase();
    /** 分类树：每层一个 Map（保持节点库里的出现顺序）。 */
    const root = { children: new Map(), nodes: [] };
    for (const node of NODE_LIBRARY) {
      if (needle !== '') {
        const hay = `${node.type} ${node.title} ${node.category} ${node.doc ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const parts = String(node.category ?? '未分类')
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
      let level = root;
      for (const part of parts) {
        if (!level.children.has(part)) level.children.set(part, { name: part, children: new Map(), nodes: [] });
        level = level.children.get(part);
      }
      level.nodes.push(node);
    }

    const sections = [];
    /** 递归渲染一层；`path` 是折叠状态的键。 */
    const emit = (level, depth, path) => {
      for (const [name, child] of level.children) {
        const key = path ? `${path}/${name}` : name;
        const open = !this.collapsedCats.has(key);
        sections.push(
          h('div.swb-lib-group', { style: `margin-left:${depth * 10}px` }, [
            h('div.swb-lib-group__title.swb-lib-group__title--fold', {
              text: `${open ? '▾' : '▸'} ${name}`,
              on: {
                click: () => {
                  if (open) this.collapsedCats.add(key);
                  else this.collapsedCats.delete(key);
                  this._renderLibrary(filter);
                },
              },
            }),
            ...(open ? child.nodes.map((node) => this._libItem(node)) : []),
          ]),
        );
        if (open) emit(child, depth + 1, key);
      }
      if (depth === 0 && level.nodes.length > 0) {
        sections.push(h('div.swb-lib-group', {}, level.nodes.map((node) => this._libItem(node))));
      }
    };
    emit(root, 0, '');

    if (sections.length === 0) {
      this._libraryHost.replaceChildren(empty('没有匹配的节点'));
      return;
    }
    this._libraryHost.replaceChildren(...sections);
  }

  // ─────────────────────── 尺寸 / 坐标 ───────────────────────

  /** 监听尺寸变化。 */
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => this.invalidate());
    this._resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
  }

  /** 画布 CSS 尺寸（逻辑像素）。 */
  _size() {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth || this.canvas.clientWidth || 800;
    const height = parent?.clientHeight || this.canvas.clientHeight || 500;
    return { width, height };
  }

  /** 屏幕坐标 → 世界坐标。 */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.zoom,
      y: (clientY - rect.top - this.view.y) / this.view.zoom,
    };
  }

  /** 世界坐标 → 屏幕坐标（画布内）。 */
  toScreen(x, y) {
    return { x: x * this.view.zoom + this.view.x, y: y * this.view.zoom + this.view.y };
  }

  /**
   * 取某节点某端口在**视口坐标系**下的位置。
   *
   * 「视口坐标」= CDP / `elementFromPoint` 用的那套坐标系，也就是
   * 画布内坐标再加上画布自身在页面里的偏移。做外部拖拽（自动化、手柄吸附）时需要它。
   *
   * @param {string} nodeId
   * @param {'in'|'out'} dir
   * @param {string} portId
   * @returns {{x:number,y:number}|null} 找不到节点返回 null
   */
  portPosition(nodeId, dir, portId) {
    const node = this.visibleNodes().find((n) => n.id === nodeId);
    if (!node) return null;
    const metrics = measureNode(node);
    const ports = dir === 'in' ? metrics.inputs : metrics.outputs;
    const index = Math.max(0, ports.findIndex((p) => p.id === portId));
    const local = dir === 'in' ? inputPortPos(index) : outputPortPos(metrics, index);
    const screen = this.toScreen(node.x + local.x, node.y + local.y);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }

  /**
   * 取某节点标题栏的中心点在视口坐标系下的位置（拖节点时按住这里最稳）。
   * @param {string} nodeId
   * @returns {{x:number,y:number}|null}
   */
  nodeHeaderPosition(nodeId) {
    const node = this.visibleNodes().find((n) => n.id === nodeId);
    if (!node) return null;
    const metrics = measureNode(node);
    const screen = this.toScreen(node.x + metrics.width / 2, node.y + HEADER_HEIGHT / 2);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + screen.x, y: rect.top + screen.y };
  }

  /** 请求重画。 */
  invalidate() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this.draw();
    });
  }

  // ─────────────────────── 绘制 ───────────────────────

  /** 画一帧。 */
  draw() {
    const ctx = this.ctx;
    const { width, height } = this._size();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // 背景网格
    this._drawGrid(ctx, width, height);

    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.zoom, this.view.zoom);

    const nodes = this.visibleNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // 连线（在节点下面）
    for (const edge of this.visibleEdges()) {
      this._drawEdge(ctx, edge, byId);
    }
    // 正在拖的那根
    if (this.drag?.kind === 'edge') {
      this._drawPendingEdge(ctx);
    }

    // 节点
    for (const node of nodes) {
      this._drawNode(ctx, node);
    }

    ctx.restore();

    // 状态栏
    this._status.textContent = `${nodes.length} 节点 / ${this.visibleEdges().length} 连线 · 缩放 ${(this.view.zoom * 100).toFixed(0)}%${this.selection.size > 0 ? ` · 选中 ${this.selection.size}` : ''}`;
  }

  /** 网格背景。 */
  _drawGrid(ctx, width, height) {
    const size = 24 * this.view.zoom;
    if (size < 6) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(128, 140, 160, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ox = this.view.x % size;
    const oy = this.view.y % size;
    for (let x = ox; x < width; x += size) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = oy; y < height; y += size) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 画一个节点。 */
  _drawNode(ctx, node) {
    const metrics = measureNode(node);
    const selected = this.selection.has(node.id);
    const def = getNodeDef(node.type);

    ctx.save();
    ctx.translate(node.x, node.y);

    // 圆角矩形底
    const radius = 8;
    roundRect(ctx, 0, 0, metrics.width, metrics.height, radius);
    ctx.fillStyle = selected ? 'rgba(56, 108, 200, 0.28)' : 'rgba(28, 32, 40, 0.94)';
    ctx.fill();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#5b9bff' : 'rgba(255,255,255,0.16)';
    ctx.stroke();

    // 标题栏
    ctx.save();
    roundRect(ctx, 0, 0, metrics.width, HEADER_HEIGHT, radius);
    ctx.clip();
    ctx.fillStyle = categoryColor(def?.category);
    ctx.fillRect(0, 0, metrics.width, HEADER_HEIGHT);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(clipText(ctx, def?.title ?? node.type, metrics.width - 16), 8, HEADER_HEIGHT / 2 + 0.5);

    // 端口行
    for (let i = 0; i < metrics.inputs.length; i++) {
      const port = metrics.inputs[i];
      const pos = inputPortPos(i);
      const connected = this._isInputConnected(node.id, port.id);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, PORT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = connected ? PORT_COLORS[port.type] : 'rgba(20,22,26,1)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PORT_COLORS[port.type] ?? '#9aa4b2';
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(clipText(ctx, port.label ?? port.id, metrics.width / 2 - 18), 10, pos.y + 0.5);
    }
    for (let i = 0; i < metrics.outputs.length; i++) {
      const port = metrics.outputs[i];
      const pos = outputPortPos(metrics, i);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, PORT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = PORT_COLORS[port.type] ?? '#9aa4b2';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      const label = port.label ?? port.id;
      ctx.fillText(label, metrics.width - 10 - ctx.measureText(label).width, pos.y + 0.5);
    }

    // 参数摘要（有 custom 表达式时直接显示，省得点开）
    const expr = node.params?.expr;
    if (node.type === 'custom' && typeof expr === 'string' && expr.trim() !== '') {
      ctx.fillStyle = 'rgba(140, 200, 255, 0.8)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(clipText(ctx, expr.replace(/\s+/g, ' '), metrics.width - 16), 8, metrics.height - 6);
    }

    ctx.restore();
  }

  /** 画一条连线。 */
  _drawEdge(ctx, edge, byId) {
    const from = byId.get(edge.from.node);
    const to = byId.get(edge.to.node);
    if (!from || !to) return;
    const fromMetrics = measureNode(from);
    const toMetrics = measureNode(to);
    const a = outputPortPos(fromMetrics, fromMetrics.outputs.findIndex((p) => p.id === edge.from.port));
    const b = inputPortPos(Math.max(0, toMetrics.inputs.findIndex((p) => p.id === edge.to.port)));
    const p0 = { x: from.x + a.x, y: from.y + a.y };
    const p1 = { x: to.x + b.x, y: to.y + b.y };
    const type = fromMetrics.outputs.find((p) => p.id === edge.from.port)?.type ?? 'float';

    // 连线的颜色 = 上游端口类型，一眼看出数据流
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = PORT_COLORS[type] ?? '#9aa4b2';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    bezier(ctx, p0, p1);
    ctx.stroke();

    // 中点小箭头，表明方向
    const mid = bezierPoint(p0, p1, 0.5);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PORT_COLORS[type] ?? '#9aa4b2';
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 正在拖拽的那根虚线。 */
  _drawPendingEdge(ctx) {
    const from = this.drag.from;
    const a = { x: from.node.x + from.offset.x, y: from.node.y + from.offset.y };
    const b = this.pointer.world;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = this.drag.reject ? '#f87171' : PORT_COLORS[from.type] ?? '#9aa4b2';
    ctx.beginPath();
    bezier(ctx, a, b);
    ctx.stroke();
    ctx.restore();
  }

  /** 某输入端口是否已连线。 */
  _isInputConnected(nodeId, portId) {
    return (this.graph.edges ?? []).some((e) => e.to.node === nodeId && e.to.port === portId);
  }

  // ─────────────────────── 命中测试 ───────────────────────

  /**
   * 命中测试。
   * @param {number} worldX
   * @param {number} worldY
   * @returns {object|null}
   */
  hitTest(worldX, worldY) {
    const nodes = this.visibleNodes();
    // 反向遍历：后画的在上面
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const metrics = measureNode(node);
      const lx = worldX - node.x;
      const ly = worldY - node.y;
      if (lx < -PORT_RADIUS || ly < -PORT_RADIUS || lx > metrics.width + PORT_RADIUS || ly > metrics.height + PORT_RADIUS) {
        continue;
      }
      // 输入端口
      for (let k = 0; k < metrics.inputs.length; k++) {
        const pos = inputPortPos(k);
        if (Math.hypot(lx - pos.x, ly - pos.y) <= PORT_RADIUS + 4) {
          return { kind: 'port', node, port: metrics.inputs[k], dir: 'in', index: k };
        }
      }
      // 输出端口
      for (let k = 0; k < metrics.outputs.length; k++) {
        const pos = outputPortPos(metrics, k);
        if (Math.hypot(lx - pos.x, ly - pos.y) <= PORT_RADIUS + 4) {
          return { kind: 'port', node, port: metrics.outputs[k], dir: 'out', index: k };
        }
      }
      return { kind: 'node', node, metrics, offset: { x: lx, y: ly } };
    }
    return null;
  }

  // ─────────────────────── 事件 ───────────────────────

  /** 挂事件。 */
  _bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
    });
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this._onKeyDown(e));
    canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));

    // 从节点库拖进来
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('text/swb-node')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    canvas.addEventListener('drop', (e) => {
      const type = e.dataTransfer?.getData('text/swb-node');
      if (!type) return;
      e.preventDefault();
      const world = this.toWorld(e.clientX, e.clientY);
      this.addNode(type, world.x - NODE_WIDTH / 2, world.y - HEADER_HEIGHT / 2);
    });
  }

  /** @param {PointerEvent} e */
  _onPointerDown(e) {
    this.canvas.focus?.();
    const world = this.toWorld(e.clientX, e.clientY);
    const hit = this.hitTest(world.x, world.y);

    // 中键或空格 = 平移
    if (e.button === 1 || (e.button === 0 && this._spaceDown)) {
      this.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, originX: this.view.x, originY: this.view.y, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button === 2) {
      this._openContextMenu(e, hit);
      return;
    }

    if (e.button !== 0) return;

    if (!hit) {
      this.selection.clear();
      this.drag = { kind: 'marquee', origin: world, current: world };
      this.invalidate();
      return;
    }

    if (hit.kind === 'port') {
      if (hit.dir === 'in') {
        // 从输入端口往外拖 = 把这根线摘下来重接
        const existing = (this.graph.edges ?? []).find((ed) => ed.to.node === hit.node.id && ed.to.port === hit.port.id);
        if (existing) {
          const fromNode = this.visibleNodes().find((n) => n.id === existing.from.node);
          if (fromNode) {
            const fm = measureNode(fromNode);
            const idx = fm.outputs.findIndex((p) => p.id === existing.from.port);
            const offset = outputPortPos(fm, Math.max(0, idx));
            this.graph.edges = this.graph.edges.filter((ed) => ed.id !== existing.id);
            this.drag = {
              kind: 'edge',
              from: { node: fromNode, port: fm.outputs[Math.max(0, idx)], type: fm.outputs[Math.max(0, idx)]?.type, offset },
              reject: false,
            };
            this.canvas.setPointerCapture(e.pointerId);
            this._emit({ reason: 'detach-edge' });
            return;
          }
        }
        return;
      }
      this.drag = {
        kind: 'edge',
        from: { node: hit.node, port: hit.port, type: hit.port.type, offset: outputPortPos(hit.metrics ?? measureNode(hit.node), hit.index) },
        reject: false,
      };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 点节点
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!this.selection.has(hit.node.id)) {
      if (!additive) this.selection.clear();
      this.selection.add(hit.node.id);
    } else if (additive) {
      this.selection.delete(hit.node.id);
    }
    const moving = [...this.selection]
      .map((id) => this.visibleNodes().find((n) => n.id === id))
      .filter(Boolean)
      .map((n) => ({ id: n.id, originX: n.x, originY: n.y }));
    this.drag = { kind: 'node', start: world, moving };
    this.canvas.setPointerCapture(e.pointerId);
    this.invalidate();
  }

  /** @param {PointerEvent} e */
  _onPointerMove(e) {
    const world = this.toWorld(e.clientX, e.clientY);
    this.pointer.world = world;

    if (!this.drag) {
      const hit = this.hitTest(world.x, world.y);
      const next = hit ? (hit.kind === 'port' ? 'port' : 'node') : null;
      if (next !== this.hover) {
        this.hover = next;
        this.canvas.style.cursor = next === 'port' ? 'crosshair' : next === 'node' ? 'grab' : 'default';
      }
      return;
    }

    if (this.drag.kind === 'pan') {
      this.view.x = this.drag.originX + (e.clientX - this.drag.startX);
      this.view.y = this.drag.originY + (e.clientY - this.drag.startY);
      this.drag.moved = true;
      this.invalidate();
      return;
    }

    if (this.drag.kind === 'node') {
      const dx = world.x - this.drag.start.x;
      const dy = world.y - this.drag.start.y;
      for (const item of this.drag.moving) {
        const node = this.graph.nodes.find((n) => n.id === item.id);
        if (!node) continue;
        node.x = Math.round(item.originX + dx);
        node.y = Math.round(item.originY + dy);
      }
      this.invalidate();
      return;
    }

    if (this.drag.kind === 'edge') {
      const hit = this.hitTest(world.x, world.y);
      this.drag.reject = Boolean(hit && !this._canDrop(hit, this.drag));
      this.invalidate();
      return;
    }

    if (this.drag.kind === 'marquee') {
      this.drag.current = world;
      this.invalidate();
    }
  }

  /**
   * 判断这次拖线能不能落在目标上。
   *
   * **drag 必须显式传入**：`_onPointerUp` 一进来就把 `this.drag` 清了，
   * 如果这里读 `this.drag` 就永远是 null → 永远返回 false → 手动连线全部失效。
   * （这个 bug 只有真拖一次才会暴露：模板建图绕过了检查，所以看不出来。）
   *
   * @param {object} hit hitTest 的结果
   * @param {object} drag 当前拖拽状态
   * @returns {boolean}
   */
  _canDrop(hit, drag) {
    if (!drag || drag.kind !== 'edge') return false;
    if (!hit || hit.kind !== 'port') return false;
    // 输出 → 输入 才合法
    if (hit.dir !== 'in') return false;
    if (hit.node.id === drag.from.node.id) return false;
    if (!canConnect(drag.from.type, hit.port.type)) return false;
    // 不能成环：目标是自己的祖先就不行
    if (this._wouldCycle(drag.from.node.id, hit.node.id)) return false;
    return true;
  }

  /**
   * 从 fromId 出发能不能走到 toId（能走到说明反着连会成环）。
   * @param {string} fromId 上游节点
   * @param {string} toId 下游节点
   * @returns {boolean}
   */
  _wouldCycle(fromId, toId) {
    // 从 toId 顺着下游走，看能不能回到 fromId
    const edges = this.graph.edges ?? [];
    const seen = new Set();
    const stack = [toId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === fromId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const e of edges) if (e.from.node === current) stack.push(e.to.node);
    }
    return false;
  }

  /** @param {PointerEvent} e */
  _onPointerUp(e) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;

    if (drag.kind === 'node') {
      this._emit({ reason: 'move-node' });
      return;
    }

    if (drag.kind === 'marquee') {
      const x0 = Math.min(drag.origin.x, drag.current.x);
      const x1 = Math.max(drag.origin.x, drag.current.x);
      const y0 = Math.min(drag.origin.y, drag.current.y);
      const y1 = Math.max(drag.origin.y, drag.current.y);
      if (Math.abs(x1 - x0) > 4 || Math.abs(y1 - y0) > 4) {
        for (const node of this.visibleNodes()) {
          const m = measureNode(node);
          if (node.x + m.width >= x0 && node.x <= x1 && node.y + m.height >= y0 && node.y <= y1) {
            this.selection.add(node.id);
          }
        }
      }
      this.invalidate();
      return;
    }

    if (drag.kind === 'edge') {
      const world = this.toWorld(e.clientX, e.clientY);
      const hit = this.hitTest(world.x, world.y);
      // 注意：此时 this.drag 已经被清空，必须把 drag 传进去
      if (hit && this._canDrop(hit, drag)) {
        this.graph.edges = [
          ...(this.graph.edges ?? []).filter((ed) => !(ed.to.node === hit.node.id && ed.to.port === hit.port.id)),
          {
            id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            from: { node: drag.from.node.id, port: drag.from.port.id },
            to: { node: hit.node.id, port: hit.port.id },
          },
        ];
        // 有损转换要提示，但不阻止——生成器的规则是确定的，用户有权这么接
        const kind = conversionKind(drag.from.type, hit.port.type);
        if (kind === 'truncate') {
          this._setStatus(`已连接：${drag.from.type} → ${hit.port.type} 会丢弃多余分量`, 'info');
        } else if (kind === 'extend' || kind === 'broadcast') {
          this._setStatus(`已连接：${drag.from.type} → ${hit.port.type} 会自动补位`, 'info');
        }
        this._emit({ reason: 'connect' });
      } else if (hit && hit.kind === 'port') {
        const reason = !canConnect(drag.from.type, hit.port.type)
          ? '类型不匹配'
          : this._wouldCycle(drag.from.node.id, hit.node.id)
            ? '会形成环路'
            : '这个端口接不了';
        this._setStatus(reason, 'error');
        this.invalidate();
      } else {
        this.invalidate();
      }
      return;
    }

    this.invalidate();
  }

  /** @param {WheelEvent} e */
  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
    if (next === this.view.zoom) return;
    // 以光标为锚点缩放
    this.view.x = mx - ((mx - this.view.x) / this.view.zoom) * next;
    this.view.y = my - ((my - this.view.y) / this.view.zoom) * next;
    this.view.zoom = next;
    this.invalidate();
  }

  /** @param {KeyboardEvent} e */
  _onKeyDown(e) {
    if (e.key === ' ') {
      this._spaceDown = true;
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.size === 0) return;
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      for (const node of this.visibleNodes()) this.selection.add(node.id);
      this.invalidate();
      return;
    }
    if (e.key === '0') {
      this.resetView();
    }
  }

  /**
   * 双击节点：把 custom 节点的表达式提出来快速编辑。
   * @param {MouseEvent} e
   */
  _onDoubleClick(e) {
    const world = this.toWorld(e.clientX, e.clientY);
    const hit = this.hitTest(world.x, world.y);
    if (!hit) {
      this.resetView();
      return;
    }
    if (hit.kind === 'node') this.onNodeDoubleClick?.(hit.node);
  }

  /** 重置视图。 */
  resetView() {
    this.view = { x: 40, y: 40, zoom: 1 };
    this.invalidate();
  }

  /** 缩放到合适大小。 */
  fitView() {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) {
      this.resetView();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const m = measureNode(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + m.width);
      maxY = Math.max(maxY, node.y + m.height);
    }
    const { width, height } = this._size();
    const pad = 48;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY))),
    );
    this.view.zoom = zoom;
    this.view.x = (width - (maxX - minX) * zoom) / 2 - minX * zoom;
    this.view.y = (height - (maxY - minY) * zoom) / 2 - minY * zoom;
    this.invalidate();
  }

  // ─────────────────────── 编辑操作 ───────────────────────

  /**
   * 加一个节点。
   * @param {string} type
   * @param {number} [x]
   * @param {number} [y]
   * @returns {object|undefined}
   */
  addNode(type, x, y) {
    const def = getNodeDef(type);
    if (!def) {
      this._setStatus(`不认识的节点类型：${type}`, 'error');
      return undefined;
    }
    if (def.terminal && this.visibleNodes().some((n) => n.type === 'output')) {
      this._setStatus('这个 Pass 已经有输出节点了，一个 Pass 只能有一个', 'error');
      return undefined;
    }
    const { width, height } = this._size();
    const center = this.toWorld(width / 2, height / 2);
    const node = {
      id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      x: Math.round(x ?? center.x + (Math.random() - 0.5) * 80),
      y: Math.round(y ?? center.y + (Math.random() - 0.5) * 80),
      params: defaultParams(def),
    };
    this.graph.nodes = [...(this.graph.nodes ?? []), node];
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (pass) pass.graph = [...(pass.graph ?? []), node.id];
    this.selection = new Set([node.id]);
    this._emit({ reason: 'add-node', nodeId: node.id });
    return node;
  }

  /** 删除选中节点（连带它们的连线）。 */
  deleteSelected() {
    if (this.selection.size === 0) return;
    const ids = new Set(this.selection);
    this.graph.nodes = (this.graph.nodes ?? []).filter((n) => !ids.has(n.id));
    this.graph.edges = (this.graph.edges ?? []).filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
    for (const pass of this.graph.passes ?? []) {
      if (Array.isArray(pass.graph)) pass.graph = pass.graph.filter((id) => !ids.has(id));
    }
    this.selection.clear();
    this._emit({ reason: 'delete-node' });
  }

  /** 复制选中节点。 */
  duplicateSelected() {
    if (this.selection.size === 0) return;
    const map = new Map();
    const copies = [];
    for (const id of this.selection) {
      const node = this.graph.nodes.find((n) => n.id === id);
      if (!node) continue;
      const copy = {
        ...node,
        id: `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        x: node.x + 28,
        y: node.y + 28,
        params: { ...node.params },
      };
      map.set(id, copy.id);
      copies.push(copy);
    }
    this.graph.nodes = [...(this.graph.nodes ?? []), ...copies];
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (pass) pass.graph = [...(pass.graph ?? []), ...copies.map((c) => c.id)];

    // 内部连线也复制一份
    const internal = (this.graph.edges ?? []).filter((e) => map.has(e.from.node) && map.has(e.to.node));
    this.graph.edges = [
      ...(this.graph.edges ?? []),
      ...internal.map((e) => ({
        id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        from: { node: map.get(e.from.node), port: e.from.port },
        to: { node: map.get(e.to.node), port: e.to.port },
      })),
    ];
    this.selection = new Set(copies.map((c) => c.id));
    this._emit({ reason: 'duplicate' });
  }

  /**
   * 把选中的节点打成一个「组」（Group 元节点）。
   *
   * 组是元节点：**子图内联在组节点的 `params.graph` 里**，生成时被展开。
   * 跨边界的连线自动变成组的输入/输出端口，所以打完组之后图的语义完全不变 ——
   * 只是画布上少了一堆节点。
   *
   * 这是"不碰插件源码就能造新节点"的正路：搭好一张子图 → 打成组 → 到处复用。
   *
   * @returns {object|null} 新造的组节点
   */
  groupSelection() {
    const all = this.graph.nodes ?? [];
    // output 是 Pass 的终点，不能进组；已经是组输入/输出的也不该再包一层
    const selected = all.filter(
      (n) => this.selection.has(n.id) && n.type !== 'output' && n.type !== 'groupInput' && n.type !== 'groupOutput',
    );
    if (selected.length === 0) return null;

    const innerIds = new Set(selected.map((n) => n.id));
    const edges = this.graph.edges ?? [];
    const internal = edges.filter((e) => innerIds.has(e.from.node) && innerIds.has(e.to.node));
    const incoming = edges.filter((e) => !innerIds.has(e.from.node) && innerIds.has(e.to.node));
    const outgoing = edges.filter((e) => innerIds.has(e.from.node) && !innerIds.has(e.to.node));

    /** 生成一个节点 id，和 duplicateSelected 用的是同一套写法。 */
    const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const groupId = newId('g');

    const subNodes = selected.map((n) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      params: { ...(n.params ?? {}) },
      ...(n.paramDefaults ? { paramDefaults: { ...n.paramDefaults } } : {}),
    }));
    const subEdges = internal.map((e) => ({ from: { ...e.from }, to: { ...e.to } }));

    const inputs = [];
    const outputs = [];
    const outerEdges = [];

    /** 端口显示名：拿上游/下游节点的标题 + 端口名，别让用户对着一串 id 猜。 */
    const portLabel = (nodeId, dir, portId) => {
      const def = getNodeDef(all.find((n) => n.id === nodeId)?.type);
      const port = resolvePorts(all.find((n) => n.id === nodeId), dir).find((p) => p.id === portId);
      return `${def?.title ?? nodeId}·${port?.label ?? portId}`;
    };

    for (const edge of incoming) {
      const target = all.find((n) => n.id === edge.to.node);
      const type = resolvePortType(target, 'in', edge.to.port) ?? 'vec4';
      const portId = `in_${edge.to.node}_${edge.to.port}`;
      const inputNodeId = `gi_${edge.to.node}_${edge.to.port}`;
      inputs.push({ id: portId, label: portLabel(edge.to.node, 'in', edge.to.port), type });
      subNodes.push({
        id: inputNodeId,
        type: 'groupInput',
        x: (target?.x ?? 0) - 200,
        y: target?.y ?? 0,
        params: { port: portId, type },
      });
      subEdges.push({ from: { node: inputNodeId, port: 'out' }, to: { node: edge.to.node, port: edge.to.port } });
      outerEdges.push({ from: { ...edge.from }, to: { node: groupId, port: portId } });
    }

    for (const edge of outgoing) {
      const source = all.find((n) => n.id === edge.from.node);
      const type = resolvePortType(source, 'out', edge.from.port) ?? 'vec4';
      const portId = `out_${edge.from.node}_${edge.from.port}`;
      const outputNodeId = `go_${edge.from.node}_${edge.from.port}`;
      outputs.push({ id: portId, label: portLabel(edge.from.node, 'out', edge.from.port), type });
      subNodes.push({
        id: outputNodeId,
        type: 'groupOutput',
        x: (source?.x ?? 0) + 220,
        y: source?.y ?? 0,
        params: { port: portId, type },
      });
      subEdges.push({ from: { node: edge.from.node, port: edge.from.port }, to: { node: outputNodeId, port: 'color' } });
      outerEdges.push({ from: { node: groupId, port: portId }, to: { ...edge.to } });
    }

    const cx = selected.reduce((sum, n) => sum + (n.x ?? 0), 0) / selected.length;
    const cy = selected.reduce((sum, n) => sum + (n.y ?? 0), 0) / selected.length;

    const groupNode = {
      id: groupId,
      type: 'group',
      x: Math.round(cx),
      y: Math.round(cy),
      params: {
        graph: {
          name: `组（${selected.length} 节点）`,
          inputs,
          outputs,
          nodes: subNodes,
          edges: subEdges,
        },
      },
    };

    // 换血：删掉内部节点与所有沾边的连线，放进组节点和跨边界连线
    this.graph.nodes = [...all.filter((n) => !innerIds.has(n.id)), groupNode];
    this.graph.edges = [
      ...edges.filter((e) => !innerIds.has(e.from.node) && !innerIds.has(e.to.node)),
      ...outerEdges.map((e) => ({ id: newId('e'), ...e })),
    ];
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (pass) {
      pass.graph = [...(pass.graph ?? []).filter((id) => !innerIds.has(id)), groupId];
    }

    this.selection = new Set([groupId]);
    this._emit({ reason: 'group-nodes', nodeId: groupId });
    return groupNode;
  }

  /** 拆开选中的组：子图还原回画布。 */
  ungroupSelection() {
    const targets = (this.graph.nodes ?? []).filter((n) => this.selection.has(n.id) && n.type === 'group');
    if (targets.length === 0) return 0;

    let restored = 0;
    for (const groupNode of targets) {
      const sub = groupNode.params?.graph;
      if (!sub || !Array.isArray(sub.nodes)) continue;
      const prefix = `${groupNode.id}::`;
      const idMap = new Map();
      const added = [];
      for (const inner of sub.nodes) {
        if (inner.type === 'groupInput' || inner.type === 'groupOutput') continue;
        const id = `${prefix}${inner.id}`;
        idMap.set(inner.id, id);
        added.push({ ...inner, id, x: (groupNode.x ?? 0) + (inner.x ?? 0), y: (groupNode.y ?? 0) + (inner.y ?? 0) });
      }
      // 跨边界连线接回去：组输入 → 里面那根线的目标；里面那根线的源 → 组输出
      const bridge = [];
      for (const inner of sub.nodes) {
        if (inner.type === 'groupInput') {
          const port = inner.params?.port;
          const outEdge = (sub.edges ?? []).find((e) => e.from.node === inner.id);
          const outer = (this.graph.edges ?? []).find((e) => e.to.node === groupNode.id && e.to.port === port);
          if (outEdge && outer && idMap.has(outEdge.to.node)) {
            bridge.push({ id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: { ...outer.from }, to: { node: idMap.get(outEdge.to.node), port: outEdge.to.port } });
          }
        }
        if (inner.type === 'groupOutput') {
          const port = inner.params?.port;
          const inEdge = (sub.edges ?? []).find((e) => e.to.node === inner.id);
          const outer = (this.graph.edges ?? []).find((e) => e.from.node === groupNode.id && e.from.port === port);
          if (inEdge && outer && idMap.has(inEdge.from.node)) {
            bridge.push({ id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: { node: idMap.get(inEdge.from.node), port: inEdge.from.port }, to: { ...outer.to } });
          }
        }
      }
      const innerEdges = (sub.edges ?? [])
        .filter((e) => idMap.has(e.from.node) && idMap.has(e.to.node))
        .map((e) => ({ id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, from: { node: idMap.get(e.from.node), port: e.from.port }, to: { node: idMap.get(e.to.node), port: e.to.port } }));

      this.graph.nodes = [...(this.graph.nodes ?? []).filter((n) => n.id !== groupNode.id), ...added];
      this.graph.edges = [
        ...(this.graph.edges ?? []).filter((e) => e.from.node !== groupNode.id && e.to.node !== groupNode.id),
        ...bridge,
        ...innerEdges,
      ];
      const pass = this.graph.passes?.find((p) => p.name === this.pass);
      if (pass) pass.graph = [...(pass.graph ?? []).filter((id) => id !== groupNode.id), ...added.map((n) => n.id)];
      restored += added.length;
    }

    this.selection.clear();
    this._emit({ reason: 'ungroup-nodes' });
    return restored;
  }

  /**
   * 改某节点的参数。
   * @param {string} nodeId
   * @param {string} key
   * @param {any} value
   */
  setParam(nodeId, key, value) {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.params = { ...node.params, [key]: value };
    this._emit({ reason: 'set-param', nodeId, key });
  }

  /**
   * 断开某输入端口的连线。
   * @param {string} nodeId
   * @param {string} portId
   */
  disconnectInput(nodeId, portId) {
    this.graph.edges = (this.graph.edges ?? []).filter((e) => !(e.to.node === nodeId && e.to.port === portId));
    this._emit({ reason: 'disconnect' });
  }

  /**
   * 断开某输出端口的全部连线。
   * @param {string} nodeId
   */
  disconnectOutputs(nodeId) {
    this.graph.edges = (this.graph.edges ?? []).filter((e) => e.from.node !== nodeId);
    this._emit({ reason: 'disconnect' });
  }

  /**
   * 清空当前 Pass。
   */
  clearPass() {
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (!pass) return;
    const ids = new Set(pass.graph ?? []);
    this.graph.nodes = (this.graph.nodes ?? []).filter((n) => !ids.has(n.id));
    this.graph.edges = (this.graph.edges ?? []).filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
    pass.graph = [];
    this.selection.clear();
    this._emit({ reason: 'clear-pass' });
  }

  /**
   * 往当前 Pass 里塞一个「能出画面」的最小图。
   * @param {string} kind 'plasma' | 'gradient'
   */
  insertTemplate(kind) {
    const x0 = 80;
    const y0 = 90;

    if (kind === 'gradient') {
      const uv = this.addNode('uv', x0, y0);
      const grad = this.addNode('palette', x0 + 240, y0);
      const out = this.addNode('output', x0 + 480, y0);
      if (!uv || !grad || !out) return;
      this._link([
        [uv.id, 'out', grad.id, 't'],
        [grad.id, 'out', out.id, 'color'],
      ]);
      this.fitView();
      return;
    }

    // 默认：时间驱动的等离子体
    const uv = this.addNode('uv', x0, y0);
    const scale = this.addNode('scaleP', x0, y0 + 120);
    const time = this.addNode('time', x0, y0 + 260);
    const palette = this.addNode('palette', x0 + 230, y0 + 190);
    const noise = this.addNode('fbm', x0 + 230, y0 - 10);
    const add = this.addNode('add', x0 + 470, y0 + 80);
    const out = this.addNode('output', x0 + 700, y0 + 80);
    if (!uv || !scale || !time || !palette || !noise || !add || !out) return;

    this._link([
      [uv.id, 'out', scale.id, 'p'],
      [scale.id, 'out', noise.id, 'uv'],
      [time.id, 'out', add.id, 'a'],
      [noise.id, 'out', add.id, 'b'],
      [add.id, 'out', palette.id, 't'],
      [palette.id, 'out', out.id, 'color'],
    ]);
    this.fitView();
  }

  /**
   * 内部用：批量加连线（跳过已存在与非法项）。
   * @param {Array<[string,string,string,string]>} list [fromNode, fromPort, toNode, toPort]
   */
  _link(list) {
    const stamp = Date.now().toString(36);
    const added = [];
    for (const [fromNode, fromPort, toNode, toPort] of list) {
      if ((this.graph.edges ?? []).some((e) => e.to.node === toNode && e.to.port === toPort)) continue;
      added.push({
        id: `e_tpl_${stamp}_${added.length}`,
        from: { node: fromNode, port: fromPort },
        to: { node: toNode, port: toPort },
      });
    }
    if (added.length === 0) {
      this._emit({ reason: 'template' });
      return;
    }
    this.graph.edges = [...(this.graph.edges ?? []), ...added];
    this._emit({ reason: 'template' });
  }

  /** 在指定位置弹右键菜单。 */
  _openContextMenu(e, hit) {
    const items = [];
    if (hit?.kind === 'node') {
      const node = hit.node;
      const def = getNodeDef(node.type);
      items.push(menuItem(`复制「${def?.title ?? node.type}」`, () => this.duplicateSelected(), { shortcut: 'Ctrl+D' }));
      if (def && def.inputs.length > 0) {
        items.push(menuItem('断开全部输入', () => {
          this.graph.edges = (this.graph.edges ?? []).filter((ed) => ed.to.node !== node.id);
          this._emit({ reason: 'disconnect-all-in' });
        }));
      }
      if (def && def.outputs.length > 0) {
        items.push(menuItem('断开全部输出', () => this.disconnectOutputs(node.id)));
      }
      items.push(h('div.swb-menu__sep'));
      items.push(menuItem('删除节点', () => {
        this.selection = new Set([node.id]);
        this.deleteSelected();
      }, { tone: 'danger', shortcut: 'Del' }));
    } else if (hit?.kind === 'port') {
      if (hit.dir === 'in') {
        items.push(menuItem('断开这条连线', () => this.disconnectInput(hit.node.id, hit.port.id)));
      } else {
        items.push(menuItem('断开该输出的全部连线', () => this.disconnectOutputs(hit.node.id)));
      }
    } else {
      if (this.selection.size > 0) {
        items.push(menuItem(`打成 Group（${this.selection.size} 个节点）`, () => this.groupSelection()));
      }
      if ([...this.selection].some((id) => this.graph.nodes?.find((n) => n.id === id)?.type === 'group')) {
        items.push(menuItem('拆开组', () => this.ungroupSelection()));
      }
      items.push(menuItem('插入示例：等离子球', () => this.insertTemplate('plasma')));
      items.push(menuItem('插入示例：渐变', () => this.insertTemplate('gradient')));
      items.push(h('div.swb-menu__sep'));
      items.push(menuItem('适应视图', () => this.fitView(), { shortcut: '0' }));
      items.push(menuItem('重置视图', () => this.resetView()));
      items.push(h('div.swb-menu__sep'));
      items.push(menuItem('清空当前 Pass', () => this.clearPass(), { tone: 'danger' }));
    }
    popup(items, e.clientX, e.clientY);
  }

  /** 状态栏提示。 */
  _setStatus(text, tone = 'info') {
    this._status.textContent = text;
    this._status.dataset.tone = tone;
  }

  /** 释放。 */
  dispose() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }
}

/**
 * 取节点参数的默认值表。
 * @param {object} def
 * @returns {object}
 */
export function defaultParams(def) {
  const out = {};
  for (const [key, meta] of Object.entries(def.params ?? {})) out[key] = meta.value;
  return out;
}

/**
 * 分类配色。
 * @param {string} category
 * @returns {string}
 */
function categoryColor(category) {
  const table = {
    输入: '#3b5b8c',
    数学: '#4a4a6a',
    向量: '#3f6660',
    颜色: '#7a4a5c',
    程序化: '#5a5a3a',
    纹理: '#6a4a2a',
    自定义: '#4a3a6a',
    输出: '#2f6b4f',
  };
  return table[category] ?? '#44506b';
}

/**
 * 画圆角矩形路径。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * 三次贝塞尔连线路径。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}} p0
 * @param {{x:number,y:number}} p1
 */
function bezier(ctx, p0, p1) {
  const dx = Math.max(36, Math.abs(p1.x - p0.x) * 0.5);
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p0.x + dx, p0.y, p1.x - dx, p1.y, p1.x, p1.y);
}

/**
 * 贝塞尔曲线上 t 处的点。
 * @param {{x:number,y:number}} p0
 * @param {{x:number,y:number}} p1
 * @param {number} t
 * @returns {{x:number,y:number}}
 */
function bezierPoint(p0, p1, t) {
  const dx = Math.max(36, Math.abs(p1.x - p0.x) * 0.5);
  const c0 = { x: p0.x + dx, y: p0.y };
  const c1 = { x: p1.x - dx, y: p1.y };
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

/**
 * 按宽度裁字符串。
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
function clipText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export { NODE_WIDTH, HEADER_HEIGHT, PORT_COLORS };
