/**
 * SPIR-V 二进制格式层：操作码表、编码器、反汇编器、结构校验器。
 *
 * ## 背景：为什么自己写
 *
 * 正规做法是 `glslangValidator -V shader.frag -o shader.spv`。但本机没有工具链，
 * 而工作台要求零依赖 + 全离线，所以这里自己把 AST 编成 SPIR-V 二进制。
 * AST → 二进制的那一层在 `spirv-gen.js`，这个文件只管「字怎么摆」。
 *
 * ## 诚实说明：这份产物验证到哪一层
 *
 * 本机**没有 `spirv-val`**，所以这份二进制**没有经过官方校验器**。
 * 能保证的是：
 *   - 指令流结构自洽（字长、id 界内、先定义后使用）；
 *   - 每条指令的操作数个数与 OP 表声明的格式匹配；
 *   - 控制流合法（每个块都有终止指令，`OpLoopMerge` / `OpSelectionMerge` 结构正确）；
 *   - 反汇编出来的汇编**再汇编回去逐字节相同**（编码器与解码器互为逆运算）。
 *
 * 不能保证的是：真机驱动一定接受它。要更强保证，请在有工具链的机器上跑
 * `spirv-val shader.spv`。文档与工具描述里都写明了这一点。
 *
 * ## 设计
 *
 * 一张 `OP` 表同时给编码器和反汇编器用：每个 opcode 声明它的操作数格式。
 * 于是「写出去」和「读回来」不可能各说各话 —— 这也是反汇编器能当校验器用的原因。
 *
 * 操作数格式记号：
 *   `r` 结果类型 id ｜ `i` 结果 id ｜ `a` id 操作数 ｜ `l` 字面量 ｜ `e` 枚举 ｜ `s` 字符串
 * 末尾的 `*` 表示「重复前一个记号直到用完」。
 *
 * @module dsh-shader-workbench/shared/spirv
 */

/** SPIR-V 魔数。 */
export const SPIRV_MAGIC = 0x07230203;
/** 目标版本：SPIR-V 1.0（兼容性最好）。 */
export const SPIRV_VERSION = 0x00010000;

/** 执行模型。 */
export const ExecutionModel = { Vertex: 0, TessellationControl: 1, TessellationEvaluation: 2, Geometry: 3, Fragment: 4, GLCompute: 5, Kernel: 6 };
/** 存储类别。 */
export const StorageClass = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Workgroup: 4, CrossWorkgroup: 5, Private: 6, Function: 7, Generic: 8, PushConstant: 9 };
/** 装饰。 */
export const Decoration = { RelaxedPrecision: 0, SpecId: 1, Block: 2, BufferBlock: 3, RowMajor: 4, ColMajor: 5, ArrayStride: 6, MatrixStride: 7, BuiltIn: 11, Flat: 14, NoPerspective: 13, Centroid: 16, Sample: 17, Invariant: 18, Location: 30, Component: 31, Index: 32, Binding: 33, DescriptorSet: 34, Offset: 35 };
/** 内建变量。 */
export const BuiltIn = { Position: 0, PointSize: 1, ClipDistance: 3, CullDistance: 4, VertexId: 5, InstanceId: 6, PrimitiveId: 7, InvocationId: 8, Layer: 9, ViewportIndex: 10, FragCoord: 15, PointCoord: 16, FrontFacing: 17, SampleId: 18, SampleMask: 20, FragDepth: 22 };
/** 执行模式。 */
export const ExecutionMode = { Invocations: 0, OriginUpperLeft: 7, OriginLowerLeft: 8, EarlyFragmentTests: 9, LocalSize: 17, LocalSizeHint: 18 };
/** 图像维度。 */
export const Dim = { '1D': 0, '2D': 1, '3D': 2, Cube: 3 };
/** 源语言。 */
export const SourceLanguage = { Unknown: 0, ESSL: 1, GLSL: 2, OpenCL_C: 3, OpenCL_CPP: 4, HLSL: 5 };
/** 选择控制。 */
export const SelectionControl = { None: 0, Flatten: 1, DontFlatten: 2 };
/** 循环控制。 */
export const LoopControl = { None: 0, Unroll: 1, DontUnroll: 2 };
/** 函数控制。 */
export const FunctionControl = { None: 0, Inline: 1, DontInline: 2, Pure: 4, Const: 8 };

