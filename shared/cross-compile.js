/**
 * GLSL → HLSL / MSL / SPIR-V 跨平台转译。
 *
 * ## 为什么是「源码级转译」而不是调工具链
 *
 * 正规做法是 `glslangValidator` 出 SPIR-V，再用 `spirv-cross` 转 HLSL / MSL。
 * 但工作台是**零依赖 + 全离线**的插件，用户机器上不保证有这些工具。
 * 所以这里自己实现：先解析（`glsl-parse.js`），再把 AST 转成目标语言的 AST，
 * 最后按目标语法打印出来。
 *
 * ## 转译里最容易错的四件事（每一条都有测试钉住）
 *
 * 1. **矩阵的列主序 / 行主序**
 *    GLSL 和 MSL 的 `mat2(a,b,c,d)` 是**两列**；HLSL 的 `float2x2(a,b,c,d)` 是**两行**。
 *    所以转到 HLSL 时必须把中间两个参数换位，否则矩阵被转置 —— 画面还能出，
 *    只是全歪了，肉眼很难一眼看出。
 *
 * 2. **矩阵乘法**
 *    GLSL 里 `m * v` 是线性代数乘法；HLSL 里 `m * v` 是**逐分量**乘法。
 *    必须改写成 `mul(m, v)`，否则结果完全不对。MSL 与 GLSL 一致，不用改。
 *
 * 3. **`mod` 的语义**
 *    GLSL `mod(x,y) = x - y*floor(x/y)`（结果跟 y 同号）；
 *    HLSL/MSL 的 `fmod` 是截断式（结果跟 x 同号）。负数上一眼就能看出差别，
 *    所以这里统一发一个 `st_mod()` helper，而不是换成 `fmod`。
 *
 * 4. **`gl_FragCoord` 的原点**
 *    GLSL 原点在**左下**，HLSL 的 `SV_Position` / MSL 的 `[[position]]` 在**左上**。
 *    不处理的话导出结果相对预览上下颠倒。这里按 `iResolution.y - y` 翻转，
 *    让导出结果与工作台预览一致。
 *
 * ## 验证方式
 *
 * 本机没有 shader 编译器，所以「能不能编译」这一层**验不了**（文档里已写明）。
 * 能验的是**语义**：`shared/glsl-eval.js` 把原 AST 和转译后的 AST 用同一套求值器
 * 跑同一组输入，要求逐位相等。`tests/cross-compile.test.js` 对全部示例做这件事。
 *
 * ## 关键设计：打印和求值共用同一棵 AST
 *
 * `transformToTarget()` 产出的 AST **就是**要打印出来的那棵：入口函数的包装
 * （`st_fragCoord` 翻转、出口变量改成局部、末尾 `return`）都在这棵树里。
 * 于是「打印出来的代码」和「测试里求值的代码」不可能跑偏 ——
 * 否则测试就变成了自己验自己。
 *
 * ## 扩展
 *
 * 导出目标走注册机制（需求.md：「导出目标通过注册机制」）：
 * `registerExportTarget({ id, label, extension, build })`。
 *
 * @module dsh-shader-workbench/shared/cross-compile
 */

import { parseGlsl, swizzleType, isValidSwizzle, findFunction } from './glsl-parse.js';
import { spirvFromAst, spirvAssemblyFromAst } from './spirv-gen.js';

/** GLSL → HLSL 的类型名。 */
const HLSL_TYPES = {
  float: 'float', int: 'int', uint: 'uint', bool: 'bool',
  vec2: 'float2', vec3: 'float3', vec4: 'float4',
  ivec2: 'int2', ivec3: 'int3', ivec4: 'int4',
  bvec2: 'bool2', bvec3: 'bool3', bvec4: 'bool4',
  mat2: 'float2x2', mat3: 'float3x3', mat4: 'float4x4',
};

/** GLSL → MSL 的类型名（向量写法与 HLSL 相同，但矩阵是列主序，与 GLSL 一致）。 */
const MSL_TYPES = {
  float: 'float', int: 'int', uint: 'uint', bool: 'bool',
  vec2: 'float2', vec3: 'float3', vec4: 'float4',
  ivec2: 'int2', ivec3: 'int3', ivec4: 'int4',
  bvec2: 'bool2', bvec3: 'bool3', bvec4: 'bool4',
  mat2: 'float2x2', mat3: 'float3x3', mat4: 'float4x4',
};

/** `st_mod` 的 7 个重载（GLSL 的 `mod` 有 genType/genType 与 genType/float 两组）。 */
const MOD_HELPER_LINES = [
  'float  st_mod(float x, float y)   { return x - y * floor(x / y); }',
  'float2 st_mod(float2 x, float2 y) { return x - y * floor(x / y); }',
  'float3 st_mod(float3 x, float3 y) { return x - y * floor(x / y); }',
  'float4 st_mod(float4 x, float4 y) { return x - y * floor(x / y); }',
  'float2 st_mod(float2 x, float y)  { return x - y * floor(x / y); }',
  'float3 st_mod(float3 x, float y)  { return x - y * floor(x / y); }',
  'float4 st_mod(float4 x, float y)  { return x - y * floor(x / y); }',
];

