/**
 * Shadertoy 导入：把一段 Shadertoy 的 `mainImage()` 源码变成工作台能用的
 * 「用户节点 + 图」。
 *
 * ## 为什么落成「用户节点」而不是改材质模型
 *
 * 工作台本来就有一套**用户节点**机制（`<工作区>/library/nodes/*.json`）：
 * 定义里可以带 `glslPrelude`（任意 GLSL 前置代码）和 `code`（调用表达式），
 * 正好能装下「一整段自定义 GLSL」。走这条路，导入不需要改 codegen、
 * 不需要新增材质类型，也不会让「预览 / 热重载 / 导出」三条路各写一遍。
 *
 * ## 包装方式
 *
 * Shadertoy 的入口是：
 *
 * ```glsl
 * void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
 * ```
 *
 * 而工作台的节点 prelude 是「一段自由代码」，所以我们把它包成一个**有返回值的函数**：
 *
 * ```glsl
 * vec4 st_shadertoyMain(vec2 fragCoord) {
 *   vec4 fragColor = vec4(0.0, 0.0, 0.0, 1.0);
 *   ...原来的函数体...
 *   return fragColor;
 * }
 * ```
 *
 * 两个细节：
 *   - 函数体里裸的 `return;` 会改写成 `return fragColor;`（Shadertoy 允许提前退出）；
 *   - `mainImage` 之外的代码（`#define`、辅助函数、`const`）原样保留，放在包装函数旁边。
 *
 * ## 已知边界（不猜、直接说）
 *
 * - 只认 `mainImage` 这一种入口写法，找不到就报错而不是猜；
 * - 不解析 `#define`，所以用宏拼出来的奇怪调用可能包装后编译不过 ——
 *   这种情况交给用户在节点定义里改；
 * - 如果源码里自带 `void main()`（有些 Shadertoy 备份会带），会给出警告并**移除**它，
 *   否则会和生成器产出的 `main()` 撞名。
 *
 * @module dsh-shader-workbench/shared/shadertoy-import
 */

import { BUFFER_NAMES, CHANNEL_SLOTS, makeEdge, makeGraph, makeNode } from './graph.js';

/** 导入后生成的节点 type。 */
export const SHADERTOY_NODE_TYPE = 'shadertoyMain';
/** 包装函数名（带 `st_` 前缀，避免和用户代码撞名）。 */
export const SHADERTOY_ENTRY = 'st_shadertoyMain';

/** Shadertoy 入口函数的签名。 */
const MAIN_IMAGE_RE = /\bvoid\s+mainImage\s*\(\s*(?:out\s+)?vec4\s+(\w+)\s*,\s*(?:in\s+)?vec2\s+(\w+)\s*\)/;

/**
 * 从 `start`（必须是 `{`）找到配对的 `}`，跳过注释与字符串。
 *
 * 不能用「数括号」的朴素写法：Shadertoy 代码里注释和字符串中出现花括号很常见，
 * 数错一个整段代码就废了。
 *
 * @param {string} source
 * @param {number} start
 * @returns {number} `}` 的下标，找不到返回 -1
 */
function matchBrace(source, start) {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 从 Shadertoy 源码里切出 `mainImage`。
 *
 * @param {string} source
 * @returns {{fragColor:string, fragCoord:string, start:number, bodyStart:number, bodyEnd:number, end:number, body:string}|null}
 */
export function extractMainImage(source) {
  const text = String(source ?? '');
  const match = MAIN_IMAGE_RE.exec(text);
  if (!match) return null;
  const braceStart = text.indexOf('{', match.index + match[0].length);
  if (braceStart < 0) return null;
  const braceEnd = matchBrace(text, braceStart);
  if (braceEnd < 0) return null;
  return {
    fragColor: match[1],
    fragCoord: match[2],
    start: match.index,
    bodyStart: braceStart,
    bodyEnd: braceEnd,
    end: braceEnd + 1,
    body: text.slice(braceStart + 1, braceEnd),
  };
}

/**
 * 扫一遍源码，看它用到了哪些 Shadertoy 内建。
 *
 * 这些不是「猜」，而是纯文本扫描 —— 用来告诉用户「这份材质要绑几个纹理槽」，
 * 以及提醒 Buffer pass 才能用 `iFrame`。
 *
 * @param {string} source
 * @returns {{channels:string[], buffers:string[], usesFrame:boolean, usesMouse:boolean, usesDate:boolean, usesTime:boolean, usesTimeDelta:boolean}}
 */
export function detectShadertoyFeatures(source) {
  const text = String(source ?? '');
  const has = (name) => new RegExp(`\\b${name}\\b`).test(text);
  return {
    channels: CHANNEL_SLOTS.filter((ch) => has(ch)),
    buffers: BUFFER_NAMES.filter((buf) => has(buf)),
    usesFrame: has('iFrame'),
    usesMouse: has('iMouse'),
    usesDate: has('iDate'),
    usesTime: has('iTime'),
    usesTimeDelta: has('iTimeDelta'),
  };
}

/** 按缩进把一段代码逐行右移。 */
function indent(text, pad) {
  return text.split('\n').map((line) => (line.trim() === '' ? line : pad + line)).join('\n');
}

/**
 * 去掉公共缩进。
 *
 * Shadertoy 的 `mainImage` 函数体本身就带一层缩进，直接再缩一层会越缩越深，
 * 读起来很难受。所以先削掉公共前缀再重新缩。
 */
function dedent(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  if (nonEmpty.length === 0) return text;
  const min = Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/)[0].length));
  if (min === 0) return text;
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(min))).join('\n');
}

