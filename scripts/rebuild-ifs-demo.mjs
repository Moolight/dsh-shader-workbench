/**
 * 重建 `demo`（Phantom Star / IFS 隧道）—— **按原版搬，不走样**。
 *
 * 上一版我为了"可展开"把 99 步累积辉光换成了屏幕空间的 2D 折叠 + 一次雾化，
 * 结果和原版不是同一个效果了（用户直接指出来了）。这次的做法：
 *
 *   - **原样搬**：摄像头（cPos/cDir/cUp/cross 射线）、3D 折叠（`abs(p)-1` +
 *     xy 转 t*0.3 + xz 转 t*0.1，5 次）、空间平铺 + 5 重对称、box SDF、
 *     脉冲带、最后的配色公式 —— 全部照 `scripts/.phantom-star/phantom-star.frag`。
 *   - **循环展开**：99 步累积展开成节点链，步长按 `99/步数` 补偿，
 *     所以覆盖的距离和原版一样，只是采样粗一些。
 *   - **IFS 场封成组**：一次场求值 22 个节点，16 步就是 16 个实例 ——
 *     画布上只看得到 16 颗「IFS 场」组节点，右键「拆开组」就能编辑里面。
 *     组是**可以展开**的，所以这不是黑盒。
 *
 * 判据是**和原版并排看**：探针会把原版 .frag 一起渲出来对比。
 *
 * 跑法：node scripts/rebuild-ifs-demo.mjs [步数]
 */

import { mkdirSync, writeFileSync, cpSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/Projects/DSHP/dsh-shader-workbench';
const WORKSPACE_ROOT = 'D:/Projects/DSHP/shader-workbench';
const PROBE_DIR = 'D:/Projects/DSHP/scripts/.ifs-compare';
const ORIGINAL_FRAG = 'D:/Projects/DSHP/scripts/.phantom-star/phantom-star.frag';

/** 展开多少步。原版是 99 步，步长按比例补偿。 */
const STEPS = Number(process.argv[2] ?? 16);
/** 原版 `dist += d * 0.5`，99 步；展开后保持总距离一致。 */
const STRIDE = (99 * 0.5) / STEPS;
/** 原版 gain 0.01（99 步）按步数缩放。 */
const GAIN = (0.01 * 99) / STEPS;

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href);
const { buildGraphFromSpec } = await load('host/index.js');
const { compileGraph } = await load('client/runtime/codegen.js');
const { Workspace } = await load('host/workspace.js');

const custom = (id, expr, x, y) => ({ id, type: 'custom', x, y, params: { expr } });

/** 绕某轴的 2D 旋转矩阵（GLSL 列主序）。 */
const rot2 = (angleExpr) =>
  `mat2(cos(${angleExpr}), sin(${angleExpr}), -sin(${angleExpr}), cos(${angleExpr}))`;

/**
 * 「IFS 场」组：一次 st_ifsMap + st_ifsField 求值，返回 box SDF 距离。
 *
 * 组接口：pos(vec4, xyz 是世界坐标) + t(float) → d(float)
 * 内部 22 个节点，照原版逐句搬。
 */