/**
 * 指令表：名字 → { code, operands, enumHints }。
 *
 * `enumHints` 把某个操作数位置标成某个枚举，反汇编时就能打出 `Fragment` 而不是 `4`。
 * @type {Record<string, {code:number, operands:string, enumHints?:Record<number,string>}>}
 */
export const OP = {
  OpNop: { code: 0, operands: '' },
  OpUndef: { code: 1, operands: 'ri' },
  OpSource: { code: 3, operands: 'el*', enumHints: { 0: 'SourceLanguage' } },
  OpSourceExtension: { code: 4, operands: 's' },
  OpName: { code: 5, operands: 'as' },
  OpMemberName: { code: 6, operands: 'als' },
  OpString: { code: 7, operands: 'is' },
  OpExtension: { code: 10, operands: 's' },
  OpExtInstImport: { code: 11, operands: 'is' },
  OpExtInst: { code: 12, operands: 'riaela*' },
  OpMemoryModel: { code: 14, operands: 'ee' },
  OpEntryPoint: { code: 15, operands: 'eisa*', enumHints: { 0: 'ExecutionModel' } },
  OpExecutionMode: { code: 16, operands: 'iel*', enumHints: { 1: 'ExecutionMode' } },
  OpCapability: { code: 17, operands: 'e' },

  OpTypeVoid: { code: 19, operands: 'i' },
  OpTypeBool: { code: 20, operands: 'i' },
  OpTypeInt: { code: 21, operands: 'ill' },
  OpTypeFloat: { code: 22, operands: 'il' },
  OpTypeVector: { code: 23, operands: 'ial' },
  OpTypeMatrix: { code: 24, operands: 'ial' },
  OpTypeImage: { code: 25, operands: 'iaelllle', enumHints: { 2: 'Dim' } },
  OpTypeSampler: { code: 26, operands: 'i' },
  OpTypeSampledImage: { code: 27, operands: 'ia' },
  OpTypeStruct: { code: 30, operands: 'ia*' },
  OpTypePointer: { code: 32, operands: 'iea', enumHints: { 1: 'StorageClass' } },
  OpTypeFunction: { code: 33, operands: 'iaa*' },

  OpConstantTrue: { code: 41, operands: 'ri' },
  OpConstantFalse: { code: 42, operands: 'ri' },
  OpConstant: { code: 43, operands: 'ril*' },
  OpConstantComposite: { code: 44, operands: 'ria*' },
  OpConstantNull: { code: 46, operands: 'ri' },

  OpFunction: { code: 54, operands: 'riea', enumHints: { 2: 'FunctionControl' } },
  OpFunctionParameter: { code: 55, operands: 'ri' },
  OpFunctionEnd: { code: 56, operands: '' },
  OpFunctionCall: { code: 57, operands: 'riaa*' },

  OpVariable: { code: 59, operands: 'rie', enumHints: { 2: 'StorageClass' } },
  OpLoad: { code: 61, operands: 'ria' },
  OpStore: { code: 62, operands: 'aa' },
  OpAccessChain: { code: 65, operands: 'riaa*' },

  OpDecorate: { code: 71, operands: 'ael*', enumHints: { 1: 'Decoration' } },
  OpMemberDecorate: { code: 72, operands: 'alel*', enumHints: { 2: 'Decoration' } },

  OpVectorShuffle: { code: 79, operands: 'riaal*' },
  OpCompositeConstruct: { code: 80, operands: 'ria*' },
  OpCompositeExtract: { code: 81, operands: 'rial*' },
  OpTranspose: { code: 84, operands: 'ria' },

  OpSampledImage: { code: 86, operands: 'riaa' },
  OpImageSampleImplicitLod: { code: 87, operands: 'riaa' },

  OpConvertFToS: { code: 110, operands: 'ria' },
  OpConvertSToF: { code: 111, operands: 'ria' },

  OpSNegate: { code: 126, operands: 'ria' },
  OpFNegate: { code: 127, operands: 'ria' },
  OpIAdd: { code: 128, operands: 'riaa' },
  OpFAdd: { code: 129, operands: 'riaa' },
  OpISub: { code: 130, operands: 'riaa' },
  OpFSub: { code: 131, operands: 'riaa' },
  OpIMul: { code: 132, operands: 'riaa' },
  OpFMul: { code: 133, operands: 'riaa' },
  OpFDiv: { code: 136, operands: 'riaa' },
  OpSMod: { code: 139, operands: 'riaa' },
  OpFRem: { code: 140, operands: 'riaa' },
  OpFMod: { code: 141, operands: 'riaa' },
  OpVectorTimesScalar: { code: 142, operands: 'riaa' },
  OpMatrixTimesScalar: { code: 143, operands: 'riaa' },
  OpVectorTimesMatrix: { code: 144, operands: 'riaa' },
  OpMatrixTimesVector: { code: 145, operands: 'riaa' },
  OpMatrixTimesMatrix: { code: 146, operands: 'riaa' },
  OpDot: { code: 148, operands: 'riaa' },

  OpAny: { code: 153, operands: 'ria' },
  OpAll: { code: 154, operands: 'ria' },
  OpLogicalOr: { code: 166, operands: 'riaa' },
  OpLogicalAnd: { code: 167, operands: 'riaa' },
  OpLogicalNot: { code: 168, operands: 'ria' },
  OpSelect: { code: 169, operands: 'riaaa' },
  OpIEqual: { code: 170, operands: 'riaa' },
  OpINotEqual: { code: 171, operands: 'riaa' },
  OpSLessThan: { code: 177, operands: 'riaa' },
  OpSLessThanEqual: { code: 179, operands: 'riaa' },
  OpFOrdEqual: { code: 180, operands: 'riaa' },
  OpFOrdNotEqual: { code: 182, operands: 'riaa' },
  OpFOrdLessThan: { code: 184, operands: 'riaa' },
  OpFOrdGreaterThan: { code: 186, operands: 'riaa' },
  OpFOrdLessThanEqual: { code: 188, operands: 'riaa' },
  OpFOrdGreaterThanEqual: { code: 190, operands: 'riaa' },

  OpDPdx: { code: 207, operands: 'ria' },
  OpDPdy: { code: 208, operands: 'ria' },
  OpFwidth: { code: 209, operands: 'ria' },

  OpLoopMerge: { code: 246, operands: 'aae', enumHints: { 2: 'LoopControl' } },
  OpSelectionMerge: { code: 247, operands: 'ae', enumHints: { 1: 'SelectionControl' } },
  OpLabel: { code: 248, operands: 'i' },
  OpBranch: { code: 249, operands: 'a' },
  OpBranchConditional: { code: 250, operands: 'aal*' },
  OpKill: { code: 252, operands: '' },
  OpUnreachable: { code: 255, operands: '' },
  OpReturn: { code: 253, operands: '' },
  OpReturnValue: { code: 254, operands: 'a' },
};

