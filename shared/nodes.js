/**
 * 节点库：唯一事实来源。
 *
 * 每个节点定义 = 端口 + 参数 + 一段 GLSL **表达式**。
 * 表达式里的占位符：
 *   `$in.<端口id>`  → 该输入端口接上的表达式；没接线时用端口自己的 `def`
 *   `$p.<参数名>`   → 参数当前值（按参数类型序列化成 GLSL 字面量）
 *
 * 硬性约定：
 *  - `code` 必须是**单个 GLSL 表达式**，禁止分号、禁止语句序列。
 *    需要多步的节点用 `glslPrelude` 定义辅助函数，code 里只调用它。
 *  - 需要额外 GLSL 函数的节点在 `helpers` 里列函数名（见 GLSL_HELPERS）。
 *  - 接线时的类型转换由生成器负责（见 client/runtime/codegen.js）：
 *    float 接进 vecN → 广播；vecN 接进 float → 取 `.x`；vecN↔vecM → 截断/补零。
 *
 * ## 为什么这里的三个导出是**可变**的
 *
 * 它们以前是 `Object.freeze` 的模块级常量，只在**首次 import 那一刻**算一次。
 * 结果就是：新增一个节点必须重启宿主进程 —— 面板经 `/module/` 从磁盘现拉，
 * 刷新就生效；宿主是静态 import，进程活着就永远是旧的那一份。
 *
 * 现在改成**同一批对象、原地重建**：所有持有者拿到的还是同一个数组/Map 实例，
 * 注册表一变它们就跟着变，不需要谁去重新 import，也不需要重启。
 *
 * 定义本身仍然是冻结的（`defineNode` 会 freeze 每个 def），
 * 可变的只是"集合里有哪些定义"。
 *
 * @module dsh-shader-workbench/shared/nodes
 */

import { NODE_LIBRARY_RAW } from './nodelib.js';

export { GLSL_HELPERS, resolveHelpers, renderHelpers } from './glsl-helpers.js';

/** 参数类型表。决定 UI 怎么渲染控件、GLSL 怎么序列化。 */
export const PARAM_TYPES = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'color', 'select', 'text', 'graph'];

/** 内置节点（可被热重载整体替换）。 */
let builtinDefs = NODE_LIBRARY_RAW;
/** 用户节点（来自工作区 `library/nodes/*.json`）。 */
let userDefs = [];
/** type → 定义来自哪儿（`builtin` / `user`），用于诊断与 UI 标注。 */
const nodeSource = new Map();

/**
 * 完整节点库。
 *
 * ⚠️ **刻意不冻结、也不重新赋值**：注册表原地重建，所有持有者自动看到新节点。
 * 别改成 `export let` 或重新 `Object.freeze`，那会把运行时注册这条路堵死。
 * @type {object[]}
 */
export const NODE_LIBRARY = [];

/** type → 定义 的索引。同样是**同一个 Map 实例，原地更新**。 */
export const NODE_BY_TYPE = new Map();

/** 所有 category，按节点库里首次出现的顺序。 */
export const NODE_CATEGORIES = [];

/** 每次重建 +1，给 UI 做缓存失效用。 */
let version = 0;

/**
 * 节点库版本号。变了就说明节点集合动过（UI 可以据此重建列表）。
 * @returns {number}
 */
export function nodeLibraryVersion() {
  return version;
}

/**
 * 某个节点类型的来源。
 * @param {string} type
 * @returns {'builtin'|'user'|null}
 */
export function nodeSourceOf(type) {
  return nodeSource.get(type) ?? null;
}

/**
 * 原地重建三个导出（不重新赋值，保持引用稳定）。
 */