function ifsFieldGroup() {
  const nodes = [
    { id: 'gi_pos', type: 'groupInput', x: -400, y: 0, params: { port: 'pos', type: 'vec4' } },
    { id: 'gi_t', type: 'groupInput', x: -400, y: 160, params: { port: 't', type: 'float' } },
  ];
  const edges = [];

  // 空间平铺（x/y 每 10 一格、z 每 16 一格）+ 极坐标 5 重对称
  const qx = '(mod($in.a.x - 5.0, 10.0) - 5.0)';
  const qy = '(mod($in.a.y - 5.0, 10.0) - 5.0)';
  const qz = '(mod($in.a.z, 16.0) - 8.0)';
  const symA = `(floor((atan(${qx}, ${qy}) + 0.6283185307179586) / 1.2566370614359172) * 1.2566370614359172)`;
  nodes.push(
    custom(
      'tile',
      // ⚠️ 原版写的是 `q.xy *= rot(a)`：GLSL 里「向量 * 矩阵」是**按行向量**乘，
      //    等价于乘转置 —— 和「矩阵 * 向量」方向相反。这里必须把向量写在前面。
      `vec4(vec2(${qx}, ${qy}) * ${rot2(`(-${symA})`)}, ${qz}, 0.0)`,
      -120,
      0,
    ),
  );
  edges.push({ from: { node: 'gi_pos', port: 'out' }, to: { node: 'tile', port: 'a' } });

  // 5 次折叠：abs(p)-1 → xy 转 t*0.3 → xz 转 t*0.1
  let prev = { node: 'tile', port: 'out' };
  for (let i = 0; i < 5; i += 1) {
    const absId = `fold${i}_abs`;
    const xyId = `fold${i}_xy`;
    const xzId = `fold${i}_xz`;
    nodes.push(custom(absId, 'vec4(abs($in.a.xyz) - 1.0, 0.0)', 120 + i * 240, 0));
    nodes.push(
      custom(xyId, `vec4($in.a.xy * ${rot2('($in.b.x * 0.3)')}, $in.a.z, 0.0)`, 120 + i * 240, 170),
    );
    nodes.push(
      custom(
        xzId,
        `vec4(($in.a.xz * ${rot2('($in.b.x * 0.1)')}).x, $in.a.y, ($in.a.xz * ${rot2('($in.b.x * 0.1)')}).y, 0.0)`,
        120 + i * 240,
        340,
      ),
    );
    edges.push({ from: prev, to: { node: absId, port: 'a' } });
    edges.push({ from: { node: absId, port: 'out' }, to: { node: xyId, port: 'a' } });
    edges.push({ from: { node: 'gi_t', port: 'out' }, to: { node: xyId, port: 'b' } });
    edges.push({ from: { node: xyId, port: 'out' }, to: { node: xzId, port: 'a' } });
    edges.push({ from: { node: 'gi_t', port: 'out' }, to: { node: xzId, port: 'b' } });
    prev = { node: xzId, port: 'out' };
  }

  // 收尾再绕 xz 转 t
  nodes.push(
    custom(
      'finalrot',
      `vec4(($in.a.xz * ${rot2('$in.b.x')}).x, $in.a.y, ($in.a.xz * ${rot2('$in.b.x')}).y, 0.0)`,
      1400,
      170,
    ),
  );
  edges.push({ from: prev, to: { node: 'finalrot', port: 'a' } });
  edges.push({ from: { node: 'gi_t', port: 'out' }, to: { node: 'finalrot', port: 'b' } });

  // box SDF：d = abs(p)-b;  min(max(d.x,max(d.y,d.z)),0) + length(max(d,0))
  nodes.push(custom('boxd', 'vec4(abs($in.a.xyz) - vec3(0.4, 0.8, 0.3), 0.0)', 1640, 170));
  edges.push({ from: { node: 'finalrot', port: 'out' }, to: { node: 'boxd', port: 'a' } });
  nodes.push(
    custom(
      'box',
      'vec4(min(max($in.a.x, max($in.a.y, $in.a.z)), 0.0) + length(max($in.a.xyz, 0.0)), 0.0, 0.0, 1.0)',
      1880,
      170,
    ),
  );
  edges.push({ from: { node: 'boxd', port: 'out' }, to: { node: 'box', port: 'a' } });

  nodes.push({ id: 'go', type: 'groupOutput', x: 2120, y: 170, params: { port: 'd', type: 'float' } });
  edges.push({ from: { node: 'box', port: 'out' }, to: { node: 'go', port: 'color' } });

  return {
    name: 'IFS 场（平铺 + 5 重对称 + 5 次折叠 + box SDF）',
    inputs: [
      { id: 'pos', label: 'pos', type: 'vec4' },
      { id: 't', label: 't', type: 'float' },
    ],
    outputs: [{ id: 'd', label: '距离', type: 'float' }],
    nodes,
    edges,
  };
}

