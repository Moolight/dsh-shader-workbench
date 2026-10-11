/**
 * 跨平台导出测试：GLSL → HLSL / MSL / SPIR-V。
 *
 * ## 这个文件在守什么
 *
 * 转译最危险的地方是「**产出一段看着很像、其实语义错了**的代码」：矩阵被静默转置、
 * `mod` 换成了语义不同的 `fmod`、坐标原点翻了两次。这些东西肉眼看代码很难发现，
 * 只有跑起来对数值才露馅。
 *
 * 所以主测试是**语义等价**：拿全部示例的每个 pass，用同一套求值器（`shared/glsl-eval.js`）
 * 跑原始 GLSL 的 AST 和转译后的 AST，要求 24 个采样点上逐位相等。
 *
 * ## 为什么还要文本断言
 *
 * 语义等价有个盲区，是实测出来的：把 `mod` → `$mod` 的改名**故意去掉**，
 * 语义测试**一个都不失败** —— 因为求值器对两种写法都实现 GLSL 的 mod 语义。
 * 也就是说「内建函数改名」这类纯文本变换，语义测试根本管不到。
 * 所以这里额外钉一组文本断言，两套一起才盖得住。
 *
 * ## SPIR-V 验到哪一层
 *
 * 本机没有 `spirv-val`，也没有任何 SPIR-V 解释器，所以**验不了「驱动会不会接受」**。
 * 能验的是：
 *   - 结构自洽（`validateSpirv`：字长、id 界内、块终止、分支目标、先定义后使用）；
 *   - 编码器与反汇编器互为逆运算（`roundTripSpirv` 逐字节相同）；
 *   - **那棵 AST 的语义没跑偏**（SPIR-V 目标用的是 GLSL 语义，所以能直接和原 GLSL 对数值）。
 * 最后一条是这里最有价值的部分 —— 它证明「喂给 SPIR-V 生成器的那棵树」是对的。
 *
 * 跑法：node tests/cross-compile.test.js
 *
 * @module dsh-shader-workbench/tests/cross-compile
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crossCompile,
  listExportTargets,
  registerExportTarget,
  EXPORT_TARGETS,
} from '../shared/cross-compile.js';
import { parseGlsl } from '../shared/glsl-parse.js';
import { Evaluator } from '../shared/glsl-eval.js';
import {
  SPIRV_MAGIC, SPIRV_VERSION, disassembleSpirv, validateSpirv, roundTripSpirv, ExecutionModel,
} from '../shared/spirv.js';
import { compileGraph } from '../client/runtime/codegen.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

/** 采样用的视口尺寸。 */
const W = 96;
const H = 64;

/** 固定的 uniform 桩值（确定性，方便复现）。 */
const UNIFORMS = {
  iResolution: [W, H, 1],
  iTime: 1.7,
  iTimeDelta: 0.016,
  iMouse: [0.3, 0.6, 0, 0],
  iDate: [2026, 9, 11, 12],
};

/** 固定的采样器桩（返回常量色，保证确定性）。 */
const SAMPLERS = {
  iChannel0: () => [0.2, 0.4, 0.6, 1],
  iChannel1: () => [0.7, 0.1, 0.3, 1],
  BufferA: () => [0.1, 0.2, 0.3, 1],
  BufferB: () => [0.5, 0.5, 0.5, 1],
  BufferC: () => [0, 0, 0, 1],
  BufferD: () => [1, 1, 1, 1],
};

/** 24 个分散的采样点。 */
const SAMPLES = Array.from({ length: 24 }, (_, i) => [
  3 + ((i * 7) % (W - 6)) + 0.5,
  2 + ((i * 11) % (H - 4)) + 0.5,
]);

