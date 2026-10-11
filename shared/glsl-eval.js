/**
 * GLSL 子集的**参考求值器**（JS 实现）。
 *
 * ## 它为什么存在
 *
 * FR-06 要把 GLSL 转成 HLSL / MSL / SPIR-V，而本机没有任何 shader 工具链 ——
 * 也就是说**转译结果没法交给编译器验证**。这种情况下最容易发生的事是：
 * 转译器默默把 `mat2(a,b,c,d)` 的参数顺序搞反、把 GLSL 的 `mod` 当成 HLSL 的 `fmod`、
 * 把矩阵乘法写成逐分量乘法……产出一段「看着挺像」但语义已经跑偏的代码。
 *
 * 所以这里的做法是：把「原 AST」和「转译后的 AST」**用同一套求值器**跑一遍，
 * 喂同一组输入，要求逐位相等。转译器的每一条变换（矩阵参数换序、`mod` 展开、
 * `mix`→`lerp`、矩阵乘法改 `mul`……）都被这条测试钉住。
 *
 * 求值器按**目标语言的语义**求值 —— 因为它要同时喂两种 AST：
 *
 * | 语义开关 | GLSL / MSL | HLSL |
 * |---|---|---|
 * | `matrixLayout` | `column`（`mat2(a,b,c,d)` = 两列） | `row`（`float2x2(a,b,c,d)` = 两行） |
 * | `matrixMultiply` | `algebraic`（`m * v` 是线性代数乘法） | `componentwise`（要写 `mul(m,v)`） |
 *
 * 于是「GLSL AST + GLSL 语义」与「HLSL AST + HLSL 语义」的结果必须相同 ——
 * 这正是「转译正确」的定义。
 *
 * 只在测试与自检里用，不参与运行时渲染。
 *
 * @module dsh-shader-workbench/shared/glsl-eval
 */

import { swizzleType, isValidSwizzle } from './glsl-parse.js';

/** 分量个数。 */
export function widthOf(type) {
  if (type === 'float' || type === 'int' || type === 'bool' || type === 'uint') return 1;
  const v = /^[ibu]?vec([234])$/.exec(type);
  if (v) return Number(v[1]);
  if (/^mat([234])(?:x[234])?$/.test(type)) return 4;
  return 0;
}

/** 是不是矩阵类型。 */
export function isMatrixType(type) {
  return /^mat[234]/.test(type) || /^float[234]x[234]$/.test(type);
}

/** 把 HLSL / MSL 的类型名归一化回 GLSL 的写法，求值器只认一套。 */
export function normalizeTypeName(type) {
  if (typeof type !== 'string') return type;
  const h = /^float([234])(?:x([234]))?$/.exec(type);
  if (h) return h[2] ? `mat${h[1]}x${h[2]}` : `vec${h[1]}`;
  const i = /^int([234])$/.exec(type);
  if (i) return `ivec${i[1]}`;
  if (/^half([234])$/.test(type)) return `vec${type[4]}`;
  if (/^uint([234])$/.test(type)) return `uvec${type[4]}`;
  return type;
}

/** 分量个数（接受 HLSL 类型名）。 */
function w(type) {
  return widthOf(normalizeTypeName(type));
}

function isMat(type) {
  return isMatrixType(normalizeTypeName(type));
}

/** 标量类型 → 同族的向量类型。 */
function vecTypeOf(scalar, n) {
  const s = normalizeTypeName(scalar);
  if (s === 'float') return `vec${n}`;
  if (s === 'int') return `ivec${n}`;
  if (s === 'uint') return `uvec${n}`;
  if (s === 'bool') return `bvec${n}`;
  return `vec${n}`;
}

/** 向量类型 → 它的标量类型。 */
function scalarOf(type) {
  const t = normalizeTypeName(type);
  const m = /^([ibu]?)vec[234]$/.exec(t);
  if (!m) return t;
  return m[1] === 'i' ? 'int' : m[1] === 'u' ? 'uint' : m[1] === 'b' ? 'bool' : 'float';
}

/** 造一个值。`d` 是分量数组；矩阵按**列主序**存（与 GLSL / MSL 一致）。 */
function val(type, d) {
  return { t: normalizeTypeName(type), d };
}

/** 求值过程中的错误（不是用户 shader 的错，是求值器没实现某个东西）。 */
export class GlslEvalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GlslEvalError';
  }
}