/**
 * 循环体：一步累积。**这就是原版 for 循环里那一段**，一个字都没改，
 * 只是搬进了「重复组」的子图里 —— 循环体只写一遍，外面套 for。
 *
 * 组接口：
 *   不变量  ray(vec4) / t(float)
 *   跨迭代  dist(float) / acc(vec4) / acc2(vec4)   ← carries
 */
function stepGroup() {
  const field = ifsFieldGroup();
  const nodes = [
    { id: 'gi_ray', type: 'groupInput', x: -420, y: 0, params: { port: 'ray', type: 'vec4' } },
    { id: 'gi_t', type: 'groupInput', x: -420, y: 150, params: { port: 't', type: 'float' } },
    { id: 'gi_dist', type: 'groupInput', x: -420, y: 300, params: { port: 'dist', type: 'float' } },
    { id: 'gi_acc', type: 'groupInput', x: -420, y: 450, params: { port: 'acc', type: 'vec4' } },
    { id: 'gi_acc2', type: 'groupInput', x: -420, y: 600, params: { port: 'acc2', type: 'vec4' } },
    // pos = cPos + ray * dist
    custom('pos', 'vec4(vec3(0.0, 0.0, -3.0 * $in.c) + $in.a.xyz * $in.b.x, 0.0)', -140, 0),
    { id: 'field', type: 'group', x: 120, y: 0, params: { graph: field } },
    // d = max(|field|, 0.02)；dist += d * 0.5
    custom('step', 'vec4($in.b.x + max(abs($in.a.x), 0.02) * 0.5, max(abs($in.a.x), 0.02), 0.0, 0.0)', 380, 0),
    // a = exp(-d * glow)
    custom('glow', 'vec4(exp(-$in.a.y * 3.0), 0.0, 0.0, 1.0)', 620, 0),
    // 脉冲带
    custom('pulse', 'vec4(step(mod(length($in.a.xyz) + 24.0 * $in.b.x, 30.0), 3.0), 0.0, 0.0, 1.0)', 620, 150),
    // 原版是在 `acc += a` **之前**改的 a，所以两个累加器吃到的都是放大后的值
    custom('aeff', 'vec4($in.a.x * (1.0 + $in.b.x * 1.0), 0.0, 0.0, 1.0)', 860, 75),
    custom('acc_new', 'vec4($in.a.x + $in.b.x, 0.0, 0.0, 1.0)', 1100, 0),
    custom('acc2_new', 'vec4($in.a.x + $in.b.x * $in.c, 0.0, 0.0, 1.0)', 1100, 300),
    { id: 'go_dist', type: 'groupOutput', x: 1340, y: 0, params: { port: 'dist', type: 'float' } },
    { id: 'go_acc', type: 'groupOutput', x: 1340, y: 200, params: { port: 'acc', type: 'vec4' } },
    { id: 'go_acc2', type: 'groupOutput', x: 1340, y: 400, params: { port: 'acc2', type: 'vec4' } },
  ];
  const edges = [
    { from: { node: 'gi_ray', port: 'out' }, to: { node: 'pos', port: 'a' } },
    { from: { node: 'gi_dist', port: 'out' }, to: { node: 'pos', port: 'b' } },
    { from: { node: 'gi_t', port: 'out' }, to: { node: 'pos', port: 'c' } },
    { from: { node: 'pos', port: 'out' }, to: { node: 'field', port: 'pos' } },
    { from: { node: 'gi_t', port: 'out' }, to: { node: 'field', port: 't' } },
    { from: { node: 'field', port: 'd' }, to: { node: 'step', port: 'a' } },
    { from: { node: 'gi_dist', port: 'out' }, to: { node: 'step', port: 'b' } },
    { from: { node: 'step', port: 'out' }, to: { node: 'glow', port: 'a' } },
    { from: { node: 'pos', port: 'out' }, to: { node: 'pulse', port: 'a' } },
    { from: { node: 'gi_t', port: 'out' }, to: { node: 'pulse', port: 'b' } },
    { from: { node: 'glow', port: 'out' }, to: { node: 'aeff', port: 'a' } },
    { from: { node: 'pulse', port: 'out' }, to: { node: 'aeff', port: 'b' } },
    { from: { node: 'gi_acc', port: 'out' }, to: { node: 'acc_new', port: 'a' } },
    { from: { node: 'aeff', port: 'out' }, to: { node: 'acc_new', port: 'b' } },
    { from: { node: 'gi_acc2', port: 'out' }, to: { node: 'acc2_new', port: 'a' } },
    { from: { node: 'aeff', port: 'out' }, to: { node: 'acc2_new', port: 'b' } },
    { from: { node: 'pulse', port: 'out' }, to: { node: 'acc2_new', port: 'c' } },
    { from: { node: 'step', port: 'out' }, to: { node: 'go_dist', port: 'color' } },
    { from: { node: 'acc_new', port: 'out' }, to: { node: 'go_acc', port: 'color' } },
    { from: { node: 'acc2_new', port: 'out' }, to: { node: 'go_acc2', port: 'color' } },
  ];
  return {
    name: `累积一步（重复 ${STEPS} 次）`,
    carries: ['dist', 'acc', 'acc2'],
    inputs: [
      { id: 'ray', label: 'ray', type: 'vec4' },
      { id: 't', label: 't', type: 'float' },
      { id: 'dist', label: 'dist', type: 'float' },
      { id: 'acc', label: 'acc', type: 'vec4' },
      { id: 'acc2', label: 'acc2', type: 'vec4' },
    ],
    outputs: [
      { id: 'dist', label: 'dist', type: 'float' },
      { id: 'acc', label: 'acc', type: 'vec4' },
      { id: 'acc2', label: 'acc2', type: 'vec4' },
    ],
    nodes,
    edges,
  };
}

