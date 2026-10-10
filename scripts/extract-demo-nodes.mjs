/**
 * 把只服务某个 demo 的「特殊节点」从内置节点库里**拆出去**，改成示例自带的用户节点。
 *
 * 拆的是这三个（库里仅剩的、带大段 glslPrelude 的效果专用节点）：
 *
 *   | 节点            | prelude | 只被谁用                |
 *   |-----------------|---------|------------------------|
 *   | `ifsTunnel`     | 2.0 KB  | demo                   |
 *   | `fourierSeries` | 3.5 KB  | fourier-series / -spectrum |
 *   | `epicycles`     | 12 KB   | fourier-epicycles      |
 *
 * 为什么该拆：内置节点 = 插件源码 = 每个用不上它的人也得背着，改一次还要动源码。
 * 用户节点写在 `<工作区>/library/nodes/*.json`，**随示例走**：载入示例时装进工作区，
 * 不碰插件源码、不重启。这才是"效果应该是图/数据，不是代码"。
 *
 * 搬的时候字段**原样搬运**，所以生成的 GLSL 必须逐字节一致 —— 脚本最后会自己验：
 * 拿搬完的定义重新编译每个示例，和仓库里存的 `.frag` 对比，不一样就报错退出。
 *
 * 跑法：node scripts/extract-demo-nodes.mjs [--check]
 *   --check 只校验、不写文件
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/Projects/DSHP/dsh-shader-workbench';
const WORKSPACE_ROOT = 'D:/Projects/DSHP/shader-workbench';
const CHECK_ONLY = process.argv.includes('--check');

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href);
const { NODE_BY_TYPE } = await load('shared/index.js');
const { parseUserNodeFiles } = await load('shared/user-nodes.js');
const { setUserNodes } = await load('shared/index.js');
const { compileGraph } = await load('client/runtime/codegen.js');

/** 谁搬去哪儿。 */
const MOVE = {
  ifsTunnel: ['demo'],
  fourierSeries: ['fourier-series', 'fourier-spectrum'],
  epicycles: ['fourier-epicycles'],
};

/**
 * 内置节点定义 → 用户节点 JSON（字段一一对应，不丢东西）。
 * @param {object} def
 * @returns {object}
 */
function toUserNodeJson(def) {
  const port = (p) => ({
    id: p.id,
    type: p.type,
    label: p.label ?? p.id,
    ...(p.def !== undefined ? { def: p.def } : {}),
  });
  return {
    type: def.type,
    title: def.title,
    category: def.category,
    doc: def.doc ?? '',
    inputs: (def.inputs ?? []).map(port),
    outputs: (def.outputs ?? []).map(port),
    params: def.params ?? {},
    glslPrelude: def.glslPrelude ?? '',
    code: def.code,
    ...(def.defaults ? { defaults: def.defaults } : {}),
  };
}

// ── 1. 生成 JSON ──────────────────────────────────────────────

const written = [];
for (const [type, examples] of Object.entries(MOVE)) {
  const def = NODE_BY_TYPE.get(type);
  if (!def) {
    console.log(`· ${type} 已经不在内置库里了，跳过（可能已经拆过）`);
    continue;
  }
  if (!def.glslPrelude) throw new Error(`${type} 没有 glslPrelude，不该走这个脚本`);
  const json = `${JSON.stringify(toUserNodeJson(def), null, 2)}\n`;

  // 每个用到它的示例各带一份，示例才是自包含的
  for (const example of examples) {
    const dir = join(PLUGIN, 'examples', example, 'library', 'nodes');
    const file = join(dir, `${type}.json`);
    if (!CHECK_ONLY) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, json, 'utf8');
    }
    written.push({ type, example, file, bytes: json.length });
  }

  // 工作区里已经建好的项目也要能继续跑 —— 顺手装进工作区的用户节点目录
  const wsDir = join(WORKSPACE_ROOT, 'library', 'nodes');
  if (!CHECK_ONLY && existsSync(join(WORKSPACE_ROOT, 'library'))) {
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, `${type}.json`), json, 'utf8');
  }
}

for (const w of written) {
  console.log(`· ${w.type.padEnd(15)} → examples/${w.example}/library/nodes/${w.type}.json  (${(w.bytes / 1024).toFixed(1)} KB)`);
}

// ── 2. 用搬完的定义把每个示例重新编译一遍，和仓库里的 .frag 对比 ──

// 按 type 去重：同一个节点可能被两个示例各带一份（比如 fourierSeries），
// 装进工作区时按 `<type>.json` 落文件，本来就是同一份。
const entriesByType = new Map();
for (const [, examples] of Object.entries(MOVE)) {
  for (const example of examples) {
    const dir = join(PLUGIN, 'examples', example, 'library', 'nodes');
    if (!existsSync(dir)) continue;
    for (const name of readdirSafe(dir)) {
      const json = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      entriesByType.set(json.type, { name: `${example}/${name}`, json });
    }
  }
}
const parsed = parseUserNodeFiles([...entriesByType.values()]);
if (parsed.errors.length > 0) {
  console.error('✗ 用户节点解析失败：', JSON.stringify(parsed.errors, null, 2));
  process.exit(1);
}
setUserNodes(parsed.defs);
console.log(`\n注册了 ${parsed.defs.length} 个用户节点：${parsed.defs.map((d) => d.type).join(', ')}`);

let checked = 0;
let drift = 0;
for (const example of ['demo', 'fourier-series', 'fourier-spectrum', 'fourier-epicycles']) {
  const matsDir = join(PLUGIN, 'examples', example, 'materials');
  for (const material of readdirSafe(matsDir)) {
    const dir = join(matsDir, material);
    const graph = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8'));
    // 示例里存的 uniforms 在图里，直接拿来编译
    const compiled = compileGraph(graph, 'image', { uniforms: graph.uniforms ?? [] });
    if (!compiled.ok) {
      console.error(`✗ ${example}/${material} 编译不过：${JSON.stringify(compiled.errors)}`);
      drift += 1;
      continue;
    }
    const stored = `${material}.frag`;
    if (!existsSync(join(dir, stored))) continue;
    const before = readFileSync(join(dir, stored), 'utf8');
    if (before !== compiled.code) {
      console.error(`✗ ${example}/${material}：搬完之后生成的 GLSL 和原来不一致`);
      drift += 1;
    }
    checked += 1;
  }
}

console.log(`\n逐字节对比：${checked} 个材质，${drift} 个不一致`);
if (drift > 0) process.exit(1);
console.log(CHECK_ONLY ? '只校验模式，没写任何文件。' : '完成。接下来从 shared/nodelib.js 里删掉这三个定义。');

/** @param {string} dir */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
