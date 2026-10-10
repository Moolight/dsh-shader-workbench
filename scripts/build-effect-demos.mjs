/**
 * 建 3 个"用现有组件搭出来"的效果示例：高斯模糊 / 景深 / 贝塞尔曲线。
 *
 * 设计要点（这也是这个脚本值得看的地方）：
 *
 *  1. **一个内置节点都不加。** 三样全部用现有组件搭：
 *     `group`（元节点）/ `groupInput` / `groupOutput` / `bufferSample` /
 *     `custom` / `uniform` / `add` / `output`。
 *     这也正好回答"不可能每次加效果都改插件源码"——效果应该是**图**，不是代码。
 *
 *  2. **重活藏在组里。** 9 抽样高斯核要 27 个节点、32 段贝塞尔要 36 个节点，
 *     直接摊在画布上没法看。打进 `group` 之后画布上只剩 4~7 个节点，
 *     子图内联在 `params.graph` 里（材质自包含）。
 *
 *  3. **能让用户拖的都做成 uniform**（不是 const）：模糊半径、焦点、光圈、
 *     4 个贝塞尔控制点 —— 面板的「自定义参数」里直接出滑块/数值框。
 *
 *  跑法：node scripts/build-effect-demos.mjs
 *  产物：运行期工作区里的 3 个项目 + `examples/` 里的 3 份自带示例 +
 *        `scripts/.effect-demos/*.frag`（给多 Pass 探针做真机校验）
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/Projects/DSHP/dsh-shader-workbench';
const WORKSPACE_ROOT = 'D:/Projects/DSHP/shader-workbench';
const PROBE_DIR = 'D:/Projects/DSHP/scripts/.effect-demos';

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href);
const { buildGraphFromSpec } = await load('host/index.js');
const { compileGraph } = await load('client/runtime/codegen.js');
const { Workspace } = await load('host/workspace.js');

// ───────────────────────── 共用小工具 ─────────────────────────

/** 9 抽样高斯权重（3×3 可分离核的乘积，和为 1）。 */
const GAUSS_3X3 = [0.075, 0.124, 0.075, 0.124, 0.204, 0.124, 0.075, 0.124, 0.075];
/** 对应偏移（以半径为单位）。 */
const OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [0, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * 造一个「9 抽样高斯模糊」组的子图。
 *
 * 组接口：uv(vec2) + radius(float) → out(vec4)
 *
 * 每个抽样 3 个节点：
 *   ① custom 算偏移量（`uv + 方向 * 半径`）
 *   ② bufferSample 按偏移采样源 Pass
 *   ③ custom 加权累加（`上一份累加 + 本次采样 * 权重`）
 * 累加从 `vec4(0.0)` 起步，权重和为 1，所以结果不用再除。
 *
 * @param {object} opts
 * @param {string} opts.source 源 Pass 名（BufferA / BufferB …）
 * @returns {object} `params.graph` 的值
 */
function gaussianBlurSubgraph({ source }) {
  const nodes = [
    { id: 'gi_uv', type: 'groupInput', x: -460, y: 0, params: { port: 'uv', type: 'vec2' } },
    { id: 'gi_r', type: 'groupInput', x: -460, y: 150, params: { port: 'radius', type: 'float' } },
    { id: 'seed', type: 'custom', x: -460, y: 300, params: { expr: 'vec4(0.0)' } },
  ];
  const edges = [];
  let acc = { node: 'seed', port: 'out' };

  OFFSETS.forEach(([dx, dy], i) => {
    const off = `off${i}`;
    const samp = `samp${i}`;
    const sum = `sum${i}`;
    nodes.push({
      id: off,
      type: 'custom',
      x: -180,
      y: i * 96,
      // 注意 `.xy` / `.c` 的写法：端口会按声明类型自动补转换，
      // 所以一律显式取分量，别指望 vec2 会「原样透传」。
      params: { expr: `vec4($in.a.xy + vec2(${dx.toFixed(1)}, ${dy.toFixed(1)}) * $in.c, 0.0, 1.0)` },
    });
    nodes.push({ id: samp, type: 'bufferSample', x: 80, y: i * 96, params: { buffer: source } });
    nodes.push({
      id: sum,
      type: 'custom',
      x: 340,
      y: i * 96,
      params: { expr: `$in.b + $in.a * ${GAUSS_3X3[i].toFixed(4)}` },
    });
    edges.push({ from: { node: 'gi_uv', port: 'out' }, to: { node: off, port: 'a' } });
    edges.push({ from: { node: 'gi_r', port: 'out' }, to: { node: off, port: 'c' } });
    edges.push({ from: { node: off, port: 'out' }, to: { node: samp, port: 'uv' } });
    edges.push({ from: { node: samp, port: 'out' }, to: { node: sum, port: 'a' } });
    edges.push({ from: acc, to: { node: sum, port: 'b' } });
    acc = { node: sum, port: 'out' };
  });

  nodes.push({ id: 'go', type: 'groupOutput', x: 600, y: 0, params: { port: 'out', type: 'vec4' } });
  edges.push({ from: acc, to: { node: 'go', port: 'color' } });

  return {
    name: `高斯模糊 9 抽样（源 ${source}）`,
    inputs: [
      { id: 'uv', label: 'uv', type: 'vec2' },
      { id: 'radius', label: '半径', type: 'float' },
    ],
    outputs: [{ id: 'out', label: 'color', type: 'vec4' }],
    nodes,
    edges,
  };
}

/** 屏幕坐标 → 中心化、短边归一、长宽比正确的坐标（值域大约 ±1）。 */
const Q = '(gl_FragCoord.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y)';

/**
 * 造一个「贝塞尔描线」组的**循环体**：重复 24 次，每次量一段的距离。
 *
 * 关键点：**不再把 24 段各复制一份**。段号由 `loopIndex` 给出来，
 * 曲线上的点按伯恩斯坦基用公式算（`P(t) = Σ A_k(t)·P_k`），
 * 所以循环体只写一遍 —— 24 份复制会生成 51 KB 着色器，加载直接卡。
 *
 * 组接口：
 *   p0..p3(vec2 控制点) 每轮都不变
 *   best(float)         跨迭代传递：目前为止的最小距离
 * 循环体里用 `gl_FragCoord` 拿像素坐标，不占端口。
 *
 * @param {object} opts
 * @param {number} opts.segments 段数（= 重复次数）
 * @returns {object} `params.graph` 的值
 */
function bezierSubgraph({ segments }) {
  const N = segments;
  /** 伯恩斯坦基下的曲线点：用打包好的控制点算。 */
  const pointAt = (t) =>
    [
      `((1.0 - ${t}) * (1.0 - ${t}) * (1.0 - ${t}) * $in.a.xy)`,
      `(3.0 * (1.0 - ${t}) * (1.0 - ${t}) * ${t} * $in.a.zw)`,
      `(3.0 * (1.0 - ${t}) * ${t} * ${t} * $in.b.xy)`,
      `(${t} * ${t} * ${t} * $in.b.zw)`,
    ].join(' + ');

  const nodes = [
    { id: 'gi_p0', type: 'groupInput', x: -560, y: 0, params: { port: 'p0', type: 'vec2' } },
    { id: 'gi_p1', type: 'groupInput', x: -560, y: 110, params: { port: 'p1', type: 'vec2' } },
    { id: 'gi_p2', type: 'groupInput', x: -560, y: 220, params: { port: 'p2', type: 'vec2' } },
    { id: 'gi_p3', type: 'groupInput', x: -560, y: 330, params: { port: 'p3', type: 'vec2' } },
    { id: 'gi_best', type: 'groupInput', x: -560, y: 440, params: { port: 'best', type: 'float' } },
    { id: 'pack01', type: 'custom', x: -320, y: 0, params: { expr: 'vec4($in.a.xy, $in.b.xy)' } },
    { id: 'pack23', type: 'custom', x: -320, y: 200, params: { expr: 'vec4($in.a.xy, $in.b.xy)' } },
    // 段号 → 两个端点的参数 t
    { id: 'idx', type: 'loopIndex', x: -320, y: 400 },
    { id: 't0n', type: 'custom', x: -80, y: 330, params: { expr: `vec4($in.a.x / ${N}.0, 0.0, 0.0, 1.0)` } },
    { id: 't1n', type: 'custom', x: -80, y: 450, params: { expr: `vec4(($in.a.x + 1.0) / ${N}.0, 0.0, 0.0, 1.0)` } },
    { id: 'pa', type: 'custom', x: 180, y: 250, params: { expr: `vec4(${pointAt('$in.c')}, 0.0, 1.0)` } },
    { id: 'pb', type: 'custom', x: 180, y: 450, params: { expr: `vec4(${pointAt('$in.c')}, 0.0, 1.0)` } },
    { id: 'packab', type: 'custom', x: 440, y: 350, params: { expr: 'vec4($in.a.xy, $in.b.xy)' } },
    // 到这一段的距离（端点已打包进 .xy / .zw）
    {
      id: 'segdist',
      type: 'custom',
      x: 680,
      y: 350,
      params: {
        expr: `vec4(length((${Q}) - ($in.b.xy + clamp(dot((${Q}) - $in.b.xy, $in.b.zw - $in.b.xy) / max(dot($in.b.zw - $in.b.xy, $in.b.zw - $in.b.xy), 1e-8), 0.0, 1.0) * ($in.b.zw - $in.b.xy))))`,
      },
    },
    {
      id: 'best_new',
      type: 'custom',
      x: 940,
      y: 350,
      params: { expr: 'vec4(min($in.a.x, $in.b.x), 0.0, 0.0, 1.0)' },
    },
    { id: 'go', type: 'groupOutput', x: 1180, y: 350, params: { port: 'best', type: 'float' } },
  ];

  const edges = [
    { from: { node: 'gi_p0', port: 'out' }, to: { node: 'pack01', port: 'a' } },
    { from: { node: 'gi_p1', port: 'out' }, to: { node: 'pack01', port: 'b' } },
    { from: { node: 'gi_p2', port: 'out' }, to: { node: 'pack23', port: 'a' } },
    { from: { node: 'gi_p3', port: 'out' }, to: { node: 'pack23', port: 'b' } },
    { from: { node: 'idx', port: 'out' }, to: { node: 't0n', port: 'a' } },
    { from: { node: 'idx', port: 'out' }, to: { node: 't1n', port: 'a' } },
    { from: { node: 'pack01', port: 'out' }, to: { node: 'pa', port: 'a' } },
    { from: { node: 'pack23', port: 'out' }, to: { node: 'pa', port: 'b' } },
    { from: { node: 't0n', port: 'out' }, to: { node: 'pa', port: 'c' } },
    { from: { node: 'pack01', port: 'out' }, to: { node: 'pb', port: 'a' } },
    { from: { node: 'pack23', port: 'out' }, to: { node: 'pb', port: 'b' } },
    { from: { node: 't1n', port: 'out' }, to: { node: 'pb', port: 'c' } },
    { from: { node: 'pa', port: 'out' }, to: { node: 'packab', port: 'a' } },
    { from: { node: 'pb', port: 'out' }, to: { node: 'packab', port: 'b' } },
    { from: { node: 'packab', port: 'out' }, to: { node: 'segdist', port: 'b' } },
    { from: { node: 'segdist', port: 'out' }, to: { node: 'best_new', port: 'a' } },
    { from: { node: 'gi_best', port: 'out' }, to: { node: 'best_new', port: 'b' } },
    { from: { node: 'best_new', port: 'out' }, to: { node: 'go', port: 'color' } },
  ];

  return {
    name: `贝塞尔描线：重复 ${N} 段求最小距离`,
    carries: ['best'],
    inputs: [
      { id: 'p0', label: 'P0', type: 'vec2' },
      { id: 'p1', label: 'P1', type: 'vec2' },
      { id: 'p2', label: 'P2', type: 'vec2' },
      { id: 'p3', label: 'P3', type: 'vec2' },
      { id: 'best', label: '最小距离', type: 'float' },
    ],
    outputs: [{ id: 'best', label: '最小距离', type: 'float' }],
    nodes,
    edges,
  };
}

/** 便捷构造 uniform 节点。 */
const uni = (id, name, outType, x, y) => ({
  id,
  type: 'uniform',
  x,
  y,
  params: { name, outType },
});

/**
 * 曲线本体 + 控制多边形 + 沿线跑的小球。
 *
 * 一次表达式搞定，靠的是：`iTime` 和 `gl_FragCoord` 在 custom 里可以直接用。
 * `$in.c` 是循环体算出来的最小距离。
 */
function bezierColorExpr() {
  const P = ['$in.a.xy', '$in.a.zw', '$in.b.xy', '$in.b.zw'];
  const seg = (A, B) =>
    `length(${Q} - (${A} + clamp(dot(${Q} - ${A}, ${B} - ${A}) / max(dot(${B} - ${A}, ${B} - ${A}), 1e-8), 0.0, 1.0) * (${B} - ${A})))`;
  const u = 'fract(iTime * 0.18)';
  const uu = `(1.0 - ${u})`;
  const dot3 = `(${uu} * ${uu} * ${uu} * ${P[0]} + 3.0 * ${uu} * ${uu} * ${u} * ${P[1]} + 3.0 * ${uu} * ${u} * ${u} * ${P[2]} + ${u} * ${u} * ${u} * ${P[3]})`;
  const poly = `min(min(${seg(P[0], P[1])}, ${seg(P[1], P[2])}), ${seg(P[2], P[3])})`;

  return [
    'mix(',
    'mix(vec3(0.03, 0.04, 0.06), vec3(0.30, 0.42, 0.60), smoothstep(0.010, 0.0, ' + poly + ')),',
    'vec3(0.25, 0.95, 1.00), smoothstep(0.011, 0.004, $in.c)',
    ') +',
    `vec3(0.95, 0.75, 0.30) * (smoothstep(0.028, 0.016, length(${Q} - ${P[0]})) + smoothstep(0.028, 0.016, length(${Q} - ${P[1]})) + smoothstep(0.028, 0.016, length(${Q} - ${P[2]})) + smoothstep(0.028, 0.016, length(${Q} - ${P[3]}))) +`,
    `vec3(1.00, 0.85, 0.40) * smoothstep(0.055, 0.0, length(${Q} - ${dot3}))`,
  ].join('\n');
}

const bezierPass = {
  nodes: [
    uni('p0', 'uP0', 'vec2', 0, 0),
    uni('p1', 'uP1', 'vec2', 0, 140),
    uni('p2', 'uP2', 'vec2', 0, 280),
    uni('p3', 'uP3', 'vec2', 0, 420),
    { id: 'pack01', type: 'custom', x: 260, y: 40, params: { expr: 'vec4($in.a.xy, $in.b.xy)' } },
    { id: 'pack23', type: 'custom', x: 260, y: 200, params: { expr: 'vec4($in.a.xy, $in.b.xy)' } },
    { id: 'best_seed', type: 'custom', x: 260, y: 360, params: { expr: 'vec4(9.0)' } },
    // 重复 24 次：循环体只写一遍（复制 24 份会生成 51 KB 着色器）
    {
      id: 'curve',
      type: 'group',
      x: 560,
      y: 140,
      params: { repeat: 24, graph: bezierSubgraph({ segments: 24 }) },
    },
    { id: 'paint', type: 'custom', x: 900, y: 100, params: { expr: `vec4(${bezierColorExpr()}, 1.0)` } },
    { id: 'out0', type: 'output', x: 1200, y: 100 },
  ],
  edges: [
    { from: 'p0.out', to: 'pack01.a' },
    { from: 'p1.out', to: 'pack01.b' },
    { from: 'p2.out', to: 'pack23.a' },
    { from: 'p3.out', to: 'pack23.b' },
    { from: 'p0.out', to: 'curve.p0' },
    { from: 'p1.out', to: 'curve.p1' },
    { from: 'p2.out', to: 'curve.p2' },
    { from: 'p3.out', to: 'curve.p3' },
    { from: 'best_seed.out', to: 'curve.best' },
    { from: 'pack01.out', to: 'paint.a' },
    { from: 'pack23.out', to: 'paint.b' },
    { from: 'curve.best', to: 'paint.c' },
    { from: 'paint.out', to: 'out0.color' },
  ],
};

// ───────────────────────── 示例 1：高斯模糊 ─────────────────────────

const BLUR_SOURCE = [
  'vec4(mix(',
  'mix(vec3(0.05, 0.06, 0.10), vec3(0.86, 0.70, 0.28), mod(floor($in.a.xy.x * 26.0) + floor($in.a.xy.y * 16.0), 2.0)),',
  'vec3(0.92, 0.26, 0.42),',
  'smoothstep(0.030, 0.0, abs(length(($in.a.xy - vec2(0.5, 0.5)) * vec2(1.78, 1.0)) - 0.26))',
  '), 1.0)',
].join('\n');

const blurImagePass = {
  nodes: [
    { id: 'uv0', type: 'uv', x: 0, y: 0 },
    uni('rad', 'uRadius', 'float', 0, 160),
    { id: 'blur', type: 'group', x: 260, y: 40, params: { graph: gaussianBlurSubgraph({ source: 'BufferA' }) } },
    { id: 'grade', type: 'custom', x: 620, y: 40, params: { expr: 'vec4(pow($in.a.rgb, vec3(0.4545)), 1.0)' } },
    { id: 'out0', type: 'output', x: 880, y: 40 },
  ],
  edges: [
    { from: 'uv0.out', to: 'blur.uv' },
    { from: 'rad.out', to: 'blur.radius' },
    { from: 'blur.out', to: 'grade.a' },
    { from: 'grade.out', to: 'out0.color' },
  ],
};

// ───────────────────────── 示例 2：景深 ─────────────────────────
//
// 场景是**平地上几块不同距离的方块**（不是透视棋盘：透视花纹在掠射角必然摩尔纹，
// 糊出来一片竖条，根本看不出景深）。深度写进 BufferA 的 alpha，image Pass 读回来
// 算弥散圆 —— 没有深度缓冲的话，只知道屏幕坐标、不知道像素多远，弥散圆算不出来。

const DOF_HORIZON = 0.40;
const DOF_CAMH = 0.30;
const DOF_K = 2.0;
const DOF_MAXZ = 12.0;
const UVX = '$in.a.xy.x';
const UVY = '$in.a.xy.y';

/** 世界 (X, Z) 处的方块投影到屏幕占哪块矩形。 */
function dofBox(X, Z, W, H) {
  const zk = Z * DOF_K;
  const cx = 0.5 + X / zk;
  const hx = W / 2 / zk;
  const yBase = DOF_HORIZON + DOF_CAMH / Z;
  const yTop = DOF_HORIZON + (DOF_CAMH - H) / Z;
  return `(step(abs(${UVX} - ${cx.toFixed(4)}), ${hx.toFixed(4)}) * step(${yTop.toFixed(4)}, ${UVY}) * step(${UVY}, ${yBase.toFixed(4)}))`;
}

/** 五块方块：距离从近到远，焦点放在第 3 块附近。 */
const DOF_BOXES = [
  { X: -0.8, Z: 1.3, W: 0.8, H: 0.7, color: '0.92, 0.35, 0.32' },
  { X: 1.4, Z: 2.0, W: 0.9, H: 0.9, color: '0.95, 0.72, 0.28' },
  { X: -0.4, Z: 3.2, W: 0.7, H: 0.6, color: '0.30, 0.85, 0.90' },
  { X: 2.3, Z: 4.8, W: 0.8, H: 1.0, color: '0.62, 0.45, 0.90' },
  { X: -2.4, Z: 7.5, W: 1.0, H: 1.2, color: '0.42, 0.55, 0.78' },
];

const DOF_SKY = `mix(vec3(0.20, 0.24, 0.36), vec3(0.56, 0.64, 0.80), smoothstep(${DOF_HORIZON}, 0.90, ${UVY}))`;
const DOF_GROUND = `mix(vec3(0.09, 0.10, 0.14), vec3(0.40, 0.42, 0.46), smoothstep(${DOF_HORIZON}, 1.0, ${UVY}))`;
const DOF_GROUND_DEPTH = `min(${DOF_CAMH} / max(${UVY} - ${DOF_HORIZON}, 0.02), ${DOF_MAXZ.toFixed(1)})`;

const DOF_SCENE_SOURCE = (() => {
  const base = `((${UVY} > ${DOF_HORIZON}) ? (${DOF_SKY}) : (${DOF_GROUND}))`;
  const baseDepth = `((${UVY} > ${DOF_HORIZON}) ? ${DOF_MAXZ.toFixed(1)} : (${DOF_GROUND_DEPTH}))`;
  const color = DOF_BOXES.reduce((acc, b) => `mix(${acc}, vec3(${b.color}), ${dofBox(b.X, b.Z, b.W, b.H)})`, base);
  const depth = DOF_BOXES.reduce((acc, b) => `mix(${acc}, ${b.Z.toFixed(3)}, ${dofBox(b.X, b.Z, b.W, b.H)})`, baseDepth);
  return `vec4(${color}, (${depth}) / ${DOF_MAXZ.toFixed(1)})`;
})();

/**
 * 弥散圆：离焦越远越大。
 * a = BufferA 采样（`.w` 是深度），b = 光圈，c = 对焦距离。
 */
const DOF_COC = [
  'vec4(clamp(',
  `abs($in.a.w * ${DOF_MAXZ.toFixed(1)} - $in.c) * 0.010 * $in.b.x,`,
  '0.0, 0.06',
  '))',
].join('\n');

const dofImagePass = {
  nodes: [
    { id: 'uv0', type: 'uv', x: 0, y: 0 },
    uni('focus', 'uFocus', 'float', 0, 160),
    uni('ap', 'uAperture', 'float', 0, 280),
    { id: 'depth', type: 'bufferSample', x: 220, y: 300, params: { buffer: 'BufferA' } },
    { id: 'coc', type: 'custom', x: 480, y: 180, params: { expr: DOF_COC } },
    { id: 'blur', type: 'group', x: 760, y: 60, params: { graph: gaussianBlurSubgraph({ source: 'BufferA' }) } },
    { id: 'grade', type: 'custom', x: 1120, y: 60, params: { expr: 'vec4(pow($in.a.rgb, vec3(0.4545)), 1.0)' } },
    { id: 'out0', type: 'output', x: 1380, y: 60 },
  ],
  edges: [
    { from: 'uv0.out', to: 'depth.uv' },
    { from: 'uv0.out', to: 'blur.uv' },
    { from: 'depth.out', to: 'coc.a' },
    { from: 'ap.out', to: 'coc.b' },
    { from: 'focus.out', to: 'coc.c' },
    { from: 'coc.out', to: 'blur.radius' },
    { from: 'blur.out', to: 'grade.a' },
    { from: 'grade.out', to: 'out0.color' },
  ],
};

// ───────────────────────── 组装 ─────────────────────────

const DEMOS = [
  {
    project: 'gaussian-blur',
    material: 'blur',
    title: '高斯模糊：9 抽样可分离核',
    graphName: 'Gaussian blur (9 taps in a group)',
    passes: {
      BufferA: [
        { id: 'uvs', type: 'uv', x: 0, y: 0 },
        { id: 'src', type: 'custom', x: 260, y: 0, params: { expr: BLUR_SOURCE } },
        { id: 'outA', type: 'output', x: 560, y: 0 },
      ],
      image: blurImagePass.nodes,
    },
    edges: {
      BufferA: [
        { from: 'uvs.out', to: 'src.a' },
        { from: 'src.out', to: 'outA.color' },
      ],
      image: blurImagePass.edges,
    },
    uniforms: [{ name: 'uRadius', type: 'float', value: 0.028, min: 0, max: 0.06, label: '模糊半径' }],
  },
  {
    project: 'depth-of-field',
    material: 'dof',
    title: '景深：按弥散圆半径做高斯模糊',
    graphName: 'Depth of field (CoC driven blur)',
    passes: {
      BufferA: [
        { id: 'uvs', type: 'uv', x: 0, y: 0 },
        { id: 'src', type: 'custom', x: 260, y: 0, params: { expr: DOF_SCENE_SOURCE } },
        { id: 'outA', type: 'output', x: 560, y: 0 },
      ],
      image: dofImagePass.nodes,
    },
    edges: {
      BufferA: [
        { from: 'uvs.out', to: 'src.a' },
        { from: 'src.out', to: 'outA.color' },
      ],
      image: dofImagePass.edges,
    },
    uniforms: [
      { name: 'uFocus', type: 'float', value: 3.0, min: 0, max: 12, label: '对焦距离' },
      { name: 'uAperture', type: 'float', value: 1.0, min: 0, max: 3, label: '光圈' },
    ],
  },
  {
    project: 'bezier',
    material: 'curve',
    title: '贝塞尔曲线：24 段采样求最小距离',
    graphName: 'Cubic Bezier (24 segment taps)',
    passes: { image: bezierPass.nodes },
    edges: { image: bezierPass.edges },
    uniforms: [
      { name: 'uP0', type: 'vec2', value: [-0.62, -0.42], label: 'P0' },
      { name: 'uP1', type: 'vec2', value: [-0.20, 0.72], label: 'P1' },
      { name: 'uP2', type: 'vec2', value: [0.30, -0.78], label: 'P2' },
      { name: 'uP3', type: 'vec2', value: [0.66, 0.36], label: 'P3' },
    ],
  },
];

mkdirSync(PROBE_DIR, { recursive: true });
const workspace = new Workspace(WORKSPACE_ROOT);
await workspace.init();

const probeManifest = [];

for (const demo of DEMOS) {
  const nodes = Object.values(demo.passes).flat();
  const edges = Object.values(demo.edges).flat();
  const spec = {
    name: demo.graphName,
    nodes,
    edges,
    uniforms: demo.uniforms,
    passes: Object.fromEntries(Object.entries(demo.passes).map(([pass, list]) => [pass, list.map((n) => n.id)])),
  };
  const graph = buildGraphFromSpec(spec);

  const passNames = ['BufferA', 'BufferB', 'BufferC', 'BufferD', 'image'].filter((p) =>
    (graph.passes ?? []).some((entry) => entry.name === p && (entry.graph ?? []).length > 0),
  );

  const frags = {};
  for (const pass of passNames) {
    const compiled = compileGraph(graph, pass, { uniforms: demo.uniforms });
    if (!compiled.ok) {
      console.error(`✗ ${demo.project} / ${pass} 编译不过：`, JSON.stringify(compiled.errors, null, 2));
      process.exit(1);
    }
    frags[pass] = compiled.code;
    writeFileSync(join(PROBE_DIR, `${demo.project}__${pass}.frag`), compiled.code, 'utf8');
  }
  console.log(
    `${demo.project.padEnd(17)} 图节点 ${String(graph.nodes.length).padStart(2)} / 连线 ${String(graph.edges.length).padStart(2)} · Pass ${passNames.join(' → ')} · shader ${Object.values(frags).map((c) => (c.length / 1024).toFixed(1) + 'K').join(' + ')}`,
  );

  // 进运行期工作区
  try {
    await workspace.createProject({ name: demo.project, title: demo.title, description: '用现有组件搭出来的效果示例' });
  } catch {
    /* 已存在 */
  }
  try {
    await workspace.createMaterial({ project: demo.project, name: demo.material, title: demo.title });
  } catch {
    /* 已存在 */
  }
  await workspace.saveMaterial({
    project: demo.project,
    material: demo.material,
    graph,
    // 清单里的 uniforms 是「名字 → 声明」的对象（不是数组），passes 要列全
    manifest: {
      uniforms: Object.fromEntries(demo.uniforms.map((u) => [u.name, u])),
      passes: passNames,
    },
  });
  await workspace.write(workspace.materialFile(demo.project, demo.material, `${demo.material}.frag`), frags.image);
  try {
    await workspace.snapshot({ project: demo.project, material: demo.material, label: 'effect' });
  } catch {
    /* 快照失败不影响示例 */
  }

  // 拷成自带示例
  // ⚠️ 只重写「项目」那部分，**别整个删目录**：examples/<名>/library/ 里可能放着
  // 该示例自带的用户节点（效果专用节点随示例走）。上一版 rmSync 整个目录会清掉它们。
  const exampleDir = join(PLUGIN, 'examples', demo.project);
  rmSync(join(exampleDir, 'materials'), { recursive: true, force: true });
  rmSync(join(exampleDir, 'project.json'), { force: true });
  mkdirSync(join(exampleDir, 'materials'), { recursive: true });
  cpSync(join(WORKSPACE_ROOT, 'projects', demo.project), exampleDir, { recursive: true });

  probeManifest.push({ project: demo.project, material: demo.material, passes: passNames, uniforms: demo.uniforms });
}

writeFileSync(join(PROBE_DIR, 'manifest.json'), `${JSON.stringify(probeManifest, null, 2)}\n`, 'utf8');
console.log(`\n多 Pass 探针素材写到 ${PROBE_DIR}`);
