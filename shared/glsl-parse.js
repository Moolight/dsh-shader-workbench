/**
 * GLSL(ES 3.00) 子集解析器 —— 跨平台转译器的地基。
 *
 * ## 为什么自己写解析器
 *
 * FR-06 要把工作台生成的 GLSL 转成 HLSL / MSL / SPIR-V。本机没有任何 shader
 * 工具链（glslangValidator / spirv-cross / dxc 全缺），而项目要求**零依赖 + 全离线**，
 * 所以只能做源码级转译。源码级转译的第一步就是**看懂源码**：
 * 拿正则去替换 `mix(` → `lerp(` 这种做法，碰到 `mat2` 的列主序、`mod` 的语义差异
 * 这类问题一定会错，而且错得悄无声息。
 *
 * ## 覆盖范围（刻意收窄）
 *
 * 只覆盖 `client/runtime/codegen.js` **实际会生成**的那部分 GLSL，
 * 外加 `shared/glsl-helpers.js` 与节点 `glslPrelude` 里出现过的写法：
 *
 *   - 类型：`float / int / bool / vec2-4 / mat2 / sampler2D / void`
 *   - 语句：声明（带初始化）、赋值、`for`、`if / else`、`break / continue`、`return`
 *   - 表达式：四则、比较、逻辑、一元、三元、成员访问（swizzle）、函数调用、构造器
 *   - 函数定义（含重载）—— 节点 `glslPrelude` 靠它
 *
 * 不在子集里的东西（`while`、`switch`、数组、结构体、位运算……）会被**记进
 * `unsupported[]`**，而不是猜一个转换结果。调用方看到非空就应当拒绝导出并原样报出来 ——
 * 「宁可说做不到，也不要给一段编译不过或者语义不对的代码」。
 *
 * @module dsh-shader-workbench/shared/glsl-parse
 */

/** 内置类型名。 */
export const TYPE_NAMES = new Set([
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4',
  'ivec2', 'ivec3', 'ivec4',
  'bvec2', 'bvec3', 'bvec4',
  'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'sampler2DShadow',
]);

/** 存储限定符与精度限定符。 */
export const QUALIFIERS = new Set([
  'const', 'uniform', 'in', 'out', 'inout', 'attribute', 'varying',
  'flat', 'smooth', 'noperspective', 'centroid', 'invariant', 'precise',
  'lowp', 'mediump', 'highp',
]);

/** 赋值运算符。 */
export const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

/** 多字符运算符要先匹配，否则 `<` 会先吃掉 `<=` 的第一个字符。 */
const PUNCTUATORS = [
  '<<=', '>>=', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '==', '!=', '<=', '>=', '&&', '||', '^^', '<<', '>>',
  '(', ')', '{', '}', '[', ']', ',', ';', ':', '.', '?',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
];