/**
 * 整张图：摄像头 → **重复组**（循环体只写一遍）→ 配色。
 *
 * 之前这里是 99 份循环体复制，生成 676 KB 着色器、2 MB 图、codegen 352 ms，
 * 加载直接卡住。改成重复组之后循环体只出现一次。
 */
function ifsTunnelGraph() {
  const step = stepGroup();
  const nodes = [
    { id: 'uv0', type: 'uv', x: 0, y: 0 },
    // ⚠️ 这里必须是 1.0：原版的 speed=3 只乘在 cPos 上，旋转角和脉冲带用的是**原始 t**。
    //    给 time 节点设 scale=3 会把角度也乘 3，姿态就完全不对了（踩过）。
    { id: 't0', type: 'time', x: 0, y: 200, params: { scale: 1.0 } },
    // Shadertoy 对齐：p = (fragCoord * 2 - iResolution.xy) / min(iResolution.x, iResolution.y)
    custom('p1', 'vec4(($in.a.xy * iResolution.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y), 0.0, 1.0)', 260, 0),
    // cPos = (0,0,-speed*t)，cUp = (sin t, 1, 0)，ray = normalize(cross(cDir,cUp)*p.x + cUp*p.y + cDir)
    custom(
      'ray',
      `vec4(normalize(cross(vec3(0.0, 0.0, -1.0), vec3(sin($in.b.x), 1.0, 0.0)) * $in.a.x + vec3(sin($in.b.x), 1.0, 0.0) * $in.a.y + vec3(0.0, 0.0, -1.0)), 0.0)`,
      520,
      0,
    ),
    custom('dist_seed', 'vec4(0.0)', 520, 200),
    custom('acc_seed', 'vec4(0.0)', 520, 340),
    custom('acc2_seed', 'vec4(0.0)', 520, 480),
    { id: 'loop', type: 'group', x: 820, y: 100, params: { repeat: STEPS, graph: step } },
    custom(
      'color',
      `vec4(vec3($in.a.x, $in.a.x * 1.1 + $in.b.x * 0.2, $in.a.x * 1.2 + $in.b.x * 0.5) * ${GAIN.toFixed(5)}, 1.0)`,
      1180,
      200,
    ),
    { id: 'out0', type: 'output', x: 1460, y: 200 },
  ];
  const edges = [
    { from: { node: 'uv0', port: 'out' }, to: { node: 'p1', port: 'a' } },
    { from: { node: 'p1', port: 'out' }, to: { node: 'ray', port: 'a' } },
    { from: { node: 't0', port: 'out' }, to: { node: 'ray', port: 'b' } },
    { from: { node: 'ray', port: 'out' }, to: { node: 'loop', port: 'ray' } },
    { from: { node: 't0', port: 'out' }, to: { node: 'loop', port: 't' } },
    { from: { node: 'dist_seed', port: 'out' }, to: { node: 'loop', port: 'dist' } },
    { from: { node: 'acc_seed', port: 'out' }, to: { node: 'loop', port: 'acc' } },
    { from: { node: 'acc2_seed', port: 'out' }, to: { node: 'loop', port: 'acc2' } },
    { from: { node: 'loop', port: 'acc' }, to: { node: 'color', port: 'a' } },
    { from: { node: 'loop', port: 'acc2' }, to: { node: 'color', port: 'b' } },
    { from: { node: 'color', port: 'out' }, to: { node: 'out0', port: 'color' } },
  ];
  return { name: `IFS 隧道（原版搬移 + 重复组 ${STEPS} 次）`, nodes, edges };
}
// ───────────────────────── 构建 ─────────────────────────

