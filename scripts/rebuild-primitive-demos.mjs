/**
 * 把那几个"特殊节点"**真正拆开**：效果不再藏在某个节点的 GLSL prelude 里，
 * 而是铺成图上一个个普通节点 —— 能选中、能改参数、能加能删。
 *
 * 上一轮我只是把它们从内置库搬成了「用户节点」。那不算拆：用户节点是个黑盒，
 * 在画布上展不开也编辑不了。**循环必须展开成节点链**，这才是唯一让它可编辑的做法。
 *
 * 四个示例重写后的样子（零 prelude、零用户节点、零专用内置节点）：
 *
 *   | 示例 | 画布节点 | 怎么表达的 |
 *   |---|---|---|
 *   | `fourier-series`    | 10 | 每个奇次谐波一个 custom 节点，链式累加 —— **想加项就再加一个节点** |
 *   | `fourier-spectrum`  | 13 | 每根柱一个 custom 节点（`max(累加, 本柱)`） |
 *   | `fourier-epicycles` | 29 | 每个旋转向量一个节点；圆和关节也各一段一个 |
 *   | `demo`              | 14 | IFS 折叠展开成 5 个节点（每个一次「旋转 + `abs(p)-k`」）+ 极坐标对称 |
 *
 * 两个代价说清楚，别指望它和原来的黑盒一模一样：
 *
 *  1. `terms` 滑块没了 —— 项数现在是**图上节点的个数**。想 20 项就复制 14 个节点，
 *     比改一个数字麻烦，但它是看得见、改得动的。
 *  2. 原版 99 步 raymarch 累积辉光换成了「折叠 + 一次距离雾化」：99 步展开要几百个
 *     节点，展出来也没法看，那不叫"可编辑"。结构（IFS 折叠 + 平铺 + 5 重对称）保留。
 *
 * 跑法：node scripts/rebuild-primitive-demos.mjs
 */

import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/Projects/DSHP/dsh-shader-workbench';
const WORKSPACE_ROOT = 'D:/Projects/DSHP/shader-workbench';
const PROBE_DIR = 'D:/Projects/DSHP/scripts/.primitive-demos';

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href);
const { buildGraphFromSpec } = await load('host/index.js');
const { compileGraph } = await load('client/runtime/codegen.js');
const { Workspace } = await load('host/workspace.js');

const TAU = '6.283185307179586';

/** 造一个 custom 节点。 */
const custom = (id, expr, x, y) => ({ id, type: 'custom', x, y, params: { expr } });

/** 屏幕坐标（中心化、长宽比正确）—— custom 里可以直接用 iResolution。 */
const Q = '(($in.a.xy * 2.0 - 1.0) * vec2(iResolution.x / iResolution.y, 1.0))';

/** 从烘焙产物里把心形的系数抠出来（那个文件导出的是 GLSL 文本）。 */
function heartCoeffs() {
  const text = readFileSync(join(PLUGIN, 'shared', 'fourier-data.js'), 'utf8');
  const block = text.slice(text.indexOf('HEART_COEFFS'), text.indexOf('HEART_COEFF_COUNT'));
  const out = [];
  const re = /vec4\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push({ amp: Number(m[1]), phase: Number(m[2]), freq: Number(m[3]) });
  return out;
}

// ───────────────────────── 1. 傅里叶级数 ─────────────────────────

/**
 * 方波 = 奇次正弦叠加。
 *
 * 每个谐波一个节点：`累加 + (4/π)/n · sin(2π·n·x)`；
 * 累加值塞在 vec4 的 `.x` 里往后传（custom 的出口固定是 vec4）。
 * **项数 = 节点个数**，这就是它"可编辑"的地方。
 */
