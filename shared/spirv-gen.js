/**
 * AST → SPIR-V 二进制生成器。
 *
 * 输入是 `transformToTarget(program, 'spirv')` 的产物 —— 也就是「GLSL 语义」的目标 AST：
 * 原点在左下、矩阵是列主序、`mod` 是 GLSL 的 mod。这些都和 SPIR-V 一致，
 * 所以这一层不需要再做语义改写，只负责把 AST 落成指令。
 *
 * ## 产物形态
 *
 * 一个标准的 Vulkan 风格片段着色器模块：
 *   - uniform 收进一个 `%Uniforms` 结构体（`Block` 装饰 + std140 偏移）；
 *   - `sampler2D` 用 `UniformConstant` + `DescriptorSet/Binding`；
 *   - 出口变量是 `Output` 存储类 + `Location 0`；
 *   - `gl_FragCoord` 是 `Input` 存储类 + `BuiltIn FragCoord`，原点左下；
 *   - 内建数学函数走 `OpExtInst` + `GLSL.std.450`。
 *
 * ## 覆盖范围
 *
 * 只覆盖 codegen 实际会吐出来的那个子集（见 `需求.md` / `docs/开发与验证.md`）：
 * 类型 `float/int/vec2-4/mat2/sampler2D`，语句 `decl/expr/return/if/for/break/continue`，
 * 表达式 `num/id/member/un/bin/cond/assign/comma/call`。
 * 遇到子集外的东西一律抛错 —— 宁可导出失败，也不产出一段看着像模像样的坏二进制。
 *
 * ## 验证到哪一层
 *
 * 本机没有 `spirv-val`，所以这份二进制**没有经过官方校验器**。能保证的是结构自洽 +
 * 编码/解码互逆（见 `spirv.js` 的 `disassembleSpirv` / `roundTripSpirv`）。
 *
 * @module dsh-shader-workbench/shared/spirv-gen
 */

import {
  ModuleBuilder, encodeModule, disassembleSpirv, GLSL_STD_450,
  ExecutionModel, StorageClass, Decoration, BuiltIn, ExecutionMode,
  Dim, SourceLanguage, SelectionControl, LoopControl, FunctionControl,
} from './spirv.js';
import { swizzleIndices } from './glsl-parse.js';

/** 出口变量名（与 codegen 的约定一致）。 */
const FRAGMENT_OUTPUT = 'st_fragColor';
/** 入口函数名。 */
const ENTRY_NAME = 'main';
/** `gl_FragCoord` 在 SPIR-V 里的变量名。 */
const FRAG_COORD_VAR = 'st_gl_FragCoord';

/** GLSL 标量类型 → SPIR-V 类型声明的参数。 */
const SCALAR_TYPES = {
  bool: { op: 'OpTypeBool' },
  int: { op: 'OpTypeInt', args: [32, 1] },
  uint: { op: 'OpTypeInt', args: [32, 0] },
  float: { op: 'OpTypeFloat', args: [32] },
};

/** 向量 / 矩阵的基类型与分量数。 */
function shapeOf(type) {
  const v = /^([ibu]?)vec([234])$/.exec(type ?? '');
  if (v) return { prefix: v[1] ?? '', width: Number(v[2]), kind: 'vector' };
  const m = /^mat([234])$/.exec(type ?? '');
  if (m) return { prefix: '', width: Number(m[1]), kind: 'matrix' };
  return null;
}

/** 标量基类型名（`vec3` → `float`，`ivec3` → `int`）。 */
function scalarOf(type) {
  const s = shapeOf(type);
  if (!s) return type;
  if (s.kind === 'matrix') return 'float';
  if (s.prefix === 'i') return 'int';
  if (s.prefix === 'u') return 'uint';
  if (s.prefix === 'b') return 'bool';
  return 'float';
}

/** 是不是矩阵。 */
function isMatrix(type) {
  return /^mat[234]$/.test(type ?? '');
}

/** 分量数：标量 1，矩阵按列数算。 */
function componentCount(type) {
  const s = shapeOf(type);
  if (!s) return 1;
  return s.width;
}

/** 是不是「标量」（含 bool/int）。 */
function isScalarType(type) {
  return !shapeOf(type);
}

/** 同族的向量类型名。 */
function vectorType(base, width) {
  if (base === 'float') return `vec${width}`;
  if (base === 'int') return `ivec${width}`;
  if (base === 'uint') return `uvec${width}`;
  if (base === 'bool') return `bvec${width}`;
  return `vec${width}`;
}

/** 把 JS number 转成 IEEE-754 单精度位模式。 */
function f32bits(v) {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setFloat32(0, Math.fround(v), true);
  return dv.getUint32(0, true);
}

/** std140 里一个类型占的字节数与对齐。 */
function std140(type) {
  if (type === 'float' || type === 'int' || type === 'uint' || type === 'bool') return { align: 4, size: 4 };
  if (type === 'vec2') return { align: 8, size: 8 };
  if (type === 'vec3') return { align: 16, size: 12 };
  if (type === 'vec4') return { align: 16, size: 16 };
  if (type === 'mat2') return { align: 16, size: 32 };
  if (type === 'mat3') return { align: 16, size: 48 };
  if (type === 'mat4') return { align: 16, size: 64 };
  return { align: 16, size: 16 };
}

/** 向上取整到对齐。 */
function alignUp(v, a) {
  return Math.ceil(v / a) * a;
}

/**
 * 生成器。
 *
 * 一个实例只编一个模块；`run()` 走完全流程。
 */
