/**
 * 建 3 个傅里叶示例：写进运行期工作区，再拷成插件自带示例。
 *
 * 为什么走脚本而不是 shader_graph_build 工具：运行中的 DSH 进程内存里是旧节点库，
 * 认不出 fourierSeries / epicycles（要重启才认）。这个脚本直接 import 磁盘上的
 * 插件模块，路径与工具完全一致。
 *
 * 产物：
 *   1. <工作区>/projects/<示例>/            ← 立刻能在面板里打开
 *   2. dsh-shader-workbench/examples/<示例>/ ← 随插件走的交付物
 *   3. scripts/.fourier-demos/*.frag        ← 给浏览器探针做真机编译校验
 *
 * 跑法：node scripts/build-fourier-demos.mjs
 */

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/Projects/DSHP/dsh-shader-workbench';
const WORKSPACE_ROOT = 'D:/Projects/DSHP/shader-workbench';
const PROBE_DIR = 'D:/Projects/DSHP/scripts/.fourier-demos';

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href);
const { buildGraphFromSpec } = await load('host/index.js');
const { compileGraph } = await load('client/runtime/codegen.js');
const { Workspace } = await load('host/workspace.js');
const { parseUserNodeFiles } = await load('shared/user-nodes.js');
const { setUserNodes } = await load('shared/index.js');
const { exampleNodeEntries } = await load('host/examples.js');

/**
 * 傅里叶这三个示例用的是**用户节点**（`fourierSeries` / `epicycles`），它们随示例走、
 * 不在内置节点库里 —— 所以建图之前必须先把示例自带的库装上，
 * 否则 `buildGraphFromSpec` 会报「不认识的节点类型」。
 */
{
  const { entries, errors } = await exampleNodeEntries();
  const parsed = parseUserNodeFiles(entries);
  const problems = [...errors, ...parsed.errors];
  if (problems.length > 0) {
    console.error('示例自带的用户节点有问题：', problems);
    process.exit(1);
  }
  setUserNodes(parsed.defs);
  console.log(`装了 ${parsed.defs.length} 个用户节点：${parsed.defs.map((d) => d.type).join(', ')}\n`);
}

/** 三个示例的定义。 */
const DEMOS = [
  {
    project: 'fourier-series',
    material: 'square-wave',
    title: '傅里叶级数：方波 = 正弦叠加',
    graphName: 'Square wave by sines',
    nodes: [
      { id: 'uv0', type: 'uv', x: 0, y: 0 },
      { id: 't0', type: 'time', x: 0, y: 170 },
      {
        id: 'fs',
        type: 'fourierSeries',
        x: 250,
        y: 40,
        params: { wave: 'FS_WAVE_SQUARE', show: 'FS_SHOW_SUM', terms: 5, speed: 1 },
      },
      { id: 'out0', type: 'output', x: 640, y: 90 },
    ],
    edges: [
      { from: 'uv0.out', to: 'fs.uv' },
      { from: 't0.out', to: 'fs.time' },
      { from: 'fs.out', to: 'out0.color' },
    ],
  },
  {
    project: 'fourier-spectrum',
    material: 'harmonics',
    title: '频谱：每根柱是一次谐波',
    graphName: 'Harmonic spectrum',
    nodes: [
      { id: 'uv0', type: 'uv', x: 0, y: 0 },
      { id: 't0', type: 'time', x: 0, y: 170 },
      {
        id: 'fs',
        type: 'fourierSeries',
        x: 250,
        y: 40,
        params: { wave: 'FS_WAVE_SQUARE', show: 'FS_SHOW_SPECTRUM', terms: 16, speed: 1 },
      },
      { id: 'out0', type: 'output', x: 640, y: 90 },
    ],
    edges: [
      { from: 'uv0.out', to: 'fs.uv' },
      { from: 't0.out', to: 'fs.time' },
      { from: 'fs.out', to: 'out0.color' },
    ],
  },
  {
    project: 'fourier-epicycles',
    material: 'epicycles',
    title: 'DFT 逆变换：本轮画出一条曲线',
    graphName: 'Epicycles',
    nodes: [
      { id: 'uv0', type: 'uv', x: 0, y: 0 },
      { id: 't0', type: 'time', x: 0, y: 170 },
      {
        id: 'epi',
        type: 'epicycles',
        x: 250,
        y: 40,
        params: { shape: 'EPI_SHAPE_HEART', show: 'EPI_SHOW_BOTH', terms: 8, speed: 0.12, size: 0.72 },
      },
      { id: 'out0', type: 'output', x: 640, y: 90 },
    ],
    edges: [
      { from: 'uv0.out', to: 'epi.uv' },
      { from: 't0.out', to: 'epi.time' },
      { from: 'epi.out', to: 'out0.color' },
    ],
  },
];

mkdirSync(PROBE_DIR, { recursive: true });
const workspace = new Workspace(WORKSPACE_ROOT);
await workspace.init();

for (const demo of DEMOS) {
  const graph = buildGraphFromSpec({ name: demo.graphName, nodes: demo.nodes, edges: demo.edges });
  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  const errors = compiled.errors.map((e) => e.message).join('；');
  console.log(`${demo.project.padEnd(18)} 节点 ${graph.nodes.length} / 连线 ${graph.edges.length}  ok=${compiled.ok} ${errors}`);
  if (!compiled.ok) {
    console.error('   ↑ 编译不过，中止');
    process.exit(1);
  }

  // 1) 进运行期工作区
  try {
    await workspace.createProject({ name: demo.project, title: demo.title, description: '傅里叶变换示例' });
  } catch {
    // 已存在就继续
  }
  try {
    await workspace.createMaterial({ project: demo.project, name: demo.material, title: demo.title });
  } catch {
    // 同上
  }
  await workspace.saveMaterial({ project: demo.project, material: demo.material, graph });
  // 导出的 GLSL 也落一份到材质目录（示例要自包含）
  await workspace.write(workspace.materialFile(demo.project, demo.material, `${demo.material}.frag`), compiled.code);
  try {
    await workspace.snapshot({ project: demo.project, material: demo.material, label: 'fourier' });
  } catch {
    // 快照失败不影响示例
  }

  // 2) 拷成插件自带示例
  // ⚠️ 只重写「项目」那部分，**别整个删目录**：examples/<名>/library/ 里放着该示例
  // 自带的用户节点（效果专用节点随示例走）。上一版 rmSync 整个目录，把它们清掉了。
  const exampleDir = join(PLUGIN, 'examples', demo.project);
  rmSync(join(exampleDir, 'materials'), { recursive: true, force: true });
  rmSync(join(exampleDir, 'project.json'), { force: true });
  mkdirSync(join(exampleDir, 'materials'), { recursive: true });
  cpSync(join(WORKSPACE_ROOT, 'projects', demo.project), exampleDir, { recursive: true });

  // 3) 给探针留一份
  writeFileSync(join(PROBE_DIR, `${demo.project}.frag`), compiled.code, 'utf8');
}

console.log(`\n探针用的 .frag 写到 ${PROBE_DIR}`);