/** 二元运算符优先级表，从低到高。 */
const BINARY_LEVELS = [
  ['||'],
  ['^^'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

/** 解析错误（带行列，方便对着 shader 找）。 */
export class GlslParseError extends Error {
  /**
   * @param {string} message
   * @param {{line:number, col:number, value:string}} [tok]
   */
  constructor(message, tok) {
    super(tok ? `${message}（第 ${tok.line} 行第 ${tok.col} 列，读到 "${tok.value}"）` : message);
    this.name = 'GlslParseError';
    if (tok) this.location = { line: tok.line, col: tok.col, token: tok.value };
  }
}

/**
 * 词法分析。
 *
 * 预处理指令（`#version` / `#include` / `#define`…）整行作为一个 directive token，
 * 原样留给上层决定怎么处理 —— 转译到 HLSL 时它们是**要丢掉**的。
 *
 * @param {string} src
 * @returns {Array<{kind:'num'|'ident'|'punct'|'directive'|'eof', value:string|number, raw?:string, line:number, col:number}>}
 */
export function tokenize(src) {
  const out = [];
  const text = String(src);
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  /** 前一个非空白字符是不是换行/行首（判断 `#` 是否处于行首）。 */
  const advance = (count) => {
    for (let k = 0; k < count; k += 1) {
      if (text[i + k] === '\n') {
        line += 1;
        lineStart = i + k + 1;
      }
    }
    i += count;
  };

  while (i < n) {
    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance(1);
      continue;
    }

    // 注释
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new GlslParseError('块注释没有闭合', { line, col: i - lineStart + 1, value: '/*' });
      advance(end + 2 - i);
      continue;
    }

    const col = i - lineStart + 1;

    // 预处理指令：`#` 只认行首（前面除了空白没有别的东西）
    if (c === '#' && /^[ \t]*$/.test(text.slice(lineStart, i))) {
      let end = i;
      while (end < n && text[end] !== '\n') end += 1;
      const raw = text.slice(i, end);
      out.push({ kind: 'directive', value: raw.trim(), raw, line, col });
      advance(end - i);
      continue;
    }

    // 数字：1.0 / .5 / 1. / 1e-8 / 24
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      const raw = m[0];
      const isFloat = /[.eE]/.test(raw);
      out.push({ kind: 'num', value: isFloat ? Number(raw) : Number.parseInt(raw, 10), raw, isFloat, line, col });
      advance(raw.length);
      continue;
    }

    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      out.push({ kind: 'ident', value: m[0], line, col });
      advance(m[0].length);
      continue;
    }

    // 运算符 / 标点
    const punct = PUNCTUATORS.find((p) => text.startsWith(p, i));
    if (!punct) {
      throw new GlslParseError('不认识的字符', { line, col, value: c });
    }
    out.push({ kind: 'punct', value: punct, line, col });
    advance(punct.length);
  }

  out.push({ kind: 'eof', value: '', line, col: i - lineStart + 1 });
  return out;
}

/**
 * 取一个 swizzle 结果的分量个数。
 * @param {string} swizzle
 * @returns {number}
 */
export function swizzleWidth(swizzle) {
  return swizzle.length;
}

/**
 * 按基础类型和 swizzle 推出结果类型。
 * @param {string} baseType
 * @param {string} swizzle
 * @returns {string|null} 推不出来返回 null
 */
export function swizzleType(baseType, swizzle) {
  const width = swizzle.length;
  if (width < 1 || width > 4) return null;
  if (baseType === 'float' || baseType === 'int' || baseType === 'bool') {
    return width === 1 ? baseType : `${baseType === 'float' ? 'vec' : `${baseType[0]}vec`}${width}`;
  }
  const m = /^([ibu]?)vec([234])$/.exec(baseType);
  if (!m) return null;
  const prefix = m[1] ?? '';
  if (width === 1) return prefix === '' ? 'float' : `${prefix}int`;
  return `${prefix}vec${width}`;
}

/** 分量字母 → 下标。 */
const SWIZZLE_INDEX = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 };

/**
 * swizzle 是否合法（同一套字母表、不越界）。
 * @param {string} swizzle
 * @param {number} width 基础类型的分量数
 * @returns {boolean}
 */
export function isValidSwizzle(swizzle, width) {
  if (!/^[xyzwrgba]{1,4}$/.test(swizzle)) return false;
  const set = /^[xyzw]+$/.test(swizzle) ? 'xyzw' : /^[rgba]+$/.test(swizzle) ? 'rgba' : null;
  if (!set) return false;
  return [...swizzle].every((ch) => SWIZZLE_INDEX[ch] < width);
}

/**
 * 取 swizzle 的分量下标数组（SPIR-V 的 OpVectorShuffle 要用）。
 * @param {string} swizzle
 * @returns {number[]}
 */
export function swizzleIndices(swizzle) {
  return [...swizzle].map((ch) => SWIZZLE_INDEX[ch]);
}

/** 解析器。 */
class Parser {
  /**
   * @param {string} src
   * @param {object} [opts]
   */
  constructor(src, opts = {}) {
    this.tokens = tokenize(src);
    this.i = 0;
    this.unsupported = [];
    this.src = String(src);
    this.opts = opts;
  }

  peek(k = 0) {
    const idx = Math.min(this.i + k, this.tokens.length - 1);
    return this.tokens[idx];
  }

  next() {
    const tok = this.tokens[this.i];
    if (this.i < this.tokens.length - 1) this.i += 1;
    return tok;
  }