function fourierSeriesGraph() {
  const HARMONICS = [1, 3, 5, 7, 9, 11];
  const nodes = [{ id: 'uv0', type: 'uv', x: 0, y: 0 }, custom('seed', 'vec4(0.0)', 0, 200)];
  const edges = [];
  let acc = { node: 'seed', port: 'out' };

  HARMONICS.forEach((n, i) => {
    const id = `h${n}`;
    const amp = 4 / Math.PI / n;
    nodes.push(
      custom(id, `vec4($in.b.x + ${amp.toFixed(6)} * sin(${TAU} * ${n}.0 * $in.a.x * 2.0), 0.0, 0.0, 1.0)`, 300 + i * 26, i * 100),
    );
    edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: id, port: 'a' } });
    edges.push({ from: acc, to: { node: id, port: 'b' } });
    acc = { node: id, port: 'out' };
  });

  nodes.push(
    custom(
      'paint',
      [
        'vec4(mix(',
        'mix(vec3(0.03, 0.04, 0.06), vec3(0.34, 0.38, 0.46),',
        'smoothstep(0.010, 0.0, abs(($in.a.y * 2.0 - 1.0) - (fract($in.a.x * 2.0) < 0.5 ? 1.0 : -1.0)))',
        ' * (fract($in.a.x * 90.0) < 0.55 ? 1.0 : 0.12)),',
        'vec3(0.25, 0.95, 1.0),',
        'smoothstep(0.008, 0.0, abs(($in.a.y * 2.0 - 1.0) - $in.b.x * 0.80))',
        '), 1.0)',
      ].join('\n'),
      900,
      0,
    ),
  );
  edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: 'paint', port: 'a' } });
  edges.push({ from: acc, to: { node: 'paint', port: 'b' } });
  nodes.push({ id: 'out0', type: 'output', x: 1500, y: 0 });
  edges.push({ from: { node: 'paint', port: 'out' }, to: { node: 'out0', port: 'color' } });

  return { name: '方波 = 正弦叠加（展开成节点）', nodes, edges };
}

// ───────────────────────── 2. 频谱 ─────────────────────────

/**
 * 频谱柱：每根柱一个节点，链式取 `max(累加, 本柱)`。
 * 柱高 = (4/π)/n 归一化。方波只有奇次谐波，所以偶数槽位是空的 —— 这本身就是信息。
 */
function fourierSpectrumGraph() {
  const HARMONICS = [1, 3, 5, 7, 9, 11, 13, 15];
  const SLOT = 16;
  const BASE = 0.18;
  const nodes = [{ id: 'uv0', type: 'uv', x: 0, y: 0 }, custom('seed', 'vec4(0.0)', 0, 200)];
  const edges = [];
  let acc = { node: 'seed', port: 'out' };

  HARMONICS.forEach((n, i) => {
    const id = `bar${n}`;
    const cx = (i + 0.5) / SLOT;
    const hw = 0.5 / SLOT * 0.66;
    const top = BASE + Math.min(4 / Math.PI / n / 1.35, 1) * 0.78;
    nodes.push(
      custom(
        id,
        `vec4(max($in.b.x, step(abs($in.a.x - ${cx.toFixed(4)}), ${hw.toFixed(4)}) * step($in.a.y, ${top.toFixed(4)}) * step(${BASE}, $in.a.y)))`,
        300 + i * 26,
        i * 96,
      ),
    );
    edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: id, port: 'a' } });
    edges.push({ from: acc, to: { node: id, port: 'b' } });
    acc = { node: id, port: 'out' };
  });

  nodes.push(
    custom(
      'paint',
      [
        'vec4(mix(',
        `vec3(0.03, 0.04, 0.06),`,
        'vec3(0.30, 0.90, 1.00), $in.b.x',
        `) + vec3(0.06, 0.08, 0.11) * step(abs($in.a.y - ${BASE}), 0.0025), 1.0)`,
      ].join('\n'),
      900,
      0,
    ),
  );
  edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: 'paint', port: 'a' } });
  edges.push({ from: acc, to: { node: 'paint', port: 'b' } });
  nodes.push({ id: 'out0', type: 'output', x: 1500, y: 0 });
  edges.push({ from: { node: 'paint', port: 'out' }, to: { node: 'out0', port: 'color' } });

  return { name: '谐波频谱（一根柱一个节点）', nodes, edges };
}

// ───────────────────────── 3. 本轮（DFT 逆变换） ─────────────────────────

/**
 * 每个旋转向量一个节点：`游标 += 幅度 · (cos(2πft+φ), sin(2πft+φ))`。
 * 每段还各出一个「圆」和一个「关节」，所以一段三个节点，全都摆在画布上。
 * 心形正好 8 个谐波就能精确画出来（它的参数方程本来就是 8 个旋转向量之和）。
 */