// ─────────────────────── 逐分量运算 ───────────────────────

/** 逐分量二元运算（标量自动广播）。 */
function zip(a, b, fn, outType) {
  const wa = w(a.t);
  const wb = w(b.t);
  if (wa === wb) {
    return val(outType ?? a.t, a.d.map((x, i) => fn(x, b.d[i])));
  }
  if (wa === 1) return val(outType ?? b.t, b.d.map((y) => fn(a.d[0], y)));
  if (wb === 1) return val(outType ?? a.t, a.d.map((x) => fn(x, b.d[0])));
  throw new GlslEvalError(`分量个数对不上：${a.t} 与 ${b.t}`);
}

/** 逐分量一元运算。 */
function map1(a, fn, outType) {
  return val(outType ?? a.t, a.d.map(fn));
}

/**
 * 按第 i 个分量取值，标量广播。
 *
 * GLSL 里 `clamp(vec3, float, float)` / `smoothstep(vec3, vec3, vec3)` 这类
 * 「标量参数混在向量参数里」的写法很常见，helper 库里就有。
 */
function at(v, i) {
  return w(v.t) === 1 ? v.d[0] : v.d[i];
}

// ─────────────────────── 矩阵 ───────────────────────

/**
 * 取逻辑矩阵元素 M[row][col]。
 * 存储是列主序：`d[col * rows + row]`。
 * @param {{d:number[]}} m
 * @param {number} row
 * @param {number} col
 * @param {number} rows
 */
function matGet(m, row, col, rows = 2) {
  return m.d[col * rows + row];
}

/** 从「构造器参数」造矩阵，按给定的存储序。 */
function matFromArgs(args, layout) {
  const d = args.map((a) => a.d[0]);
  // column：参数就是列；row：参数是行，转成列主序存
  if (layout === 'column') return val('mat2', d);
  return val('mat2', [d[0], d[2], d[1], d[3]]);
}

/** 矩阵 × 矩阵（线性代数乘法，列主序）。 */
function matMulMat(a, b) {
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 2; c += 1) {
    for (let r = 0; r < 2; r += 1) {
      out[c * 2 + r] = matGet(a, r, 0) * matGet(b, 0, c) + matGet(a, r, 1) * matGet(b, 1, c);
    }
  }
  return val('mat2', out);
}

/** 矩阵 × 列向量。 */
function matMulVec(m, v) {
  return val('vec2', [
    matGet(m, 0, 0) * v.d[0] + matGet(m, 0, 1) * v.d[1],
    matGet(m, 1, 0) * v.d[0] + matGet(m, 1, 1) * v.d[1],
  ]);
}

/** 行向量 × 矩阵（GLSL 里 `v * m` 的含义）。 */
function vecMulMat(v, m) {
  return val('vec2', [
    v.d[0] * matGet(m, 0, 0) + v.d[1] * matGet(m, 1, 0),
    v.d[0] * matGet(m, 0, 1) + v.d[1] * matGet(m, 1, 1),
  ]);
}

/** 线性代数乘法（`mul()` 的语义）。 */
function algebraicMul(a, b) {
  const am = isMat(a.t);
  const bm = isMat(b.t);
  if (am && bm) return matMulMat(a, b);
  if (am && w(b.t) === 2) return matMulVec(a, b);
  if (w(a.t) === 2 && bm) return vecMulMat(a, b);
  // 矩阵 × 标量 / 标量 × 矩阵：就是逐分量放大，与 `*` 一致
  return zip(a, b, (x, y) => x * y);
}

// ─────────────────────── 内置函数 ───────────────────────

/** 逐分量数学函数表。 */
const COMPONENTWISE = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos,
  exp: Math.exp, log: Math.log, log2: Math.log2, exp2: (x) => 2 ** x,
  sqrt: Math.sqrt, inversesqrt: (x) => 1 / Math.sqrt(x),
  abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
  // GLSL 的 round 是「四舍五入、远离零」，JS 的 Math.round 是「半数向上」，负数上不一样
  round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
  fract: (x) => x - Math.floor(x),
  radians: (x) => (x * Math.PI) / 180,
  degrees: (x) => (x * 180) / Math.PI,
};