/** GLSL 内建 → 目标语言名字。`名字/参数个数` 优先于 `名字`。 */
const INTRINSIC_NAMES = {
  hlsl: {
    fract: 'frac',
    mix: 'lerp',
    inversesqrt: 'rsqrt',
    dFdx: 'ddx',
    dFdy: 'ddy',
    'atan/1': 'atan',
    'atan/2': 'atan2',
  },
  msl: {
    inversesqrt: 'rsqrt',
    dFdx: 'dfdx',
    dFdy: 'dfdy',
    'atan/1': 'atan',
    'atan/2': 'atan2',
  },
};

/** 出口变量名（与 codegen 的 `st_fragColor` 保持一致）。 */
export const FRAGMENT_OUTPUT = 'st_fragColor';
/** 入口函数名。 */
export const ENTRY_NAME = 'main';
/** 视口坐标形参名。 */
const SV_POSITION = 'st_svPosition';
/** GLSL 语义的 fragCoord 局部名。 */
const FRAG_COORD = 'st_fragCoord';

/** 是不是矩阵类型。 */
function isMat(type) {
  return typeof type === 'string' && /^mat[234]/.test(type);
}

/** 分量个数（矩阵按 4 算，够用来判断「是不是标量」）。 */
function widthOf(type) {
  if (type === 'float' || type === 'int' || type === 'uint' || type === 'bool') return 1;
  const v = /^[ibu]?vec([234])$/.exec(type ?? '');
  if (v) return Number(v[1]);
  if (isMat(type)) return 4;
  return 0;
}

/** 两个类型取「更宽」的那个（标量会广播）。 */
function wider(a, b) {
  if (!a) return b;
  if (!b) return a;
  return widthOf(a) >= widthOf(b) ? a : b;
}

/**
 * 给整棵 AST 标注类型（就地加 `.type`）。
 *
 * 转译必须知道类型才能做两件关键判断：`A * B` 里有没有矩阵（决定要不要写 `mul`）、
 * 以及构造函数产出的到底是几维。生成器产出的代码里没有显式类型标注，
 * 所以这里做一遍简单的自底向上推导。
 *
 * @param {object} program
 * @returns {object} 同一个 program（就地标注）
 */