class SpirvGen {
  /**
   * @param {object} ast `transformToTarget(program, 'spirv')` 的产物
   * @param {object} [opts]
   * @param {string} [opts.source] 来源说明，写进 `OpSource`
   */
  constructor(ast, opts = {}) {
    this.ast = ast;
    this.opts = opts;
    this.b = new ModuleBuilder();
    this.warnings = [];

    /** 类型名 → 类型 id */
    this.typeIds = new Map();
    /** `storage/type` → 指针类型 id */
    this.ptrIds = new Map();
    /** 常量缓存 */
    this.constCache = new Map();
    /** 函数签名 → OpTypeFunction id */
    this.fnTypeIds = new Map();
    /** 用户函数名 → {id, returnType, paramTypes} */
    this.userFns = new Map();
    /** uniform 名 → {index, type} */
    this.uniformSlots = new Map();
    /** 采样器名 → {varId, type} */
    this.samplers = new Map();
    /** 出口变量名 → {varId, type} */
    this.outputs = new Map();

    /** 当前函数 */
    this.currentFn = null;
    /** 作用域栈：每层是 name → {kind, id/varId, type} */
    this.scopes = [];
    /** 循环栈：{merge, continue} */
    this.loopStack = [];
    /** 当前块是否已经终止 */
    this.terminated = false;
    /** 本函数里待插入到入口块开头的 OpVariable */
    this.pendingLocals = [];

    this.glslSetId = 0;
    this.uniformStructId = 0;
    this.uniformVarId = 0;
    this.fragCoordVarId = 0;
    this.entryFnId = 0;
  }

  // ── 基础发射 ──

  /**
   * 在指定段里跑一段逻辑，跑完把游标恢复原位。
   *
   * 生成器是「顺着 AST 走」的，中途经常要往 `global` 段补类型 / 常量。
   * 不恢复游标的话，后面紧接着的 `emit` 就会写错段 —— 这类错误在
   * 反汇编之前完全看不出来，所以统一在这里挡住。
   */
  _section(name, fn) {
    const saved = this.b.cursor;
    this.b.at(name);
    try {
      return fn();
    } finally {
      this.b.cursor = saved;
    }
  }

  /** 发一条 `ri...` 格式的指令，返回结果 id。 */
  ins(name, resultType, ...rest) {
    const id = this.b.id();
    this.b.emit(name, resultType, id, ...rest);
    return id;
  }

  /** 发一条 `i...` 格式的指令（类型声明、标签），返回结果 id。 */
  insBare(name, ...rest) {
    const id = this.b.id();
    this.b.emit(name, id, ...rest);
    return id;
  }

  /** 开一个新块。 */
  label() {
    const id = this.b.id();
    this.b.emit('OpLabel', id);
    return id;
  }

  // ── 类型 ──

  /** 取一个 GLSL 类型名对应的 SPIR-V 类型 id（不存在就声明）。 */
  typeId(type) {
    const cached = this.typeIds.get(type);
    if (cached) return cached;
    const id = this._section('global', () => this.declareType(type));
    this.typeIds.set(type, id);
    return id;
  }

  /** 真正声明一个类型（调用时已经在 `global` 段）。 */
  declareType(type) {
    if (type === 'void') return this.insBare('OpTypeVoid');
    if (SCALAR_TYPES[type]) {
      const info = SCALAR_TYPES[type];
      return this.insBare(info.op, ...(info.args ?? []));
    }
    if (type === 'sampler2D') {
      const image = this.insBare('OpTypeImage', this.typeId('float'), Dim['2D'], 0, 0, 0, 1, 0);
      return this.insBare('OpTypeSampledImage', image);
    }
    const shape = shapeOf(type);
    if (!shape) throw new Error(`SPIR-V：不认识的类型 ${type}`);
    if (shape.kind === 'vector') {
      const base = shape.prefix === 'i' ? 'int' : shape.prefix === 'u' ? 'uint' : shape.prefix === 'b' ? 'bool' : 'float';
      return this.insBare('OpTypeVector', this.typeId(base), shape.width);
    }
    const column = this.typeId(`vec${shape.width}`);
    return this.insBare('OpTypeMatrix', column, shape.width);
  }

  /** 取一个指针类型 id。 */
  ptrId(storage, type) {
    const key = `${storage}/${type}`;
    const cached = this.ptrIds.get(key);
    if (cached) return cached;
    const id = this._section('global', () => this.insBare('OpTypePointer', StorageClass[storage], this.typeId(type)));
    this.ptrIds.set(key, id);
    return id;
  }

  // ── 常量 ──

  /** 浮点常量。 */
  constFloat(v) {
    const rounded = Math.fround(v);
    const key = `f:${rounded}`;
    const cached = this.constCache.get(key);
    if (cached) return cached;
    const id = this._section('global', () => this.ins('OpConstant', this.typeId('float'), f32bits(rounded)));
    this.constCache.set(key, id);
    return id;
  }

  /** 整型常量。 */
  constInt(v) {
    const key = `i:${v}`;
    const cached = this.constCache.get(key);
    if (cached) return cached;
    const id = this._section('global', () => this.ins('OpConstant', this.typeId('int'), v >>> 0));
    this.constCache.set(key, id);
    return id;
  }

  /** 全零常量（用 `OpConstantNull`，省掉一堆分量常量）。 */
  constNull(type) {
    const key = `n:${type}`;
    const cached = this.constCache.get(key);
    if (cached) return cached;
    const id = this._section('global', () => this.ins('OpConstantNull', this.typeId(type)));
    this.constCache.set(key, id);
    return id;
  }

  // ── 值工具 ──