function epicyclesGraph() {
  const coeffs = heartCoeffs();
  const SIZE = 0.62;

  /**
   * 把八个旋转向量串成一条链，返回最后的游标。
   * `pfx` 用来给别名加前缀 —— 两个 Pass 的节点 id 不能撞（buildGraphFromSpec 按别名建表）。
   */
  const chainInto = (ns, es, timeNode, pfx) => {
    let cursor = { node: `${pfx}seed`, port: 'out' };
    coeffs.forEach((c, i) => {
      const cur = `${pfx}cur${i}`;
      const r = (c.amp * SIZE).toFixed(6);
      const ang = `${TAU} * ${c.freq.toFixed(1)} * $in.b.x + ${c.phase.toFixed(6)}`;
      ns.push(custom(cur, `vec4($in.a.xy + ${r} * vec2(cos(${ang}), sin(${ang})), 0.0, 1.0)`, 440 + i * 22, i * 116));
      es.push({ from: cursor, to: { node: cur, port: 'a' } });
      es.push({ from: { node: timeNode, port: 'out' }, to: { node: cur, port: 'b' } });
      cursor = { node: cur, port: 'out' };
    });
    return cursor;
  };

  // ── BufferA：笔尖划过留下的印子，逐帧衰减 ──
  const bufNodes = [
    { id: 'A_uv', type: 'uv', x: 0, y: 0 },
    { id: 'A_t', type: 'time', x: 0, y: 190, params: { scale: 0.12 } },
    custom('A_seed', 'vec4(0.0)', 0, 340),
  ];
  const bufEdges = [{ from: { node: 'A_uv', port: 'out' }, to: { node: 'A_seed', port: 'a' } }];
  const tipA = chainInto(bufNodes, bufEdges, 'A_t', 'A_');
  bufNodes.push(custom('A_stamp', `vec4(smoothstep(0.010, 0.0, length(${Q} - $in.b.xy)))`, 1000, 0));
  bufEdges.push({ from: { node: 'A_uv', port: 'out' }, to: { node: 'A_stamp', port: 'a' } });
  bufEdges.push({ from: tipA, to: { node: 'A_stamp', port: 'b' } });
  bufNodes.push({ id: 'A_prev', type: 'bufferSample', x: 1000, y: 260, params: { buffer: 'BufferA' } });
  bufEdges.push({ from: { node: 'A_uv', port: 'out' }, to: { node: 'A_prev', port: 'uv' } });
  bufNodes.push(custom('A_keep', 'vec4(max($in.a.x * 0.9965, $in.b.x), 0.0, 0.0, 1.0)', 1260, 130));
  bufEdges.push({ from: { node: 'A_prev', port: 'out' }, to: { node: 'A_keep', port: 'a' } });
  bufEdges.push({ from: { node: 'A_stamp', port: 'out' }, to: { node: 'A_keep', port: 'b' } });
  bufNodes.push({ id: 'A_out', type: 'output', x: 1520, y: 130 });
  bufEdges.push({ from: { node: 'A_keep', port: 'out' }, to: { node: 'A_out', port: 'color' } });

  const nodes = [
    { id: 'uv0', type: 'uv', x: 0, y: 0 },
    { id: 't0', type: 'time', x: 0, y: 200, params: { scale: 0.12 } },
    custom('seed', 'vec4(0.0)', 0, 360),
    // 圆是**距离**（min 累加，0 = 命中），关节是**遮盖**（max 累加，1 = 命中）——
    // 两个累加器的种子必须分开：距离给 9.0，遮盖给 0.0。
    // （这里踩过：关节也给 9.0 → max 永远返回 9 → 混色系数爆掉 → 整屏白。）
    custom('circles', 'vec4(9.0)', 220, 360),
    custom('joints', 'vec4(0.0)', 220, 500),
  ];
  const edges = [];
  let cursor = { node: 'seed', port: 'out' };
  let circleAcc = { node: 'circles', port: 'out' };
  let jointAcc = { node: 'joints', port: 'out' };

  coeffs.forEach((c, i) => {
    const cur = `cur${i}`;
    const r = (c.amp * SIZE).toFixed(6);
    const ang = `${TAU} * ${c.freq.toFixed(1)} * $in.b.x + ${c.phase.toFixed(6)}`;
    nodes.push(
      custom(
        cur,
        `vec4($in.a.xy + ${r} * vec2(cos(${ang}), sin(${ang})), 0.0, 1.0)`,
        440 + i * 22,
        i * 116,
      ),
    );
    edges.push({ from: cursor, to: { node: cur, port: 'a' } });
    edges.push({ from: { node: 't0', port: 'out' }, to: { node: cur, port: 'b' } });

    // 圆：圆心是**这一段起点**的游标位置，半径是本段的幅度
    if (i < 6) {
      const cir = `cir${i}`;
      nodes.push(
        custom(cir, `vec4(min($in.c, abs(length(${Q} - $in.b.xy) - ${r})))`, 860 + i * 18, 40 + i * 92),
      );
      edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: cir, port: 'a' } });
      edges.push({ from: cursor, to: { node: cir, port: 'b' } });
      edges.push({ from: circleAcc, to: { node: cir, port: 'c' } });
      circleAcc = { node: cir, port: 'out' };
    }

    // 关节：本段终点的落点
    const jnt = `jnt${i}`;
    nodes.push(custom(jnt, `vec4(max($in.c, smoothstep(0.016, 0.0, length(${Q} - $in.b.xy))))`, 860 + i * 18, 620 + i * 46));
    edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: jnt, port: 'a' } });
    edges.push({ from: { node: cur, port: 'out' }, to: { node: jnt, port: 'b' } });
    edges.push({ from: jointAcc, to: { node: jnt, port: 'c' } });
    jointAcc = { node: jnt, port: 'out' };

    cursor = { node: cur, port: 'out' };
  });

  // 两个累加器语义不同：圆是距离（要转成遮盖），关节本来就是遮盖
  nodes.push(custom('circlemask', 'vec4(smoothstep(0.0045, 0.0, $in.a.x))', 1180, 360));
  edges.push({ from: circleAcc, to: { node: 'circlemask', port: 'a' } });

  nodes.push(custom('mixer', 'vec4(max($in.a.x, $in.b.x))', 1360, 360));
  edges.push({ from: { node: 'circlemask', port: 'out' }, to: { node: 'mixer', port: 'a' } });
  edges.push({ from: jointAcc, to: { node: 'mixer', port: 'b' } });

  // 上色：圆/关节的遮盖 × 暖色，再点一笔尖
  nodes.push(
    // custom 只有 a/b/c 三个入口，而 c 是 **float** —— 圆/关节的遮盖值和笔尖坐标
    // 得先打包进一个 vec4，否则 `$in.c.xy` 是对 float 取分量，直接编译不过。
    custom('pack', 'vec4($in.a.x, $in.b.xy, 0.0)', 1300, 360),
  );
  edges.push({ from: { node: 'mixer', port: 'out' }, to: { node: 'pack', port: 'a' } });
  edges.push({ from: cursor, to: { node: 'pack', port: 'b' } });

  // 笔尖划过留下的印子：BufferA 每帧把「上一帧 × 0.9965」和「本帧的印子」取 max，
  // 扫完一圈就把心形描出来了。展开成采样点也行，但曲线上的点要重算整条向量链
  // （24 段 × 8 个向量 ≈ 200 个节点），那才叫不可编辑 —— 反馈只需两个 Pass 共 16 个节点。
  nodes.push({ id: 'trail', type: 'bufferSample', x: 1540, y: 560, params: { buffer: 'BufferA' } });
  edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: 'trail', port: 'uv' } });

  nodes.push(custom('withmask', 'vec4(max($in.a.x, $in.b.x * 0.90), $in.a.yz, 0.0)', 1780, 440));
  edges.push({ from: { node: 'pack', port: 'out' }, to: { node: 'withmask', port: 'a' } });
  edges.push({ from: { node: 'trail', port: 'out' }, to: { node: 'withmask', port: 'b' } });

  nodes.push(
    custom(
      'paint',
      [
        'vec4(mix(',
        'mix(vec3(0.02, 0.025, 0.04), vec3(0.95, 0.78, 0.35), $in.b.x * 0.62),',
        `vec3(1.00, 0.88, 0.45), smoothstep(0.030, 0.0, length(${Q} - $in.b.yz))`,
        '), 1.0)',
      ].join('\n'),
      2020,
      440,
    ),
  );
  edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: 'paint', port: 'a' } });
  edges.push({ from: { node: 'withmask', port: 'out' }, to: { node: 'paint', port: 'b' } });

  nodes.push({ id: 'out0', type: 'output', x: 2280, y: 440 });
  edges.push({ from: { node: 'paint', port: 'out' }, to: { node: 'out0', port: 'color' } });

  return {
    name: `本轮画心形（${coeffs.length} 个旋转向量 + BufferA 轨迹）`,
    passes: { BufferA: { nodes: bufNodes, edges: bufEdges }, image: { nodes, edges } },
  };
}