export function annotateTypes(program) {
  const globals = new Map();
  for (const g of program.globals ?? []) globals.set(g.name, g.type);

  const userFns = new Map();
  for (const f of program.functions ?? []) {
    if (!userFns.has(f.name)) userFns.set(f.name, []);
    userFns.get(f.name).push(f);
  }

  const intrinsicType = (name, argTypes) => {
    const t0 = argTypes[0];
    switch (name) {
      case 'length': case 'distance': case 'dot': case 'determinant': return 'float';
      case 'cross': return 'vec3';
      case 'any': case 'all': return 'bool';
      case 'not': return t0;
      case 'step': return argTypes[1] ?? t0;
      case 'smoothstep': return argTypes[2] ?? t0;
      case 'mix': case 'clamp': return t0;
      case 'atan': return argTypes.length === 2 ? wider(t0, argTypes[1]) : t0;
      case 'min': case 'max': case 'pow': case 'mod': case 'fmod': case '$mod':
        return wider(t0, argTypes[1]);
      case 'texture': case 'textureLod': case '$sample': return 'vec4';
      case 'mul': {
        if (isMat(t0) && isMat(argTypes[1])) return 'mat2';
        if (isMat(t0)) return argTypes[1];
        return t0;
      }
      case 'transpose': return t0;
      case 'matrixCompMult': return t0;
      default: break;
    }
    const fns = userFns.get(name);
    if (fns) {
      const picked = fns.find((f) => f.params.length === argTypes.length);
      if (picked) return picked.returnType;
    }
    // 逐分量数学函数：类型跟第一个参数走
    return t0;
  };

  const infer = (e, scope) => {
    if (!e) return null;
    let type;
    switch (e.k) {
      case 'num':
        type = e.isFloat ? 'float' : 'int';
        break;
      case 'paren':
        type = infer(e.e, scope);
        break;
      case 'id':
        if (e.name === 'gl_FragCoord') type = 'vec4';
        else if (scope.has(e.name)) type = scope.get(e.name);
        else if (globals.has(e.name)) type = globals.get(e.name);
        else type = 'float';
        break;
      case 'member': {
        const base = infer(e.obj, scope);
        type = isValidSwizzle(e.name, widthOf(base)) ? swizzleType(base, e.name) : base;
        break;
      }
      case 'un':
        type = infer(e.x, scope);
        break;
      case 'bin': {
        const l = infer(e.l, scope);
        const r = infer(e.r, scope);
        if (['<', '>', '<=', '>=', '==', '!=', '&&', '||'].includes(e.op)) type = 'bool';
        else if (e.op === '*') {
          if (isMat(l) && isMat(r)) type = 'mat2';
          else if (isMat(l)) type = r;
          else if (isMat(r)) type = l;
          else type = wider(l, r);
        } else type = wider(l, r);
        break;
      }
      case 'cond':
        infer(e.test, scope);
        infer(e.alt, scope);
        type = infer(e.cons, scope);
        break;
      case 'assign':
        // 赋值的值也必须推一遍：SPIR-V 生成器要靠它的类型决定广播 / 转换
        infer(e.value, scope);
        type = infer(e.target, scope);
        break;
      case 'comma':
        for (const item of e.list) type = infer(item, scope);
        break;
      case 'call': {
        const argTypes = e.args.map((a) => infer(a, scope));
        if (/^[ibu]?vec[234]$/.test(e.name) || /^mat[234]/.test(e.name) || ['float', 'int', 'uint', 'bool'].includes(e.name)) {
          type = e.name;
        } else {
          type = intrinsicType(e.name, argTypes);
        }
        break;
      }
      default:
        type = 'float';
        break;
    }
    e.type = type;
    return type;
  };

  const walkStmt = (s, scope) => {
    if (!s) return;
    switch (s.k) {
      case 'block': {
        const inner = new Map(scope);
        for (const item of s.body) walkStmt(item, inner);
        return;
      }
      case 'decl':
        if (s.init) infer(s.init, scope);
        scope.set(s.name, s.type);
        return;
      case 'expr': infer(s.e, scope); return;
      case 'return': if (s.e) infer(s.e, scope); return;
      case 'for': {
        const inner = new Map(scope);
        walkStmt(s.init, inner);
        if (s.test) infer(s.test, inner);
        if (s.update) infer(s.update, inner);
        walkStmt(s.body, inner);
        return;
      }
      case 'if':
        infer(s.test, scope);
        walkStmt(s.cons, new Map(scope));
        if (s.alt) walkStmt(s.alt, new Map(scope));
        return;
      default:
        return;
    }
  };

  for (const fn of program.functions ?? []) {
    const scope = new Map(globals);
    for (const p of fn.params) scope.set(p.name, p.type);
    walkStmt(fn.body, scope);
  }
  return program;
}

/** 造一个 `id` 节点。 */
function id(name, type) {
  return { k: 'id', name, type };
}

/** 造一个成员访问。 */
function member(obj, name, type) {
  return { k: 'member', obj, name, type };
}

/** 造一个字面量。 */
function lit(v, isFloat = true) {
  return { k: 'num', v, raw: isFloat ? String(v) : String(v), isFloat, type: isFloat ? 'float' : 'int' };
}

/**
 * 造 GLSL 语义的 `gl_FragCoord` 表达式。
 *
 * `st_svPosition` 的原点在左上（HLSL / MSL 都这样），GLSL 的在左下，
 * 所以 y 要按 `iResolution.y - y` 翻过来。
 * @returns {object}
 */
function fragCoordExpr() {
  const pos = id(SV_POSITION, 'vec4');
  return {
    k: 'call',
    name: 'vec4',
    type: 'vec4',
    args: [
      member(pos, 'x', 'float'),
      {
        k: 'bin',
        op: '-',
        l: member(id('iResolution', 'vec3'), 'y', 'float'),
        r: member(id(SV_POSITION, 'vec4'), 'y', 'float'),
        type: 'float',
      },
      member(id(SV_POSITION, 'vec4'), 'zw', 'vec2'),
    ],
  };
}

/**
 * 把 GLSL AST 转成「目标语言语义」的 AST。
 *
 * 转出来的 AST 仍然用 GLSL 的类型名和函数名（打印时才改名），但**语义已经是目标语言的**：
 * HLSL 的矩阵构造器参数序、`mul()`、`st_mod()`、`$sample()`。
 * 入口函数在这里就已经包装好（`st_fragCoord` 局部、出口变量局部、末尾 `return`），
 * 所以打印和求值看到的是同一棵树。
 *
 * @param {object} program 已标注类型
 * @param {'hlsl'|'msl'|'spirv'} target
 * @returns {object}
 */
