/**
 * 跨端数据模型：ShaderGraph / MaterialManifest / TextureRef / 事件总线。
 *
 * 硬性约束（本文件是全项目唯一的事实来源）：
 *  - 纯数据 + 纯函数，**零依赖**，浏览器的 runtime 与 Node 的 host 都要能 import。
 *  - 不出现任何 `window` / `document` / `process` / `node:` 前缀的东西。
 *  - 只做结构定义与归一化，不做渲染、不做文件读写。
 *
 * @module dsh-shader-workbench/shared/graph
 */

/** 当前图格式版本。改动 nodes/edges 结构时必须递增。 */
export const GRAPH_FORMAT_VERSION = 1;

/** Shadertoy 标准 Pass 名。`image` 是输出到屏幕的最终 Pass。 */
export const PASS_NAMES = ['image', 'BufferA', 'BufferB', 'BufferC', 'BufferD'];

/** `image` 之外可以被其它 Pass 采样的 Buffer。 */
export const BUFFER_NAMES = ['BufferA', 'BufferB', 'BufferC', 'BufferD'];

/** 每个 Pass 可用的纹理通道槽位。 */
export const CHANNEL_SLOTS = ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'];

/** 纹理引用类型。 */
export const TEXTURE_TYPES = ['image', 'dds', 'video'];

/** 纹理来源：本地导入 or ComfyUI 生成。 */
export const TEXTURE_SOURCES = ['local', 'comfyui'];

/** 端口数据类型，决定连线能不能接。 */
export const PORT_TYPES = ['float', 'vec2', 'vec3', 'vec4'];

/**
 * 画布上的**装饰件**类型。
 *
 * 这两个都只活在编辑器里，**完全不参与代码生成**：
 *   - `frame`：分组框，画布上一块带标题的区域，拖它会把框里的节点一起带走
 *   - `note` ：自由注释，一块带换行文本的便签
 *
 * 之所以放在图里（而不是编辑器内存里）：它们是图的一部分，
 * 存盘后重开必须还在 —— 否则每次打开材质都得重画一遍说明。
 */
export const FRAME_KINDS = ['frame', 'note'];

/** 装饰件配色名（具体色值在面板的 style/editor 里）。 */
export const FRAME_COLORS = ['blue', 'green', 'amber', 'violet', 'rose', 'slate'];

/** 单个 Pass 最多允许多少个装饰件（防止脏数据把画布塞爆）。 */
export const MAX_FRAMES_PER_PASS = 300;

/** 装饰件尺寸下限，避免被拖成 0 宽之后再也点不到。 */
export const MIN_FRAME_SIZE = 80;

/**
 * 建一个装饰件。
 * @param {'frame'|'note'} kind
 * @param {number} x
 * @param {number} y
 * @param {object} [over] 覆盖字段：w / h / title / text / color / id
 * @returns {object}
 */
export function makeFrame(kind, x, y, over = {}) {
  const k = FRAME_KINDS.includes(kind) ? kind : 'frame';
  return normalizeFrame({
    id: over.id ?? makeId('f'),
    kind: k,
    x,
    y,
    w: k === 'note' ? 240 : 360,
    h: k === 'note' ? 110 : 220,
    title: k === 'frame' ? '分组' : '',
    text: '',
    color: 'blue',
    ...over,
  });
}

/**
 * 归一化一个装饰件。非法输入返回 null。
 * @param {any} raw
 * @returns {object|null}
 */
export function normalizeFrame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!FRAME_KINDS.includes(raw.kind)) return null;
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const size = (value, fallback) => Math.max(MIN_FRAME_SIZE, Math.min(20000, num(value, fallback)));
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : makeId('f'),
    kind: raw.kind,
    x: Math.round(num(raw.x, 0)),
    y: Math.round(num(raw.y, 0)),
    w: Math.round(size(raw.w, 360)),
    h: Math.round(size(raw.h, 220)),
    // 文本截断：装饰件是给人看的，不需要承载无限内容
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    text: typeof raw.text === 'string' ? raw.text.slice(0, 4000) : '',
    color: FRAME_COLORS.includes(raw.color) ? raw.color : 'blue',
  };
}

/**
 * 归一化一个 Pass 的装饰件数组。永不抛错。
 * @param {any} raw
 * @returns {object[]}
 */
export function normalizeFrames(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const frame = normalizeFrame(item);
    if (!frame) continue;
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    out.push(frame);
    if (out.length >= MAX_FRAMES_PER_PASS) break;
  }
  return out;
}

/**
 * 端口：类型 + 缺省值。缺省值就是「这个输入没接线时用什么」。
 * 生成器读 `port.def` 作为未接线时的字面量，缺省按类型给 (0 / vecN(0))。
 *
 * @param {string} id 端口 id，节点内唯一
 * @param {string} type float | vec2 | vec3 | vec4
 * @param {object} [opt] label 显示名；def 未接线缺省值（数字或数组）
 * @returns {{id:string,type:string,label:string,def:any}}
 */