/** 把全部示例的每个 pass 编译一遍，作为测试语料。 */
function collectPasses() {
  const out = [];
  for (const proj of readdirSync(EXAMPLES)) {
    const materials = join(EXAMPLES, proj, 'materials');
    if (!existsSync(materials)) continue;
    for (const material of readdirSync(materials)) {
      const file = join(materials, material, 'graph.json');
      if (!existsSync(file)) continue;
      const graph = JSON.parse(readFileSync(file, 'utf8'));
      for (const pass of graph.passes ?? []) {
        const result = compileGraph(graph, pass.name, { uniforms: {} });
        if (!result.ok) continue;
        out.push({ label: `${proj}/${material}::${pass.name}`, code: result.code });
      }
    }
  }
  return out;
}

const PASSES = collectPasses();

/** 跑一次求值，返回 RGBA。 */
function evaluate(program, options) {
  return new Evaluator(program, {
    uniforms: UNIFORMS,
    samplers: SAMPLERS,
    ...options,
  }).runMain(options.args ? { args: options.args } : {});
}

/** 两个 RGBA 的最大分量差。 */
function maxDiff(a, b) {
  return a.reduce((acc, v, i) => Math.max(acc, Math.abs(v - b[i])), 0);
}

/**
 * 去掉整行注释，只留代码。
 *
 * 文本断言必须跑在这上面：生成的代码开头有一段说明性注释，里面会**提到**
 * `mod()` / `fmod()` 这些名字（用来解释为什么不这么干），拿全文去断言会被它绊倒。
 */
function codeOnly(source) {
  return source.split('\n').filter((line) => !/^\s*(\/\/|;)/.test(line)).join('\n');
}