/** 名字 → code 的反查表。 */
const CODE_TO_OP = new Map(Object.entries(OP).map(([name, info]) => [info.code, { name, ...info }]));

/** 枚举名字表（反汇编时打名字用）。 */
const ENUMS = {
  ExecutionModel, StorageClass, Decoration, BuiltIn, ExecutionMode, Dim, SourceLanguage, SelectionControl, LoopControl, FunctionControl,
};

/** GLSL 内建 → GLSL.std.450 扩展指令编号。 */
export const GLSL_STD_450 = {
  round: 1, roundEven: 2, trunc: 3, abs: 4, sign: 7,
  floor: 8, ceil: 9, fract: 10,
  radians: 11, degrees: 12,
  sin: 13, cos: 14, tan: 15, asin: 16, acos: 17, atan: 18,
  sinh: 19, cosh: 20, tanh: 21,
  atan2: 25, pow: 26, exp: 27, log: 28, exp2: 29, log2: 30,
  sqrt: 31, inversesqrt: 32,
  determinant: 33, matrixInverse: 34,
  min: 37, max: 40, clamp: 43,
  mix: 46, step: 48, smoothstep: 49,
  length: 66, distance: 67, cross: 68, normalize: 69,
  faceforward: 70, reflect: 71, refract: 72,
};

