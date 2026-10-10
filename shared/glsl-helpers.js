/**
 * 内置 GLSL 辅助函数库。
 *
 * 命名一律带 `st_` 前缀（shader toy），避免和用户 uniform / GLSL 内建撞名。
 * 生成器按「实际用到的节点」做依赖闭包裁剪，没用到的一个字符都不会进 shader。
 *
 * @module dsh-shader-workbench/shared/glsl-helpers
 */

/** 函数名 → 完整 GLSL 定义。 */
export const GLSL_HELPERS = Object.freeze({
  st_mul: `vec4 st_mul(vec4 a, vec4 b) { return a * b; }
vec4 st_mul(vec4 a, float b) { return a * b; }
vec4 st_mul(float a, vec4 b) { return a * b; }
vec4 st_mul(vec4 a, vec3 b) { return a * vec4(b, 1.0); }
vec4 st_mul(vec3 a, vec4 b) { return vec4(a, 1.0) * b; }
vec3 st_mul(vec3 a, vec3 b) { return a * b; }
vec3 st_mul(vec3 a, float b) { return a * b; }
vec3 st_mul(float a, vec3 b) { return a * b; }
vec3 st_mul(vec3 a, vec2 b) { return a * vec3(b, 1.0); }
vec3 st_mul(vec2 a, vec3 b) { return vec3(a, 1.0) * b; }
vec2 st_mul(vec2 a, vec2 b) { return a * b; }
vec2 st_mul(vec2 a, float b) { return a * b; }
vec2 st_mul(float a, vec2 b) { return a * b; }
float st_mul(float a, float b) { return a * b; }`,

  st_add: `vec4 st_add(vec4 a, vec4 b) { return a + b; }
vec4 st_add(vec4 a, float b) { return a + b; }
vec4 st_add(float a, vec4 b) { return a + b; }
vec4 st_add(vec4 a, vec3 b) { return a + vec4(b, 0.0); }
vec4 st_add(vec3 a, vec4 b) { return vec4(a, 0.0) + b; }
vec3 st_add(vec3 a, vec3 b) { return a + b; }
vec3 st_add(vec3 a, vec2 b) { return a + vec3(b, 0.0); }
vec3 st_add(vec3 a, float b) { return a + b; }
vec3 st_add(float a, vec3 b) { return a + b; }
vec2 st_add(vec2 a, vec2 b) { return a + b; }
vec2 st_add(vec2 a, float b) { return a + b; }
vec2 st_add(float a, vec2 b) { return a + b; }
float st_add(float a, float b) { return a + b; }`,

  st_sub: `vec4 st_sub(vec4 a, vec4 b) { return a - b; }
vec4 st_sub(vec4 a, float b) { return a - b; }
vec4 st_sub(float a, vec4 b) { return a - b; }
vec4 st_sub(vec4 a, vec3 b) { return a - vec4(b, 0.0); }
vec3 st_sub(vec3 a, vec3 b) { return a - b; }
vec3 st_sub(vec3 a, vec2 b) { return a - vec3(b, 0.0); }
vec3 st_sub(vec3 a, float b) { return a - b; }
vec3 st_sub(float a, vec3 b) { return a - b; }
vec2 st_sub(vec2 a, vec2 b) { return a - b; }
vec2 st_sub(vec2 a, float b) { return a - b; }
vec2 st_sub(float a, vec2 b) { return a - b; }
float st_sub(float a, float b) { return a - b; }`,

  st_div: `vec4 st_div(vec4 a, vec4 b) { return a / max(abs(b), vec4(1e-6)); }
vec4 st_div(vec4 a, float b) { return a / max(abs(b), 1e-6); }
vec4 st_div(float a, vec4 b) { return a / max(abs(b), vec4(1e-6)); }
vec3 st_div(vec3 a, vec3 b) { return a / max(abs(b), vec3(1e-6)); }
vec3 st_div(vec3 a, float b) { return a / max(abs(b), 1e-6); }
vec3 st_div(float a, vec3 b) { return a / max(abs(b), vec3(1e-6)); }
vec2 st_div(vec2 a, vec2 b) { return a / max(abs(b), vec2(1e-6)); }
vec2 st_div(vec2 a, float b) { return a / max(abs(b), 1e-6); }
vec2 st_div(float a, vec2 b) { return a / max(abs(b), vec2(1e-6)); }
float st_div(float a, float b) { return a / max(abs(b), 1e-6); }`,

  st_mix: `vec4 st_mix(vec4 a, vec4 b, float t) { return mix(a, b, t); }
vec3 st_mix(vec3 a, vec3 b, float t) { return mix(a, b, t); }
vec2 st_mix(vec2 a, vec2 b, float t) { return mix(a, b, t); }
float st_mix(float a, float b, float t) { return mix(a, b, t); }`,

  st_smoothstep: `vec4 st_smoothstep(float e0, float e1, vec4 x) { return smoothstep(vec4(e0), vec4(e1), x); }
vec3 st_smoothstep(float e0, float e1, vec3 x) { return smoothstep(vec3(e0), vec3(e1), x); }
vec3 st_smoothstep(vec3 e0, vec3 e1, vec3 x) { return smoothstep(e0, e1, x); }
vec2 st_smoothstep(float e0, float e1, vec2 x) { return smoothstep(vec2(e0), vec2(e1), x); }
float st_smoothstep(float e0, float e1, float x) { return smoothstep(e0, e1, x); }`,

  st_pow: `vec4 st_pow(vec4 a, vec4 b) { return pow(max(a, vec4(0.0)), b); }
vec4 st_pow(vec4 a, float b) { return pow(max(a, vec4(0.0)), vec4(b)); }
vec3 st_pow(vec3 a, vec3 b) { return pow(max(a, vec3(0.0)), b); }
vec3 st_pow(vec3 a, float b) { return pow(max(a, vec3(0.0)), vec3(b)); }
vec3 st_pow(float a, vec3 b) { return pow(max(vec3(a), vec3(0.0)), b); }
vec2 st_pow(vec2 a, vec2 b) { return pow(max(a, vec2(0.0)), b); }
vec2 st_pow(vec2 a, float b) { return pow(max(a, vec2(0.0)), vec2(b)); }
vec2 st_pow(float a, vec2 b) { return pow(max(vec2(a), vec2(0.0)), b); }
float st_pow(float a, float b) { return pow(max(a, 0.0), b); }`,

  st_mod: `vec4 st_mod(vec4 a, float b) { return mod(a, b); }
vec3 st_mod(vec3 a, float b) { return mod(a, b); }
vec2 st_mod(vec2 a, float b) { return mod(a, b); }
float st_mod(float a, float b) { return mod(a, b); }`,

  st_vec2: `vec2 st_vec2(float x, float y) { return vec2(x, y); }`,
  st_vec3: `vec3 st_vec3(float x, float y, float z) { return vec3(x, y, z); }`,
  st_vec4: `vec4 st_vec4(float x, float y, float z, float w) { return vec4(x, y, z, w); }`,

  st_luma: `float st_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float st_luma(vec4 c) { return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); }`,

  st_rot2: `vec2 st_rot2(vec2 p, float a) {
  float s = sin(a);
  float c = cos(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}`,

  st_hash: `float st_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }`,

  st_noise: `float st_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(st_hash(i + vec2(0.0, 0.0)), st_hash(i + vec2(1.0, 0.0)), u.x),
             mix(st_hash(i + vec2(0.0, 1.0)), st_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}`,

  st_fbm: `float st_fbm(vec2 p, float octaves) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= octaves) break;
    v += a * st_noise(p);
    p = p * 2.02 + 17.3;
    a *= 0.5;
  }
  return v;
}`,
});

/** 函数名 → 它依赖的其它 helper 名。 */
const HELPER_DEPS = {
  st_mul: [],
  st_add: [],
  st_sub: [],
  st_div: [],
  st_mix: [],
  st_smoothstep: [],
  st_pow: [],
  st_mod: [],
  st_vec2: [],
  st_vec3: [],
  st_vec4: [],
  st_luma: [],
  st_rot2: [],
  st_hash: [],
  st_noise: ['st_hash'],
  st_fbm: ['st_noise'],
};

/**
 * 展开 helper 依赖闭包，返回按依赖顺序排好的函数名数组（被依赖的在前）。
 * @param {Iterable<string>} used 直接引用的 helper 名
 * @returns {string[]}
 */
export function resolveHelpers(used) {
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const deps = HELPER_DEPS[name];
    if (!deps) throw new Error(`未知 GLSL helper：${name}`);
    for (const d of deps) visit(d);
    out.push(name);
  };
  for (const name of used) visit(name);
  return out;
}

/**
 * 把一串 helper 拼成可直接插进 shader 的源码。
 * @param {string[]} names resolveHelpers() 的结果
 * @returns {string}
 */
export function renderHelpers(names) {
  return names.map((n) => GLSL_HELPERS[n]).join('\n\n');
}