  /** 把 `{id, type}` 广播/转换成目标类型。 */
  coerce(value, targetType) {
    if (value.type === targetType) return value;
    // 标量 → 向量：每个分量都填同一个标量
    if (isScalarType(value.type) && componentCount(targetType) > 1) {
      const n = componentCount(targetType);
      const id = this.ins('OpCompositeConstruct', this.typeId(targetType), ...Array(n).fill(value.id));
      return { id, type: targetType };
    }
    throw new Error(`SPIR-V：${value.type} 不能当成 ${targetType} 用`);
  }

  /** 读一个变量（`OpLoad`）。 */
  load(type, ptr) {
    return this.ins('OpLoad', this.typeId(type), ptr);
  }

  // ── 作用域 ──

  pushScope() {
    this.scopes.push(new Map());
  }

  popScope() {
    this.scopes.pop();
  }

  declareLocal(name, type, ptr) {
    this.scopes[this.scopes.length - 1].set(name, { kind: 'local', id: ptr, type });
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const hit = this.scopes[i].get(name);
      if (hit) return hit;
    }
    return null;
  }

  // ── 表达式 ──

  /**
   * 生成一个表达式，返回 `{id, type}`。
   * @param {object} e
   * @returns {{id:number, type:string}}
   */
  expr(e) {
    if (!e) throw new Error('SPIR-V：空表达式');
    switch (e.k) {
      case 'num':
        return e.isFloat ? { id: this.constFloat(e.v), type: 'float' } : { id: this.constInt(e.v), type: 'int' };
      case 'paren':
        return this.expr(e.e);
      case 'id':
        return this.exprId(e);
      case 'member':
        return this.exprMember(e);
      case 'un':
        return this.exprUnary(e);
      case 'bin':
        return this.exprBinary(e);
      case 'cond':
        return this.exprCond(e);
      case 'assign':
        return this.exprAssign(e);
      case 'comma': {
        let last = null;
        for (const item of e.list) last = this.expr(item);
        return last ?? { id: this.constFloat(0), type: 'float' };
      }
      case 'call':
        return this.exprCall(e);
      default:
        throw new Error(`SPIR-V：不认识的表达式 ${e.k}`);
    }
  }

  /** 标识符：局部变量 / 内建 / 出口变量 / uniform / 采样器。 */
  exprId(e) {
    const local = this.lookup(e.name);
    if (local) {
      if (local.kind === 'value') return { id: local.id, type: local.type };
      return { id: this.load(local.type, local.id), type: local.type };
    }
    if (e.name === 'gl_FragCoord') {
      if (!this.fragCoordVarId) throw new Error('SPIR-V：用到了 gl_FragCoord，但入口点没有声明它');
      return { id: this.load('vec4', this.fragCoordVarId), type: 'vec4' };
    }
    const out = this.outputs.get(e.name);
    if (out) return { id: this.load(out.type, out.varId), type: out.type };
    const sampler = this.samplers.get(e.name);
    if (sampler) return { id: this.load(sampler.type, sampler.varId), type: sampler.type };
    const slot = this.uniformSlots.get(e.name);
    if (slot) return { id: this.loadUniform(slot), type: slot.type };
    throw new Error(`SPIR-V：找不到标识符 ${e.name}`);
  }

  /** uniform block 成员：`OpAccessChain` + `OpLoad`。 */
  loadUniform(slot) {
    const idx = this.constInt(slot.index);
    const ptr = this.ptrId('Uniform', slot.type);
    const chain = this.ins('OpAccessChain', ptr, this.uniformVarId, idx);
    return this.load(slot.type, chain);
  }

  /** 成员访问（本子集里只可能是 swizzle）。 */
  exprMember(e) {
    const base = this.expr(e.obj);
    const indices = swizzleIndices(e.name);
    if (!indices || indices.some((i) => i === undefined)) {
      throw new Error(`SPIR-V：不支持的成员访问 .${e.name}（本子集只支持 swizzle）`);
    }
    if (indices.length === 1) {
      const compType = scalarOf(base.type);
      const id = this.ins('OpCompositeExtract', this.typeId(compType), base.id, indices[0]);
      return { id, type: compType };
    }
    const id = this.ins('OpVectorShuffle', this.typeId(e.type), base.id, base.id, ...indices);
    return { id, type: e.type };
  }

  /** 一元：取负 / 逻辑非 / 自增自减。 */
  exprUnary(e) {
    if (e.op === '++' || e.op === '--') return this.exprIncDec(e);
    const x = this.expr(e.x);
    if (e.op === '-') {
      const name = isScalarType(x.type) && scalarOf(x.type) === 'int' ? 'OpSNegate' : 'OpFNegate';
      return { id: this.ins(name, this.typeId(x.type), x.id), type: x.type };
    }
    if (e.op === '!') return { id: this.ins('OpLogicalNot', this.typeId(e.type), x.id), type: e.type };
    throw new Error(`SPIR-V：不支持的一元运算符 ${e.op}`);
  }

  /** `i++` / `i--`（前缀返回新值，后缀返回旧值）。 */
  exprIncDec(e) {
    if (e.x.k !== 'id') throw new Error('SPIR-V：自增自减的目标必须是变量');
    const local = this.lookup(e.x.name);
    if (!local || local.kind !== 'local') throw new Error(`SPIR-V：${e.x.name} 不是可写的变量`);
    const old = this.load(local.type, local.id);
    const one = local.type === 'int' ? this.constInt(1) : this.constFloat(1);
    const op = e.op === '++'
      ? (local.type === 'int' ? 'OpIAdd' : 'OpFAdd')
      : (local.type === 'int' ? 'OpISub' : 'OpFSub');
    const next = this.ins(op, this.typeId(local.type), old, one);
    this.b.emit('OpStore', local.id, next);
    return { id: e.prefix ? next : old, type: local.type };
  }

  /** 二元运算。 */
  exprBinary(e) {
    return this.binary(e.op, this.expr(e.l), this.expr(e.r), e.type);
  }

  /**
   * 二元运算（操作数已经求好值）。
   * @param {string} op
   * @param {{id:number,type:string}} l
   * @param {{id:number,type:string}} r
   * @param {string} resultType
   */
  binary(op, l, r, resultType) {
    if (op === '&&' || op === '||') {
      return { id: this.ins(op === '&&' ? 'OpLogicalAnd' : 'OpLogicalOr', this.typeId(resultType), l.id, r.id), type: resultType };
    }
    if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return this.compare(op, l, r, resultType);
    if (op === '*') return this.multiply(l, r, resultType);

    const ops = {
      '+': ['OpFAdd', 'OpIAdd'],
      '-': ['OpFSub', 'OpISub'],
      '/': ['OpFDiv', null],
      '%': [null, 'OpSMod'],
    }[op];
    if (!ops) throw new Error(`SPIR-V：不支持的二元运算符 ${op}`);

    const isInt = scalarOf(resultType) === 'int';
    const name = ops[isInt ? 1 : 0];
    if (!name) throw new Error(`SPIR-V：${op} 不支持 ${resultType}`);
    return {
      id: this.ins(name, this.typeId(resultType), this.coerce(l, resultType).id, this.coerce(r, resultType).id),
      type: resultType,
    };
  }

  /**
   * `*`：GLSL 的乘法有四种形状（标量、向量×标量、矩阵×向量、矩阵×矩阵），
   * SPIR-V 各有一条专用指令，必须分开写。
   *
   * @param {{id:number,type:string}} l
   * @param {{id:number,type:string}} r
   * @param {string} result
   */
  multiply(l, r, result) {
    const lt = l.type;
    const rt = r.type;

    let name;
    let a = l;
    let b = r;
    if (isMatrix(lt) && isMatrix(rt)) {
      name = 'OpMatrixTimesMatrix';
    } else if (isMatrix(lt) && !isScalarType(rt)) {
      name = 'OpMatrixTimesVector';
    } else if (!isScalarType(lt) && isMatrix(rt)) {
      name = 'OpVectorTimesMatrix';
    } else if (isMatrix(lt) || isMatrix(rt)) {
      name = 'OpMatrixTimesScalar';
    } else if (isScalarType(lt) && isScalarType(rt)) {
      name = 'OpFMul';
      a = this.coerce(l, result);
      b = this.coerce(r, result);
    } else if (componentCount(lt) > 1 && isScalarType(rt)) {
      name = 'OpVectorTimesScalar';
    } else if (isScalarType(lt) && componentCount(rt) > 1) {
      // 指令要求「向量在前、标量在后」
      name = 'OpVectorTimesScalar';
      a = r;
      b = l;
    } else {
      name = 'OpFMul';
      a = this.coerce(l, result);
      b = this.coerce(r, result);
    }
    return { id: this.ins(name, this.typeId(result), a.id, b.id), type: result };
  }

  /** 比较运算，结果类型是 `bool` / `bvecN`。 */
  exprCompare(e) {
    return this.compare(e.op, this.expr(e.l), this.expr(e.r), e.type);
  }

  /**
   * 比较（操作数已经求好值）。
   * @param {string} op
   * @param {{id:number,type:string}} l
   * @param {{id:number,type:string}} r
   * @param {string} resultType
   */
  compare(op, l, r, resultType) {
    const isInt = scalarOf(l.type) === 'int' || scalarOf(l.type) === 'uint';
    const table = isInt
      ? { '<': 'OpSLessThan', '>': 'OpSGreaterThan', '<=': 'OpSLessThanEqual', '>=': 'OpSGreaterThanEqual', '==': 'OpIEqual', '!=': 'OpINotEqual' }
      : { '<': 'OpFOrdLessThan', '>': 'OpFOrdGreaterThan', '<=': 'OpFOrdLessThanEqual', '>=': 'OpFOrdGreaterThanEqual', '==': 'OpFOrdEqual', '!=': 'OpFOrdNotEqual' };
    const name = table[op];
    if (!name) throw new Error(`SPIR-V：不支持的比较运算符 ${op}`);
    // 比较的**操作数**取两个里更宽的那个；`resultType` 是 bool / bvecN，跟操作数不同族
    const operandType = l.type === r.type
      ? l.type
      : (componentCount(l.type) >= componentCount(r.type) ? l.type : r.type);
    return {
      id: this.ins(name, this.typeId(resultType), this.coerce(l, operandType).id, this.coerce(r, operandType).id),
      type: resultType,
    };
  }

  /** 三元表达式 → `OpSelect`。 */
  exprCond(e) {
    const test = this.expr(e.test);
    const cons = this.expr(e.cons);
    const alt = this.expr(e.alt);
    const type = cons.type === alt.type ? cons.type : e.type;
    const a = this.coerce(cons, type);
    const b = this.coerce(alt, type);
    return { id: this.ins('OpSelect', this.typeId(type), test.id, a.id, b.id), type };
  }

  /** 赋值（表达式位置）。 */
  exprAssign(e) {
    if (e.target.k !== 'id') throw new Error('SPIR-V：赋值的目标必须是变量');
    const name = e.target.name;

    const out = this.outputs.get(name);
    const local = this.lookup(name);
    const slot = out ? { kind: 'output', id: out.varId, type: out.type } : local;
    if (!slot || slot.kind === 'value') throw new Error(`SPIR-V：${name} 不是可写的变量`);

    const value = this.expr(e.value);
    let final = this.coerce(value, slot.type);

    if (e.op !== '=') {
      const binOp = e.op.slice(0, -1);
      const current = this.load(slot.type, slot.id);
      final = this.binary(binOp, current, final, slot.type);
    }

    this.b.emit('OpStore', slot.id, final.id);
    return { id: final.id, type: slot.type };
  }

  /** 函数调用。 */
  exprCall(e) {
    const name = e.name;
    const args = e.args.map((a) => this.expr(a));

    // 构造函数
    if (/^[ibu]?vec[234]$/.test(name)) return this.constructVector(name, args);
    if (/^mat[234]$/.test(name)) return this.constructMatrix(name, args);
    if (name === 'float') return this.convert(args[0], 'float');
    if (name === 'int') return this.convert(args[0], 'int');
    if (name === 'bool') return this.convert(args[0], 'bool');

    // 采样
    if (name === '$sample') return this.sample(args[0], args[1]);

    if (name === 'matrixCompMult') {
      throw new Error('SPIR-V：matrixCompMult() 不在本子集里（SPIR-V 没有逐分量矩阵乘指令）');
    }
    if (name === 'mul') {
      // `mul` 只在 HLSL 目标里出现；SPIR-V 目标下按矩阵乘法形状分派
      return this.multiply(args[0], args[1], e.type);
    }
    if (name === 'transpose') {
      return { id: this.ins('OpTranspose', this.typeId(e.type), args[0].id), type: e.type };
    }
    if (name === 'dot') {
      return { id: this.ins('OpDot', this.typeId('float'), args[0].id, args[1].id), type: 'float' };
    }
    if (name === 'dFdx' || name === 'dFdy' || name === 'fwidth') {
      const opName = { dFdx: 'OpDPdx', dFdy: 'OpDPdy', fwidth: 'OpFwidth' }[name];
      return { id: this.ins(opName, this.typeId(e.type), args[0].id), type: e.type };
    }
    if (name === '$mod' || name === 'mod') {
      const type = e.type;
      return { id: this.ins('OpFMod', this.typeId(type), this.coerce(args[0], type).id, this.coerce(args[1], type).id), type };
    }

    // GLSL.std.450
    const ext = this.extInst(name, args, e.type);
    if (ext) return ext;

    // 用户函数
    const fn = this.userFns.get(name);
    if (fn) {
      const coerced = args.map((a, i) => this.coerce(a, fn.paramTypes[i]));
      const id = this.ins('OpFunctionCall', this.typeId(fn.returnType), fn.id, ...coerced.map((a) => a.id));
      return { id, type: fn.returnType };
    }

    throw new Error(`SPIR-V：不认识的内建函数 ${name}()（本子集没覆盖）`);
  }

  /** `vecN(...)`：分量可以是标量也可以是向量，拼够 N 个就行。 */
  constructVector(type, args) {
    const total = args.reduce((s, a) => s + componentCount(a.type), 0);
    const width = componentCount(type);
    if (total === 1) {
      // `vec3(x)` 是广播
      return { id: this.ins('OpCompositeConstruct', this.typeId(type), ...Array(width).fill(args[0].id)), type };
    }
    if (total !== width) throw new Error(`SPIR-V：${type}(${args.map((a) => a.type).join(', ')}) 分量个数对不上`);
    return { id: this.ins('OpCompositeConstruct', this.typeId(type), ...args.map((a) => a.id)), type };
  }

  /** `matN(...)`：列主序，4 个标量就是两列。 */
  constructMatrix(type, args) {
    const width = componentCount(type);
    const columnType = `vec${width}`;
    let columns;
    if (args.length === width) {
      columns = args.map((a) => this.coerce(a, columnType));
    } else {
      const total = args.reduce((s, a) => s + componentCount(a.type), 0);
      if (total !== width * width) {
        throw new Error(`SPIR-V：${type}(${args.map((a) => a.type).join(', ')}) 分量个数对不上`);
      }
      // 摊平成标量，再两两组成列
      const flat = [];
      for (const a of args) {
        if (componentCount(a.type) === 1) flat.push(a);
        else {
          for (let i = 0; i < componentCount(a.type); i += 1) {
            const comp = scalarOf(a.type);
            flat.push({ id: this.ins('OpCompositeExtract', this.typeId(comp), a.id, i), type: comp });
          }
        }
      }
      columns = [];
      for (let c = 0; c < width; c += 1) {
        const comps = flat.slice(c * width, c * width + width).map((x) => x.id);
        columns.push({ id: this.ins('OpCompositeConstruct', this.typeId(columnType), ...comps), type: columnType });
      }
    }
    return { id: this.ins('OpCompositeConstruct', this.typeId(type), ...columns.map((c) => c.id)), type };
  }

  /** `mul(a, b)`（HLSL 的写法，SPIR-V 目标下按同一套形状分派）。 */
  /** 数值转换。 */
  convert(value, target) {
    if (value.type === target) return value;
    if (target === 'float' && scalarOf(value.type) === 'int') {
      return { id: this.ins('OpConvertSToF', this.typeId('float'), value.id), type: 'float' };
    }
    if (target === 'int' && scalarOf(value.type) === 'float') {
      return { id: this.ins('OpConvertFToS', this.typeId('int'), value.id), type: 'int' };
    }
    if (target === 'bool') return { id: value.id, type: value.type };
    return this.coerce(value, target);
  }

  /** `texture(sampler, uv)` → `OpImageSampleImplicitLod`。 */
  sample(samplerValue, uvValue) {
    const uv = uvValue.type === 'vec2' ? uvValue : this.coerce(uvValue, 'vec2');
    const id = this.ins('OpImageSampleImplicitLod', this.typeId('vec4'), samplerValue.id, uv.id);
    return { id, type: 'vec4' };
  }

  /** GLSL.std.450 扩展指令。 */
  extInst(name, args, resultType) {
    // `atan(y, x)` 在 GLSL.std.450 里叫 atan2
    const key = name === 'atan' && args.length === 2 ? 'atan2' : name;
    const num = GLSL_STD_450[key];
    if (num === undefined) return null;
    // `length` / `distance` 是「归约」函数：结果类型是 float，但参数还是原来的向量，
    // 所以不能像别的函数那样一律按结果类型广播。
    const reduce = key === 'length' || key === 'distance';
    const argType = reduce ? args[0].type : resultType;
    const coerced = args.map((a) => this.coerce(a, argType));
    const id = this.ins('OpExtInst', this.typeId(resultType), this.glslSetId, num, ...coerced.map((a) => a.id));
    return { id, type: resultType };
  }

  // ── 语句 ──

  /** 生成一条语句。 */
  stmt(s) {
    if (!s) return;
    // 上一条是 return / break / continue，后面的代码不可达 —— 跳过，
    // 这样每个块都能保证以终止指令收尾
    if (this.terminated) return;
    switch (s.k) {
      case 'block':
        this.pushScope();
        for (const item of s.body) this.stmt(item);
        this.popScope();
        break;
      case 'decl':
        this.stmtDecl(s);
        break;
      case 'expr':
        this.expr(s.e);
        break;
      case 'return':
        this.stmtReturn(s);
        break;
      case 'if':
        this.stmtIf(s);
        break;
      case 'for':
        this.stmtFor(s);
        break;
      case 'break': {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw new Error('SPIR-V：break 不在循环里');
        this.b.emit('OpBranch', loop.merge);
        this.terminated = true;
        break;
      }
      case 'continue': {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) throw new Error('SPIR-V：continue 不在循环里');
        this.b.emit('OpBranch', loop.continueTarget);
        this.terminated = true;
        break;
      }
      case 'discard':
        this.b.emit('OpKill');
        this.terminated = true;
        break;
      case 'empty':
        break;
      default:
        throw new Error(`SPIR-V：不认识的语句 ${s.k}`);
    }
  }

  /** `vec2 uv = ...;` → 一个 Function 存储类的变量 + `OpStore`。 */
  stmtDecl(s) {
    const ptr = this.ptrId('Function', s.type);
    const varId = this.b.id();
    // SPIR-V 要求 Function 存储类的变量全部落在函数第一个块的最前面
    this.pendingLocals.push({ name: 'OpVariable', operands: [ptr, varId, StorageClass.Function] });
    this.declareLocal(s.name, s.type, varId);
    if (s.init) {
      const value = this.coerce(this.expr(s.init), s.type);
      this.b.emit('OpStore', varId, value.id);
    }
  }

  /** `return;` / `return v;` */
  stmtReturn(s) {
    if (this.currentFn.isVoid) {
      this.b.emit('OpReturn');
    } else {
      const v = this.expr(s.e);
      this.b.emit('OpReturnValue', v.id);
    }
    this.terminated = true;
  }

  /** `if / else`。 */
  stmtIf(s) {
    const test = this.expr(s.test);
    const thenLabel = this.b.id();
    const elseLabel = s.alt ? this.b.id() : null;
    const mergeLabel = this.b.id();

    this.b.emit('OpSelectionMerge', mergeLabel, SelectionControl.None);
    this.b.emit('OpBranchConditional', test.id, thenLabel, elseLabel ?? mergeLabel);

    this.b.emit('OpLabel', thenLabel);
    this.terminated = false;
    this.stmt(s.cons);
    const thenEnds = this.terminated;
    if (!thenEnds) this.b.emit('OpBranch', mergeLabel);

    let elseEnds = true;
    if (s.alt) {
      this.b.emit('OpLabel', elseLabel);
      this.terminated = false;
      this.stmt(s.alt);
      elseEnds = this.terminated;
      if (!elseEnds) this.b.emit('OpBranch', mergeLabel);
    }

    if (thenEnds && elseEnds) {
      // 两边都终止了，没有分支会落到合并块 —— 不开它
      this.terminated = true;
      return;
    }
    this.b.emit('OpLabel', mergeLabel);
    this.terminated = false;
  }

  /** `for` 循环。 */
  stmtFor(s) {
    if (s.init) this.stmt(s.init);

    const headerLabel = this.b.id();
    const bodyLabel = this.b.id();
    const continueLabel = this.b.id();
    const mergeLabel = this.b.id();

    this.b.emit('OpBranch', headerLabel);

    this.b.emit('OpLabel', headerLabel);
    this.b.emit('OpLoopMerge', mergeLabel, continueLabel, LoopControl.None);
    if (s.test) {
      const test = this.expr(s.test);
      this.b.emit('OpBranchConditional', test.id, bodyLabel, mergeLabel);
    } else {
      this.b.emit('OpBranch', bodyLabel);
    }

    this.b.emit('OpLabel', bodyLabel);
    this.loopStack.push({ merge: mergeLabel, continueTarget: continueLabel });
    this.terminated = false;
    this.stmt(s.body);
    const bodyEnds = this.terminated;
    this.loopStack.pop();
    if (!bodyEnds) this.b.emit('OpBranch', continueLabel);

    this.b.emit('OpLabel', continueLabel);
    this.terminated = false;
    if (s.update) this.expr(s.update);
    this.b.emit('OpBranch', headerLabel);

    this.b.emit('OpLabel', mergeLabel);
    this.terminated = false;
  }

  // ── 函数 ──

  /** 生成一个用户函数（id / 函数类型已在 `run()` 里预登记）。 */
  genFunction(fn) {
    const info = this.userFns.get(fn.name);
    if (!info) throw new Error(`SPIR-V：函数 ${fn.name}() 没有预登记`);
    const fnId = info.id;
    const paramTypes = info.paramTypes;
    const returnType = info.returnType;

    this.b.at('function');
    this.b.emit('OpFunction', info.returnTypeId, fnId, FunctionControl.None, info.fnTypeId);

    const paramIds = [];
    for (let i = 0; i < paramTypes.length; i += 1) {
      const pid = this.b.id();
      this.b.emit('OpFunctionParameter', info.paramTypeIds[i], pid);
      paramIds.push(pid);
    }

    this.label();
    const mark = this.b.mark();

    this.currentFn = { name: fn.name, returnType, isVoid: returnType === 'void' };
    this.scopes = [new Map()];
    this.loopStack = [];
    this.terminated = false;
    this.pendingLocals = [];
    fn.params.forEach((p, i) => {
      this.scopes[0].set(p.name, { kind: 'value', id: paramIds[i], type: p.type });
    });
    this.stmt(fn.body);

    if (!this.terminated) {
      if (returnType === 'void') this.b.emit('OpReturn');
      else throw new Error(`SPIR-V：函数 ${fn.name}() 有返回值却没 return`);
    }
    this.b.emit('OpFunctionEnd');

    // 把局部变量补到入口块开头
    for (const local of this.pendingLocals) {
      this.b.insertAt(mark, local.name, ...local.operands);
    }
    this.pendingLocals = [];
  }

  // ── 模块 ──

  /** 走完整个流程，返回二进制。 */
  run() {
    const ast = this.ast;
    const b = this.b;

    // 1. 头部
    b.at('capability').emit('OpCapability', 1 /* Shader */);
    b.at('extinst');
    this.glslSetId = this.insBare('OpExtInstImport', 'GLSL.std.450');
    b.at('memorymodel').emit('OpMemoryModel', 0 /* Logical */, 0 /* GLSL450 */);

    // 2. 模块级声明（类型 / 常量 / 变量）—— 必须在函数之前
    b.at('global');
    this.typeId('void');
    this.typeId('float');
    this.typeId('int');
    this.buildUniformBlock();
    this.buildOutputs();
    this.buildFragCoord();
    this.buildSamplers();

    // 3. 预登记所有用户函数：先分配 id 和函数类型。
    //    辅助函数之间会互相调用（`st_fbm` → `st_noise` → `st_hash`），
    //    而生成顺序是按声明来的，不预登记的话后面的函数查不到。
    for (const fn of ast.functions ?? []) {
      if (fn.isEntry) continue;
      const paramTypes = fn.params.map((p) => p.type);
      const returnTypeId = this.typeId(fn.returnType);
      const paramTypeIds = paramTypes.map((t) => this.typeId(t));
      const key = `${fn.returnType}(${paramTypes.join(',')})`;
      let fnTypeId = this.fnTypeIds.get(key);
      if (!fnTypeId) {
        fnTypeId = this._section('global', () => this.insBare('OpTypeFunction', returnTypeId, ...paramTypeIds));
        this.fnTypeIds.set(key, fnTypeId);
      }
      this.userFns.set(fn.name, {
        id: this.b.id(), returnType: fn.returnType, paramTypes, fnTypeId, returnTypeId, paramTypeIds,
      });
    }

    // 4. 入口点。`OpEntryPoint` 必须排在函数之前，所以先把入口函数的 id 留出来。
    b.at('entrypoint');
    const interfaces = [
      ...[...this.outputs.values()].map((o) => o.varId),
      ...(this.fragCoordVarId ? [this.fragCoordVarId] : []),
    ];
    const entryFn = (ast.functions ?? []).find((f) => f.isEntry);
    if (!entryFn) throw new Error('SPIR-V：AST 里没有入口函数');

    this.entryFnId = b.id();
    b.emit('OpEntryPoint', ExecutionModel.Fragment, this.entryFnId, ENTRY_NAME, ...interfaces);
    b.emit('OpExecutionMode', this.entryFnId, ExecutionMode.OriginLowerLeft);
    b.emit('OpSource', SourceLanguage.ESSL, 310);

    // 5. 函数体
    b.at('function');
    for (const fn of ast.functions ?? []) {
      if (fn.isEntry) continue;
      this.genFunction(fn);
    }
    this.genEntryFunction(entryFn, this.entryFnId);

    return encodeModule(b);
  }

  /** 生成入口函数（`void main()`，无参数）。 */
  genEntryFunction(fn, fnId) {
    const b = this.b;
    const voidType = this.typeId('void');
    const fnTypeKey = 'void()';
    let fnTypeId = this.fnTypeIds.get(fnTypeKey);
    if (!fnTypeId) {
      fnTypeId = this._section('global', () => this.insBare('OpTypeFunction', voidType));
      this.fnTypeIds.set(fnTypeKey, fnTypeId);
    }

    b.at('function');
    b.emit('OpFunction', voidType, fnId, FunctionControl.None, fnTypeId);
    this.label();
    const mark = b.mark();

    this.currentFn = { name: fn.name, returnType: 'void', isVoid: true };
    this.scopes = [new Map()];
    this.loopStack = [];
    this.terminated = false;
    this.pendingLocals = [];

    this.stmt(fn.body);

    if (!this.terminated) b.emit('OpReturn');
    b.emit('OpFunctionEnd');

    for (const local of this.pendingLocals) {
      b.insertAt(mark, local.name, ...local.operands);
    }
    this.pendingLocals = [];
  }

  /** uniform 收进一个 std140 结构体。 */
  buildUniformBlock() {
    const uniforms = this.ast.uniforms ?? [];
    if (!uniforms.length) return;
    const b = this.b;
    b.at('global');

    let offset = 0;
    const memberTypes = [];
    uniforms.forEach((u, index) => {
      const { align, size } = std140(u.type);
      offset = alignUp(offset, align);
      this.uniformSlots.set(u.name, { index, type: u.type, offset });
      memberTypes.push(this.typeId(u.type));
      offset += size;
    });
    offset = alignUp(offset, 16);

    const structId = this.insBare('OpTypeStruct', ...memberTypes);
    this.uniformStructId = structId;
    const ptrId = this.insBare('OpTypePointer', StorageClass.Uniform, structId);
    const varId = this.ins('OpVariable', ptrId, StorageClass.Uniform);
    this.uniformVarId = varId;

    b.at('annotation');
    b.emit('OpDecorate', structId, Decoration.Block);
    uniforms.forEach((u, index) => {
      b.emit('OpMemberDecorate', structId, index, Decoration.Offset, this.uniformSlots.get(u.name).offset);
    });
    b.emit('OpDecorate', varId, Decoration.DescriptorSet, 0);
    b.emit('OpDecorate', varId, Decoration.Binding, 0);
    b.emit('OpName', varId, 'Uniforms');

    b.at('debug');
    uniforms.forEach((u) => b.emit('OpMemberName', structId, this.uniformSlots.get(u.name).index, u.name));
  }

  /** 出口变量（`out vec4 st_fragColor`）。 */
  buildOutputs() {
    const outputs = this.ast.outputs ?? [];
    if (!outputs.length) return;
    const b = this.b;
    b.at('global');
    outputs.forEach((o, index) => {
      const ptr = this.ptrId('Output', o.type);
      const varId = this.ins('OpVariable', ptr, StorageClass.Output);
      this.outputs.set(o.name, { varId, type: o.type });
      b.at('annotation').emit('OpDecorate', varId, Decoration.Location, index);
      b.at('debug').emit('OpName', varId, o.name);
      b.at('global');
    });
  }

  /** `gl_FragCoord`（Input + BuiltIn FragCoord）。 */
  buildFragCoord() {
    if (!this.ast.usesFragCoord) return;
    const b = this.b;
    b.at('global');
    const ptr = this.ptrId('Input', 'vec4');
    const varId = this.ins('OpVariable', ptr, StorageClass.Input);
    this.fragCoordVarId = varId;
    b.at('annotation').emit('OpDecorate', varId, Decoration.BuiltIn, BuiltIn.FragCoord);
    b.at('debug').emit('OpName', varId, FRAG_COORD_VAR);
  }

  /** `sampler2D` 变量（UniformConstant + DescriptorSet/Binding）。 */
  buildSamplers() {
    const samplers = this.ast.samplers ?? [];
    if (!samplers.length) return;
    const b = this.b;
    samplers.forEach((s, index) => {
      b.at('global');
      const type = this.typeId(s.type);
      const ptr = this.ptrId('UniformConstant', s.type);
      const varId = this.ins('OpVariable', ptr, StorageClass.UniformConstant);
      this.samplers.set(s.name, { varId, type: s.type });
      b.at('annotation').emit('OpDecorate', varId, Decoration.DescriptorSet, 0);
      b.at('annotation').emit('OpDecorate', varId, Decoration.Binding, index + 1);
      b.at('debug').emit('OpName', varId, s.name);
    });
  }
}