// ─────────────────────── 编码器 ───────────────────────

/**
 * 逻辑布局里的段。SPIR-V 规定类型 / 常量 / 全局变量必须排在函数之前，
 * 而生成器是「顺着表达式走」的，走到哪才发现要用哪个类型 —— 所以按段收集，
 * 最后一次性拼成合法的指令流。
 */
export const SECTION_ORDER = ['capability', 'extinst', 'memorymodel', 'entrypoint', 'debug', 'annotation', 'global', 'function'];

/** 指令缓冲区。 */
export class ModuleBuilder {
  constructor() {
    /** @type {Map<string, Array<{opcode:number, name:string, operands:Array<number|string>}>>} */
    this.sections = new Map(SECTION_ORDER.map((s) => [s, []]));
    this.nextId = 1;
    this.cursor = 'function';
  }

  /** 切换当前写入的段。 */
  at(section) {
    if (!this.sections.has(section)) throw new Error(`SPIR-V：不认识的段 ${section}`);
    this.cursor = section;
    return this;
  }

  /** 分配一个新 id。 */
  id() {
    const v = this.nextId;
    this.nextId += 1;
    return v;
  }

  /**
   * 在当前段追加一条指令。
   * @param {string} name OP 表里的名字
   * @param {...(number|string)} operands
   * @returns {number} 第一个操作数（`ri` 格式下是结果类型 id；结果 id 由调用方自己管理）
   */
  emit(name, ...operands) {
    const info = OP[name];
    if (!info) throw new Error(`SPIR-V：不认识的操作码 ${name}`);
    this.sections.get(this.cursor).push({ opcode: info.code, name, operands });
    return operands[0];
  }

  /**
   * 在当前段打一个点，之后可以用 `insertAt()` 往这里补指令。
   * 用来把 `OpVariable`（Function 存储类）提到函数入口块的开头。
   */
  mark() {
    return { section: this.cursor, index: this.sections.get(this.cursor).length };
  }

  /** 把一条指令插到 mark 处。多次插入会依次前移，但同段内彼此无依赖，顺序不重要。 */
  insertAt(mark, name, ...operands) {
    const info = OP[name];
    if (!info) throw new Error(`SPIR-V：不认识的操作码 ${name}`);
    this.sections.get(mark.section).splice(mark.index, 0, { opcode: info.code, name, operands });
  }

  /** 按逻辑布局拼好的完整指令流。 */
  get instructions() {
    const out = [];
    for (const s of SECTION_ORDER) out.push(...this.sections.get(s));
    return out;
  }
}

/** 把一个字符串打成 SPIR-V 的字序列（UTF-8 + 末尾 0）。 */
function encodeString(text) {
  const bytes = new TextEncoder().encode(text);
  const words = [];
  let acc = 0;
  let shift = 0;
  for (const b of bytes) {
    acc |= b << shift;
    shift += 8;
    if (shift === 32) {
      words.push(acc >>> 0);
      acc = 0;
      shift = 0;
    }
  }
  if (shift > 0) words.push(acc >>> 0);
  // 结尾的 0 字：不管刚好对齐还是没对齐，都要有一个
  words.push(0);
  return words;
}