export function transformToTarget(program, target) {
  const matrixLayout = target === 'hlsl' ? 'row' : 'column';
  const needsMul = target === 'hlsl';
  // SPIR-V 是 GLSL 的编译目标：原点、矩阵语义、mod 语义都与 GLSL 一致，
  // 所以既不用翻 y，出口变量也仍然是模块级的 Output 变量（不是入口局部）。
  const isSpirv = target === 'spirv';

  const transformExpr = (e) => {
    if (!e) return null;
    switch (e.k) {
      case 'num':
        return { ...e };
      case 'id':
        // `gl_FragCoord` 在 HLSL / MSL 里被换成翻正过的入口局部变量；
        // SPIR-V 里它本来就是个 Input 内建变量，保持原样。
        return e.name === 'gl_FragCoord' && !isSpirv
          ? { k: 'id', name: FRAG_COORD, type: e.type }
          : { ...e };
      case 'paren':
        return { k: 'paren', e: transformExpr(e.e), type: e.type };
      case 'member':
        return { k: 'member', obj: transformExpr(e.obj), name: e.name, type: e.type };
      case 'un':
        return { k: 'un', op: e.op, x: transformExpr(e.x), prefix: e.prefix, type: e.type };
      case 'bin': {
        const l = transformExpr(e.l);
        const r = transformExpr(e.r);
        if (e.op === '*' && needsMul) {
          const lm = isMat(e.l.type);
          const rm = isMat(e.r.type);
          const lw = widthOf(e.l.type);
          const rw = widthOf(e.r.type);
          // 只有「矩阵 × 非标量」才需要 mul：矩阵×标量在 HLSL 里也是逐分量放大，与 GLSL 等价
          if ((lm && rw > 1) || (rm && lw > 1)) {
            return { k: 'call', name: 'mul', args: [l, r], type: e.type };
          }
        }
        return { k: 'bin', op: e.op, l, r, type: e.type };
      }
      case 'cond':
        return { k: 'cond', test: transformExpr(e.test), cons: transformExpr(e.cons), alt: transformExpr(e.alt), type: e.type };
      case 'assign':
        return { k: 'assign', op: e.op, target: transformExpr(e.target), value: transformExpr(e.value), type: e.type };
      case 'comma':
        return { k: 'comma', list: e.list.map(transformExpr), type: e.type };
      case 'call': {
        const args = e.args.map(transformExpr);

        if (/^mat[234]/.test(e.name) && args.length === 4 && matrixLayout === 'row') {
          // GLSL/MSL 的 4 个参数是列；HLSL 的是行 —— 换中间两个就等价
          return { k: 'call', name: e.name, args: [args[0], args[2], args[1], args[3]], type: e.type };
        }
        if (e.name === 'mod') return { k: 'call', name: '$mod', args, type: e.type };
        if (e.name === 'texture' || e.name === 'textureLod') {
          return { k: 'call', name: '$sample', args: [args[0], args[1]], type: e.type };
        }
        // HLSL 的 `*` 对矩阵是**逐分量**乘，正好等价于 GLSL 的 matrixCompMult。
        // MSL / SPIR-V 的 `*` 是线性代数乘，所以这两个目标下保留原名，让下游明确拒绝。
        if (e.name === 'matrixCompMult' && target === 'hlsl') {
          return { k: 'bin', op: '*', l: args[0], r: args[1], type: e.type };
        }
        return { k: 'call', name: e.name, args, type: e.type };
      }
      default:
        return { ...e };
    }
  };

  const transformStmt = (s) => {
    if (!s) return null;
    switch (s.k) {
      case 'block':
        return { k: 'block', body: s.body.map(transformStmt) };
      case 'decl':
        return { k: 'decl', qualifiers: s.qualifiers, type: s.type, name: s.name, init: transformExpr(s.init), token: s.token };
      case 'expr':
        return { k: 'expr', e: transformExpr(s.e) };
      case 'return':
        return { k: 'return', e: transformExpr(s.e) };
      case 'for':
        return { k: 'for', init: transformStmt(s.init), test: transformExpr(s.test), update: transformExpr(s.update), body: transformStmt(s.body) };
      case 'if':
        return { k: 'if', test: transformExpr(s.test), cons: transformStmt(s.cons), alt: s.alt ? transformStmt(s.alt) : null };
      default:
        return { ...s };
    }
  };

  const outputs = (program.globals ?? [])
    .filter((g) => (g.qualifiers ?? []).includes('out'))
    .map((g) => ({ name: g.name, type: g.type }));
  const outName = outputs[0]?.name ?? FRAGMENT_OUTPUT;
  const outType = outputs[0]?.type ?? 'vec4';

  const mainFn = findFunction(program, ENTRY_NAME);
  if (!mainFn) throw new Error('GLSL 里找不到 main()');
  const mainBody = mainFn.body.body;
  // SPIR-V 里 gl_FragCoord 是模块级 Input 变量，**辅助函数也能读**，
  // 所以判断「用不用得到」要扫全部函数，不能只看 main。
  const usesFragCoord = JSON.stringify(program.functions ?? []).includes('gl_FragCoord');

  // 辅助函数里读 gl_FragCoord 是合法的 GLSL，但转译到 HLSL / MSL 后它是个入口局部变量，
  // 辅助函数看不见。与其悄悄产出一段编译不过的代码，不如在这里明确说不支持。
  // （SPIR-V 里 gl_FragCoord 是模块级 Input 变量，辅助函数读它没问题，所以跳过这项检查。）
  if (!isSpirv) {
    for (const f of program.functions ?? []) {
      if (f.name === ENTRY_NAME) continue;
      if (JSON.stringify(f.body).includes('gl_FragCoord')) {
        throw new Error(
          `辅助函数 ${f.name}() 里直接读了 gl_FragCoord。转译后 gl_FragCoord 是入口函数的局部变量，`
          + '辅助函数看不到它 —— 请把坐标当参数传进去再导出。',
        );
      }
    }
  }

  // 入口函数的最终形态：与打印出来的代码逐句对应
  const wrapped = [];
  if (usesFragCoord && !isSpirv) {
    wrapped.push({ k: 'decl', type: 'vec4', name: FRAG_COORD, init: fragCoordExpr() });
  }
  if (!isSpirv) {
    wrapped.push({ k: 'decl', type: outType, name: outName, init: { k: 'call', name: outType, args: [lit(0)], type: outType } });
  }
  for (const s of mainBody) wrapped.push(transformStmt(s));
  if (!isSpirv) wrapped.push({ k: 'return', e: id(outName, outType) });

  const others = (program.functions ?? [])
    .filter((f) => f.name !== ENTRY_NAME)
    .map((f) => ({
      name: f.name,
      returnType: f.returnType,
      params: f.params.map((p) => ({ ...p })),
      body: transformStmt(f.body),
      isEntry: false,
    }));

  const uniforms = (program.globals ?? [])
    .filter((g) => (g.qualifiers ?? []).includes('uniform') && !/^sampler/.test(g.type))
    .map((g) => ({ name: g.name, type: g.type }));
  const samplers = (program.globals ?? [])
    .filter((g) => /^sampler/.test(g.type))
    .map((g) => ({ name: g.name, type: g.type }));

  return {
    target,
    matrixLayout,
    matrixMultiply: target === 'hlsl' ? 'componentwise' : 'algebraic',
    uniforms,
    samplers,
    // 求值器按 globals 装配环境。
    // HLSL / MSL 的出口变量在入口里已经变成局部，所以不在这里；
    // SPIR-V 的出口仍是模块级 Output 变量，赋值要走全局，所以要放进来。
    globals: [
      ...uniforms.map((u) => ({ qualifiers: ['uniform'], type: u.type, name: u.name })),
      ...samplers.map((s) => ({ qualifiers: ['uniform'], type: s.type, name: s.name })),
      ...(isSpirv ? outputs.map((o) => ({ qualifiers: ['out'], type: o.type, name: o.name })) : []),
    ],
    outputs,
    outputName: outName,
    outputType: outType,
    usesFragCoord,
    functions: [
      ...others,
      {
        name: ENTRY_NAME,
        returnType: outType,
        params: isSpirv ? [] : [{ name: SV_POSITION, type: 'vec4' }],
        body: { k: 'block', body: wrapped },
        isEntry: true,
      },
    ],
  };
}