/**
 * 按 GLSL 语义求值的二元逐分量函数。
 *
 * `mod` 与 `fmod` 在这里是**两个不同的函数**，这正是要区分它们的原因：
 * GLSL 的 `mod(x,y) = x - y*floor(x/y)`（结果取 y 的符号），
 * C/HLSL/MSL 的 `fmod` 是截断式（结果取 x 的符号）。
 */
const COMPONENTWISE2 = {
  min: Math.min,
  max: Math.max,
  pow: (x, y) => x ** y,
  mod: (x, y) => x - y * Math.floor(x / y),
  // 转译产物里的 `$mod` 就是 GLSL 的 `mod`（HLSL/MSL 的 fmod 语义不同，所以单独发一个 helper）
  $mod: (x, y) => x - y * Math.floor(x / y),
  fmod: (x, y) => x % y,
  atan2: (y, x) => Math.atan2(y, x),
  step: (edge, x) => (x < edge ? 0 : 1),
};

/**
 * 求值器。
 */
export class Evaluator {
  /**
   * @param {object} program parseGlsl() 的结果（或转译器产出的同形 AST）
   * @param {object} [opts]
   * @param {'column'|'row'} [opts.matrixLayout] 矩阵构造器的参数序
   * @param {'algebraic'|'componentwise'} [opts.matrixMultiply] `*` 遇到矩阵时的语义
   * @param {Record<string, number[]>} [opts.uniforms] uniform 初值
   * @param {Record<string, Function>} [opts.samplers] 采样器：`(u, v) => [r,g,b,a]`
   * @param {number[]} [opts.fragCoord] GLSL 语义的 `gl_FragCoord`（原点左下）
   * @param {number} [opts.maxSteps] 循环步数上限（防死循环）
   */
  constructor(program, opts = {}) {
    this.program = program;
    this.matrixLayout = opts.matrixLayout ?? 'column';
    this.matrixMultiply = opts.matrixMultiply ?? 'algebraic';
    this.uniforms = opts.uniforms ?? {};
    this.samplers = opts.samplers ?? {};
    this.fragCoord = opts.fragCoord ?? null;
    this.maxSteps = opts.maxSteps ?? 2_000_000;
    this.steps = 0;
    this.globals = new Map();
  }

  /** 按名字取内置函数；没有则返回 null（交给用户函数 / 构造器处理）。 */
  _builtin(name, args) {
    if (name in COMPONENTWISE) {
      const fn = COMPONENTWISE[name];
      return map1(args[0], fn);
    }
    if (name in COMPONENTWISE2) {
      const fn = COMPONENTWISE2[name];
      return zip(args[0], args[1], fn);
    }
    switch (name) {
      case 'length':
        return val('float', [Math.hypot(...args[0].d)]);
      case 'distance':
        return val('float', [Math.hypot(...args[0].d.map((x, i) => x - args[1].d[i]))]);
      case 'dot':
        return val('float', [args[0].d.reduce((s, x, i) => s + x * args[1].d[i], 0)]);
      case 'cross':
        return val('vec3', [
          args[0].d[1] * args[1].d[2] - args[0].d[2] * args[1].d[1],
          args[0].d[2] * args[1].d[0] - args[0].d[0] * args[1].d[2],
          args[0].d[0] * args[1].d[1] - args[0].d[1] * args[1].d[0],
        ]);
      case 'normalize': {
        const len = Math.hypot(...args[0].d) || 1;
        return map1(args[0], (x) => x / len);
      }
      case 'clamp': {
        const [x, lo, hi] = args;
        return val(x.t, x.d.map((v, i) => Math.min(Math.max(v, at(lo, i)), at(hi, i))));
      }
      case 'mix': {
        const [a, b, t] = args;
        return val(a.t, a.d.map((v, i) => v + (at(b, i) - v) * at(t, i)));
      }
      case 'smoothstep': {
        const [e0, e1, x] = args;
        return val(x.t, x.d.map((v, i) => {
          const lo = at(e0, i);
          const hi = at(e1, i);
          const denom = hi - lo;
          const t = denom === 0 ? (v < lo ? 0 : 1) : Math.min(1, Math.max(0, (v - lo) / denom));
          return t * t * (3 - 2 * t);
        }));
      }
      case 'atan': {
        if (args.length === 1) return map1(args[0], Math.atan);
        return zip(args[0], args[1], (y, x) => Math.atan2(y, x));
      }
      case 'faceforward': {
        const [n, i, nref] = args;
        const d = i.d.reduce((s, x, k) => s + x * nref.d[k], 0);
        return map1(n, (x) => (d < 0 ? x : -x));
      }
      case 'reflect': {
        const [i, n] = args;
        const d = i.d.reduce((s, x, k) => s + x * n.d[k], 0);
        return zip(i, n, (a, b) => a - 2 * d * b);
      }
      case 'mul':
        // HLSL 专用：显式线性代数乘法
        return algebraicMul(args[0], args[1]);
      case 'transpose':
        return val(args[0].t, [matGet(args[0], 0, 0), matGet(args[0], 0, 1), matGet(args[0], 1, 0), matGet(args[0], 1, 1)]);
      case 'determinant':
        return val('float', [matGet(args[0], 0, 0) * matGet(args[0], 1, 1) - matGet(args[0], 0, 1) * matGet(args[0], 1, 0)]);
      case 'matrixCompMult':
        return zip(args[0], args[1], (a, b) => a * b);
      case 'texture':
      case 'textureLod':
      case '$sample': {
        // GLSL 的 `texture(s, uv)` 与转译产物里的 `$sample(s, uv)` 走同一条路
        const sampler = args[0];
        const uv = args[1];
        if (sampler.t !== 'sampler2D') throw new GlslEvalError(`采样对象不是 sampler2D：${sampler.t}`);
        const fn = this.samplers[sampler.name];
        if (!fn) throw new GlslEvalError(`测试没有为采样器 ${sampler.name} 提供实现`);
        return val('vec4', fn(uv.d[0], uv.d[1]));
      }
      case 'any':
        return val('bool', [args[0].d.some((x) => x !== 0)]);
      case 'all':
        return val('bool', [args[0].d.every((x) => x !== 0)]);
      case 'not':
        return map1(args[0], (x) => (x ? 0 : 1), vecTypeOf('bool', w(args[0].t)));
      default:
        return null;
    }
  }