/**
 * 把 Shadertoy 源码包成节点 prelude。
 *
 * @param {string} source
 * @param {object} main `extractMainImage()` 的结果
 * @param {object} [opts]
 * @param {string} [opts.entry] 包装函数名
 * @returns {{prelude:string, warnings:string[]}}
 */
export function buildShadertoyPrelude(source, main, opts = {}) {
  const warnings = [];
  const entry = opts.entry ?? SHADERTOY_ENTRY;
  const before = source.slice(0, main.start);
  const after = source.slice(main.end);

  // 有些 Shadertoy 备份会自带一个 `void main()`；留着会和生成器产出的入口撞名
  const stripMain = (text, where) => {
    if (!/\bvoid\s+main\s*\(/.test(text)) return text;
    warnings.push(`源码${where}自带 void main()，已移除（会和生成器产出的入口撞名）`);
    const at = text.search(/\bvoid\s+main\s*\(/);
    const brace = text.indexOf('{', at);
    if (brace < 0) return text;
    const end = matchBrace(text, brace);
    if (end < 0) return text;
    return text.slice(0, at) + text.slice(end + 1);
  };

  const head = stripMain(before, '的 mainImage 之前').trim();
  const tail = stripMain(after, '的 mainImage 之后').trim();

  // Shadertoy 允许 `return;` 提前退出，我们包成了有返回值的函数，得补上返回值
  let body = main.body;
  const earlyReturns = (body.match(/\breturn\s*;/g) ?? []).length;
  if (earlyReturns > 0) {
    body = body.replace(/\breturn\s*;/g, `return ${main.fragColor};`);
    warnings.push(`函数体里有 ${earlyReturns} 处提前 return，已改写成 return ${main.fragColor};`);
  }

  const wrapper = [
    `vec4 ${entry}(vec2 ${main.fragCoord}) {`,
    `  vec4 ${main.fragColor} = vec4(0.0, 0.0, 0.0, 1.0);`,
    indent(dedent(body).trim(), '  '),
    `  return ${main.fragColor};`,
    '}',
  ].join('\n');

  const parts = [];
  parts.push('// ── 由 Shadertoy 源码导入 ──');
  if (head) parts.push(head);
  parts.push(wrapper);
  if (tail) parts.push(tail);

  return { prelude: parts.join('\n\n'), warnings };
}

/**
 * 生成用户节点定义（就是 `<工作区>/library/nodes/<type>.json` 的内容）。
 *
 * @param {object} main
 * @param {string} prelude
 * @param {object} [opts]
 * @returns {object}
 */
export function shadertoyNodeDefinition(main, prelude, opts = {}) {
  const type = opts.nodeType ?? SHADERTOY_NODE_TYPE;
  const entry = opts.entry ?? SHADERTOY_ENTRY;
  return {
    type,
    title: opts.title ?? 'Shadertoy 主函数',
    category: '自定义',
    doc: '从 Shadertoy 导入的 mainImage()。想改代码就直接编辑这个节点定义里的 glslPrelude。',
    inputs: [],
    outputs: [{ id: 'out', type: 'vec4' }],
    params: {},
    glslPrelude: prelude,
    // Shadertoy 的 fragCoord 是像素坐标、原点左下 —— 正是 gl_FragCoord 的口径
    code: `${entry}(gl_FragCoord.xy)`,
    defaults: {},
  };
}

/**
 * 一条龙：Shadertoy 源码 → `{ node, graph, features, warnings }`。
 *
 * @param {string} source
 * @param {object} [opts]
 * @param {string} [opts.name] 图名
 * @param {string} [opts.nodeType]
 * @param {string} [opts.sourceUrl] 来源链接（记进 metadata）
 * @returns {{node:object, graph:object, prelude:string, features:object, warnings:string[]}}
 */
export function importShadertoy(source, opts = {}) {
  const text = String(source ?? '');
  if (text.trim() === '') throw new Error('Shadertoy 源码是空的');

  const main = extractMainImage(text);
  if (!main) {
    throw new Error(
      '找不到 mainImage()。Shadertoy 的入口签名应当是 '
      + '`void mainImage(out vec4 fragColor, in vec2 fragCoord)`。',
    );
  }

  const features = detectShadertoyFeatures(text);
  const { prelude, warnings } = buildShadertoyPrelude(text, main, opts);
  const nodeDef = shadertoyNodeDefinition(main, prelude, opts);

  if (features.usesFrame) {
    warnings.push('代码里用了 iFrame，它只在 Buffer Pass 里有值；放在 image Pass 上会是 0。');
  }
  if (features.buffers.length > 0) {
    warnings.push(`代码里引用了 ${features.buffers.join(' / ')}，需要在图里补上对应的 Buffer Pass。`);
  }

  const shaderNode = makeNode(nodeDef.type, 120, 140);
  // 每个 Pass 必须有且只有一个 `output` 终止节点，它的 color 决定这个 Pass 写什么
  const outputNode = makeNode('output', 470, 150);
  const graph = makeGraph({
    name: opts.name ?? 'shadertoy',
    nodes: [shaderNode, outputNode],
    edges: [makeEdge(shaderNode.id, 'out', outputNode.id, 'color')],
    passes: [{ name: 'image', graph: [shaderNode.id, outputNode.id], frames: [] }],
    metadata: {
      version: '0.1.0',
      tags: ['shadertoy'],
      ...(opts.sourceUrl ? { source: opts.sourceUrl } : {}),
    },
  });

  return { node: nodeDef, graph, prelude, features, warnings, shaderNodeId: shaderNode.id, outputNodeId: outputNode.id };
}
