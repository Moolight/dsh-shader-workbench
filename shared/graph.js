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
    passes.push({ name, graph: found?.graph ?? null });
  }
  if (!passes.some((p) => p.name === 'image')) passes.unshift({ name: 'image', graph: null });

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
    pass = { name: passName, graph: [] };
    graph.passes.push(pass);
  }
  pass.graph = [...nodeIds];
  return graph;
}