// ─────────────────────── 打印 ───────────────────────

/**
 * 造一个打印器。类型名、内建名、uniform 前缀都在这里定。
 * @param {'hlsl'|'msl'} target
 */
function makePrinter(target) {
  const types = target === 'hlsl' ? HLSL_TYPES : MSL_TYPES;
  const intrinsics = INTRINSIC_NAMES[target];
  const uniformNames = new Set();

  const typeName = (t) => types[t] ?? t;

  /** 浮点字面量必须带小数点：HLSL / MSL 里 `1` 是 int。 */
  const printNum = (e) => {
    if (!e.isFloat) return String(e.v);
    const s = String(e.v);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  };

  const print = (e) => {
    if (!e) return '0.0';
    switch (e.k) {
      case 'num':
        return printNum(e);
      case 'id': {
        if (e.name === 'gl_FragCoord') return FRAG_COORD;
        if (target === 'msl' && uniformNames.has(e.name)) return `u.${e.name}`;
        return e.name;
      }
      case 'paren':
        return `(${print(e.e)})`;
      case 'member':
        return `${print(e.obj)}.${e.name}`;
      case 'un':
        return e.prefix ? `${e.op}${print(e.x)}` : `${print(e.x)}${e.op}`;
      case 'bin':
        return `(${print(e.l)} ${e.op} ${print(e.r)})`;
      case 'cond':
        return `(${print(e.test)} ? ${print(e.cons)} : ${print(e.alt)})`;
      case 'assign':
        return `${print(e.target)} ${e.op} ${print(e.value)}`;
      case 'comma':
        return e.list.map(print).join(', ');
      case 'call': {
        if (e.name === '$sample') {
          const sampler = print(e.args[0]);
          const uv = print(e.args[1]);
          return target === 'hlsl'
            ? `${sampler}.Sample(st_sampler, ${uv})`
            : `${sampler}.sample(st_sampler, ${uv})`;
        }
        if (e.name === '$mod') return `st_mod(${e.args.map(print).join(', ')})`;
        if (e.name === 'mul') return `mul(${e.args.map(print).join(', ')})`;
        if (types[e.name] || /^[ibu]?vec[234]$/.test(e.name) || /^mat[234]/.test(e.name)) {
          return `${typeName(e.name)}(${e.args.map(print).join(', ')})`;
        }
        const mapped = intrinsics[`${e.name}/${e.args.length}`] ?? intrinsics[e.name] ?? e.name;
        return `${mapped}(${e.args.map(print).join(', ')})`;
      }
      default:
        return '/* ??? */';
    }
  };

  return {
    print,
    typeName,
    setUniforms(names) {
      uniformNames.clear();
      for (const n of names) uniformNames.add(n);
    },
  };
}