test('语料齐全：示例里的每个 pass 都能编译出来', () => {
  assert.ok(PASSES.length >= 8, `只收集到 ${PASSES.length} 个 pass，示例可能被改坏了`);
  for (const p of PASSES) {
    assert.match(p.code, /void main\s*\(/, `${p.label} 编出来的 GLSL 里没有 main`);
  }
});

test('解析器吃得下全部真实 GLSL，没有超出子集的东西', () => {
  for (const p of PASSES) {
    const program = parseGlsl(p.code);
    assert.deepEqual(
      program.unsupported,
      [],
      `${p.label} 里有超出转译子集的语法：${program.unsupported.map((u) => u.msg).join('；')}`,
    );
    assert.ok(program.functions.length >= 1, `${p.label} 没解析出函数`);
  }
});

test('语义等价：HLSL / MSL / SPIR-V 的 AST 与原 GLSL 逐位一致', () => {
  let checked = 0;
  for (const p of PASSES) {
    for (const target of ['hlsl', 'msl', 'spirv']) {
      const res = crossCompile(p.code, target, { source: p.label });
      assert.ok(
        res.ok,
        `${p.label} → ${target} 转译失败：${(res.errors ?? []).map((e) => e.message).join('；')}`,
      );

      const spirvLike = target === 'spirv';
      for (const [x, y] of SAMPLES) {
        let original;
        let translated;
        try {
          original = evaluate(res.program, { fragCoord: [x, y, 0, 1], matrixLayout: 'column', matrixMultiply: 'algebraic' });
          translated = spirvLike
            // SPIR-V 目标是 GLSL 语义：gl_FragCoord 是内建变量，入口也不带参数
            ? evaluate(res.ast, { fragCoord: [x, y, 0, 1], matrixLayout: res.ast.matrixLayout, matrixMultiply: res.ast.matrixMultiply })
            // HLSL / MSL 把视口坐标当入口参数传进来（原点在左上，所以要翻 y）
            : evaluate(res.ast, {
              matrixLayout: res.ast.matrixLayout,
              matrixMultiply: res.ast.matrixMultiply,
              args: [{ t: 'vec4', d: [x, H - y, 0, 1] }],
            });
        } catch (error) {
          assert.fail(`${p.label} → ${target} 在 (${x},${y}) 求值抛错：${error.message}`);
        }
        const diff = maxDiff(original, translated);
        assert.ok(
          diff < 1e-4,
          `${p.label} → ${target} 在 (${x},${y}) 不一致：GLSL=${JSON.stringify(original)} 转译=${JSON.stringify(translated)}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 200, `只比对了 ${checked} 个点，样本太少`);
});

test('内建函数改名被钉住：mod 走 st_mod，而不是语义不同的 fmod', () => {
  const glsl = `#version 300 es
precision highp float;
uniform float iTime;
out vec4 st_fragColor;
void main() {
  float m = mod(iTime - 2.0, 3.0);
  float f = fract(iTime);
  vec3 c = mix(vec3(0.0), vec3(1.0), f);
  float d = inversesqrt(abs(iTime) + 1.0);
  st_fragColor = vec4(c * m, d);
}`;

  const hlsl = crossCompile(glsl, 'hlsl');
  assert.ok(hlsl.ok, hlsl.errors?.map((e) => e.message).join('；'));
  const hlslCode = codeOnly(hlsl.code);
  assert.match(hlslCode, /st_mod\s*\(/, 'HLSL 里 mod 应该走 st_mod');
  assert.match(hlslCode, /\blerp\s*\(/, 'HLSL 里 mix 应该改名 lerp');
  assert.match(hlslCode, /\bfrac\s*\(/, 'HLSL 里 fract 应该改名 frac');
  assert.match(hlslCode, /\brsqrt\s*\(/, 'HLSL 里 inversesqrt 应该改名 rsqrt');
  // `st_mod` 里含 `mod`，但 `\bmod\(` 不会匹配到它 —— 所以这两条是有效的
  assert.doesNotMatch(hlslCode, /\bmod\s*\(/, 'HLSL 里不该出现 GLSL 的 mod(');
  assert.doesNotMatch(hlslCode, /\bfmod\s*\(/, '不能用 fmod 顶替 mod：负数上语义不同');

  const msl = crossCompile(glsl, 'msl');
  assert.ok(msl.ok);
  const mslCode = codeOnly(msl.code);
  assert.match(mslCode, /\bst_mod\s*\(/, 'MSL 里 mod 也应该走 st_mod');
  assert.match(mslCode, /\bmix\s*\(/, 'MSL 里 mix 保持原名');
  assert.doesNotMatch(mslCode, /\bfmod\s*\(/);
});

test('矩阵构造器参数序：HLSL 换中间两个，MSL 不换', () => {
  const glsl = `#version 300 es
precision highp float;
uniform float iTime;
out vec4 st_fragColor;
void main() {
  float a = iTime;
  float b = 1.0;
  float c = 2.0;
  float d = 3.0;
  mat2 m = mat2(a, b, c, d);
  vec2 v = m * vec2(a, b);
  st_fragColor = vec4(v, c, d);
}`;

  const hlsl = crossCompile(glsl, 'hlsl');
  assert.ok(hlsl.ok);
  const hlslCode = codeOnly(hlsl.code);
  // GLSL 的 4 个参数是两列；HLSL 的是两行 —— 所以中间两个换位
  assert.match(hlslCode, /float2x2\(a, c, b, d\)/, 'HLSL 的矩阵构造器参数序没换');
  // 矩阵 × 向量必须走 mul()
  assert.match(hlslCode, /mul\(m, float2\(a, b\)\)/, 'HLSL 里矩阵乘法没用 mul()');

  const msl = crossCompile(glsl, 'msl');
  assert.ok(msl.ok);
  const mslCode = codeOnly(msl.code);
  assert.match(mslCode, /float2x2\(a, b, c, d\)/, 'MSL 的矩阵构造器参数序不该变');
  assert.doesNotMatch(mslCode, /\bmul\s*\(/, 'MSL 不需要 mul()');
});

test('辅助函数直接读 gl_FragCoord：HLSL / MSL 明确拒绝，SPIR-V 放行', () => {
  const glsl = `#version 300 es
precision highp float;
uniform vec3 iResolution;
out vec4 st_fragColor;
float edge() { return gl_FragCoord.x / iResolution.x; }
void main() {
  st_fragColor = vec4(vec3(edge()), 1.0);
}`;

  for (const target of ['hlsl', 'msl']) {
    const res = crossCompile(glsl, target);
    assert.equal(res.ok, false, `${target} 应当拒绝：转译后 gl_FragCoord 是入口局部变量`);
    assert.match(res.errors[0].message, /gl_FragCoord/);
    assert.match(res.errors[0].message, /edge/, '报错要指出是哪个函数');
  }

  // SPIR-V 里 gl_FragCoord 是模块级 Input 变量，辅助函数读它完全合法
  const spirv = crossCompile(glsl, 'spirv');
  assert.ok(spirv.ok, spirv.errors?.map((e) => e.message).join('；'));
});

test('超出子集的语法明确报错，而不是猜一个转换结果', () => {
  const glsl = `#version 300 es
precision highp float;
out vec4 st_fragColor;
void main() {
  int i = 0;
  while (i < 3) { i = i + 1; }
  st_fragColor = vec4(float(i));
}`;

  const res = crossCompile(glsl, 'hlsl');
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);
  assert.match(res.errors[0].message, /超出转译子集/);
  assert.ok(res.unsupported.length > 0, '应当把不支持的语法原样报出来');
});

test('SPIR-V：全部 pass 都能编出结构自洽、往返一致的模块', () => {
  for (const p of PASSES) {
    const res = crossCompile(p.code, 'spirv', { source: p.label });
    assert.ok(res.ok, `${p.label} 生成失败：${(res.errors ?? []).map((e) => e.message).join('；')}`);
    assert.ok(res.code instanceof Uint8Array, 'SPIR-V 目标应当产出二进制');

    const view = new DataView(res.code.buffer, res.code.byteOffset, res.code.byteLength);
    assert.equal(view.getUint32(0, true), SPIRV_MAGIC, `${p.label} 魔数不对`);
    assert.equal(view.getUint32(4, true), SPIRV_VERSION, `${p.label} 版本不对`);
    assert.equal(res.code.byteLength % 4, 0, `${p.label} 长度不是 4 的倍数`);

    const validated = validateSpirv(res.code);
    assert.deepEqual(validated.errors, [], `${p.label} 结构有问题：${validated.errors.join('；')}`);

    // 编码器与反汇编器互为逆运算
    const roundTrip = roundTripSpirv(res.code);
    assert.ok(roundTrip.ok, `${p.label} 往返不一致：${roundTrip.message}`);
  }
});

test('SPIR-V：模块结构正确（入口点 / 装饰 / uniform 块 / 扩展指令集）', () => {
  const source = PASSES.find((p) => /texture\s*\(/.test(p.code)) ?? PASSES[0];
  const res = crossCompile(source.code, 'spirv', { source: source.label });
  assert.ok(res.ok);

  const dis = disassembleSpirv(res.code);
  const names = dis.instructions.map((i) => i.name);
  for (const required of ['OpCapability', 'OpMemoryModel', 'OpEntryPoint', 'OpExecutionMode', 'OpFunction', 'OpFunctionEnd', 'OpExtInstImport']) {
    assert.ok(names.includes(required), `缺少 ${required}`);
  }

  // 入口点必须是片段着色器，且叫 main
  const entry = dis.instructions.find((i) => i.name === 'OpEntryPoint');
  assert.equal(entry.values[0], ExecutionModel.Fragment, '入口点应当是 Fragment 阶段');
  assert.equal(entry.values[2], 'main', '入口函数名应当是 main');
  assert.ok(entry.values.length > 3, '入口点应当声明至少一个接口变量');

  // 原点必须是左下 —— 这是「SPIR-V 与 GLSL 语义一致」的关键
  const mode = dis.instructions.find((i) => i.name === 'OpExecutionMode');
  assert.equal(mode.values[1], 8, 'OpExecutionMode 应当是 OriginLowerLeft(8)');

  // uniform 收进了一个 Block 结构体
  assert.ok(names.includes('OpTypeStruct'), 'uniform 应当收进结构体');
  assert.ok(dis.instructions.some((i) => i.name === 'OpDecorate' && i.values[1] === 2), '结构体应当有 Block 装饰');
  assert.ok(names.includes('OpMemberDecorate'), '结构体成员应当有 Offset 装饰');

  assert.match(dis.assembly, /GLSL\.std\.450/, '汇编里应当能看到扩展指令集');
  assert.match(dis.assembly, /OpEntryPoint Fragment/, '汇编里应当能看到 Fragment 入口点');
});

test('SPIR-V：gl_FragCoord 作为 Input 内建变量出现', () => {
  const source = PASSES.find((p) => /gl_FragCoord/.test(p.code));
  assert.ok(source, '示例里应当有用到 gl_FragCoord 的 pass');

  const res = crossCompile(source.code, 'spirv', { source: source.label });
  assert.ok(res.ok);
  const dis = disassembleSpirv(res.code);

  // BuiltIn FragCoord = 15
  const decoration = dis.instructions.find((i) => i.name === 'OpDecorate' && i.values[1] === 11 && i.values[2] === 15);
  assert.ok(decoration, '应当有 BuiltIn FragCoord 装饰');
  assert.match(dis.assembly, /FragCoord/, '汇编里应当打出 BuiltIn 的名字而不是数字');
});

test('SPIR-V 汇编目标：产出可读文本，且与二进制一致', () => {
  const source = PASSES[0];
  const binary = crossCompile(source.code, 'spirv', { source: source.label });
  const text = crossCompile(source.code, 'spvasm', { source: source.label });
  assert.ok(binary.ok);
  assert.ok(text.ok);
  assert.equal(typeof text.code, 'string');

  // 汇编正文必须和直接反汇编二进制的结果一致
  const dis = disassembleSpirv(binary.code);
  assert.ok(text.code.includes(dis.assembly), 'spvasm 的正文应当与反汇编结果一致');
  assert.match(text.code, /没有 spirv-val/, '文件头要写明验证到哪一层');
});

test('导出目标通过注册机制（需求.md 的硬要求）', () => {
  const targets = listExportTargets();
  const ids = targets.map((t) => t.id);
  for (const id of ['glsl', 'hlsl', 'msl', 'spirv', 'spvasm']) {
    assert.ok(ids.includes(id), `导出目标缺 ${id}`);
  }

  const spirv = targets.find((t) => t.id === 'spirv');
  assert.equal(spirv.binary, true, 'spirv 目标应当标记为二进制');
  assert.equal(spirv.extension, 'spv');
  assert.equal(spirv.mime, 'application/octet-stream');

  const spvasm = targets.find((t) => t.id === 'spvasm');
  assert.equal(spvasm.binary, false);
  assert.equal(spvasm.extension, 'spvasm');

  // 外部目标能挂进来，并且真的会被 crossCompile 用上
  const before = EXPORT_TARGETS.size;
  registerExportTarget({
    id: '__probe__',
    label: '探针目标',
    extension: 'txt',
    build: ({ glsl }) => `// ${glsl.length} 个字符`,
  });
  try {
    assert.equal(EXPORT_TARGETS.size, before + 1);
    const res = crossCompile('void main() {}', '__probe__');
    assert.ok(res.ok, res.errors?.map((e) => e.message).join('；'));
    assert.match(res.code, /^\/\/ \d+ 个字符$/);
  } finally {
    EXPORT_TARGETS.delete('__probe__');
  }
  assert.equal(EXPORT_TARGETS.size, before, '探针目标应当被清理干净');
});