  /** 当前是不是某个标点。 */
  atPunct(value) {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  /** 当前是不是某个标识符（关键字）。 */
  atIdent(value) {
    const t = this.peek();
    return t.kind === 'ident' && t.value === value;
  }

  /** 当前标识符是不是类型名。 */
  atTypeName() {
    const t = this.peek();
    return t.kind === 'ident' && TYPE_NAMES.has(t.value);
  }

  /** 吃掉一个指定标点，没有就报错。 */
  expectPunct(value) {
    const t = this.peek();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new GlslParseError(`期望 "${value}"`, t);
    }
    return this.next();
  }

  /** 吃掉一个标识符。 */
  expectIdent(what = '标识符') {
    const t = this.peek();
    if (t.kind !== 'ident') throw new GlslParseError(`期望${what}`, t);
    return this.next();
  }

  /** 记一条「超出子集」的说明。 */
  note(msg, tok = this.peek()) {
    this.unsupported.push({ msg, line: tok.line, col: tok.col, token: String(tok.value) });
  }

  // ─────────────────────── 顶层 ───────────────────────

  parseProgram() {
    const program = {
      version: null,
      directives: [],
      precisions: [],
      globals: [],
      functions: [],
      unsupported: this.unsupported,
    };

    while (this.peek().kind !== 'eof') {
      const tok = this.peek();

      if (tok.kind === 'directive') {
        this.next();
        program.directives.push(tok.value);
        const m = /^#\s*version\s+(.+)$/.exec(tok.value);
        if (m) program.version = m[1].trim();
        continue;
      }

      if (this.atIdent('precision')) {
        this.next();
        const qualifier = this.expectIdent('精度限定符').value;
        const type = this.expectIdent('类型').value;
        this.expectPunct(';');
        program.precisions.push({ qualifier, type });
        continue;
      }

      if (this.atIdent('struct')) {
        this.note('结构体（struct）不在转译子集内', tok);
        this.skipTopLevelDeclaration();
        continue;
      }

      // 限定符 / 类型开头 → 全局声明或函数定义
      const parsed = this.parseDeclarationOrFunction();
      if (parsed) {
        if (parsed.kind === 'function') program.functions.push(parsed);
        else program.globals.push(...parsed.items);
      }
    }

    return program;
  }