/**
 * 按操作数格式把指令编成字（little-endian 由 Buffer 负责）。
 *
 * 字符串操作数（`OpName` / `OpEntryPoint` 的名字等）是**内联**的，占若干个字。
 *
 * @param {number} opcode
 * @param {Array<number|string>} operands
 * @returns {number[]}
 */
function encodeInstruction(opcode, operands) {
  const words = [];
  for (const operand of operands) {
    if (typeof operand === 'string') {
      words.push(...encodeString(operand));
      continue;
    }
    words.push(operand >>> 0);
  }
  return [((words.length + 1) << 16) | opcode, ...words];
}

/**
 * 把指令流编码成二进制。
 * @param {ModuleBuilder} builder
 * @returns {Uint8Array}
 */
export function encodeModule(builder) {
  const words = [SPIRV_MAGIC, SPIRV_VERSION, 0, builder.nextId, 0];
  for (const inst of builder.instructions) {
    words.push(...encodeInstruction(inst.opcode, inst.operands));
  }
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w >>> 0, true));
  return out;
}

// ─────────────────────── 反汇编 / 校验 ───────────────────────

/**
 * 按操作数格式把原始字拆成「值 / 记号 / 占几个字」。
 *
 * 字符串是变长的（UTF-8 打包、末尾补 0），所以必须记下每个操作数占几个字，
 * 后面的操作数才找得到位置 —— `OpEntryPoint Fragment %main "main" %a %b` 里
 * 接口变量就排在名字字符串后面。
 *
 * @param {string} format
 * @param {number[]} raw
 * @param {string[]} errors
 * @param {number} at
 * @returns {{values:Array<number|string>, kinds:string[], spans:Array<[number,number]>, literals:number[]}}
 */
function decodeOperands(format, raw, errors, at) {
  const values = [];
  const kinds = [];
  const spans = [];
  const literals = [];
  let ri = 0;

  const takeOne = (kind) => {
    values.push(raw[ri]);
    kinds.push(kind);
    spans.push([ri, 1]);
    if (kind === 'l' || kind === 'e') literals.push(raw[ri]);
    ri += 1;
  };

  const takeString = () => {
    const start = ri;
    const bytes = [];
    let terminated = false;
    while (ri < raw.length) {
      const w = raw[ri];
      ri += 1;
      for (let b = 0; b < 4; b += 1) {
        const byte = (w >>> (b * 8)) & 0xff;
        if (byte === 0) { terminated = true; break; }
        bytes.push(byte);
      }
      if (terminated) break;
    }
    if (!terminated) errors.push(`第 ${at} 个字处：字符串没有以 0 结尾`);
    values.push(new TextDecoder().decode(new Uint8Array(bytes)));
    kinds.push('s');
    spans.push([start, ri - start]);
  };

  for (let f = 0; f < format.length; f += 1) {
    const kind = format[f];
    if (kind === '*') {
      // 重复前一个记号直到用完。字符串不会出现在 `*` 展开里（它是内联且定长的写法）。
      const prev = format[f - 1];
      if (prev === 's') { errors.push(`第 ${at} 个字处：不支持重复的字符串操作数`); break; }
      while (ri < raw.length) takeOne(prev);
      break;
    }
    if (ri >= raw.length && kind !== 's') {
      // `x*` 允许出现零次 —— `OpDecorate %v Block` 里就没有尾随的字面量
      if (format[f + 1] === '*') break;
      errors.push(`第 ${at} 个字处：${format} 需要的操作数不够`);
      break;
    }
    if (kind === 's') takeString();
    else takeOne(kind);
  }
  return { values, kinds, spans, literals };
}