  // ── 表达式 ──

  evalExpr(e, scope) {
    switch (e.k) {
      case 'num':
        return val(e.isFloat ? 'float' : 'int', [e.v]);
      case 'paren':
        return this.evalExpr(e.e, scope);
      case 'id': {
        const found = this.lookup(e.name, scope);
        if (found) {
          // 采样器要把名字带上：取纹理内容时靠它去查测试提供的实现
          if (/^sampler/.test(found.t)) return { t: found.t, d: [], name: e.name };
          return found;
        }
        if (Object.hasOwn(this.samplers, e.name)) return { t: 'sampler2D', d: [], name: e.name };
        throw new GlslEvalError(`未定义的标识符：${e.name}`);
      }
      case 'member':
        return this.evalMember(e, scope);
      case 'un':
        return this.evalUnary(e, scope);
      case 'bin':
        return this.evalBinary(e, scope);
      case 'cond':
        return this.truthy(this.evalExpr(e.test, scope)) ? this.evalExpr(e.cons, scope) : this.evalExpr(e.alt, scope);
      case 'assign':
        return this.evalAssign(e, scope);
      case 'call':
        return this.evalCall(e, scope);
      case 'comma': {
        let last = null;
        for (const item of e.list) last = this.evalExpr(item, scope);
        return last;
      }
      default:
        throw new GlslEvalError(`求值器不认识的表达式节点：${e.k}`);
    }
  }

