/**
 * 烘焙「本轮（epicycles）」要用的傅里叶系数与轨迹折线。
 *
 * 为什么要烘焙、而不是在 shader 里现算：
 *   1. **系数**：要对一条采样曲线做 DFT，是 O(N²)，shader 里每个像素算一遍不可能。
 *      这里用 JS 算好，烤成 GLSL 的 `const vec4[]`（幅度 / 相位 / 频率）。
 *   2. **轨迹折线**：把曲线画出来需要「点到曲线的距离」。直接按时间采样求和是
 *      O(点数 × 阶数)/像素，太贵；烤成 160 段折线后，每像素只要做 160 次线段距离
 *      （每次约 10 次浮点运算），1080p 也扛得住。
 *
 * 形状用参数方程给（心形 / 五角星），所以不依赖任何外部素材，随时能重烤。
 *
 * 跑法：node scripts/bake-fourier-epicycles.mjs
 * 产物：shared/fourier-data.js（自动生成，别手改）
 *
 * @module dsh-shader-workbench/scripts/bake-fourier-epicycles
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 采样点数（DFT 的 N）。 */
const SAMPLES = 1024;
/** 保留的谐波阶数（正负各这么多，按幅度从大到小排序后取前 N）。 */
const HARMONICS = 48;
/** 轨迹折线的点数。 */
const PATH_POINTS = 120;

/**
 * 参数形状表。t ∈ [0, 1) 走一圈。
 * @type {Record<string, (t:number) => [number, number]>}
 */
const SHAPES = {
  // 经典心形（16 sin³t / 13cos t − 5cos2t − 2cos3t − cos4t）
  heart(t) {
    const a = t * Math.PI * 2;
    return [
      16 * Math.sin(a) ** 3,
      13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a),
    ];
  },
  // 五角星：用尖角版本（星形多边形公式），谐波衰减慢 —— 这样才看得到「项数越多越像」
  star(t) {
    const a = t * Math.PI * 2;
    const spikes = 5;
    const half = Math.PI / spikes;
    const local = (((a % (2 * half)) + 2 * half) % (2 * half)) - half;
    const r = Math.cos(half) / Math.cos(local);
    return [r * Math.cos(a), r * Math.sin(a)];
  },
};

/**
 * 把采样点居中并缩放到「最大半径 = 1」。
 * @param {Array<[number,number]>} points
 * @returns {Array<[number,number]>}
 */
function normalize(points) {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let max = 0;
  for (const [x, y] of points) max = Math.max(max, Math.hypot(x - cx, y - cy));
  return points.map(([x, y]) => [(x - cx) / max, (y - cy) / max]);
}

/**
 * 对闭合曲线做 DFT，取幅度最大的前 K 个谐波。
 *
 * 复系数 c_k = (1/N) Σ z_n e^{-i2πkn/N}；重建时每一项是
 * 一个长度 a_k、初相 φ_k、角速度 2πk 的旋转向量 —— 也就是一个「本轮」。
 *
 * @param {Array<[number,number]>} points
 * @returns {Array<{amp:number, phase:number, freq:number}>}
 */
function dft(points) {
  const n = points.length;
  const out = [];
  for (let k = -HARMONICS; k <= HARMONICS; k += 1) {
    // k = 0 是直流分量：形状已经居中了，跳掉
    if (k === 0) continue;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (-2 * Math.PI * k * i) / n;
      const [x, y] = points[i];
      re += x * Math.cos(angle) - y * Math.sin(angle);
      im += x * Math.sin(angle) + y * Math.cos(angle);
    }
    re /= n;
    im /= n;
    const amp = Math.hypot(re, im);
    if (amp < 1e-6) continue;
    out.push({ amp, phase: Math.atan2(im, re), freq: k });
  }
  return out.sort((a, b) => b.amp - a.amp);
}