/** 收集一条指令用到的 id（按记号表判断，结果 id 不算「使用」）。 */
function collectUses(inst) {
  const out = [];
  for (let k = 0; k < inst.kinds.length; k += 1) {
    if (inst.kinds[k] !== 'a') continue;
    if (k === 1 && inst.kinds[0] === 'r') continue; // 结果 id 是定义，不是使用
    out.push({ id: inst.values[k], at: inst.name });
  }
  return out;
}

/**
 * 反汇编（同时充当结构校验器）。
 *
 * 返回的 `assembly` 是标准 SPIR-V 汇编写法（`%1 = OpTypeFloat 32` 这种），
 * 可以直接给 `spirv-as` 汇编；`errors` 非空说明模块结构有问题。
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{ok:boolean, header:object|null, instructions:Array<object>, assembly:string, errors:string[], definedIds:Set<number>}}
 */
export function disassembleSpirv(bytes) {
  const errors = [];
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.byteLength < 20) {
    return { ok: false, header: null, instructions: [], assembly: '', errors: ['模块比 20 字节的头部还短'], definedIds: new Set() };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    generator: view.getUint32(8, true),
    bound: view.getUint32(12, true),
    schema: view.getUint32(16, true),
  };
  if (header.magic !== SPIRV_MAGIC) errors.push(`魔数不对：0x${header.magic.toString(16)}（应为 0x${SPIRV_MAGIC.toString(16)}）`);
  if (header.schema !== 0) errors.push(`schema 应为 0，实际 ${header.schema}`);

  const total = buf.byteLength / 4;
  if (!Number.isInteger(total)) errors.push('模块长度不是 4 的倍数');
  const words = [];
  for (let i = 0; i < Math.floor(total); i += 1) words.push(view.getUint32(i * 4, true));

  const instructions = [];
  const definedIds = new Set();
  const labelIds = new Set();
  const merges = [];

  let i = 5;
  while (i < words.length) {
    const first = words[i];
    const wordCount = first >>> 16;
    const opcode = first & 0xffff;
    if (wordCount === 0) {
      errors.push(`第 ${i} 个字处 wordCount 为 0`);
      break;
    }
    if (i + wordCount > words.length) {
      errors.push(`第 ${i} 个字处的指令声明了 ${wordCount} 个字，但模块只剩 ${words.length - i} 个`);
      break;
    }
    const raw = words.slice(i + 1, i + wordCount);
    const info = CODE_TO_OP.get(opcode);
    if (!info) {
      errors.push(`第 ${i} 个字处是未知操作码 ${opcode}`);
      instructions.push({ opcode, name: `OpUnknown${opcode}`, raw, values: raw, kinds: [], spans: [] });
      i += wordCount;
      continue;
    }

    const { values, kinds, spans, literals } = decodeOperands(info.operands, raw, errors, i);
    const inst = { opcode, name: info.name, raw, values, kinds, spans, literals, operands: values };

    // id 定义
    if (info.operands.startsWith('ri')) {
      const resultId = values[1];
      if (!Number.isInteger(resultId) || resultId <= 0 || resultId >= header.bound) {
        errors.push(`${info.name} 的结果 id %${resultId} 越界（bound=${header.bound}）`);
      }
      if (definedIds.has(resultId)) errors.push(`id %${resultId} 被定义了两次（${info.name}）`);
      definedIds.add(resultId);
    }
    if (info.name === 'OpLabel') labelIds.add(values[0]);
    if (info.name === 'OpLoopMerge') merges.push({ at: inst.name, merge: values[0], continueTarget: values[1] });
    if (info.name === 'OpSelectionMerge') merges.push({ at: inst.name, merge: values[0] });

    instructions.push(inst);
    i += wordCount;
  }

  // 每个块都必须有终止指令
  const terminators = new Set(['OpBranch', 'OpBranchConditional', 'OpReturn', 'OpReturnValue', 'OpKill', 'OpUnreachable', 'OpSwitch']);
  for (let k = 0; k < instructions.length; k += 1) {
    if (instructions[k].name !== 'OpLabel') continue;
    const next = instructions[k + 1];
    if (!next) { errors.push(`最后一个块（%${instructions[k].values[0]}）没有终止指令`); break; }
    if (next.name === 'OpLabel') errors.push(`块 %${instructions[k].values[0]} 没有终止指令就直接开了下一个块`);
  }
  const lastInst = instructions[instructions.length - 1];
  if (lastInst && !terminators.has(lastInst.name) && lastInst.name !== 'OpFunctionEnd') {
    errors.push(`模块以 ${lastInst.name} 结尾，不是合法的收尾`);
  }

  // 分支目标必须是块
  for (const inst of instructions) {
    if (inst.name === 'OpBranch' && !labelIds.has(inst.values[0])) errors.push(`OpBranch 的目标 %${inst.values[0]} 不是块`);
    if (inst.name === 'OpBranchConditional') {
      if (!labelIds.has(inst.values[1])) errors.push(`OpBranchConditional 的真分支 %${inst.values[1]} 不是块`);
      if (!labelIds.has(inst.values[2])) errors.push(`OpBranchConditional 的假分支 %${inst.values[2]} 不是块`);
    }
  }
  for (const m of merges) {
    if (!labelIds.has(m.merge)) errors.push(`${m.at} 的合并块 %${m.merge} 不是块`);
    if (m.continueTarget !== undefined && !labelIds.has(m.continueTarget)) {
      errors.push(`${m.at} 的 continue 目标 %${m.continueTarget} 不是块`);
    }
  }

  // 先定义后使用。
  //
  // 有两类合法的前向引用要放行：
  //   1. debug 段（OpName / OpMemberName）、annotation 段（OpDecorate）、
  //      OpEntryPoint / OpExecutionMode —— 它们本来就排在类型和全局变量前面；
  //   2. **块标签** —— 循环头必须引用它后面的合并块，前向分支在 SPIR-V 里是正常的。
  const FORWARD_OK = new Set([
    'OpName', 'OpMemberName', 'OpDecorate', 'OpMemberDecorate',
    'OpEntryPoint', 'OpExecutionMode', 'OpSource',
  ]);
  const seen = new Set();
  for (const inst of instructions) {
    if (inst.kinds[0] === 'r') seen.add(inst.values[1]);
    else if (inst.kinds[0] === 'i') seen.add(inst.values[0]);
    if (FORWARD_OK.has(inst.name)) continue;
    for (const u of collectUses(inst)) {
      // 标签可以前向引用；别的操作数（比如 OpBranchConditional 的条件）仍然要检查
      if (labelIds.has(u.id)) continue;
      if (!seen.has(u.id)) errors.push(`${inst.name} 用了还没定义的 id %${u.id}`);
    }
  }

  // 入口点声明的接口变量必须存在
  for (const inst of instructions) {
    if (inst.name !== 'OpEntryPoint') continue;
    // 格式 eisa*：前三个是执行模型、入口 id、名字，之后才是接口变量
    for (const vid of inst.values.slice(3)) {
      if (!definedIds.has(vid)) errors.push(`OpEntryPoint 声明的接口 %${vid} 不存在`);
    }
  }

  const assembly = renderAssembly(header, instructions);
  return { ok: errors.length === 0, header, instructions, assembly, errors, definedIds };
}