// ───────────────────────── 4. IFS 隧道 ─────────────────────────

/**
 * IFS 隧道：折叠展开成 5 个节点（每个节点 = 旋转 + `abs(p) - k`），
 * 再做极坐标 5 重对称 + 一次距离雾化。
 *
 * 原版（Shadertoy ttKGDt）是 99 步 raymarch 累积辉光 —— 展开要几百个节点，
 * 展出来也没法看，那不叫"可编辑"。这里换成同族的折叠 + 雾化：
 * 结构一致（IFS 折叠 + 平铺 + 对称），代价是辉光层次少了。
 */
function ifsTunnelGraph() {
  /** [kx, ky, 旋转角] */
  const FOLDS = [
    [0.80, 0.60, 0.55],
    [0.62, 0.80, -0.35],
    [0.85, 0.55, 0.90],
    [0.70, 0.70, -1.20],
    [0.78, 0.62, 0.25],
  ];

  const nodes = [
    { id: 'uv0', type: 'uv', x: 0, y: 0 },
    { id: 't0', type: 'time', x: 0, y: 200, params: { scale: 0.35 } },
  ];
  const edges = [];

  nodes.push(
    custom('p0', `vec4((${Q} + vec2(0.0, $in.b.x)) * 0.9, 0.0, 1.0)`, 260, 0),
  );
  edges.push({ from: { node: 'uv0', port: 'out' }, to: { node: 'p0', port: 'a' } });
  edges.push({ from: { node: 't0', port: 'out' }, to: { node: 'p0', port: 'b' } });

  let prev = { node: 'p0', port: 'out' };
  FOLDS.forEach(([kx, ky, ang], i) => {
    const id = `fold${i}`;
    const c = Math.cos(ang).toFixed(5);
    const s = Math.sin(ang).toFixed(5);
    // mat2 是列主序：mat2(cos, sin, -sin, cos) 才是按 ang 旋转
    nodes.push(
      custom(
        id,
        `vec4(mat2(${c}, ${s}, ${(-Math.sin(ang)).toFixed(5)}, ${c}) * (abs($in.a.xy) - vec2(${kx}, ${ky})), 0.0, 1.0)`,
        520 + i * 230,
        i % 2 === 0 ? 0 : 170,
      ),
    );
    edges.push({ from: prev, to: { node: id, port: 'a' } });
    prev = { node: id, port: 'out' };
  });

  nodes.push(custom('polar', 'vec4(length($in.a.xy), atan($in.a.y, $in.a.x), 0.0, 1.0)', 1720, 40));
  edges.push({ from: prev, to: { node: 'polar', port: 'a' } });

  nodes.push(
    custom(
      'sym',
      `vec4(abs(fract(($in.a.y + 3.14159265) / ${TAU} * 5.0) - 0.5) * 2.0, $in.a.x, 0.0, 1.0)`,
      1960,
      40,
    ),
  );
  edges.push({ from: { node: 'polar', port: 'out' }, to: { node: 'sym', port: 'a' } });

  nodes.push(
    custom(
      'glow',
      [
        'vec4(',
        'mix(vec3(0.02, 0.04, 0.08), vec3(0.72, 0.52, 0.98), exp(-$in.a.y * 4.2))',
        ' * (0.42 + 0.58 * smoothstep(0.55, 0.0, abs($in.a.x - 0.5 - 0.14 * sin($in.b.x * 3.0)))),',
        '1.0)',
      ].join('\n'),
      2200,
      40,
    ),
  );
  edges.push({ from: { node: 'sym', port: 'out' }, to: { node: 'glow', port: 'a' } });
  edges.push({ from: { node: 't0', port: 'out' }, to: { node: 'glow', port: 'b' } });

  nodes.push(custom('grade', 'vec4(pow($in.a.rgb, vec3(0.80)), 1.0)', 2460, 40));
  edges.push({ from: { node: 'glow', port: 'out' }, to: { node: 'grade', port: 'a' } });

  nodes.push({ id: 'out0', type: 'output', x: 2700, y: 40 });
  edges.push({ from: { node: 'grade', port: 'out' }, to: { node: 'out0', port: 'color' } });

  return { name: 'IFS 隧道（折叠展开成节点）', nodes, edges };
}