/** 缩进一段文本。 */
function indent(text, pad = '  ') {
  return text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

/** 打印一串语句。 */
function printStatements(body, p, pad = '') {
  return body.map((s) => indent(printStatement(s, p), pad)).join('\n');
}

/** 打印一条语句。 */
function printStatement(s, p) {
  switch (s.k) {
    case 'block':
      return `{\n${printStatements(s.body, p, '  ')}\n}`;
    case 'decl':
      return `${p.typeName(s.type)} ${s.name}${s.init ? ` = ${p.print(s.init)}` : ''};`;
    case 'expr':
      return `${p.print(s.e)};`;
    case 'return':
      return s.e ? `return ${p.print(s.e)};` : 'return;';
    case 'break':
      return 'break;';
    case 'continue':
      return 'continue;';
    case 'if': {
      const head = `if (${p.print(s.test)}) ${printStatement(s.cons, p)}`;
      return s.alt ? `${head} else ${printStatement(s.alt, p)}` : head;
    }
    case 'for': {
      const init = s.init
        ? (s.init.k === 'decl' ? printStatement(s.init, p).replace(/;$/, '') : p.print(s.init.e))
        : '';
      const test = s.test ? p.print(s.test) : '';
      const update = s.update ? p.print(s.update) : '';
      return `for (${init}; ${test}; ${update}) ${printStatement(s.body, p)}`;
    }
    case 'empty':
      return ';';
    default:
      return `/* 未支持的语句：${s.k} */`;
  }
}

/** 打印一个普通函数（HLSL / MSL 的函数语法一致）。 */
function printFunction(fn, p) {
  const params = fn.params.map((x) => `${p.typeName(x.type)} ${x.name}`).join(', ');
  return `${p.typeName(fn.returnType)} ${fn.name}(${params}) {\n${printStatements(fn.body.body, p, '  ')}\n}`;
}

/** AST 里有没有用到某个东西（按 JSON 文本找，够用且不依赖遍历）。 */
function astUses(ast, token) {
  return JSON.stringify(ast.functions).includes(token);
}

/**
 * 生成 HLSL（Shader Model 5.0）。
 *
 * @param {object} ast transformToTarget() 的结果
 * @param {object} [opts]
 * @param {string} [opts.source]
 * @param {string} [opts.generatedAt]
 * @returns {string}
 */
export function emitHlsl(ast, opts = {}) {
  const p = makePrinter('hlsl');
  p.setUniforms(ast.uniforms.map((u) => u.name));

  const out = [];
  out.push('// HLSL (Shader Model 5.0) —— 由 dsh-shader-workbench 从节点图转译');
  if (opts.source) out.push(`// 来源：${opts.source}`);
  if (opts.generatedAt) out.push(`// 生成时间：${opts.generatedAt}`);
  out.push('//');
  out.push('// 需要你自己接手的部分：');
  out.push('//   - uniform 声明成了全局变量，请按目标引擎改写成 cbuffer / 常量缓冲；');
  out.push('//   - HLSL 里纹理与采样器是两个对象，已按 t0 / s0 起编号；');
  out.push('//   - gl_FragCoord 原点在左下、SV_Position 在左上，这里已按 iResolution.y 翻转，');
  out.push('//     导出结果与工作台预览一致（不是上下颠倒的）。');
  out.push('');

  ast.samplers.forEach((s, i) => out.push(`Texture2D    ${s.name} : register(t${i});`));
  if (ast.samplers.length > 0) out.push('SamplerState st_sampler : register(s0);');
  if (ast.samplers.length > 0) out.push('');

  for (const u of ast.uniforms) out.push(`${p.typeName(u.type)} ${u.name};`);
  if (ast.uniforms.length > 0) out.push('');

  if (astUses(ast, '"$mod"')) {
    out.push('// GLSL 的 mod() 与 HLSL 的 fmod() 语义不同（结果跟谁同号），这里保留 GLSL 语义');
    out.push(...MOD_HELPER_LINES);
    out.push('');
  }

  const seen = new Set();
  for (const fn of ast.functions) {
    if (fn.isEntry) continue;
    const key = `${fn.name}/${fn.params.map((x) => x.type).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(printFunction(fn, p));
    out.push('');
  }

  const entry = ast.functions.find((f) => f.isEntry);
  out.push(`float4 main(float4 ${SV_POSITION} : SV_Position) : SV_Target {`);
  const body = printStatements(entry.body.body, p, '  ');
  if (body.trim()) out.push(body);
  out.push('}');
  out.push('');

  return out.join('\n');
}

/**
 * 生成 MSL（Metal Shading Language）。
 *
 * @param {object} ast
 * @param {object} [opts]
 * @returns {string}
 */
export function emitMsl(ast, opts = {}) {
  const p = makePrinter('msl');
  p.setUniforms(ast.uniforms.map((u) => u.name));

  const out = [];
  out.push('// Metal Shading Language —— 由 dsh-shader-workbench 从节点图转译');
  if (opts.source) out.push(`// 来源：${opts.source}`);
  if (opts.generatedAt) out.push(`// 生成时间：${opts.generatedAt}`);
  out.push('//');
  out.push('// 需要你自己接手的部分：');
  out.push('//   - uniform 打包在 StUniforms 里（[[buffer(0)]]）。Metal 里 float3 占 16 字节，');
  out.push('//     主机侧请用同一份结构体定义，别手算偏移；');
  out.push('//   - 纹理按 [[texture(0..N)]] 起编号；');
  out.push('//   - gl_FragCoord 原点在左下、[[position]] 在左上，这里已按 u.iResolution.y 翻转。');
  out.push('');
  out.push('#include <metal_stdlib>');
  out.push('using namespace metal;');
  out.push('');

  if (ast.uniforms.length > 0) {
    out.push('struct StUniforms {');
    for (const u of ast.uniforms) out.push(`  ${p.typeName(u.type)} ${u.name};`);
    out.push('};');
    out.push('');
  }

  out.push('struct StOut {');
  out.push('  float4 color [[color(0)]];');
  out.push('};');
  out.push('');

  if (ast.samplers.length > 0) {
    out.push('constexpr sampler st_sampler(coord::normalized, filter::linear, address::clamp_to_edge);');
    out.push('');
  }

  if (astUses(ast, '"$mod"')) {
    out.push('// GLSL 的 mod() 与 MSL 的 fmod() 语义不同（结果跟谁同号），这里保留 GLSL 语义');
    out.push(...MOD_HELPER_LINES);
    out.push('');
  }

  const seen = new Set();
  for (const fn of ast.functions) {
    if (fn.isEntry) continue;
    const key = `${fn.name}/${fn.params.map((x) => x.type).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(printFunction(fn, p));
    out.push('');
  }

  const entry = ast.functions.find((f) => f.isEntry);
  const params = [];
  if (ast.uniforms.length > 0) params.push('constant StUniforms& u [[buffer(0)]]');
  ast.samplers.forEach((s, i) => params.push(`texture2d<float> ${s.name} [[texture(${i})]]`));
  params.push(`float4 ${SV_POSITION} [[position]]`);
  out.push(`fragment StOut st_main(${params.join(',\n                 ')}) {`);

  // 末尾那条 `return st_fragColor;` 换成 MSL 的结构体出口
  const stmts = entry.body.body;
  const last = stmts[stmts.length - 1];
  const head = last && last.k === 'return' ? stmts.slice(0, -1) : stmts;
  const body = printStatements(head, p, '  ');
  if (body.trim()) out.push(body);
  out.push('  StOut st_out;');
  out.push(`  st_out.color = ${last && last.k === 'return' ? p.print(last.e) : ast.outputName};`);
  out.push('  return st_out;');
  out.push('}');
  out.push('');

  return out.join('\n');
}

// ─────────────────────── 导出目标注册表 ───────────────────────

/**
 * 导出目标注册表。需求.md 明确要求「导出目标通过注册机制」。
 * @type {Map<string, object>}
 */
export const EXPORT_TARGETS = new Map();

/**
 * 注册一个导出目标。
 * @param {object} target
 * @param {string} target.id
 * @param {string} target.label
 * @param {string} target.extension
 * @param {string} [target.mime]
 * @param {boolean} [target.binary] 产物是二进制（`build` 返回 Uint8Array）
 * @param {'hlsl'|'msl'|'glsl'} [target.astTarget] 用哪套目标语义做 AST 转换
 * @param {(ctx:{ast:object,program:object,glsl:string,source?:string,generatedAt?:string}) => string|Uint8Array|{code:string|Uint8Array,warnings?:string[]}} target.build
 */
export function registerExportTarget(target) {
  if (!target?.id) throw new Error('导出目标必须有 id');
  if (typeof target.build !== 'function') throw new Error(`导出目标 ${target.id} 缺少 build()`);
  EXPORT_TARGETS.set(target.id, { mime: 'text/plain', binary: false, astTarget: target.id, ...target });
  return target.id;
}

/**
 * 列出全部导出目标（给面板 / 工具描述用）。
 * @returns {Array<{id:string,label:string,extension:string,mime:string,binary:boolean}>}
 */
export function listExportTargets() {
  return [...EXPORT_TARGETS.values()].map(({ id, label, extension, mime, binary }) => ({ id, label, extension, mime, binary }));
}

/**
 * 转译入口。
 *
 * @param {string} glsl 生成的 GLSL（GLSL ES 3.00）
 * @param {string} targetId 目标 id
 * @param {object} [opts]
 * @param {string} [opts.source] 来源说明（写进文件头注释）
 * @param {string} [opts.generatedAt]
 * @returns {{ok:true, code:string|Uint8Array, ast:object, program:object, warnings:string[]}
 *          |{ok:false, errors:Array<{message:string,line?:number}>, unsupported:Array<object>}}
 */
export function crossCompile(glsl, targetId, opts = {}) {
  const target = EXPORT_TARGETS.get(targetId);
  if (!target) {
    return { ok: false, errors: [{ message: `不认识的导出目标：${targetId}` }], unsupported: [] };
  }

  let program;
  try {
    program = parseGlsl(glsl);
  } catch (error) {
    return { ok: false, errors: [{ message: `GLSL 解析失败：${error.message}` }], unsupported: [] };
  }

  if ((program.unsupported ?? []).length > 0) {
    return {
      ok: false,
      errors: program.unsupported.map((u) => ({ message: `超出转译子集：${u.msg}`, line: u.line })),
      unsupported: program.unsupported,
    };
  }

  if (!findFunction(program, ENTRY_NAME)) {
    return { ok: false, errors: [{ message: 'GLSL 里找不到 main()' }], unsupported: [] };
  }

  annotateTypes(program);
  let ast;
  try {
    ast = transformToTarget(program, target.astTarget);
  } catch (error) {
    return { ok: false, errors: [{ message: `转译失败：${error.message}` }], unsupported: [] };
  }

  const warnings = [];
  // 只有 HLSL / MSL 需要靠 iResolution 翻 y；SPIR-V 是 GLSL 原点，不依赖它
  if (['hlsl', 'msl'].includes(target.astTarget) && !(program.globals ?? []).some((g) => g.name === 'iResolution')) {
    warnings.push('这份 GLSL 没有声明 iResolution，gl_FragCoord 的 y 翻转可能不可用');
  }

  let built;
  try {
    built = target.build({ ast, program, glsl, source: opts.source, generatedAt: opts.generatedAt });
  } catch (error) {
    return { ok: false, errors: [{ message: `转译失败：${error.message}` }], unsupported: [] };
  }

  const code = built && typeof built === 'object' && 'code' in built ? built.code : built;
  return { ok: true, code, ast, program, warnings: [...warnings, ...(built?.warnings ?? [])] };
}

// ── 注册内置目标 ──

registerExportTarget({
  id: 'glsl',
  label: 'GLSL ES 3.00（原样）',
  extension: 'frag',
  astTarget: 'msl', // 只为让 AST 有个合法形状；这个目标不打印 AST
  build: ({ glsl }) => glsl,
});

registerExportTarget({
  id: 'hlsl',
  label: 'HLSL（Shader Model 5.0）',
  extension: 'hlsl',
  astTarget: 'hlsl',
  build: ({ ast, source, generatedAt }) => emitHlsl(ast, { source, generatedAt }),
});

registerExportTarget({
  id: 'msl',
  label: 'Metal Shading Language',
  extension: 'metal',
  astTarget: 'msl',
  build: ({ ast, source, generatedAt }) => emitMsl(ast, { source, generatedAt }),
});

// SPIR-V 走的是同一套 AST 转换，只是 `astTarget` 取 `'spirv'` ——
// 那个模式下原点保持左下、矩阵保持列主序、出口变量保持模块级，也就是 GLSL 原本的语义。
// 二进制由 shared/spirv-gen.js 自己写，不依赖任何外部工具链。
registerExportTarget({
  id: 'spirv',
  label: 'SPIR-V 二进制（Vulkan 风格）',
  extension: 'spv',
  mime: 'application/octet-stream',
  binary: true,
  astTarget: 'spirv',
  build: ({ ast, source }) => spirvFromAst(ast, { source }),
});

registerExportTarget({
  id: 'spvasm',
  label: 'SPIR-V 汇编（.spvasm，人读用）',
  extension: 'spvasm',
  astTarget: 'spirv',
  build: ({ ast, source }) => spirvAssemblyFromAst(ast, { source }),
});
