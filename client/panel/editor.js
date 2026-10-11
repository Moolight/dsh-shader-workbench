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
 *   Delete 删除选中，Ctrl+D 复制选中，Ctrl+A 全选
 *   Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做
 *   右键出菜单（节点：复制/删除/断开；空白：新建分组框 / 注释 + 显示全部节点库）
 *
 * 分组框（frame）与注释（note）是**编辑器层**的东西，只画在画布上、
 * 不参与代码生成，但会跟着图一起存进 `passes[].frames`。
 *
 * @module dsh-shader-workbench/client/panel/editor
 */

import { button, empty, h, menuItem, popup } from './dom.js';
import { canConnect, conversionKind, makeFrame } from '../../shared/graph.js';
import { NODE_LIBRARY, getNodeDef, resolvePortType, resolvePorts } from '../../shared/nodes.js';

/** 节点尺寸常量。 */
const NODE_WIDTH = 168;
const HEADER_HEIGHT = 26;
const PORT_ROW_HEIGHT = 18;
const PORT_RADIUS = 5;
const BODY_PADDING = 8;

/** 分组框标题栏高度。 */
const FRAME_HEADER_HEIGHT = 22;
/** 右下角缩放把手的边长。 */
const FRAME_HANDLE_SIZE = 14;
/** 新建分组框 / 注释的默认尺寸。 */
const FRAME_DEFAULT_SIZE = { w: 360, h: 220 };
const NOTE_DEFAULT_SIZE = { w: 240, h: 110 };
/** 装饰件尺寸下限（和 shared/graph.js 的 MIN_FRAME_SIZE 保持一致）。 */
const FRAME_MIN_SIZE = 80;

/**
 * 撤销栈上限。
 *
 * 数量与**字节**双封顶：图小的时候留 100 步手感好；
 * 万一有人把几百个节点铺满画布（单份快照 1 MB 级），
 * 光按数量留就会吃掉几百兆内存，所以再加一条总字节预算。
 */
const HISTORY_LIMIT = 100;
const HISTORY_BYTE_BUDGET = 12 * 1024 * 1024;
/** 连续同类操作（拖滑杆、连点微调）在这个窗口内合并成一步。 */
const HISTORY_MERGE_MS = 700;

/** 各端口类型的配色。 */
const PORT_COLORS = {
  float: '#9aa4b2',
  vec2: '#4ade80',
  vec3: '#fbbf24',
  vec4: '#f472b6',
};

/** 装饰件配色表。 */
const FRAME_TINTS = {
  blue: { head: 'rgba(58, 108, 190, 0.80)', body: 'rgba(58, 108, 190, 0.10)', line: 'rgba(122, 172, 255, 0.55)' },
  green: { head: 'rgba(42, 132, 96, 0.80)', body: 'rgba(42, 132, 96, 0.10)', line: 'rgba(94, 219, 160, 0.55)' },
  amber: { head: 'rgba(160, 122, 36, 0.80)', body: 'rgba(160, 122, 36, 0.10)', line: 'rgba(245, 185, 66, 0.55)' },
  violet: { head: 'rgba(114, 86, 176, 0.80)', body: 'rgba(114, 86, 176, 0.10)', line: 'rgba(184, 154, 255, 0.55)' },
  rose: { head: 'rgba(162, 66, 88, 0.80)', body: 'rgba(162, 66, 88, 0.10)', line: 'rgba(250, 140, 160, 0.55)' },
  slate: { head: 'rgba(88, 98, 112, 0.80)', body: 'rgba(88, 98, 112, 0.12)', line: 'rgba(160, 175, 195, 0.50)' },
};

/** 装饰件配色的中文名（右键菜单用）。 */
const FRAME_COLOR_LABELS = {
  blue: '蓝',
  green: '绿',
  amber: '琥珀',
  violet: '紫',
  rose: '玫红',
  slate: '灰',
};