  /** 遇到不认识的东西时，跳到下一个分号或大括号块结束。 */
  skipTopLevelDeclaration() {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.kind === 'punct') {
        if (t.value === '{') depth += 1;
        else if (t.value === '}') {
          depth -= 1;
          if (depth <= 0) return;
        } else if (t.value === ';' && depth === 0) return;
      }
    }
  }

  /** 收集限定符（可能一个都没有）。 */
  parseQualifiers() {
    const qualifiers = [];
    while (this.peek().kind === 'ident' && QUALIFIERS.has(this.peek().value) && !this.atTypeName()) {
      qualifiers.push(this.next().value);
    }
    return qualifiers;
  }

  /**
   * 解析「[限定符] 类型 名字 …」，可能是全局变量声明，也可能是函数定义。
   * @returns {{kind:'function'|'globals'}|null}
   */
  parseDeclarationOrFunction() {
    const start = this.peek();
    const qualifiers = this.parseQualifiers();

    if (!this.atTypeName() && !this.atIdent('void')) {
      // 不是声明也不是函数 —— 顶层不该出现表达式语句，记一笔然后跳过
      this.note(`顶层出现不认识的语句（限定符：${qualifiers.join(' ') || '无'}）`, start);
      this.skipTopLevelDeclaration();
      return null;
    }

    const type = this.next().value;
    const nameTok = this.expectIdent('名字');
    const name = nameTok.value;

    if (this.atPunct('(')) {
      return { kind: 'function', ...this.parseFunctionRest(qualifiers, type, name, nameTok) };
    }

    // 变量声明（可能一次声明多个，用逗号隔开）
    const items = [];
    let arrayWidth = null;
    if (this.atPunct('[')) {
      this.next();
      // 数组长度：只接受常量或空
      if (!this.atPunct(']')) {
        const sizeTok = this.peek();
        if (sizeTok.kind !== 'num') {
          this.note('非常量数组长度不在转译子集内', sizeTok);
          this.skipToSemicolon();
          return { kind: 'globals', items };
        }
        arrayWidth = sizeTok.value;
        this.next();
      }
      this.expectPunct(']');
      this.note('数组不在转译子集内', nameTok);
    }

    let init = null;
    if (this.atPunct('=')) {
      this.next();
      init = this.parseAssignment();
    }
    items.push({ qualifiers, type, name, arrayWidth, init });

    while (this.atPunct(',')) {
      this.next();
      const n2 = this.expectIdent('名字');
      items.push({ qualifiers, type, name: n2.value, arrayWidth: null, init: null });
      this.note('一个声明里声明多个变量不在转译子集内（转译器按「一个声明一个变量」处理）', n2);
    }

    this.expectPunct(';');
    return { kind: 'globals', items };
  }

  /** 函数定义的剩余部分：参数列表 + 可选的语义标注 + 函数体。 */
  parseFunctionRest(qualifiers, returnType, name, nameTok) {
    this.expectPunct('(');
    const params = [];
    if (!this.atPunct(')')) {
      if (this.atIdent('void') && this.peek(1).kind === 'punct' && this.peek(1).value === ')') {
        this.next(); // 显式 void 参数表
      } else {
        do {
          const pQualifiers = this.parseQualifiers();
          if (!this.atTypeName() && !this.atIdent('void')) {
            this.note('函数参数类型不在转译子集内', this.peek());
            this.skipToClosingParen();
            return { returnType, name, params, body: { k: 'block', body: [] }, token: nameTok };
          }
          const pType = this.next().value;
          const pName = this.expectIdent('参数名').value;
          let pArray = null;
          if (this.atPunct('[')) {
            this.next();
            if (!this.atPunct(']')) {
              pArray = this.peek().value;
              this.next();
            }
            this.expectPunct(']');
            this.note('数组参数不在转译子集内', this.peek());
          }
          // HLSL / MSL 的语义标注（`: SV_Position` / `[[position]]`）—— 自己生成的回读用
          let semantic = null;
          if (this.atPunct(':')) {
            this.next();
            semantic = this.expectIdent('语义名').value;
          }
          params.push({ qualifiers: pQualifiers, type: pType, name: pName, arrayWidth: pArray, semantic });
        } while (this.atPunct(',') && this.next());
      }
    }
    this.expectPunct(')');

    // 返回值语义标注
    let returnSemantic = null;
    if (this.atPunct(':')) {
      this.next();
      returnSemantic = this.expectIdent('语义名').value;
    }

    const body = this.parseBlock();
    return { returnType, name, params, body, qualifiers, returnSemantic, token: nameTok };
  }

  skipToSemicolon() {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.kind !== 'punct') continue;
      if (t.value === '(' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === '}') depth -= 1;
      else if (t.value === ';' && depth <= 0) return;
    }
  }

  skipToClosingParen() {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.next();
      if (t.kind !== 'punct') continue;
      if (t.value === '(') depth += 1;
      else if (t.value === ')') {
        if (depth === 0) return;
        depth -= 1;
      }
    }
  }

  // ─────────────────────── 语句 ───────────────────────

  parseBlock() {
    this.expectPunct('{');
    const body = [];
    while (!this.atPunct('}') && this.peek().kind !== 'eof') {
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    this.expectPunct('}');
    return { k: 'block', body };
  }

  parseStatement() {
    const tok = this.peek();

    if (this.atPunct('{')) return this.parseBlock();
    if (this.atPunct(';')) {
      this.next();
      return { k: 'empty' };
    }

    if (tok.kind === 'ident') {
      switch (tok.value) {
        case 'for':
          return this.parseFor();
        case 'if':
          return this.parseIf();
        case 'while':
          this.note('while 循环不在转译子集内（生成器只会产出 for）', tok);
          this.skipTopLevelDeclaration();
          return { k: 'unsupported', what: 'while' };
        case 'do':
          this.note('do-while 不在转译子集内', tok);
          this.skipTopLevelDeclaration();
          return { k: 'unsupported', what: 'do' };
        case 'switch':
          this.note('switch 不在转译子集内', tok);
          this.skipTopLevelDeclaration();
          return { k: 'unsupported', what: 'switch' };
        case 'return': {
          this.next();
          const e = this.atPunct(';') ? null : this.parseExpression();
          this.expectPunct(';');
          return { k: 'return', e };
        }
        case 'break':
          this.next();
          this.expectPunct(';');
          return { k: 'break' };
        case 'continue':
          this.next();
          this.expectPunct(';');
          return { k: 'continue' };
        case 'discard':
          this.next();
          this.expectPunct(';');
          this.note('discard 不在转译子集内（生成器不会产出它）', tok);
          return { k: 'discard' };
        default:
          break;
      }
    }

    // 声明：限定符 / 类型名开头，且后面跟的是标识符（构造器调用后面跟的是 `(`）
    if (this.startsDeclaration()) return this.parseLocalDeclaration();

    const e = this.parseExpression();
    this.expectPunct(';');
    return { k: 'expr', e };
  }

  /** 判断当前位置是不是一条声明语句。 */
  startsDeclaration() {
    let k = 0;
    while (this.peek(k).kind === 'ident' && QUALIFIERS.has(this.peek(k).value)) k += 1;
    const t = this.peek(k);
    if (t.kind !== 'ident' || !TYPE_NAMES.has(t.value)) return false;
    // `vec4(...)` 是构造器调用，不是声明
    const after = this.peek(k + 1);
    return after.kind === 'ident';
  }

  parseLocalDeclaration() {
    const qualifiers = this.parseQualifiers();
    const typeTok = this.peek();
    const type = this.next().value;
    const nameTok = this.expectIdent('变量名');
    const name = nameTok.value;

    if (this.atPunct('[')) {
      this.note('数组不在转译子集内', nameTok);
      this.skipToSemicolon();
      return { k: 'unsupported', what: 'array' };
    }

    let init = null;
    if (this.atPunct('=')) {
      this.next();
      init = this.parseAssignment();
    }
    if (this.atPunct(',')) {
      this.note('一个声明里声明多个变量不在转译子集内', this.peek());
      this.skipToSemicolon();
      return { k: 'unsupported', what: 'multi-declarator' };
    }
    this.expectPunct(';');
    return { k: 'decl', qualifiers, type, name, init, token: typeTok };
  }

  parseFor() {
    this.next(); // 'for' 是标识符，不是标点
    this.expectPunct('(');

    let init = null;
    if (this.atPunct(';')) {
      this.next();
    } else if (this.startsDeclaration()) {
      init = this.parseLocalDeclaration();
    } else {
      const e = this.parseExpression();
      this.expectPunct(';');
      init = { k: 'expr', e };
    }

    const test = this.atPunct(';') ? null : this.parseExpression();
    this.expectPunct(';');

    const update = this.atPunct(')') ? null : this.parseExpression();
    this.expectPunct(')');

    const body = this.parseStatement();
    return { k: 'for', init, test, update, body };
  }

  parseIf() {
    this.next(); // 'if' 是标识符，不是标点
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const cons = this.parseStatement();
    let alt = null;
    if (this.atIdent('else')) {
      this.next();
      alt = this.parseStatement();
    }
    return { k: 'if', test, cons, alt };
  }

  // ─────────────────────── 表达式 ───────────────────────

  parseExpression() {
    // 逗号表达式：生成器不产出，遇到就记一笔但仍按逗号序列解析
    let e = this.parseAssignment();
    if (this.atPunct(',')) {
      const list = [e];
      while (this.atPunct(',')) {
        this.next();
        list.push(this.parseAssignment());
      }
      this.note('逗号表达式不在转译子集内');
      e = { k: 'comma', list };
    }
    return e;
  }

  parseAssignment() {
    const target = this.parseConditional();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      this.next();
      const value = this.parseAssignment();
      return { k: 'assign', op: t.value, target, value };
    }
    return target;
  }

  parseConditional() {
    const test = this.parseBinary(0);
    if (!this.atPunct('?')) return test;
    this.next();
    const cons = this.parseAssignment();
    this.expectPunct(':');
    const alt = this.parseAssignment();
    return { k: 'cond', test, cons, alt };
  }

  /** 按优先级表爬升。 */
  parseBinary(level) {
    if (level >= BINARY_LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct' || !BINARY_LEVELS[level].includes(t.value)) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { k: 'bin', op: t.value, l: left, r: right, token: t };
    }
  }

  parseUnary() {
    const t = this.peek();
    if (t.kind === 'punct' && ['+', '-', '!', '~', '++', '--'].includes(t.value)) {
      this.next();
      if (t.value === '~' || t.value === '&' || t.value === '|') this.note('位运算不在转译子集内', t);
      return { k: 'un', op: t.value, x: this.parseUnary(), prefix: true, token: t };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct') return e;
      if (t.value === '.') {
        this.next();
        const name = this.expectIdent('成员名').value;
        e = { k: 'member', obj: e, name, token: t };
        continue;
      }
      if (t.value === '[') {
        this.next();
        const idx = this.parseExpression();
        this.expectPunct(']');
        this.note('下标访问不在转译子集内（生成器用 swizzle 而不是下标）', t);
        e = { k: 'index', obj: e, idx, token: t };
        continue;
      }
      if (t.value === '++' || t.value === '--') {
        this.next();
        e = { k: 'un', op: t.value, x: e, prefix: false, token: t };
        continue;
      }
      return e;
    }
  }

  parsePrimary() {
    const t = this.peek();

    if (t.kind === 'num') {
      this.next();
      return { k: 'num', v: t.value, raw: t.raw, isFloat: t.isFloat === true, token: t };
    }

    if (t.kind === 'ident') {
      this.next();
      if (this.atPunct('(')) {
        this.next();
        const args = [];
        if (!this.atPunct(')')) {
          do {
            args.push(this.parseAssignment());
          } while (this.atPunct(',') && this.next());
        }
        this.expectPunct(')');
        return { k: 'call', name: t.value, args, token: t };
      }
      return { k: 'id', name: t.value, token: t };
    }

    if (t.kind === 'punct' && t.value === '(') {
      this.next();
      const e = this.parseExpression();
      this.expectPunct(')');
      return { k: 'paren', e, token: t };
    }

    throw new GlslParseError('期望一个表达式', t);
  }
}

