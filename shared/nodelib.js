/**
 * 节点库数据表。
 *
 * 本文件只放数据，不放函数（`resolvePortType` / `getNodeDef` 在 nodes.js）。
 * 每个条目的 `code` 必须是**单个 GLSL 表达式**，见 nodes.js 顶部约定。
 *
 * @module dsh-shader-workbench/shared/nodelib
 */

import { PORT_TYPES, defineNode, port } from './graph.js';

const f = (id, label, def) => port(id, 'float', { label, def });
const v2 = (id, label, def) => port(id, 'vec2', { label, def });
const v3 = (id, label, def) => port(id, 'vec3', { label, def });
const v4 = (id, label, def) => port(id, 'vec4', { label, def });

/** 通道下拉选项。 */
const CHANNELS = ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'];
/** Buffer 下拉选项。 */
const BUFFERS = ['BufferA', 'BufferB', 'BufferC', 'BufferD'];
/** 标量/向量类型选项。 */
const SCALAR_VEC = ['float', 'vec2', 'vec3', 'vec4'];

/**
 * 把 params.outType 映射到输出端口类型。
 * @param {object} params
 * @param {object[]} ports
 * @returns {object[]}
 */
const outTypePorts = (params, ports) =>
  ports.map((p) => (p.id === 'out' ? { ...p, type: params.outType ?? 'float' } : p));

/**
 * 未冻结的节点定义数组。
 * @type {object[]}
 */