/** 配色枚举顺序（右键菜单按这个顺序列）。 */
const FRAME_COLOR_KEYS = Object.keys(FRAME_TINTS);

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
    /** 当前选中的分组框 / 注释 id（与节点选择互斥） */
    this.selectedFrame = null;
    /** 撤销栈。`past` 里存的是**改动之前**的图快照。 */
    this.history = { past: [], future: [] };
    /** 拖拽开始时的图快照，松手时才决定要不要入栈 */
    this._dragBefore = null;
    /** _commit 嵌套深度：>0 时内层只干活、不入栈，保证「插入模板」这类复合操作算一步 */
    this._commitDepth = 0;

    this.root = this._build();
    this.canvas = this.root.querySelector('.swb-editor__canvas');
    this.ctx = this.canvas.getContext('2d');
    this._bindEvents();
    this._resizeObserver = null;
    this._observeResize();
    this._syncHistoryButtons();
    this.invalidate();
  }

  /**
   * 更新图（外部改了数据源时调用）。
   * @param {object} graph
   * @param {string} [pass]
   * @param {object} [opts]
   * @param {boolean} [opts.keepHistory] 保留撤销栈（存盘时用；换材质时不要保留）
   */
  setGraph(graph, pass = this.pass, opts = {}) {
    this.graph = graph;
    this.pass = pass;
    // 丢掉已经不存在的选中项
    const ids = new Set(this.visibleNodes().map((n) => n.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (this.selectedFrame !== null && !this.frames().some((f) => f.id === this.selectedFrame)) {
      this.selectedFrame = null;
    }
    if (opts.keepHistory !== true) this._resetHistory();
    this._closeInlineEdit();
    this._syncPassTabs();
    this.invalidate();
  }

  /** 当前 Pass 的节点。 */
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

  /**
   * 当前 Pass 的装饰件（分组框 / 注释）。
   *
   * 不存在时**就地补一个空数组**：老材质（`frames` 字段还不存在时存的）打开后
   * 立刻就能新建分组框，不用先升级图格式。
   *
   * @returns {object[]}
   */
  frames() {
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (!pass) return [];
    if (!Array.isArray(pass.frames)) pass.frames = [];
    return pass.frames;
  }

  /** 图变了：通知外部 + 重画。 */
  _emit(meta = {}) {
    this.onChange(this.graph, { pass: this.pass, ...meta });
    this.invalidate();
  }

  // ─────────────────────── 撤销 / 重做 ───────────────────────

  /** 图的一份可还原快照。 */
  _snapshot() {
    return JSON.stringify(this.graph);
  }

  /** 清空撤销栈（换材质、载入示例时调用）。 */
  _resetHistory() {
    this.history = { past: [], future: [] };
    this._dragBefore = null;
    this._syncHistoryButtons();
  }

  /**
   * 撤销栈是否还能退。
   * @returns {boolean}
   */
  canUndo() {
    return this.history.past.length > 0;
  }

  /**
   * 撤销栈是否还能进。
   * @returns {boolean}
   */
  canRedo() {
    return this.history.future.length > 0;
  }

  /** 下次撤销会撤掉什么（按钮 title 用）。 */
  undoLabel() {
    return this.history.past[this.history.past.length - 1]?.label ?? '';
  }

  /** 下次重做会重做什么。 */
  redoLabel() {
    return this.history.future[this.history.future.length - 1]?.label ?? '';
  }

  /**
   * 把一份「改动前」的快照推进撤销栈，并清空重做栈。
   *
   * 连续同类操作（拖滑杆、按住方向键微调）会在 `HISTORY_MERGE_MS` 内合并成一步：
   * 只在第一次入栈，后面只把时间戳往后推 —— 否则拖一次滑杆就能塞进几十步。
   *
   * @param {string} label 操作名，显示在按钮 title 里
   * @param {string} state 改动前的快照
   * @param {string|null} mergeKey 合并键；相同则尝试合并
   */
  _pushHistory(label, state, mergeKey = null) {
    const past = this.history.past;
    const last = past[past.length - 1];
    const now = Date.now();
    if (mergeKey !== null && last && last.mergeKey === mergeKey && now - last.at < HISTORY_MERGE_MS) {
      last.at = now;
      last.label = label;
    } else {
      past.push({ label, state, mergeKey, at: now });
    }
    this.history.future.length = 0;
    this._trimHistory();
    this._syncHistoryButtons();
  }

  /** 按数量 + 字节双重预算裁剪撤销栈（保留最近的）。 */
  _trimHistory() {
    for (const stack of [this.history.past, this.history.future]) {
      while (stack.length > HISTORY_LIMIT) stack.shift();
      let bytes = 0;
      let keepFrom = 0;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        bytes += stack[i].state.length;
        if (bytes > HISTORY_BYTE_BUDGET) {
          // 至少保留最近一条：不然「撤销」会直接变成不可用
          keepFrom = i + 1;
          break;
        }
      }
      if (keepFrom > 0) stack.splice(0, keepFrom);
    }
  }

  /**
   * 包一个会改图的操作：自动比对改动前后的快照，真变了才入栈。
   *
   * 这样调用方不用自己判断「这次点击到底改没改东西」——
   * 例如点了一个已经选中的节点再松手、或者删一个空选择，都不该占一步撤销。
   *
   * 嵌套调用（插入模板 → 连加好几个节点 + 连线）只在**最外层**入栈一次，
   * 否则插一次模板得按十来下撤销才退得回去。
   *
   * @param {string} label 操作名
   * @param {() => any} fn 真正干活的函数
   * @param {object} [opts]
   * @param {string} [opts.mergeKey] 合并键
   * @returns {any} fn 的返回值
   */
  _commit(label, fn, opts = {}) {
    const nested = this._commitDepth > 0;
    const before = nested ? null : this._snapshot();
    this._commitDepth += 1;
    let result;
    try {
      result = fn();
    } finally {
      this._commitDepth -= 1;
    }
    if (!nested && this._snapshot() !== before) this._pushHistory(label, before, opts.mergeKey ?? null);
    return result;
  }

  /** 拖拽开始：记一份快照，松手时再决定入不入栈。 */
  _beginDrag() {
    this._dragBefore = this._snapshot();
  }

  /**
   * 拖拽结束：真改动了就入栈。
   * @param {string} label
   */
  _endDrag(label) {
    const before = this._dragBefore;
    this._dragBefore = null;
    if (before === null) return;
    if (this._snapshot() !== before) this._pushHistory(label, before);
  }

  /**
   * 撤销一步。
   * @returns {boolean} 是否真的撤了
   */
  undo() {
    const entry = this.history.past.pop();
    if (!entry) return false;
    this.history.future.push({ label: entry.label, state: this._snapshot(), mergeKey: null, at: Date.now() });
    this._restore(entry.state);
    this._setStatus(`已撤销：${entry.label}`, 'info');
    return true;
  }

  /**
   * 重做一步。
   * @returns {boolean} 是否真的重做了
   */
  redo() {
    const entry = this.history.future.pop();
    if (!entry) return false;
    this.history.past.push({ label: entry.label, state: this._snapshot(), mergeKey: null, at: Date.now() });
    this._trimHistory();
    this._restore(entry.state);
    this._setStatus(`已重做：${entry.label}`, 'info');
    return true;
  }

  /**
   * 把图还原成某个快照。
   *
   * **就地改**而不是换对象：图这个对象会被工作台、参数面板、渲染器、热重载
   * 一起拿着（`new NodeEditor({ graph })` 的调用方也一样）。
   * 一旦换成新对象，所有还捏着旧引用的地方都会悄悄对着被丢弃的图干活 ——
   * 症状是「撤销了、界面也动了，但保存下去的还是没有撤销的内容」。
   *
   * 所以这里是「清空键 → 覆盖内容」，对象身份保持不变。
   *
   * @param {string} state
   */
  _restore(state) {
    let parsed;
    try {
      parsed = JSON.parse(state);
    } catch {
      this._setStatus('撤销失败：快照损坏', 'error');
      return;
    }
    for (const key of Object.keys(this.graph)) delete this.graph[key];
    Object.assign(this.graph, parsed);
    // 撤销可能把当前 Pass 一起撤没了（比如刚新增了 BufferA 又撤销），
    // 这时必须把 this.pass 挪回一个真实存在的 Pass，否则 visibleNodes()
    // 会退化成「显示整张图的所有节点」，看着像图炸了。
    const passNames = (this.graph.passes ?? []).map((p) => p.name);
    if (!passNames.includes(this.pass)) {
      this.pass = passNames[0] ?? 'image';
      this.onPassChange(this.pass);
    }
    const ids = new Set(this.visibleNodes().map((n) => n.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (this.selectedFrame !== null && !this.frames().some((f) => f.id === this.selectedFrame)) {
      this.selectedFrame = null;
    }
    this._closeInlineEdit();
    this._syncPassTabs();
    this._syncHistoryButtons();
    this._emit({ reason: 'history' });
  }

  /** 同步撤销 / 重做按钮的可用态与提示。 */
  _syncHistoryButtons() {
    if (this._undoBtn) {
      this._undoBtn.disabled = !this.canUndo();
      this._undoBtn.title = this.canUndo() ? `撤销：${this.undoLabel()}（Ctrl+Z）` : '没有可撤销的操作（Ctrl+Z）';
    }
    if (this._redoBtn) {
      this._redoBtn.disabled = !this.canRedo();
      this._redoBtn.title = this.canRedo() ? `重做：${this.redoLabel()}（Ctrl+Shift+Z）` : '没有可重做的操作（Ctrl+Shift+Z）';
    }
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
        h('span.swb-editor__toolsep'),
        // 撤销 / 重做：按钮上带 title 说明这一步会撤掉什么，比只有图标清楚
        (this._undoBtn = h('button.swb-iconbtn', {
          type: 'button',
          text: '↶',
          title: '撤销（Ctrl+Z）',
          on: { click: () => this.undo() },
        })),
        (this._redoBtn = h('button.swb-iconbtn', {
          type: 'button',
          text: '↷',
          title: '重做（Ctrl+Shift+Z）',
          on: { click: () => this.redo() },
        })),
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
    this._commit(`新增 ${next}`, () => {
      this.graph.passes = [...(this.graph.passes ?? []), { name: next, graph: [], frames: [] }];
    });
    this.pass = next;
    this.selection.clear();
    this.selectedFrame = null;
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

    // 分组框 / 注释在最底层（它们是背景板，不该盖住节点和连线）
    this._drawFrames(ctx);

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

    // 框选矩形（以前只在数据层算，画面上没有 —— 拖了半天看不见框）
    if (this.drag?.kind === 'marquee') {
      this._drawMarquee(ctx);
    }

    ctx.restore();

    // 状态栏
    const frameCount = this.frames().length;
    const hint = this.selection.size > 0 ? ` · 选中 ${this.selection.size}` : '';
    const frameHint = this.selectedFrame ? ' · 选中分组框' : '';
    this._status.textContent = `${nodes.length} 节点 / ${this.visibleEdges().length} 连线${frameCount > 0 ? ` / ${frameCount} 分组框` : ''} · 缩放 ${(this.view.zoom * 100).toFixed(0)}%${hint}${frameHint}`;
  }

  /** 框选矩形。 */
  _drawMarquee(ctx) {
    const { origin, current } = this.drag;
    const x = Math.min(origin.x, current.x);
    const y = Math.min(origin.y, current.y);
    const w = Math.abs(current.x - origin.x);
    const h = Math.abs(current.y - origin.y);
    ctx.save();
    ctx.fillStyle = 'rgba(91, 155, 255, 0.12)';
    ctx.strokeStyle = 'rgba(91, 155, 255, 0.75)';
    ctx.lineWidth = 1 / this.view.zoom;
    ctx.setLineDash([4 / this.view.zoom, 3 / this.view.zoom]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // ─────────────────────── 分组框 / 注释 ───────────────────────

  /** 画全部装饰件。 */
  _drawFrames(ctx) {
    for (const frame of this.frames()) {
      if (frame.kind === 'note') this._drawNote(ctx, frame);
      else this._drawFrame(ctx, frame);
    }
  }

  /** 画一个分组框。 */
  _drawFrame(ctx, frame) {
    const tint = FRAME_TINTS[frame.color] ?? FRAME_TINTS.blue;
    const selected = this.selectedFrame === frame.id;
    ctx.save();
    ctx.translate(frame.x, frame.y);

    const radius = 8;
    roundRect(ctx, 0, 0, frame.w, frame.h, radius);
    ctx.fillStyle = tint.body;
    ctx.fill();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#5b9bff' : tint.line;
    ctx.stroke();

    // 标题栏
    ctx.save();
    roundRect(ctx, 0, 0, frame.w, FRAME_HEADER_HEIGHT, radius);
    ctx.clip();
    ctx.fillStyle = tint.head;
    ctx.fillRect(0, 0, frame.w, FRAME_HEADER_HEIGHT);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '600 11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(clipText(ctx, frame.title || '分组', frame.w - 16), 8, FRAME_HEADER_HEIGHT / 2 + 0.5);

    // 选中时给右下角一个缩放把手
    if (selected) {
      ctx.fillStyle = 'rgba(91, 155, 255, 0.85)';
      ctx.beginPath();
      ctx.moveTo(frame.w, frame.h - FRAME_HANDLE_SIZE);
      ctx.lineTo(frame.w, frame.h);
      ctx.lineTo(frame.w - FRAME_HANDLE_SIZE, frame.h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** 画一个注释便签。 */
  _drawNote(ctx, note) {
    const tint = FRAME_TINTS[note.color] ?? FRAME_TINTS.amber;
    const selected = this.selectedFrame === note.id;
    ctx.save();
    ctx.translate(note.x, note.y);
    roundRect(ctx, 0, 0, note.w, note.h, 6);
    ctx.fillStyle = 'rgba(24, 27, 33, 0.92)';
    ctx.fill();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#5b9bff' : tint.line;
    ctx.stroke();

    // 左侧一条色带，一眼区分注释和分组框
    ctx.save();
    roundRect(ctx, 0, 0, note.w, note.h, 6);
    ctx.clip();
    ctx.fillStyle = tint.head;
    ctx.fillRect(0, 0, 3, note.h);
    ctx.restore();

    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = '11.5px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'top';
    const text = note.text || '（双击写点说明）';
    if (!note.text) ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const lines = wrapText(ctx, text, note.w - 20);
    const maxLines = Math.max(1, Math.floor((note.h - 14) / 15));
    for (let i = 0; i < Math.min(lines.length, maxLines); i += 1) {
      const last = i === maxLines - 1 && lines.length > maxLines;
      // 单个超长 token（比如一长串 URL）折不开，画的时候再裁一刀，别糊出便签外
      const line = clipText(ctx, lines[i], note.w - 20);
      ctx.fillText(last ? `${line}…` : line, 10, 8 + i * 15);
    }
    ctx.restore();
  }

  /**
   * 在给定点新建一个分组框或注释。
   * @param {'frame'|'note'} kind
   * @param {number} worldX
   * @param {number} worldY
   * @returns {object|null}
   */
  addFrame(kind, worldX, worldY) {
    const size = kind === 'note' ? NOTE_DEFAULT_SIZE : FRAME_DEFAULT_SIZE;
    const frame = makeFrame(kind, Math.round(worldX - size.w / 2), Math.round(worldY - size.h / 2), size);
    if (kind === 'frame') frame.title = `分组 ${this.frames().filter((f) => f.kind === 'frame').length + 1}`;
    this._commit(`新建${kind === 'note' ? '注释' : '分组框'}`, () => {
      this.frames().push(frame);
    });
    this.selection.clear();
    this.selectedFrame = frame.id;
    this._emit({ reason: 'add-frame', frameId: frame.id });
    if (kind === 'note') this._beginInlineEdit(frame, 'text');
    return frame;
  }

  /**
   * 删掉一个装饰件。
   *
   * **只删框，不动框里的节点** —— 分组框是「视觉分组」，不是 `group` 元节点
   * （那个会真的改图语义，走 `groupSelection`）。
   *
   * @param {string} frameId
   * @returns {boolean}
   */
  deleteFrame(frameId) {
    const list = this.frames();
    const index = list.findIndex((f) => f.id === frameId);
    if (index < 0) return false;
    const kind = list[index].kind;
    this._commit(`删除${kind === 'note' ? '注释' : '分组框'}`, () => {
      list.splice(index, 1);
    });
    if (this.selectedFrame === frameId) this.selectedFrame = null;
    this._emit({ reason: 'delete-frame', frameId });
    return true;
  }

  /**
   * 改装饰件属性（标题 / 文本 / 配色）。
   * @param {string} frameId
   * @param {object} patch
   * @param {string} [label]
   */
  updateFrame(frameId, patch, label = '改分组框') {
    const frame = this.frames().find((f) => f.id === frameId);
    if (!frame) return;
    this._commit(label, () => {
      Object.assign(frame, patch);
    });
    this._emit({ reason: 'update-frame', frameId });
  }

  /**
   * 选中一个装饰件（和节点选择互斥）。
   * @param {string|null} frameId
   */
  selectFrame(frameId) {
    this.selectedFrame = frameId ?? null;
    if (frameId) this.selection.clear();
    this.invalidate();
  }

  /**
   * 选中某个分组框里的全部节点。
   *
   * 这是分组框最有用的一个动作：框好一片 → 选中它们 → 右键「打成 Group」
   * 就得到一颗可复用的元节点。
   *
   * @param {object} frame
   * @returns {number} 选中了几个
   */
  selectNodesInFrame(frame) {
    const x0 = frame.x;
    const y0 = frame.y;
    const x1 = frame.x + frame.w;
    const y1 = frame.y + frame.h;
    this.selection.clear();
    for (const node of this.visibleNodes()) {
      const m = measureNode(node);
      const cx = node.x + m.width / 2;
      const cy = node.y + m.height / 2;
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) this.selection.add(node.id);
    }
    this.selectedFrame = null;
    this._setStatus(`选中了框内 ${this.selection.size} 个节点（右键空白 → 打成 Group 可封装）`, 'info');
    this.invalidate();
    return this.selection.size;
  }

  /**
   * 取一个装饰件包住的节点 / 子装饰件（拖动分组框时一起走）。
   * @param {object} frame
   * @returns {{nodes:object[], frames:object[]}}
   */
  _contentsOf(frame) {
    const x0 = frame.x;
    const y0 = frame.y;
    const x1 = frame.x + frame.w;
    const y1 = frame.y + frame.h;
    const centerInside = (obj, w, h) => {
      const cx = obj.x + w / 2;
      const cy = obj.y + h / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    };
    const nodes = [];
    for (const node of this.visibleNodes()) {
      const m = measureNode(node);
      if (centerInside(node, m.width, m.height)) nodes.push(node);
    }
    const frames = [];
    for (const other of this.frames()) {
      if (other === frame || other.kind !== 'note') continue;
      if (centerInside(other, other.w, other.h)) frames.push(other);
    }
    return { nodes, frames };
  }

  /** 装饰件右下角的缩放把手命中测试。 */
  _inResizeHandle(frame, x, y) {
    if (this.selectedFrame !== frame.id) return false;
    return x >= frame.x + frame.w - FRAME_HANDLE_SIZE && x <= frame.x + frame.w && y >= frame.y + frame.h - FRAME_HANDLE_SIZE && y <= frame.y + frame.h;
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

    // 节点下面才轮到装饰件。顺序和绘制顺序一致（后画的先命中）。
    const frames = this.frames();
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      const inside = worldX >= frame.x && worldX <= frame.x + frame.w && worldY >= frame.y && worldY <= frame.y + frame.h;
      if (this._inResizeHandle(frame, worldX, worldY)) return { kind: 'frame-resize', frame };
      if (!inside) continue;
      if (frame.kind === 'note') {
        return { kind: 'note', frame, offset: { x: worldX - frame.x, y: worldY - frame.y } };
      }
      // 分组框只有标题栏是可拖的：框体内部留给框选，
      // 不然一块大框会把底下的节点全挡住、点不着。
      if (worldY <= frame.y + FRAME_HEADER_HEIGHT) return { kind: 'frame-header', frame };
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
    canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
    });
    canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this._onKeyDown(e));
    // 空格是「按住临时平移」。**必须收 keyup**：以前只置位不清零，
    // 按过一次空格之后，左键就永远是平移，再也选不中节点 —— 而且看不出原因。
    canvas.addEventListener('keyup', (e) => {
      if (e.key === ' ') this._spaceDown = false;
    });
    canvas.addEventListener('blur', () => {
      this._spaceDown = false;
    });
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
      this.selectedFrame = null;
      this.drag = { kind: 'marquee', origin: world, current: world };
      this.invalidate();
      return;
    }

    // ── 分组框 / 注释 ──
    if (hit.kind === 'frame-header' || hit.kind === 'frame-resize' || hit.kind === 'note') {
      const frame = hit.frame;
      const isResize = hit.kind === 'frame-resize';
      this.selectedFrame = frame.id;
      this.selection.clear();
      this._beginDrag();
      if (isResize) {
        this.drag = { kind: 'frame-resize', frame, start: world, origin: { w: frame.w, h: frame.h } };
      } else if (hit.kind === 'note') {
        this.drag = { kind: 'note-move', frame, start: world, origin: { x: frame.x, y: frame.y } };
      } else {
        const contents = this._contentsOf(frame);
        this.drag = {
          kind: 'frame-move',
          frame,
          start: world,
          origin: { x: frame.x, y: frame.y },
          movingNodes: contents.nodes.map((n) => ({ node: n, x: n.x, y: n.y })),
          movingFrames: contents.frames.map((f) => ({ frame: f, x: f.x, y: f.y })),
        };
      }
      this.canvas.setPointerCapture(e.pointerId);
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
            // 先记快照再动图：摘线 + 重新连上算**一步**撤销
            this._beginDrag();
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
      this._beginDrag();
      this.drag = {
        kind: 'edge',
        from: { node: hit.node, port: hit.port, type: hit.port.type, offset: outputPortPos(hit.metrics ?? measureNode(hit.node), hit.index) },
        reject: false,
      };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 点节点
    this.selectedFrame = null;
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
    this._beginDrag();
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
      const next = !hit
        ? null
        : hit.kind === 'port'
          ? 'port'
          : hit.kind === 'frame-resize'
            ? 'resize'
            : hit.kind === 'frame-header' || hit.kind === 'note'
              ? 'move'
              : 'node';
      if (next !== this.hover) {
        this.hover = next;
        this.canvas.style.cursor =
          next === 'port'
            ? 'crosshair'
            : next === 'resize'
              ? 'nwse-resize'
              : next === 'move'
                ? 'move'
                : next === 'node'
                  ? 'grab'
                  : 'default';
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

    if (this.drag.kind === 'frame-move') {
      const dx = Math.round(world.x - this.drag.start.x);
      const dy = Math.round(world.y - this.drag.start.y);
      this.drag.frame.x = this.drag.origin.x + dx;
      this.drag.frame.y = this.drag.origin.y + dy;
      // 框里的节点（和便签）跟着走 —— 这就是「分组」的手感
      for (const item of this.drag.movingNodes) {
        item.node.x = item.x + dx;
        item.node.y = item.y + dy;
      }
      for (const item of this.drag.movingFrames) {
        item.frame.x = item.x + dx;
        item.frame.y = item.y + dy;
      }
      this.invalidate();
      return;
    }

    if (this.drag.kind === 'frame-resize') {
      const dx = Math.round(world.x - this.drag.start.x);
      const dy = Math.round(world.y - this.drag.start.y);
      this.drag.frame.w = Math.max(FRAME_MIN_SIZE, this.drag.origin.w + dx);
      this.drag.frame.h = Math.max(FRAME_MIN_SIZE, this.drag.origin.h + dy);
      this.invalidate();
      return;
    }

    if (this.drag.kind === 'note-move') {
      this.drag.frame.x = Math.round(this.drag.origin.x + (world.x - this.drag.start.x));
      this.drag.frame.y = Math.round(this.drag.origin.y + (world.y - this.drag.start.y));
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
      // 拖了才入栈；只点一下（改选择）不算一步撤销
      this._endDrag(drag.moving.length > 1 ? `移动 ${drag.moving.length} 个节点` : '移动节点');
      this._emit({ reason: 'move-node' });
      return;
    }

    if (drag.kind === 'frame-move') {
      this._endDrag('移动分组框');
      this._emit({ reason: 'move-frame', frameId: drag.frame.id });
      return;
    }

    if (drag.kind === 'frame-resize') {
      this._endDrag('调整分组框大小');
      this._emit({ reason: 'resize-frame', frameId: drag.frame.id });
      return;
    }

    if (drag.kind === 'note-move') {
      this._endDrag('移动注释');
      this._emit({ reason: 'move-frame', frameId: drag.frame.id });
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
        this._endDrag('连线');
        this._emit({ reason: 'connect' });
      } else if (hit && hit.kind === 'port') {
        const reason = !canConnect(drag.from.type, hit.port.type)
          ? '类型不匹配'
          : this._wouldCycle(drag.from.node.id, hit.node.id)
            ? '会形成环路'
            : '这个端口接不了';
        this._setStatus(reason, 'error');
        this._endDrag('断开连线');
        this.invalidate();
      } else {
        // 拖到空白处松手：原来摘下来的那根线就真的断了，这也是一步可撤销的操作
        this._endDrag('断开连线');
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
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.key === 'Escape') {
      if (this.selectedFrame !== null) {
        this.selectedFrame = null;
        this.invalidate();
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // 选中分组框时优先删框（节点留在原地）
      if (this.selectedFrame !== null) {
        e.preventDefault();
        this.deleteFrame(this.selectedFrame);
        return;
      }
      if (this.selection.size === 0) return;
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if (mod && key === 'd') {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    if (mod && key === 'a') {
      e.preventDefault();
      for (const node of this.visibleNodes()) this.selection.add(node.id);
      this.selectedFrame = null;
      this.invalidate();
      return;
    }
    if (e.key === '0') {
      this.resetView();
    }
  }

  /**
   * 双击：节点交给外部处理；分组框 / 注释就地改名、改文本。
   * @param {MouseEvent} e
   */
  _onDoubleClick(e) {
    const world = this.toWorld(e.clientX, e.clientY);
    const hit = this.hitTest(world.x, world.y);
    if (!hit) {
      this.resetView();
      return;
    }
    if (hit.kind === 'node') {
      this.onNodeDoubleClick?.(hit.node);
      return;
    }
    if (hit.kind === 'frame-header') {
      this._beginInlineEdit(hit.frame, 'title');
      return;
    }
    if (hit.kind === 'note') {
      this._beginInlineEdit(hit.frame, 'text');
    }
  }

  // ─────────────────────── 就地编辑 ───────────────────────

  /**
   * 在画布上就地编辑一个装饰件的标题 / 正文。
   *
   * 为什么不用 `window.prompt`：分组框的标题、注释的正文都是要**边看画面边写**的，
   * 弹窗会把整块画布盖住。这里在画布上盖一个和元素等大的 textarea，
   * 所见即所得。
   *
   * @param {object} frame
   * @param {'title'|'text'} field
   */
  _beginInlineEdit(frame, field) {
    this._closeInlineEdit();
    const stage = this.canvas.parentElement;
    if (!stage) return;
    const multiline = field === 'text';
    const rect = {
      x: frame.x,
      y: field === 'title' ? frame.y : frame.y,
      w: frame.w,
      h: field === 'title' ? FRAME_HEADER_HEIGHT : frame.h,
    };
    const screen = this.toScreen(rect.x, rect.y);
    const zoom = this.view.zoom;

    const editor = h('textarea.swb-canvas-editor', {
      value: field === 'title' ? frame.title ?? '' : frame.text ?? '',
      spellcheck: 'false',
      placeholder: multiline ? '写点说明…（Esc 取消，Ctrl+Enter 确定）' : '分组标题',
      style: {
        left: `${this.canvas.offsetLeft + screen.x}px`,
        top: `${this.canvas.offsetTop + screen.y}px`,
        width: `${Math.max(80, rect.w * zoom)}px`,
        height: `${Math.max(24, rect.h * zoom)}px`,
        fontSize: `${Math.max(10, (multiline ? 11.5 : 11.5) * zoom)}px`,
      },
    });

    const commit = (save) => {
      if (this._inlineEdit !== editor) return;
      this._closeInlineEdit();
      if (!save) return;
      const value = editor.value;
      const current = this.frames().find((f) => f.id === frame.id);
      if (!current) return;
      if ((current[field] ?? '') === value) return;
      this._commit(field === 'title' ? '改分组框标题' : '改注释内容', () => {
        current[field] = value;
      });
      this._emit({ reason: 'update-frame', frameId: frame.id });
    };

    editor.addEventListener('blur', () => commit(true));
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        commit(false);
        return;
      }
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit(true);
        return;
      }
      // 别让画布的快捷键（空格平移、Delete 删节点）在打字时触发
      event.stopPropagation();
    });

    stage.append(editor);
    this._inlineEdit = editor;
    editor.focus();
    editor.select?.();
  }

  /** 关掉就地编辑框（如果有）。 */
  _closeInlineEdit() {
    const editor = this._inlineEdit;
    if (!editor) return;
    this._inlineEdit = null;
    editor.remove();
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
    this._commit(`新增节点 ${def.title ?? type}`, () => {
      this.graph.nodes = [...(this.graph.nodes ?? []), node];
      const pass = this.graph.passes?.find((p) => p.name === this.pass);
      if (pass) pass.graph = [...(pass.graph ?? []), node.id];
    });
    this.selection = new Set([node.id]);
    this.selectedFrame = null;
    this._emit({ reason: 'add-node', nodeId: node.id });
    return node;
  }

  /** 删除选中节点（连带它们的连线）。 */
  deleteSelected() {
    if (this.selection.size === 0) return;
    const ids = new Set(this.selection);
    this._commit(`删除 ${ids.size} 个节点`, () => {
      this.graph.nodes = (this.graph.nodes ?? []).filter((n) => !ids.has(n.id));
      this.graph.edges = (this.graph.edges ?? []).filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
      for (const pass of this.graph.passes ?? []) {
        if (Array.isArray(pass.graph)) pass.graph = pass.graph.filter((id) => !ids.has(id));
      }
    });
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
    if (copies.length === 0) return;
    // 内部连线也复制一份
    const internal = (this.graph.edges ?? []).filter((e) => map.has(e.from.node) && map.has(e.to.node));
    this._commit(`复制 ${copies.length} 个节点`, () => {
      this.graph.nodes = [...(this.graph.nodes ?? []), ...copies];
      const pass = this.graph.passes?.find((p) => p.name === this.pass);
      if (pass) pass.graph = [...(pass.graph ?? []), ...copies.map((c) => c.id)];
      this.graph.edges = [
        ...(this.graph.edges ?? []),
        ...internal.map((e) => ({
          id: `e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          from: { node: map.get(e.from.node), port: e.from.port },
          to: { node: map.get(e.to.node), port: e.to.port },
        })),
      ];
    });
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
    this._commit(`打成 Group（${selected.length} 节点）`, () => {
      this.graph.nodes = [...all.filter((n) => !innerIds.has(n.id)), groupNode];
      this.graph.edges = [
        ...edges.filter((e) => !innerIds.has(e.from.node) && !innerIds.has(e.to.node)),
        ...outerEdges.map((e) => ({ id: newId('e'), ...e })),
      ];
      const pass = this.graph.passes?.find((p) => p.name === this.pass);
      if (pass) {
        pass.graph = [...(pass.graph ?? []).filter((id) => !innerIds.has(id)), groupId];
      }
    });

    this.selection = new Set([groupId]);
    this.selectedFrame = null;
    this._emit({ reason: 'group-nodes', nodeId: groupId });
    return groupNode;
  }

  /** 拆开选中的组：子图还原回画布。 */
  ungroupSelection() {
    const targets = (this.graph.nodes ?? []).filter((n) => this.selection.has(n.id) && n.type === 'group');
    if (targets.length === 0) return 0;

    let restored = 0;
    this._commit(`拆开 Group（${targets.length} 个）`, () => {
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
    });

    this.selection.clear();
    this._emit({ reason: 'ungroup-nodes' });
    return restored;
  }

  /**
   * 改某节点的参数。
   *
   * 带 `mergeKey`：拖滑杆会连续触发几十次，靠 `HISTORY_MERGE_MS` 窗口
   * 把它们并成一步撤销，而不是每动一像素占一步。
   *
   * @param {string} nodeId
   * @param {string} key
   * @param {any} value
   * @param {object} [opts]
   * @param {boolean} [opts.silent] 不 emit（参数面板自己在拖滑杆时用，免得面板被重画、拖拽断掉）
   */
  setParam(nodeId, key, value, opts = {}) {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    this._commit(
      `改参数 ${key}`,
      () => { node.params = { ...node.params, [key]: value }; },
      { mergeKey: `param:${nodeId}:${key}` },
    );
    if (opts.silent !== true) this._emit({ reason: 'set-param', nodeId, key });
  }

  /**
   * 公开的「改图并记一步撤销」入口。
   *
   * 给工作台里其他会动图的模块用（比如参数面板增删 uniform）：
   * 它们和图共用同一个对象，但快照要在这里拍，才拍得到「改动前」。
   *
   * @param {string} label 操作名
   * @param {() => void} fn
   */
  commitGraph(label, fn) {
    return this._commit(label, fn);
  }

  /**
   * 改某个 uniform 的值。
   *
   * uniform 值挂在 `graph.uniforms[]` 上、也会被存进材质文件，所以它和图结构
   * 共用同一个撤销栈 —— 否则「撤销」会把一次无关的滑杆调整一起带回去。
   *
   * @param {string} name
   * @param {any} value
   */
  setUniformValue(name, value) {
    const uniform = (this.graph.uniforms ?? []).find((u) => u.name === name);
    if (!uniform) return;
    this._commit(`改参数 ${name}`, () => { uniform.value = value; }, { mergeKey: `uniform:${name}` });
  }

  /**
   * 断开某输入端口的连线。
   * @param {string} nodeId
   * @param {string} portId
   */
  disconnectInput(nodeId, portId) {
    this._commit('断开连线', () => {
      this.graph.edges = (this.graph.edges ?? []).filter((e) => !(e.to.node === nodeId && e.to.port === portId));
    });
    this._emit({ reason: 'disconnect' });
  }

  /**
   * 断开某输出端口的全部连线。
   * @param {string} nodeId
   */
  disconnectOutputs(nodeId) {
    this._commit('断开全部输出', () => {
      this.graph.edges = (this.graph.edges ?? []).filter((e) => e.from.node !== nodeId);
    });
    this._emit({ reason: 'disconnect' });
  }

  /**
   * 清空当前 Pass。
   */
  clearPass() {
    const pass = this.graph.passes?.find((p) => p.name === this.pass);
    if (!pass) return;
    this._commit('清空当前 Pass', () => {
      const ids = new Set(pass.graph ?? []);
      this.graph.nodes = (this.graph.nodes ?? []).filter((n) => !ids.has(n.id));
      this.graph.edges = (this.graph.edges ?? []).filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
      pass.graph = [];
    });
    this.selection.clear();
    this._emit({ reason: 'clear-pass' });
  }

  /**
   * 往当前 Pass 里塞一个「能出画面」的最小图。
   *
   * 整段包在**一个** `_commit` 里：内部 addNode/_link 的嵌套提交会被合并，
   * 所以插一次模板 = 一步撤销。
   *
   * @param {string} kind 'plasma' | 'gradient'
   */
  insertTemplate(kind) {
    const x0 = 80;
    const y0 = 90;

    this._commit(`插入示例：${kind === 'gradient' ? '渐变' : '等离子球'}`, () => {
      if (kind === 'gradient') {
        const uv = this.addNode('uv', x0, y0);
        const grad = this.addNode('palette', x0 + 240, y0);
        const out = this.addNode('output', x0 + 480, y0);
        if (!uv || !grad || !out) return;
        this._link([
          [uv.id, 'out', grad.id, 't'],
          [grad.id, 'out', out.id, 'color'],
        ]);
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
    });
    this.fitView();
  }

  /**
   * 内部用：批量加连线（跳过已存在与非法项）。
   *
   * 单独调用算一步撤销；被 `insertTemplate` 这类外层 `_commit` 包住时自动并入外层。
   *
   * @param {Array<[string,string,string,string]>} list [fromNode, fromPort, toNode, toPort]
   */
  _link(list) {
    this._commit('连线', () => {
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
      if (added.length > 0) this.graph.edges = [...(this.graph.edges ?? []), ...added];
    });
    this._emit({ reason: 'template' });
  }

  /**
   * 取某个世界坐标落在哪个装饰件上（不论标题栏还是框体）。
   *
   * `hitTest` 故意让分组框的**框体**落到节点层去（否则大框挡节点），
   * 但右键菜单需要「点到框里也算点到框」，所以这里单独来一发。
   *
   * @param {number} worldX
   * @param {number} worldY
   * @returns {object|null}
   */
  frameAt(worldX, worldY) {
    const frames = this.frames();
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i];
      if (worldX >= frame.x && worldX <= frame.x + frame.w && worldY >= frame.y && worldY <= frame.y + frame.h) {
        return frame;
      }
    }
    return null;
  }

  /** 在指定位置弹右键菜单。 */
  _openContextMenu(e, hit) {
    const items = [];
    const world = this.toWorld(e.clientX, e.clientY);
    // hit 落在框体上时为 null，这里补一次装饰件命中，右键才有分组框菜单
    const frameHit = hit?.frame ?? this.frameAt(world.x, world.y);

    if (frameHit) {
      const isNote = frameHit.kind === 'note';
      items.push(menuItem('选中框内节点', () => {
        const n = this.selectNodesInFrame(frameHit);
        this._setStatus(n > 0 ? `已选中框内 ${n} 个节点` : '框里没有节点', n > 0 ? 'info' : 'warn');
      }));
      items.push(menuItem(isNote ? '编辑注释内容' : '改分组框标题', () => this._beginInlineEdit(frameHit, isNote ? 'text' : 'title')));
      items.push(h('div.swb-menu__sep'));
      for (const color of FRAME_COLOR_KEYS) {
        items.push(menuItem(`${frameHit.color === color ? '● ' : '　'}配色：${FRAME_COLOR_LABELS[color]}`, () => {
          this.updateFrame(frameHit.id, { color }, '改装饰件配色');
          this.selectFrame(frameHit.id);
        }));
      }
      items.push(h('div.swb-menu__sep'));
      items.push(menuItem(isNote ? '删除注释' : '删除分组框', () => this.deleteFrame(frameHit.id), { tone: 'danger' }));
      items.push(menuItem('适应视图', () => this.fitView(), { shortcut: '0' }));
      popup(items, e.clientX, e.clientY);
      return;
    }

    if (hit?.kind === 'node') {
      const node = hit.node;
      const def = getNodeDef(node.type);
      items.push(menuItem(`复制「${def?.title ?? node.type}」`, () => this.duplicateSelected(), { shortcut: 'Ctrl+D' }));
      if (def && def.inputs.length > 0) {
        items.push(menuItem('断开全部输入', () => {
          this._commit('断开全部输入', () => {
            this.graph.edges = (this.graph.edges ?? []).filter((ed) => ed.to.node !== node.id);
          });
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
      items.push(h('div.swb-menu__sep'));
      items.push(menuItem('新建分组框', () => this.addFrame('frame', world.x, world.y)));
      items.push(menuItem('新建注释', () => this.addFrame('note', world.x, world.y)));
      items.push(h('div.swb-menu__sep'));
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

/**
 * 按像素宽度把一段文字折成多行（注释便签用）。
 *
 * 中文没有词间空格，按空格切会整段溢出，所以这里把**每个中日韩字符**都当成
 * 一个可断点；拉丁文仍按单词断，免得英文单词被从中间劈开。
 *
 * @param {CanvasRenderingContext2D} ctx 已经设好 font 的上下文
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapText(ctx, text, maxWidth) {
  const limit = Math.max(24, maxWidth);
  const out = [];
  // 中日韩文字 / 全角标点：单字成 token；连续非空白非中日韩：整段成 token；空白：保留
  const TOKEN = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+|\s+/g;
  for (const paragraph of String(text).split('\n')) {
    const tokens = paragraph.match(TOKEN) ?? [];
    let line = '';
    for (const token of tokens) {
      const next = line + token;
      if (line !== '' && ctx.measureText(next).width > limit) {
        out.push(line);
        line = token.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

export { NODE_WIDTH, HEADER_HEIGHT, PORT_COLORS };