function rebuild() {
  const merged = [...builtinDefs];
  const seen = new Set(merged.map((def) => def.type));

  for (const def of userDefs) {
    // 用户节点不许顶掉内置节点：名字撞了就跳过，并留一条警告（在 setUserNodes 里收集）
    if (seen.has(def.type)) continue;
    merged.push(def);
    seen.add(def.type);
  }

  NODE_LIBRARY.length = 0;
  NODE_LIBRARY.push(...merged);

  NODE_BY_TYPE.clear();
  for (const def of merged) NODE_BY_TYPE.set(def.type, def);

  NODE_CATEGORIES.length = 0;
  for (const def of merged) {
    if (!NODE_CATEGORIES.includes(def.category)) NODE_CATEGORIES.push(def.category);
  }

  nodeSource.clear();
  for (const def of builtinDefs) nodeSource.set(def.type, 'builtin');
  for (const def of userDefs) if (!nodeSource.has(def.type)) nodeSource.set(def.type, 'user');

  version += 1;
}

/**
 * 换掉内置节点层（热重载用）。
 * @param {object[]} defs
 */
export function setBuiltinNodes(defs) {
  if (!Array.isArray(defs) || defs.length === 0) throw new Error('setBuiltinNodes 需要非空数组');
  builtinDefs = defs;
  rebuild();
}

/**
 * 换掉用户节点层。
 * @param {object[]} defs 已经过校验、冻结的定义
 * @returns {{registered: string[], skipped: string[]}} 撞名被跳过的会列在 skipped
 */
export function setUserNodes(defs) {
  const list = Array.isArray(defs) ? defs : [];
  const builtinTypes = new Set(builtinDefs.map((def) => def.type));
  const skipped = [];
  const kept = [];
  const seen = new Set();
  for (const def of list) {
    if (builtinTypes.has(def.type)) {
      skipped.push(def.type);
      continue;
    }
    if (seen.has(def.type)) {
      // 用户节点之间重名：先到先得
      skipped.push(def.type);
      continue;
    }
    seen.add(def.type);
    kept.push(def);
  }
  userDefs = kept;
  rebuild();
  return { registered: kept.map((def) => def.type), skipped };
}

/** 当前用户节点定义（只读用途）。 */
export function userNodeDefs() {
  return userDefs.slice();
}

/** 汇总信息，给面板/启动日志用。 */
export function nodeLibraryInfo() {
  return {
    version,
    total: NODE_LIBRARY.length,
    builtin: builtinDefs.length,
    user: NODE_LIBRARY.filter((def) => nodeSource.get(def.type) === 'user').map((def) => def.type),
    categories: [...NODE_CATEGORIES],
  };
}

rebuild();

/**
 * 取一个节点定义。
 * @param {string} type
 * @returns {object|undefined}
 */
export function getNodeDef(type) {
  return NODE_BY_TYPE.get(type);
}

/**
 * 某方向上的实际端口列表（考虑 `dynamicOut` 这类会随参数变形的节点）。
 *
 * `dir` 会作为第三个参数传给 `dynamicOut` —— 组（group）节点的入/出端口都由
 * params 里的子图决定，必须知道问的是哪一边。
 *
 * @param {object} node 节点实例
 * @param {'in'|'out'} dir
 * @returns {object[]}
 */
export function resolvePorts(node, dir) {
  const def = getNodeDef(node?.type);
  if (!def) return [];
  const ports = dir === 'in' ? def.inputs : def.outputs;
  if (typeof def.dynamicOut === 'function') return def.dynamicOut(node.params ?? {}, ports, dir) ?? ports;
  return ports;
}

/**
 * 节点某个端口的实际类型。
 * @param {object} node 节点实例
 * @param {'in'|'out'} dir
 * @param {string} portId
 * @returns {string|null}
 */
export function resolvePortType(node, dir, portId) {
  const found = resolvePorts(node, dir).find((p) => p.id === portId);
  return found ? found.type : null;
}

/**
 * 取一个节点实例某端口的有效定义（含缺省值）。
 * @param {object} node
 * @param {'in'|'out'} dir
 * @param {string} portId
 * @returns {object|null}
 */
export function resolvePort(node, dir, portId) {
  return resolvePorts(node, dir).find((p) => p.id === portId) ?? null;
}