export const NODE_LIBRARY_RAW = [
  // ───────────────────────── 输入 ─────────────────────────
  // ───────────────────────── 音频 ─────────────────────────
defineNode({
  type: 'audioFFT',
  title: '音频频谱',
  category: '音频',
  doc: '取 FFT 某个频段的幅度（0..1）。需要先在预览栏「载入音频」把音源绑到 iChannel。',
  inputs: [f('bin', '频段 0..1', 0.3)],
  outputs: [f('out', '幅度')],
  params: { channel: { type: 'select', value: 'iChannel0', options: CHANNELS, label: '通道' } },
  code: 'AUDIO_FFT',
  audioSample: 'spectrum',
}),
defineNode({
  type: 'audioWave',
  title: '音频波形',
  category: '音频',
  doc: '取波形某个采样点，值域 −1..1。',
  inputs: [f('t', '采样点 0..1', 0.5)],
  outputs: [f('out', '波形')],
  params: { channel: { type: 'select', value: 'iChannel0', options: CHANNELS, label: '通道' } },
  code: 'AUDIO_WAVE',
  audioSample: 'wave',
}),
  defineNode({
    type: 'uv',
    title: 'UV 坐标',
    category: '输入',
    doc: '归一化屏幕坐标 0..1，y 轴向上（Shadertoy 口径）。',
    inputs: [],
    outputs: [v2('out', 'uv')],
    params: {},
    code: 'gl_FragCoord.xy / iResolution.xy',
  }),
  defineNode({
    type: 'aspect',
    title: '宽高比',
    category: '输入',
    doc: 'iResolution.x / iResolution.y',
    inputs: [],
    outputs: [f('out', 'aspect')],
    params: {},
    code: 'iResolution.x / iResolution.y',
  }),
  defineNode({
    type: 'time',
    title: '时间 iTime',
    category: '输入',
    doc: '秒为单位的时间。',
    inputs: [],
    outputs: [f('out', 't')],
    params: { scale: { type: 'float', value: 1, min: 0, max: 8, label: '倍率' } },
    code: 'iTime * $p.scale',
  }),
  defineNode({
    type: 'resolution',
    title: '分辨率',
    category: '输入',
    doc: '当前 Pass 的渲染分辨率（像素）。',
    inputs: [],
    outputs: [v2('out', 'res')],
    params: {},
    code: 'iResolution.xy',
  }),
  defineNode({
    type: 'mouse',
    title: '鼠标 iMouse',
    category: '输入',
    doc: 'xy = 按下位置，zw = 当前位置（像素）；未按下时 zw 为负。',
    inputs: [],
    outputs: [v4('out', 'mouse')],
    params: {},
    code: 'iMouse',
  }),
  defineNode({
    type: 'mouseUV',
    title: '鼠标 UV',
    category: '输入',
    doc: 'iMouse.zw 换算成 0..1。',
    inputs: [],
    outputs: [v2('out', 'uv')],
    params: {},
    code: 'iMouse.zw / iResolution.xy',
  }),
  defineNode({
    type: 'const',
    title: '常量',
    category: '输入',
    doc: '直接输出一个数值/向量。',
    inputs: [],
    outputs: [port('out', 'vec3', { label: 'value' })],
    params: {
      value: { type: 'vec3', value: [0.5, 0.5, 0.5], label: '值' },
      outType: { type: 'select', value: 'float', options: SCALAR_VEC, label: '输出类型' },
    },
    code: '$p.value',
    dynamicOut: outTypePorts,
  }),
  defineNode({
    type: 'uniform',
    title: '自定义参数',
    category: '输入',
    doc: '引用一个自定义 uniform。名字必须和「参数」面板里的一致。',
    inputs: [],
    outputs: [port('out', 'float', { label: 'value' })],
    params: {
      name: { type: 'text', value: 'uValue', label: '参数名' },
      outType: { type: 'select', value: 'float', options: SCALAR_VEC, label: '类型' },
    },
    code: '$p.name',
    dynamicOut: outTypePorts,
  }),

  // ───────────────────────── 数学 ─────────────────────────
  defineNode({
    type: 'add',
    title: '相加 +',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_add($in.a, $in.b)',
    helpers: ['st_add'],
    defaults: { a: 0, b: 0 },
  }),
  defineNode({
    type: 'sub',
    title: '相减 −',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_sub($in.a, $in.b)',
    helpers: ['st_sub'],
    defaults: { a: 0, b: 0 },
  }),
  defineNode({
    type: 'mul',
    title: '相乘 ×',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_mul($in.a, $in.b)',
    helpers: ['st_mul'],
    defaults: { a: 1, b: 1 },
  }),
  defineNode({
    type: 'div',
    title: '相除 ÷',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_div($in.a, $in.b)',
    helpers: ['st_div'],
    defaults: { a: 1, b: 1 },
  }),
  defineNode({
    type: 'pow',
    title: '幂 pow',
    category: '数学',
    inputs: [v4('a', 'a'), f('b', 'exponent', 2)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_pow($in.a, $in.b)',
    helpers: ['st_pow'],
    defaults: { a: 1 },
  }),
  defineNode({
    type: 'sqrt',
    title: '开方 sqrt',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'sqrt(max($in.in, vec4(0.0)))',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'abs',
    title: '绝对值 abs',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'abs($in.in)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'floor',
    title: '向下取整 floor',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'floor($in.in)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'fract',
    title: '取小数 fract',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'fract($in.in)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'mod',
    title: '取模 mod',
    category: '数学',
    inputs: [v4('in', 'in'), f('divisor', '除数', 1)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_mod($in.in, $in.divisor)',
    helpers: ['st_mod'],
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'clamp',
    title: '截断 clamp',
    category: '数学',
    inputs: [v4('in', 'in'), f('lo', '下界', 0), f('hi', '上界', 1)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'clamp($in.in, $in.lo, $in.hi)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'saturate',
    title: '饱和 0..1',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'clamp($in.in, 0.0, 1.0)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'smoothstep',
    title: '平滑步 smoothstep',
    category: '数学',
    inputs: [v4('x', 'x'), f('edge0', 'edge0', 0), f('edge1', 'edge1', 1)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_smoothstep($in.edge0, $in.edge1, $in.x)',
    helpers: ['st_smoothstep'],
    defaults: { x: 0 },
  }),
  defineNode({
    type: 'stepNode',
    title: '阶梯 step',
    category: '数学',
    inputs: [f('edge', '阈值', 0.5), v4('x', 'x')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'step(vec4($in.edge), $in.x)',
    defaults: { x: 0 },
  }),
  defineNode({
    type: 'mixNode',
    title: '混合 mix',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b'), f('t', 't', 0.5)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_mix($in.a, $in.b, $in.t)',
    helpers: ['st_mix'],
    defaults: { a: 0, b: 0 },
  }),
  defineNode({
    type: 'oneMinus',
    title: '取反 1−x',
    category: '数学',
    inputs: [v4('in', 'in')],
    outputs: [v4('out', 'out')],
    params: {},
    code: '1.0 - $in.in',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'minNode',
    title: '最小值 min',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'min($in.a, $in.b)',
    defaults: { a: 1, b: 1 },
  }),
  defineNode({
    type: 'maxNode',
    title: '最大值 max',
    category: '数学',
    inputs: [v4('a', 'a'), v4('b', 'b')],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'max($in.a, $in.b)',
    defaults: { a: 0, b: 0 },
  }),

  // ───────────────────────── 向量 ─────────────────────────
  defineNode({
    type: 'vec2Node',
    title: '合成 vec2',
    category: '向量',
    inputs: [f('x', 'x', 0), f('y', 'y', 0)],
    outputs: [v2('out', 'out')],
    params: {},
    code: 'st_vec2($in.x, $in.y)',
    helpers: ['st_vec2'],
  }),
  defineNode({
    type: 'vec3Node',
    title: '合成 vec3',
    category: '向量',
    inputs: [f('x', 'x', 0), f('y', 'y', 0), f('z', 'z', 0)],
    outputs: [v3('out', 'out')],
    params: {},
    code: 'st_vec3($in.x, $in.y, $in.z)',
    helpers: ['st_vec3'],
  }),
  defineNode({
    type: 'vec4Node',
    title: '合成 vec4',
    category: '向量',
    inputs: [f('x', 'x', 0), f('y', 'y', 0), f('z', 'z', 0), f('w', 'w', 1)],
    outputs: [v4('out', 'out')],
    params: {},
    code: 'st_vec4($in.x, $in.y, $in.z, $in.w)',
    helpers: ['st_vec4'],
  }),
  defineNode({
    type: 'split',
    title: '分量拆分',
    category: '向量',
    doc: '把 vec4 拆成 x/y/z/w 四个标量输出。',
    inputs: [v4('in', 'in')],
    outputs: [f('x', 'x'), f('y', 'y'), f('z', 'z'), f('w', 'w')],
    params: {},
    code: 'SPLIT',
    split: true,
    defaults: { in: [0, 0, 0, 0] },
  }),
  defineNode({
    type: 'dot',
    title: '点乘 dot',
    category: '向量',
    inputs: [v3('a', 'a'), v3('b', 'b')],
    outputs: [f('out', 'out')],
    params: {},
    code: 'dot($in.a, $in.b)',
    defaults: { a: 0, b: 0 },
  }),
  defineNode({
    type: 'normalize',
    title: '归一化 normalize',
    category: '向量',
    inputs: [v3('in', 'in')],
    outputs: [v3('out', 'out')],
    params: {},
    code: 'normalize($in.in + vec3(1e-9))',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'length',
    title: '长度 length',
    category: '向量',
    inputs: [v2('in', 'in')],
    outputs: [f('out', 'out')],
    params: {},
    code: 'length($in.in)',
    defaults: { in: 0 },
  }),
  defineNode({
    type: 'distance',
    title: '距离 distance',
    category: '向量',
    inputs: [v2('a', 'a'), v2('b', 'b')],
    outputs: [f('out', 'out')],
    params: {},
    code: 'distance($in.a, $in.b)',
    defaults: { a: 0, b: 0 },
  }),
  defineNode({
    type: 'rotate',
    title: '旋转 rotate',
    category: '向量',
    inputs: [v2('p', '点'), f('angle', '角度(弧度)', 0)],
    outputs: [v2('out', 'out')],
    params: {},
    code: 'st_rot2($in.p, $in.angle)',
    helpers: ['st_rot2'],
    defaults: { p: 0 },
  }),
  defineNode({
    type: 'scaleP',
    title: '缩放 点/UV',
    category: '向量',
    inputs: [v2('p', '点'), f('scale', '倍率', 4)],
    outputs: [v2('out', 'out')],
    params: {},
    code: '$in.p * $in.scale',
    defaults: { p: 0 },
  }),

  // ───────────────────────── 颜色 ─────────────────────────
  defineNode({
    type: 'rgb',
    title: '颜色',
    category: '颜色',
    inputs: [],
    outputs: [v3('out', 'rgb')],
    params: { color: { type: 'color', value: [1, 0.4, 0.1], label: '颜色' } },
    code: '$p.color',
  }),
  defineNode({
    type: 'mixColor',
    title: '颜色混合',
    category: '颜色',
    inputs: [v3('a', '颜色A'), v3('b', '颜色B'), f('t', '混合', 0.5)],
    outputs: [v3('out', 'out')],
    params: {},
    code: 'st_mix($in.a, $in.b, $in.t)',
    helpers: ['st_mix'],
    defaults: { a: [0, 0, 0], b: [1, 1, 1] },
  }),
  defineNode({
    type: 'palette',
    title: '调色板 (Inigo)',
    category: '颜色',
    doc: 'a + b*cos(2π(c*t+d))，经典余弦调色板。',
    inputs: [f('t', 't', 0)],
    outputs: [v3('out', 'rgb')],
    params: {
      a: { type: 'vec3', value: [0.5, 0.5, 0.5], label: 'a' },
      b: { type: 'vec3', value: [0.5, 0.5, 0.5], label: 'b' },
      c: { type: 'vec3', value: [1, 1, 1], label: 'c' },
      d: { type: 'vec3', value: [0, 0.33, 0.67], label: 'd' },
    },
    code: '$p.a + $p.b * cos(6.28318 * ($p.c * $in.t + $p.d))',
  }),
  defineNode({
    type: 'hsv',
    title: 'HSV 转 RGB',
    category: '颜色',
    inputs: [v3('in', 'hsv')],
    outputs: [v3('out', 'rgb')],
    params: {},
    code: 'st_hsv2rgb($in.in)',
    glslPrelude: `vec3 st_hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}`,
    defaults: { in: [0, 0, 0.5] },
  }),
  defineNode({
    type: 'gamma',
    title: 'Gamma 校正',
    category: '颜色',
    inputs: [v3('in', 'rgb'), f('g', 'gamma', 2.2)],
    outputs: [v3('out', 'out')],
    params: {},
    code: 'st_pow($in.in, $in.g)',
    helpers: ['st_pow'],
    defaults: { in: [0, 0, 0] },
  }),
  defineNode({
    type: 'luminance',
    title: '亮度',
    category: '颜色',
    inputs: [v3('in', 'rgb')],
    outputs: [f('out', 'luma')],
    params: {},
    code: 'st_luma($in.in)',
    helpers: ['st_luma'],
    defaults: { in: [0, 0, 0] },
  }),

  // ───────────────────────── 程序化 ─────────────────────────
  defineNode({
    type: 'noise',
    title: '噪声 noise',
    category: '程序化',
    inputs: [v2('uv', 'uv')],
    outputs: [f('out', 'value')],
    params: {},
    code: 'st_noise($in.uv)',
    helpers: ['st_noise'],
    defaults: { uv: 0 },
  }),
  defineNode({
    type: 'fbm',
    title: '分形噪声 fbm',
    category: '程序化',
    inputs: [v2('uv', 'uv'), f('octaves', '层数', 4)],
    outputs: [f('out', 'value')],
    params: {},
    code: 'st_fbm($in.uv, $in.octaves)',
    helpers: ['st_fbm'],
    defaults: { uv: 0 },
  }),
  defineNode({
    type: 'hash',
    title: '哈希 hash',
    category: '程序化',
    inputs: [v2('p', 'p')],
    outputs: [f('out', 'value')],
    params: {},
    code: 'st_hash($in.p)',
    helpers: ['st_hash'],
    defaults: { p: 0 },
  }),
  defineNode({
    type: 'circle',
    title: '圆形 SDF',
    category: '程序化',
    inputs: [v2('uv', 'uv'), v2('center', '圆心', [0.5, 0.5]), f('radius', '半径', 0.3)],
    outputs: [f('out', 'distance')],
    params: {},
    code: 'length($in.uv - $in.center) - $in.radius',
    defaults: { uv: 0 },
  }),
  defineNode({
    type: 'gradient',
    title: '线性渐变',
    category: '程序化',
    inputs: [v2('uv', 'uv'), f('angle', '角度(弧度)', 0)],
    outputs: [f('out', 't')],
    params: {},
    code: 'dot($in.uv - 0.5, vec2(cos($in.angle), sin($in.angle))) + 0.5',
    defaults: { uv: 0 },
  }),

  // ───────────────────────── 纹理 ─────────────────────────
  defineNode({
    type: 'texture',
    title: '纹理采样 iChannel',
    category: '纹理',
    doc: '采样 iChannel0..3。需要在「纹理」面板里把槽位绑上图片。',
    inputs: [v2('uv', 'uv')],
    outputs: [v4('out', 'rgba')],
    params: { channel: { type: 'select', value: 'iChannel0', options: CHANNELS, label: '通道' } },
    code: 'TEXTURE',
    textureSample: 'channel',
    defaults: { uv: 0 },
  }),
  defineNode({
    type: 'bufferSample',
    title: '采样其他 Pass',
    category: '纹理',
    doc: '采样另一个 Pass 上一帧的输出。',
    inputs: [v2('uv', 'uv')],
    outputs: [v4('out', 'rgba')],
    params: { buffer: { type: 'select', value: 'BufferA', options: BUFFERS, label: 'Buffer' } },
    code: 'TEXTURE',
    textureSample: 'buffer',
    defaults: { uv: 0 },
  }),

  // ───────────────────────── 自定义 ─────────────────────────
  defineNode({
    type: 'custom',
    title: '自定义表达式',
    category: '自定义',
    doc: '直接写 GLSL 表达式。$in.a / $in.b / $in.c 是三个通用输入。',
    inputs: [v4('a', 'a'), v4('b', 'b'), f('c', 'c', 0)],
    outputs: [v4('out', 'out')],
    params: { expr: { type: 'text', value: '$in.a', label: 'GLSL 表达式' } },
    code: '$p.expr',
    defaults: { a: 0, b: 0 },
  }),

  // ───────────────────────── 分组（元节点） ─────────────────────────
  //
  // 为什么不给每个效果加一个内置节点：那等于"每次想要新效果都得改插件源码"，
  // 而宿主进程里的 ES 模块缓存不会更新 → 必须重启 DSH。分组让新效果变成**数据**：
  // 画布上搭好一张子图 → 右键「打成 Group」→ 变成一个可复用节点，全程不碰源码。
  //
  // 子图**内联**在组的 `params.graph` 里（不是引用外部文件），所以材质是自包含的：
  // 宿主和浏览器两侧的生成器各自递归展开就行，不需要共享一个外部解析器，
  // 也不会出现"组定义改了、老材质跟着变"的意外。
  defineNode({
    type: 'group',
    title: '组 (Group)',
    category: '分组',
    doc:
      '把一组节点打包成一个可复用节点。端口由组的定义决定（params.graph 里的 inputs/outputs），' +
      '生成时子图会被内联展开。画布上框选节点 → 右键「打成 Group」即可创建。' +
      '「重复次数」> 1 时变成**循环**：循环体只写一遍，外面套 for（别把重复写成复制 —— ' +
      '99 步展开会生成 676 KB 着色器，加载直接卡住）。跨迭代传递的值由 params.graph.carries 指定' +
      '（默认取 inputs ∩ outputs）。',
    inputs: [],
    outputs: [],
    params: {
      repeat: { type: 'int', value: 1, min: 1, max: 512, label: '重复次数' },
      graph: { type: 'graph', value: null, label: '子图' },
    },
    // 入/出端口完全由子图定义决定，所以必须知道问的是哪一边
    dynamicOut: (params, ports, dir) => {
      const group = params?.graph;
      const list = dir === 'in' ? group?.inputs : group?.outputs;
      if (!Array.isArray(list)) return ports;
      return list.map((p) =>
        port(String(p.id), PORT_TYPES.includes(p.type) ? p.type : 'vec4', { label: p.label ?? p.id }),
      );
    },
    code: 'GROUP',
  }),
  defineNode({
    type: 'groupInput',
    title: '组输入',
    category: '分组',
    doc: '组内部的入口：外面接进来的值从这里进入子图。打成 Group 时自动生成。',
    inputs: [],
    outputs: [v4('out', 'value')],
    params: {
      port: { type: 'text', value: 'in', label: '端口名' },
      type: { type: 'select', value: 'vec4', options: SCALAR_VEC, label: '类型' },
    },
    // 端口类型由 `params.type` 决定 —— 注意不是 `params.outType`（那是 const / uniform
    // 的写法）。这里踩过：用错了之后端口类型会退化成 float，下游按 float→vec4 广播，
    // 生成出 `vec4(vec2变量)` 这种非法构造，真机直接一片红。
    dynamicOut: (params, ports) =>
      ports.map((p) => (p.id === 'out' ? { ...p, type: params.type ?? 'vec4' } : p)),
    code: 'GROUP_INPUT',
  }),
  defineNode({
    type: 'loopIndex',
    title: '循环轮次',
    category: '分组',
    doc:
      '重复组（「重复次数」> 1）循环体里的当前轮次，从 0 数起。' +
      '用它就能把「第几段」写成公式（贝塞尔按段取点就是这么干的），' +
      '不用把 24 段各复制一份。放在循环体外会报错。',
    inputs: [],
    outputs: [f('out', 'i')],
    code: 'LOOP_INDEX',
  }),
  defineNode({
    type: 'groupOutput',
    title: '组输出',
    category: '分组',
    doc: '组内部的出口：把子图里的值交给组外面。打成 Group 时自动生成。',
    inputs: [v4('color', 'value')],
    outputs: [],
    params: {
      port: { type: 'text', value: 'out', label: '端口名' },
      type: { type: 'select', value: 'vec4', options: SCALAR_VEC, label: '类型' },
    },
    // 只有输入端口跟着 params.type 变形
    dynamicOut: (params, ports, dir) =>
      dir === 'in' ? ports.map((p) => (p.id === 'color' ? { ...p, type: params.type ?? 'vec4' } : p)) : ports,
    code: 'GROUP_OUTPUT',
    terminal: true,
  }),

  // ───────────────────────── 输出 ─────────────────────────
  defineNode({
    type: 'output',
    title: '输出',
    category: '输出',
    doc: '每个 Pass 有且只有一个输出节点，它的 color 决定这个 Pass 写什么。',
    inputs: [v4('color', 'color', [0, 0, 0, 1])],
    outputs: [],
    params: {},
    code: 'TERMINAL',
    terminal: true,
  }),
];