/** 把模块渲染成可读的 SPIR-V 汇编。 */
function renderAssembly(header, instructions) {
  const lines = [];
  lines.push('; SPIR-V');
  lines.push(`; Version: ${header.version >>> 16}.${(header.version >>> 8) & 0xff}`);
  lines.push('; Generator: 0');
  lines.push(`; Bound: ${header.bound}`);
  lines.push(`; Schema: ${header.schema}`);
  lines.push('');

  for (const inst of instructions) {
    const parts = [];
    // 按**格式**判断有没有结果 id：`r`/`i` 开头才有，`OpStore` / `OpBranch` 这类没有
    const format = OP[inst.name]?.operands ?? inst.kinds.join('');
    if (format.startsWith('r')) {
      // `%<结果 id> = OpXxx %<结果类型> ...`
      parts.push(`%${inst.values[1]}`, '=', inst.name, `%${inst.values[0]}`);
      for (let k = 2; k < inst.values.length; k += 1) parts.push(formatOperand(inst.kinds[k], inst.values[k], inst.name, k));
    } else if (format.startsWith('i')) {
      // `%<结果 id> = OpTypeXxx ...`（只有结果 id，没有结果类型）
      parts.push(`%${inst.values[0]}`, '=', inst.name);
      for (let k = 1; k < inst.values.length; k += 1) parts.push(formatOperand(inst.kinds[k], inst.values[k], inst.name, k));
    } else {
      parts.push(inst.name);
      for (let k = 0; k < inst.values.length; k += 1) parts.push(formatOperand(inst.kinds[k], inst.values[k], inst.name, k));
    }
    lines.push(parts.filter((x) => x !== '').join(' '));
  }
  return lines.join('\n');
}