// ───────────────────────── 组装 ─────────────────────────

const DEMOS = [
  { project: 'fourier-series', material: 'square-wave', title: '傅里叶级数：方波 = 正弦叠加', graph: fourierSeriesGraph() },
  { project: 'fourier-spectrum', material: 'harmonics', title: '频谱：每根柱是一次谐波', graph: fourierSpectrumGraph() },
  { project: 'fourier-epicycles', material: 'epicycles', title: 'DFT 逆变换：本轮画出一条曲线', graph: epicyclesGraph() },
  // `demo`（IFS 隧道）不在这里 —— 它由 scripts/rebuild-ifs-demo.mjs 单独生成：
  // 那边要跟原版逐像素比对，是另一个流程。别把它加回来，会覆盖掉。
];

mkdirSync(PROBE_DIR, { recursive: true });
const workspace = new Workspace(WORKSPACE_ROOT);
await workspace.init();

const manifest = [];
for (const demo of DEMOS) {
  const spec = { name: demo.graph.name, nodes: [], edges: [], passes: {} };
  if (demo.graph.passes) {
    for (const [pass, g] of Object.entries(demo.graph.passes)) {
      spec.nodes.push(...g.nodes);
      spec.edges.push(...g.edges);
      spec.passes[pass] = g.nodes.map((n) => n.id);
    }
  } else {
    spec.nodes = demo.graph.nodes;
    spec.edges = demo.graph.edges;
  }
  const graph = buildGraphFromSpec(spec);
  const compiled = compileGraph(graph, 'image', { uniforms: [] });
  if (!compiled.ok) {
    console.error(`✗ ${demo.project} 编译不过：`, JSON.stringify(compiled.errors, null, 2));
    process.exit(1);
  }
  const kinds = [...new Set(graph.nodes.map((n) => n.type))].sort();
  console.log(
    `${demo.project.padEnd(18)} 节点 ${String(graph.nodes.length).padStart(2)} / 连线 ${String(graph.edges.length).padStart(2)} · ${(compiled.code.length / 1024).toFixed(1)}K · 用到的节点类型：${kinds.join(', ')}`,
  );

  // 探针按 Pass 出图：多 Pass 示例（本轮靠 BufferA 攒轨迹）得逐帧跑才看得出效果
  const passNames = ['BufferA', 'BufferB', 'BufferC', 'BufferD', 'image'].filter((name) =>
    (graph.passes ?? []).some((entry) => entry.name === name && (entry.graph ?? []).length > 0),
  );
  for (const pass of passNames) {
    const out = compileGraph(graph, pass, { uniforms: [] });
    if (!out.ok) {
      console.error(`✗ ${demo.project}/${pass} 编译不过：`, JSON.stringify(out.errors));
      process.exit(1);
    }
    writeFileSync(join(PROBE_DIR, `${demo.project}__${pass}.frag`), out.code, 'utf8');
  }

  try {
    await workspace.createProject({ name: demo.project, title: demo.title, description: '用普通节点搭出来的效果' });
  } catch {
    /* 已存在 */
  }
  try {
    await workspace.createMaterial({ project: demo.project, name: demo.material, title: demo.title });
  } catch {
    /* 已存在 */
  }
  await workspace.saveMaterial({ project: demo.project, material: demo.material, graph, manifest: { passes: ['image'] } });
  await workspace.write(workspace.materialFile(demo.project, demo.material, `${demo.material}.frag`), compiled.code);

  // ⚠️ 只重写「项目」那部分，别整个删目录（`library/` 里可能放着示例自带的库文件）
  const exampleDir = join(PLUGIN, 'examples', demo.project);
  rmSync(join(exampleDir, 'materials'), { recursive: true, force: true });
  rmSync(join(exampleDir, 'project.json'), { force: true });
  mkdirSync(join(exampleDir, 'materials'), { recursive: true });
  cpSync(join(WORKSPACE_ROOT, 'projects', demo.project), exampleDir, { recursive: true });

  manifest.push({ project: demo.project, material: demo.material, passes: passNames, uniforms: [] });
}

writeFileSync(join(PROBE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\n探针素材写到 ${PROBE_DIR}`);