export function port(id, type, opt = {}) {
  if (!PORT_TYPES.includes(type)) throw new Error(`未知端口类型：${type}`);
  return { id, type, label: opt.label ?? id, def: opt.def };
}

/**
 * 建一个节点定义（节点库的条目）。定义在 shared/nodes.js。
 * @param {object} def
 * @returns {object} 冻结后的定义
 */
export function defineNode(def) {
  for (const key of ['type', 'title', 'category', 'inputs', 'outputs', 'code']) {
    if (def[key] === undefined) throw new Error(`节点定义缺字段 ${key}：${def.type ?? '?'}`);
  }
  for (const p of [...def.inputs, ...def.outputs]) {
    if (!PORT_TYPES.includes(p.type)) throw new Error(`节点 ${def.type} 的端口 ${p.id} 类型非法：${p.type}`);
  }
  return Object.freeze({ params: Object.freeze(def.params ?? {}), doc: def.doc ?? '', ...def });
}

/**
 * 端口能否相连。
 *
 * **任意两种端口类型都能连**：生成器（`castExpr`）对 4×4 种组合都有确定的转换规则，
 * 所以这里全部放行。之前只允许「同类型或带 float」是错的——它会让
 * `uv`(vec2) → `output`(vec4) 这种最基本的连法都连不上，
 * 而内置示例模板又绕过检查直接连，两边行为对不上。
 *
 * 有损与否由 `conversionKind` 单独描述：UI 该提示就提示，但不该阻止。
 *
 * @param {string} fromType 上游输出类型
 * @param {string} toType 下游输入类型
 * @returns {boolean}
 */
export function canConnect(fromType, toType) {
  return PORT_TYPES.includes(fromType) && PORT_TYPES.includes(toType);
}

/**
 * 描述一次连接会做什么样的类型转换，给 UI 提示用。
 *
 * | 返回值 | 含义 | 生成的代码 |
 * |---|---|---|
 * | `exact` | 类型相同，原样 | `x` |
 * | `broadcast` | 标量抬成向量 | `vecN(x)` |
 * | `extend` | 低维抬成高维 | `vec4(x.x, x.y, 0.0, 1.0)`（第 4 位补 1） |
 * | `truncate` | 高维降成低维 / 降到标量 | `vec2(x.x, x.y)` / `(x).x` |
 * | `invalid` | 类型名不合法 | — |
 *
 * @param {string} fromType
 * @param {string} toType
 * @returns {'exact'|'broadcast'|'extend'|'truncate'|'invalid'}
 */
export function conversionKind(fromType, toType) {
  if (!PORT_TYPES.includes(fromType) || !PORT_TYPES.includes(toType)) return 'invalid';
  if (fromType === toType) return 'exact';
  const size = (t) => (t === 'float' ? 1 : Number(t.slice(3)));
  const from = size(fromType);
  const to = size(toType);
  if (from === 1) return 'broadcast';
  if (to === 1) return 'truncate';
  return to > from ? 'extend' : 'truncate';
}

/**
 * 生成一个 id。刻意不用 crypto，避免两端差异。
 * @param {string} prefix
 * @returns {string}
 */
