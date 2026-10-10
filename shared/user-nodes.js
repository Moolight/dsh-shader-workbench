/**
 * 用户节点：从 JSON 定义一个节点，**不用改插件源码、不用重启**。
 *
 * 为什么要它：节点定义以前只存在于 `shared/nodelib.js` 里，也就是"只有改代码才能加节点"。
 * 而改代码 = 宿主进程里的 ESM 缓存不会更新 = 必须重启 DSH 才认得。这不可持续。
 *
 * 现在节点可以写在 `<工作区>/library/nodes/*.json` 里，字段和内置节点一一对应：
 *
 * ```json
 * {
 *   "type": "myGlow",
 *   "title": "我的辉光",
 *   "category": "自定义",
 *   "doc": "一句话说明",
 *   "inputs":  [{ "id": "uv", "type": "vec2", "label": "uv", "def": 0 }],
 *   "outputs": [{ "id": "out", "type": "vec4" }],
 *   "params":  { "gain": { "type": "float", "value": 1, "min": 0, "max": 4, "label": "增益" } },
 *   "glslPrelude": "vec4 st_myGlow(vec2 uv, float g) { return vec4(uv, 0.0, 1.0) * g; }",
 *   "code": "st_myGlow($in.uv, $p.gain)",
 *   "defaults": { "uv": 0 }
 * }
 * ```
 *
 * 校验很严：**写错了要当场报清楚是哪个文件哪一行**，而不是等生成出一段编译不过的 GLSL。
 *
 * @module dsh-shader-workbench/shared/user-nodes
 */

import { PORT_TYPES, defineNode, port } from './graph.js';
import { PARAM_TYPES } from './nodes.js';

/** 节点 type 的合法写法。 */
const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 抛一个带来源的错。
 * @param {string} source
 * @param {string} message
 * @returns {never}
 */
function bad(source, message) {
  throw new Error(`${source || '用户节点'}：${message}`);
}

/**
 * 校验并冻结一个用户节点定义。
 *
 * @param {unknown} raw JSON 解析后的对象
 * @param {string} [source] 来源（文件名），错误信息里会带上
 * @returns {object} 冻结后的节点定义
 */
export function parseUserNodeDefinition(raw, source = '') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(source, '顶层必须是一个 JSON 对象');

  const type = raw.type;
  if (typeof type !== 'string' || !TYPE_RE.test(type)) {
    bad(source, `type 必须是标识符（字母/下划线开头），收到 ${JSON.stringify(type)}`);
  }
  if (raw.title === undefined || typeof raw.title !== 'string' || raw.title.trim() === '') {
    bad(source, 'title 不能为空');
  }
  if (raw.category === undefined || typeof raw.category !== 'string' || raw.category.trim() === '') {
    bad(source, 'category 不能为空');
  }
  if (typeof raw.code !== 'string' || raw.code.trim() === '') {
    bad(source, 'code 不能为空（必须是**单条 GLSL 表达式**）');
  }
  if (raw.code.includes(';')) {
    bad(source, 'code 里不能有分号 —— 生成器写的是 `vec4 x = <表达式>;`，只能放单条表达式。要写循环/多语句请用 glslPrelude');
  }
  if (raw.glslPrelude !== undefined && typeof raw.glslPrelude !== 'string') {
    bad(source, 'glslPrelude 必须是字符串');
  }

  const ports = (list, dir) => {
    const out = [];
    if (list === undefined) return out;
    if (!Array.isArray(list)) bad(source, `${dir} 必须是数组`);
    for (const [index, item] of list.entries()) {
      if (item === null || typeof item !== 'object') bad(source, `${dir}[${index}] 必须是对象`);
      const id = item.id;
      if (typeof id !== 'string' || !TYPE_RE.test(id)) {
        bad(source, `${dir}[${index}].id 必须是标识符，收到 ${JSON.stringify(id)}`);
      }
      if (!PORT_TYPES.includes(item.type)) {
        bad(source, `${dir}[${index}].type 非法：${JSON.stringify(item.type)}（可选 ${PORT_TYPES.join(' / ')}）`);
      }
      const meta = { label: typeof item.label === 'string' ? item.label : id };
      if (item.def !== undefined) meta.def = item.def;
      out.push(port(id, item.type, meta));
    }
    const ids = out.map((p) => p.id);
    if (new Set(ids).size !== ids.length) bad(source, `${dir} 里有重复的端口 id`);
    return out;
  };

  const inputs = ports(raw.inputs, 'inputs');
  const outputs = ports(raw.outputs, 'outputs');

  const params = {};
  if (raw.params !== undefined) {
    if (raw.params === null || typeof raw.params !== 'object' || Array.isArray(raw.params)) {
      bad(source, 'params 必须是对象');
    }
    for (const [key, meta] of Object.entries(raw.params)) {
      if (!TYPE_RE.test(key)) bad(source, `params 的键必须是标识符：${key}`);
      if (meta === null || typeof meta !== 'object') bad(source, `params.${key} 必须是对象`);
      if (!PARAM_TYPES.includes(meta.type)) {
        bad(source, `params.${key}.type 非法：${JSON.stringify(meta.type)}（可选 ${PARAM_TYPES.join(' / ')}）`);
      }
      params[key] = { ...meta };
    }
  }

  const defaults = {};
  if (raw.defaults !== undefined) {
    if (raw.defaults === null || typeof raw.defaults !== 'object' || Array.isArray(raw.defaults)) {
      bad(source, 'defaults 必须是对象');
    }
    for (const [key, value] of Object.entries(raw.defaults)) defaults[key] = value;
  }

  return defineNode({
    type,
    title: raw.title.trim(),
    category: raw.category.trim(),
    doc: typeof raw.doc === 'string' ? raw.doc : '',
    inputs,
    outputs,
    params,
    code: raw.code,
    ...(typeof raw.glslPrelude === 'string' && raw.glslPrelude !== '' ? { glslPrelude: raw.glslPrelude } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    // 标记来源：面板上要和内置节点区分开
    userDefined: true,
  });
}

/**
 * 批量解析。单个文件写坏了不该让整批都装不上 —— 坏的收集到 `errors` 里照常返回。
 *
 * @param {Array<{name:string, json:unknown}>} entries
 * @returns {{defs: object[], errors: Array<{source:string, message:string}>}}
 */
export function parseUserNodeFiles(entries) {
  const defs = [];
  const errors = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    try {
      const def = parseUserNodeDefinition(entry.json, entry.name);
      if (seen.has(def.type)) {
        errors.push({ source: entry.name, message: `节点类型 ${def.type} 重复，后面的忽略` });
        continue;
      }
      seen.add(def.type);
      defs.push(def);
    } catch (error) {
      errors.push({ source: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { defs, errors };
}