  evalMember(e, scope) {
    const obj = this.evalExpr(e.obj, scope);
    if (obj.t === 'sampler2D' || obj.t === 'samplerCube') {
      // `tex.sample(...)` 这种目标语言写法：当成整体标识符处理
      return { t: obj.t, d: [], name: obj.name, member: e.name };
    }
    if (isMat(obj.t)) {
      // 矩阵字段不参与生成的代码，直接报错比猜好
      throw new GlslEvalError(`不支持矩阵成员访问：.${e.name}`);
    }
    const width = w(obj.t);
    if (!isValidSwizzle(e.name, width)) {
      throw new GlslEvalError(`非法 swizzle：${obj.t}.${e.name}`);
    }
    const outType = swizzleType(obj.t, e.name);
    const idx = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 };
    const d = [...e.name].map((ch) => obj.d[idx[ch]]);
    return val(outType, d);
  }

  evalUnary(e, scope) {
    const x = this.evalExpr(e.x, scope);
    switch (e.op) {
      case '+': return x;
      case '-': return map1(x, (v) => -v);
      case '!': return map1(x, (v) => (v ? 0 : 1), x.t === 'bool' ? 'bool' : x.t);
      case '++':
      case '--': {
        const target = this.resolveLValue(e.x, scope);
        const delta = e.op === '++' ? 1 : -1;
        const next = map1(target.get(), (v) => v + delta);
        target.set(next);
        return e.prefix ? next : target.get();
      }
      default:
        throw new GlslEvalError(`求值器不认识的运算符：${e.op}`);
    }
  }

  evalBinary(e, scope) {
    if (e.op === '&&' || e.op === '||') {
      const l = this.truthy(this.evalExpr(e.l, scope));
      if (e.op === '&&') return l ? val('bool', [this.truthy(this.evalExpr(e.r, scope)) ? 1 : 0]) : val('bool', [0]);
      return val('bool', [l ? 1 : this.truthy(this.evalExpr(e.r, scope)) ? 1 : 0]);
    }

    const a = this.evalExpr(e.l, scope);
    const b = this.evalExpr(e.r, scope);

    switch (e.op) {
      case '+': return zip(a, b, (x, y) => x + y);
      case '-': return zip(a, b, (x, y) => x - y);
      case '*': {
        const touchesMatrix = isMat(a.t) || isMat(b.t);
        if (touchesMatrix && this.matrixMultiply === 'algebraic') return algebraicMul(a, b);
        return zip(a, b, (x, y) => x * y);
      }
      case '/': return zip(a, b, (x, y) => x / y);
      case '%': return zip(a, b, (x, y) => x % y);
      case '<': return zip(a, b, (x, y) => (x < y ? 1 : 0), 'bool');
      case '>': return zip(a, b, (x, y) => (x > y ? 1 : 0), 'bool');
      case '<=': return zip(a, b, (x, y) => (x <= y ? 1 : 0), 'bool');
      case '>=': return zip(a, b, (x, y) => (x >= y ? 1 : 0), 'bool');
      case '==': return zip(a, b, (x, y) => (x === y ? 1 : 0), 'bool');
      case '!=': return zip(a, b, (x, y) => (x !== y ? 1 : 0), 'bool');
      default:
        throw new GlslEvalError(`求值器不认识的运算符：${e.op}`);
    }
  }

  evalCall(e, scope) {
    const name = e.name;

    // 构造器
    const n = normalizeTypeName(name);
    if (n === 'float' || n === 'int' || n === 'bool' || n === 'uint') {
      return val(n, [Number(e.args.length ? this.evalExpr(e.args[0], scope).d[0] : 0)]);
    }
    if (/^[ibu]?vec[234]$/.test(n)) {
      return this.constructVector(n, e.args, scope);
    }
    if (/^mat[234]/.test(n)) {
      const args = e.args.map((a) => this.evalExpr(a, scope));
      if (args.length === 1 && isMat(args[0].t)) return args[0];
      if (args.length === 4) return matFromArgs(args, this.matrixLayout);
      if (args.length === 1) return matFromArgs([args[0], args[0], args[0], args[0]], this.matrixLayout);
      throw new GlslEvalError(`求值器只支持 2x2 矩阵构造：${name}(${args.length} 个参数)`);
    }

    // 用户函数（helper / glslPrelude / 节点自带的函数定义）
    const overloads = (this.program.functions ?? []).filter((f) => f.name === name);
    if (overloads.length > 0) {
      const args = e.args.map((a) => this.evalExpr(a, scope));
      const picked = overloads.find(
        (f) => f.params.length === args.length && f.params.every((p, i) => this.accepts(p.type, args[i].t)),
      );
      if (!picked) {
        throw new GlslEvalError(`没有匹配的重载：${name}(${args.map((a) => a.t).join(', ')})`);
      }
      return this.callFunction(picked, args);
    }

    // 内置
    const args = e.args.map((a) => this.evalExpr(a, scope));
    const built = this._builtin(name, args);
    if (built !== null && built !== undefined) return built;

    throw new GlslEvalError(`求值器不认识的函数：${name}`);
  }

  /** 实参类型能不能喂给形参（允许标量广播）。 */
  accepts(paramType, argType) {
    const p = normalizeTypeName(paramType);
    const a = normalizeTypeName(argType);
    if (p === a) return true;
    return w(p) === w(a) && scalarOf(p) === scalarOf(a);
  }

  constructVector(type, args, scope) {
    const target = w(type);
    const parts = args.map((a) => this.evalExpr(a, scope));
    const d = [];
    for (const p of parts) {
      for (const x of p.d) d.push(x);
    }
    if (d.length === 1) return val(type, new Array(target).fill(d[0]));
    if (d.length !== target) throw new GlslEvalError(`${type} 构造器收到 ${d.length} 个分量`);
    return val(type, d);
  }

  evalAssign(e, scope) {
    const target = this.resolveLValue(e.target, scope);
    const value = this.evalExpr(e.value, scope);
    let next = value;
    if (e.op !== '=') {
      const cur = target.get();
      const op = e.op[0];
      if (op === '*') {
        const touchesMatrix = isMat(cur.t) || isMat(value.t);
        next = touchesMatrix && this.matrixMultiply === 'algebraic'
          ? algebraicMul(cur, value)
          : zip(cur, value, (x, y) => x * y);
      } else if (op === '+') next = zip(cur, value, (x, y) => x + y);
      else if (op === '-') next = zip(cur, value, (x, y) => x - y);
      else if (op === '/') next = zip(cur, value, (x, y) => x / y);
      else if (op === '%') next = zip(cur, value, (x, y) => x % y);
      else throw new GlslEvalError(`求值器不认识的复合赋值：${e.op}`);
    }
    target.set(next);
    return next;
  }

  /** 解析左值，拿到「读」和「写」两个闭包。 */
  resolveLValue(e, scope) {
    if (e.k === 'paren') return this.resolveLValue(e.e, scope);
    if (e.k === 'id') {
      const cell = this.lookupCell(e.name, scope);
      if (!cell) throw new GlslEvalError(`赋值给未定义的变量：${e.name}`);
      return {
        get: () => ({ t: cell.type, d: [...cell.value] }),
        set: (v) => { cell.value = [...v.d]; },
      };
    }
    if (e.k === 'member') {
      const obj = this.resolveLValue(e.obj, scope);
      const base = obj.get();
      const idx = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 };
      const positions = [...e.name].map((ch) => idx[ch]);
      return {
        get: () => val(swizzleType(base.t, e.name), positions.map((i) => obj.get().d[i])),
        set: (v) => {
          const next = [...obj.get().d];
          positions.forEach((pos, k) => { next[pos] = v.d[k]; });
          obj.set(val(base.t, next));
        },
      };
    }
    throw new GlslEvalError(`不支持的左值：${e.k}`);
  }

  truthy(v) {
    return v.d.some((x) => x !== 0);
  }

  lookup(name, scope) {
    const cell = this.lookupCell(name, scope);
    if (!cell) return null;
    return { t: cell.type, d: [...cell.value] };
  }

  lookupCell(name, scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.cells.has(name)) return s.cells.get(name);
    }
    if (this.globals.has(name)) return this.globals.get(name);
    return null;
  }

  // ── 语句 ──

  execBlock(block, scope) {
    const inner = { parent: scope, cells: new Map() };
    for (const stmt of block.body) {
      const signal = this.execStatement(stmt, inner);
      if (signal) return signal;
    }
    return null;
  }

  execStatement(stmt, scope) {
    this.steps += 1;
    if (this.steps > this.maxSteps) throw new GlslEvalError('求值步数超限（可能是死循环）');

    switch (stmt.k) {
      case 'empty':
        return null;
      case 'block':
        return this.execBlock(stmt, scope);
      case 'decl': {
        const value = stmt.init ? this.evalExpr(stmt.init, scope) : this.zeroOf(stmt.type);
        scope.cells.set(stmt.name, { type: normalizeTypeName(stmt.type), value: [...value.d] });
        return null;
      }
      case 'expr':
        this.evalExpr(stmt.e, scope);
        return null;
      case 'return':
        return { signal: 'return', value: stmt.e ? this.evalExpr(stmt.e, scope) : null };
      case 'break':
        return { signal: 'break' };
      case 'continue':
        return { signal: 'continue' };
      case 'if': {
        if (this.truthy(this.evalExpr(stmt.test, scope))) return this.execStatement(stmt.cons, scope);
        return stmt.alt ? this.execStatement(stmt.alt, scope) : null;
      }
      case 'for': {
        const inner = { parent: scope, cells: new Map() };
        if (stmt.init) {
          const signal = this.execStatement(stmt.init, inner);
          if (signal) return signal;
        }
        for (;;) {
          this.steps += 1;
          if (this.steps > this.maxSteps) throw new GlslEvalError('求值步数超限（可能是死循环）');
          if (stmt.test && !this.truthy(this.evalExpr(stmt.test, inner))) break;
          const signal = this.execStatement(stmt.body, inner);
          if (signal) {
            if (signal.signal === 'return') return signal;
            if (signal.signal === 'break') break;
          }
          if (stmt.update) this.evalExpr(stmt.update, inner);
        }
        return null;
      }
      case 'unsupported':
        throw new GlslEvalError(`求值器遇到超出子集的语句：${stmt.what}`);
      default:
        throw new GlslEvalError(`求值器不认识的语句节点：${stmt.k}`);
    }
  }

  /** 某类型的零值。 */
  zeroOf(type) {
    const t = normalizeTypeName(type);
    const n = w(t);
    if (t === 'bool') return val('bool', [0]);
    if (isMat(t)) return val(t, [1, 0, 0, 1]);
    return val(t, new Array(n || 1).fill(0));
  }

  /** 装配全局变量（uniform / in / out / const）。 */
  setupGlobals() {
    this.globals = new Map();
    if (this.fragCoord) {
      // GLSL 内建：原点在左下，四个分量是 (x, y, depth, 1/w)
      this.globals.set('gl_FragCoord', { type: 'vec4', value: [...this.fragCoord] });
    }
    for (const g of this.program.globals ?? []) {
      const qualifiers = g.qualifiers ?? [];
      const type = normalizeTypeName(g.type);
      const n = w(type) || 1;
      let value;
      if (qualifiers.includes('uniform')) {
        // 用 hasOwn 而不是直接取：`uniforms` 是普通对象，直接取会撞上 Object.prototype
        const provided = Object.hasOwn(this.uniforms, g.name) ? this.uniforms[g.name] : undefined;
        if (provided === undefined || provided === null) {
          value = this.zeroOf(type).d;
        } else {
          // 标量 uniform 传进来的就是个数，不能直接展开
          const arr = typeof provided === 'number' ? [provided] : [...provided];
          value = n === 1 ? [arr[0] ?? 0] : Array.from({ length: n }, (_, i) => arr[i] ?? 0);
        }
      } else if (g.init) {
        value = [...this.evalExpr(g.init, { parent: null, cells: new Map() }).d];
      } else {
        value = this.zeroOf(type).d;
      }
      this.globals.set(g.name, { type, value });
    }
  }

  /**
   * 跑一次入口函数。
   *
   * 两种形状都支持：
   *   - GLSL：`void main()`，结果写在 `out` 全局变量里
   *   - 转译产物：`vec4 main()`，结果由 `return` 给出
   *
   * @param {object} [opts]
   * @param {string} [opts.entry] 入口函数名，默认 main
   * @param {string} [opts.output] 出口变量名，默认自动找 `out` 限定符的全局
   * @param {Array<{t:string,d:number[]}>} [opts.args] 入口函数的实参（转译产物的入口带参数）
   * @returns {number[]} 输出颜色的四个分量
   */
  runMain(opts = {}) {
    this.steps = 0;
    this.setupGlobals();
    const entryName = opts.entry ?? 'main';
    const fn = (this.program.functions ?? []).find((f) => f.name === entryName);
    if (!fn) throw new GlslEvalError(`找不到入口函数 ${entryName}()`);

    const result = this.callFunction(fn, opts.args ?? []);
    if (result) return result.d;

    const outGlobal = opts.output
      ? this.program.globals.find((g) => g.name === opts.output)
      : (this.program.globals ?? []).find((g) => (g.qualifiers ?? []).includes('out'));
    if (!outGlobal) throw new GlslEvalError('既没有 return，也找不到 out 全局变量');
    const cell = this.globals.get(outGlobal.name);
    return [...cell.value];
  }

  /** 调用一个用户函数。 */
  callFunction(fn, args) {
    const scope = { parent: null, cells: new Map() };
    fn.params.forEach((p, i) => {
      scope.cells.set(p.name, { type: normalizeTypeName(p.type), value: [...args[i].d] });
    });
    const signal = this.execBlock(fn.body, scope);
    if (signal && signal.signal === 'return') return signal.value;
    return null;
  }
}