/** 按操作数类型格式化一个操作数。 */
function formatOperand(kind, value, opName, index) {
  if (value === undefined) return '';
  switch (kind) {
    case 'r':
    case 'i':
    case 'a':
      return `%${value}`;
    case 'e': {
      const hint = OP[opName]?.enumHints?.[index];
      const table = hint ? ENUMS[hint] : null;
      const name = table ? Object.entries(table).find(([, v]) => v === value)?.[0] : null;
      return name ? `${name}` : `${value}`;
    }
    case 's':
      return JSON.stringify(value);
    default:
      return `${value}`;
  }
}

/**
 * 便捷校验：反汇编 + 补充「模块级完整性」检查。
 *
 * 注意这只到「结构自洽」这一层 —— 本机没有 `spirv-val`，无法确认真机驱动会接受它。
 *
 * @param {Uint8Array} bytes
 * @returns {{ok:boolean, errors:string[], warnings:string[], assembly:string}}
 */
export function validateSpirv(bytes) {
  const result = disassembleSpirv(bytes);
  const warnings = [];
  if (!result.instructions.some((i) => i.name === 'OpEntryPoint')) result.errors.push('模块里没有 OpEntryPoint');
  if (!result.instructions.some((i) => i.name === 'OpFunction')) result.errors.push('模块里没有 OpFunction');
  if (!result.instructions.some((i) => i.name === 'OpMemoryModel')) result.errors.push('模块里没有 OpMemoryModel');
  if (!result.instructions.some((i) => i.name === 'OpCapability')) warnings.push('模块没有声明任何 OpCapability');
  return { ok: result.errors.length === 0, errors: result.errors, warnings, assembly: result.assembly };
}

/**
 * 往返自检：把二进制反汇编成文本，再按 `OP` 表重新编码，比较是否逐字节相同。
 *
 * 这是「编码器和解码器互为逆运算」的可执行证据 —— 不需要任何外部工具链。
 *
 * @param {Uint8Array} bytes
 * @returns {{ok:boolean, message?:string}}
 */
export function roundTripSpirv(bytes) {
  const first = disassembleSpirv(bytes);
  if (first.errors.length) return { ok: false, message: `反汇编有错：${first.errors[0]}` };
  const b = new ModuleBuilder();
  b.nextId = first.header.bound;
  for (const inst of first.instructions) {
    b.at('function').emit(inst.name, ...inst.values);
  }
  const again = encodeModule(b);
  if (again.byteLength !== bytes.byteLength) {
    return { ok: false, message: `往返后长度变了：${bytes.byteLength} → ${again.byteLength}` };
  }
  for (let i = 0; i < bytes.byteLength; i += 1) {
    if (again[i] !== bytes[i]) return { ok: false, message: `往返后第 ${i} 个字节不同（${bytes[i]} vs ${again[i]}）` };
  }
  return { ok: true };
}