/**
 * 解析一段 GLSL。
 *
 * @param {string} src
 * @param {object} [opts]
 * @returns {{
 *   version: string|null,
 *   directives: string[],
 *   precisions: Array<{qualifier:string,type:string}>,
 *   globals: Array<object>,
 *   functions: Array<object>,
 *   unsupported: Array<{msg:string,line:number,col:number,token:string}>,
 * }}
 */
export function parseGlsl(src, opts = {}) {
  return new Parser(src, opts).parseProgram();
}

/**
 * 从解析结果里挑出入口函数。
 * @param {object} program
 * @param {string} [name]
 * @returns {object|null}
 */
export function findFunction(program, name = 'main') {
  return program.functions.find((f) => f.name === name) ?? null;
}

/**
 * 把解析结果里所有被引用到的名字收成一个集合（转译器用来决定要不要生成 helper）。
 * @param {object} program
 * @returns {Set<string>}
 */
export function collectCalledNames(program) {
  const names = new Set();
  const visitExpr = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.k === 'call') {
      names.add(e.name);
      for (const a of e.args) visitExpr(a);
      return;
    }
    for (const key of ['x', 'l', 'r', 'obj', 'idx', 'target', 'value', 'test', 'cons', 'alt', 'e']) {
      if (e[key]) visitExpr(e[key]);
    }
    if (Array.isArray(e.list)) for (const it of e.list) visitExpr(it);
    if (Array.isArray(e.args)) for (const a of e.args) visitExpr(a);
  };
  const visitStmt = (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.k === 'block') { for (const it of s.body) visitStmt(it); return; }
    if (s.k === 'for') { visitStmt(s.init); visitExpr(s.test); visitExpr(s.update); visitStmt(s.body); return; }
    if (s.k === 'if') { visitExpr(s.test); visitStmt(s.cons); if (s.alt) visitStmt(s.alt); return; }
    if (s.k === 'decl') { visitExpr(s.init); return; }
    if (s.k === 'return') { visitExpr(s.e); return; }
    if (s.k === 'expr') { visitExpr(s.e); return; }
  };
  for (const fn of program.functions) visitStmt(fn.body);
  return names;
}