/** 数字格式化：固定 6 位小数，够 GLSL 用，又不至于太长。 */
const f = (v) => {
  const s = v.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

/**
 * 生成一个形状的 GLSL 数据块。
 * @param {string} name
 * @returns {string}
 */
function bakeShape(name) {
  const raw = [];
  for (let i = 0; i < SAMPLES; i += 1) raw.push(SHAPES[name](i / SAMPLES));

  // 系数用归一化后的点算，这样 shader 里只要乘一个尺寸就行
  const normalized = normalize(raw);
  const coeffs = dft(normalized);

  // 轨迹折线直接用参数方程采样（不受保留阶数影响，画出来是理想形状）
  const path = [];
  for (let i = 0; i < PATH_POINTS; i += 1) path.push(SHAPES[name](i / PATH_POINTS));
  const pathNormalized = normalize(path);

  const coeffLines = coeffs.map((c) => `  vec4(${f(c.amp)}, ${f(c.phase)}, ${f(c.freq)}, 0.0)`).join(',\n');
  const pathLines = pathNormalized.map(([x, y]) => `  vec2(${f(x)}, ${f(y)})`).join(',\n');

  return {
    name,
    count: coeffs.length,
    coeffGlsl: coeffLines,
    pathGlsl: pathLines,
    // 只打几个数出来看衰减，验证烘焙结果是不是合理
    topAmps: coeffs.slice(0, 6).map((c) => c.amp.toFixed(3)),
  };
}

const shapes = ['heart', 'star'].map(bakeShape);

const body = `/**
 * 傅里叶系数烘焙产物 —— **自动生成，别手改。**
 *
 * 重新生成：node scripts/bake-fourier-epicycles.mjs
 *
 * 导出的都是 **GLSL 源码片段**（不是 JS 数组）：节点把它拼进 glslPrelude，
 * 变成 shader 里的 const 数组。所以这个文件在 JS 里 import 只有字符串，
 * 不会有"vec4 is not defined"这种事。
 *
 *   - COEFFS：DFT 系数，vec4(幅度, 相位, 频率, 0)。频率带符号，按幅度从大到小排，
 *     取前 N 个 = 「用 N 个本轮画这条曲线」。
 *   - PATH：轨迹折线，vec2(x, y)，归一化到最大半径 1。画曲线用。
 *
 * @module dsh-shader-workbench/shared/fourier-data
 */

`;

const out = [
  body,
  ...shapes.map(
    (s) =>
      `/** ${s.name}：${s.count} 个谐波（前几阶幅度 ${s.topAmps.join(' / ')}） */\nexport const ${s.name.toUpperCase()}_COEFFS = \`\n${s.coeffGlsl}\`;\n\nexport const ${s.name.toUpperCase()}_COEFF_COUNT = ${s.count};\n\n/** ${s.name}：轨迹折线 */\nexport const ${s.name.toUpperCase()}_PATH = \`\n${s.pathGlsl}\`;\n\nexport const ${s.name.toUpperCase()}_PATH_COUNT = ${PATH_POINTS};\n`,
  ),
  `/** 形状名 → 数据。 */\nexport const FOURIER_SHAPES = Object.freeze({\n${shapes
    .map(
      (s) =>
        `  ${s.name}: { coeffs: ${s.name.toUpperCase()}_COEFFS, coeffCount: ${s.name.toUpperCase()}_COEFF_COUNT, path: ${s.name.toUpperCase()}_PATH, pathCount: ${s.name.toUpperCase()}_PATH_COUNT },`,
    )
    .join('\n')}\n});\n`,
].join('\n');

const target = join(fileURLToPath(new URL('..', import.meta.url)), 'shared', 'fourier-data.js');
writeFileSync(target, out, 'utf8');

console.log(`写入 ${target}`);
for (const s of shapes) console.log(`  ${s.name}: ${s.count} 个谐波 + ${PATH_POINTS} 个折线点`);
console.log(`  文件大小 ${(out.length / 1024).toFixed(1)} KB`);