/**
 * 把 SPIR-V 语义的目标 AST 编成 `.spv` 二进制。
 *
 * @param {object} ast `transformToTarget(program, 'spirv')` 的产物
 * @param {object} [opts]
 * @returns {{code:Uint8Array, warnings:string[]}}
 */
export function spirvFromAst(ast, opts = {}) {
  const gen = new SpirvGen(ast, opts);
  const code = gen.run();
  return { code, warnings: gen.warnings };
}

/**
 * 生成 `.spvasm` 文本（人类可读的反汇编）。
 *
 * 复用同一份生成器，所以和 `.spv` 一定是一致的。
 *
 * @param {object} ast
 * @param {object} [opts]
 * @returns {{code:string, warnings:string[]}}
 */
export function spirvAssemblyFromAst(ast, opts = {}) {
  const { code, warnings } = spirvFromAst(ast, opts);
  const result = disassembleSpirv(code);
  if (result.errors.length) {
    throw new Error(`SPIR-V 自检失败：${result.errors.slice(0, 3).join('；')}`);
  }
  const header = [
    `; 由 DSH Shader 工作台生成`,
    opts.source ? `; 来源：${opts.source}` : null,
    ';',
    '; 这是自研生成器产出的 SPIR-V 汇编。本机没有 spirv-val，',
    '; 所以只做过结构自洽校验（见 shared/spirv.js）。',
    '',
  ].filter((l) => l !== null).join('\n');
  return { code: header + result.assembly, warnings };
}