mkdirSync(PROBE_DIR, { recursive: true });
const workspace = new Workspace(WORKSPACE_ROOT);
await workspace.init();

const spec = ifsTunnelGraph();
const graph = buildGraphFromSpec({ name: spec.name, nodes: spec.nodes, edges: spec.edges });
const compiled = compileGraph(graph, 'image', { uniforms: [] });
if (process.env.DUMP) {
  console.log('--- 节点表 ---');
  graph.nodes.forEach((n, i) => {
    const expr = n.params?.expr ? String(n.params.expr).slice(0, 46).replace(/\n/g, ' ') : '';
    console.log(`  [${i}] ${n.id}  ${n.type}  ${expr}`);
  });
}
if (!compiled.ok) {
  console.error('✗ 编译不过：', JSON.stringify(compiled.errors, null, 2));
  process.exit(1);
}
console.log(`demo  画布 ${graph.nodes.length} 节点 / ${graph.edges.length} 连线 · shader ${(compiled.code.length / 1024).toFixed(1)}K`);
console.log(`      展开 ${STEPS} 步 · 步长 ${STRIDE.toFixed(3)}（原版 0.5 × 99）· gain ${GAIN.toFixed(4)}（原版 0.01）`);

writeFileSync(join(PROBE_DIR, 'mine.frag'), compiled.code, 'utf8');
copyFileSync(ORIGINAL_FRAG, join(PROBE_DIR, 'original.frag'));
writeFileSync(
  join(PROBE_DIR, 'manifest.json'),
  `${JSON.stringify({ steps: STEPS, stride: Number(STRIDE.toFixed(4)), gain: Number(GAIN.toFixed(5)), nodes: graph.nodes.length }, null, 2)}\n`,
  'utf8',
);

try {
  await workspace.createProject({ name: 'demo', title: 'IFS 隧道 / Phantom Star', description: '原版搬移 + 循环展开' });
} catch {
  /* 已存在 */
}
try {
  await workspace.createMaterial({ project: 'demo', material: 'phantom-star', title: 'IFS 隧道 / Phantom Star' });
} catch {
  /* 已存在 */
}
await workspace.saveMaterial({ project: 'demo', material: 'phantom-star', graph, manifest: { passes: ['image'] } });
await workspace.write(workspace.materialFile('demo', 'phantom-star', 'phantom-star.frag'), compiled.code);

const exampleDir = join(PLUGIN, 'examples', 'demo');
rmSync(join(exampleDir, 'materials'), { recursive: true, force: true });
rmSync(join(exampleDir, 'project.json'), { force: true });
mkdirSync(join(exampleDir, 'materials'), { recursive: true });
cpSync(join(WORKSPACE_ROOT, 'projects', 'demo'), exampleDir, { recursive: true });

console.log(`\n对比素材写到 ${PROBE_DIR}（original.frag 是原版，mine.frag 是展开版）`);
void existsSync;