export function makeId(prefix = 'id') {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0');
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/**
 * 建一个节点实例。
 * @param {string} type 节点库里的 type
 * @param {number} x
 * @param {number} y
 * @param {object} [params]
 * @returns {object}
 */
export function makeNode(type, x, y, params = {}) {
  return { id: makeId('n'), type, x, y, params: { ...params } };
}

/**
 * 建一条连线。
 * @param {string} fromNode 上游节点 id
 * @param {string} fromPort 上游输出端口 id
 * @param {string} toNode 下游节点 id
 * @param {string} toPort 下游输入端口 id
 * @returns {object}
 */
export function makeEdge(fromNode, fromPort, toNode, toPort) {
  return { id: makeId('e'), from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

/**
 * 建一个空的 ShaderGraph。
 * @param {object} [over]
 * @returns {object}
 */
export function makeGraph(over = {}) {
  return normalizeGraph({
    id: makeId('g'),
    name: 'untitled',
    nodes: [],
    edges: [],
    uniforms: [],
    passes: [{ name: 'image', graph: null }],
    metadata: { version: '0.1.0', tags: [] },
    ...over,
  });
}

/**
 * 归一化一张图：补齐缺省字段、丢掉非法节点/连线、去重 id。
 * 这个函数必须**永不抛错**（脏数据会从磁盘上来），问题记进 `warnings`。
 *
 * @param {object} raw
 * @returns {object} 归一化后的图（多带一个 warnings 字段）
 */
export function normalizeGraph(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawNodes = Array.isArray(src.nodes) ? src.nodes : [];
  const seen = new Set();
  const nodes = [];
  for (const n of rawNodes) {
    if (!n || typeof n !== 'object') {
      warnings.push('丢了一个非对象节点');
      continue;
    }
    if (typeof n.type !== 'string' || n.type === '') {
      warnings.push(`节点 ${n.id ?? '?'} 缺 type，已丢`);
      continue;
    }
    const id = typeof n.id === 'string' && n.id !== '' ? n.id : makeId('n');
    if (seen.has(id)) {
      warnings.push(`节点 id 重复：${id}，已丢后一个`);
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      type: n.type,
      x: Number.isFinite(n.x) ? n.x : 0,
      y: Number.isFinite(n.y) ? n.y : 0,
      params: n.params && typeof n.params === 'object' ? { ...n.params } : {},
      annotation: typeof n.annotation === 'string' ? n.annotation : undefined,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const edgeSeen = new Set();
  for (const e of Array.isArray(src.edges) ? src.edges : []) {
    if (!e || typeof e !== 'object') continue;
    const from = e.from ?? {};
    const to = e.to ?? {};
    if (!byId.has(from.node) || !byId.has(to.node)) {
      warnings.push('丢了一条指向不存在节点的连线');
      continue;
    }
    const key = `${from.node}.${from.port}->${to.node}.${to.port}`;
    if (edgeSeen.has(key)) {
      warnings.push(`连线重复：${key}`);
      continue;
    }
    edgeSeen.add(key);
    edges.push({
      id: typeof e.id === 'string' && e.id !== '' ? e.id : makeId('e'),
      from: { node: from.node, port: String(from.port ?? 'out') },
      to: { node: to.node, port: String(to.port ?? 'in') },
    });
  }

  const uniforms = [];
  for (const u of Array.isArray(src.uniforms) ? src.uniforms : []) {
    if (!u || typeof u.name !== 'string' || u.name === '') continue;
    uniforms.push({
      name: u.name,
      type: PORT_TYPES.includes(u.type) ? u.type : 'float',
      value: u.value,
      min: Number.isFinite(u.min) ? u.min : undefined,
      max: Number.isFinite(u.max) ? u.max : undefined,
      label: typeof u.label === 'string' ? u.label : undefined,
      ui: u.ui === 'color' || u.ui === 'slider' || u.ui === 'angle' ? u.ui : undefined,
    });
  }

  const passes = [];
  for (const name of PASS_NAMES) {
    const found = Array.isArray(src.passes) ? src.passes.find((p) => p && p.name === name) : null;
    if (name !== 'image' && !found) continue;
    // `frames` 是编辑器层的装饰件（分组框 / 注释）。它**不参与代码生成**，
    // 但必须跟着图一起存下来，否则重开材质后画布上的说明就没了。
    passes.push({ name, graph: found?.graph ?? null, frames: normalizeFrames(found?.frames) });
  }
  if (!passes.some((p) => p.name === 'image')) passes.unshift({ name: 'image', graph: null, frames: [] });

  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id : makeId('g'),
    name: typeof src.name === 'string' && src.name !== '' ? src.name : 'untitled',
    version: GRAPH_FORMAT_VERSION,
    nodes,
    edges,
    uniforms,
    passes,
    metadata: {
      version: typeof src.metadata?.version === 'string' ? src.metadata.version : '0.1.0',
      tags: Array.isArray(src.metadata?.tags) ? src.metadata.tags.filter((t) => typeof t === 'string') : [],
      // 来源链接（Shadertoy 导入等会写）。只收非空字符串 —— 这个字段是要给人看的，
      // 留个空串或 null 只会让 UI 上多一个空行。以前这里没有白名单，导入时写进去的
      // 来源被**静默丢掉**了：不报错、不警告，用户以为记下来了其实没有。
      ...(typeof src.metadata?.source === 'string' && src.metadata.source.trim() !== ''
        ? { source: src.metadata.source.trim() }
        : {}),
    },
    warnings,
  };
}

/**
 * 取某个 Pass 的节点子图。`passes[].graph` 里存的是节点 id 列表；
 * 没配过的话该 Pass 视作空。
 * @param {object} graph 归一化后的图
 * @param {string} passName
 * @returns {{nodes:object[],edges:object[]}}
 */
export function passSubgraph(graph, passName) {
  const pass = graph.passes.find((p) => p.name === passName);
  if (!pass || !Array.isArray(pass.graph)) return { nodes: [], edges: [] };
  const ids = new Set(pass.graph);
  return {
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)),
  };
}

/**
 * 把一组节点/连线挂到某个 Pass 上（原地改 graph.passes）。
 * @param {object} graph
 * @param {string} passName
 * @param {string[]} nodeIds
 * @returns {object} graph
 */
export function setPassNodes(graph, passName, nodeIds) {
  let pass = graph.passes.find((p) => p.name === passName);
  if (!pass) {
    pass = { name: passName, graph: [], frames: [] };
    graph.passes.push(pass);
  }
  pass.graph = [...nodeIds];
  return graph;
}

/**
 * 取某个 Pass 的装饰件（分组框 / 注释）。
 * @param {object} graph
 * @param {string} passName
 * @returns {object[]}
 */
export function passFrames(graph, passName) {
  const pass = graph.passes?.find((p) => p.name === passName);
  return Array.isArray(pass?.frames) ? pass.frames : [];
}
