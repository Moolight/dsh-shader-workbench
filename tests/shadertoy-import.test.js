/**
 * Shadertoy 导入测试。
 *
 * ## 这个文件在守什么
 *
 * 「把一段别人的 GLSL 塞进我们的节点体系」有三处最容易悄悄出错，而且都不会
 * 抛异常 —— 只会产出一段编译不过或者行为不对的代码：
 *
 *   1. **切函数体切错**。Shadertoy 代码里注释/字符串中出现 `{` `}` 很常见，
 *      用「数括号」的朴素写法会切歪。这里专门放了一段带注释花括号的源码。
 *   2. **包出来的函数不满足 GLSL 语法**。Shadertoy 的 `mainImage` 是
 *      `out` 参数 + 无返回值，我们包成**有返回值**的函数，于是裸的 `return;`
 *      必须改写成 `return fragColor;`，否则 `vec4 f(){ ... return; }` 编译不过。
 *   3. **和生成器的入口撞名**。有些 Shadertoy 备份自带 `void main()`，
 *      留着会和 codegen 产出的 `main()` 重定义。
 *
 * 最后一条测试是**端到端**的：导入 → 注册成用户节点 → 真的编译一次，
 * 断言编出来的 GLSL 里出现包装函数、并且 `iChannel0` 被正确声明成 sampler。
 * 只测「字符串长得对」是不够的 —— 这一条才证明导入产物真的能跑。
 *
 * ## 已知边界（测试里也照实体现，不假装支持）
 *
 * - 只认 `mainImage(out vec4, in vec2)` 这一种签名，找不到就报错，不猜；
 * - 不解析 `#define`，宏拼出来的调用包装后可能编译不过（交给用户改）；
 * - 导入会**替换**材质图，测试里断言的就是「两个节点 + 一条边」这个形状。
 *
 * 跑法：node tests/shadertoy-import.test.js
 *
 * @module dsh-shader-workbench/tests/shadertoy-import
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADERTOY_ENTRY,
  SHADERTOY_NODE_TYPE,
  buildShadertoyPrelude,
  detectShadertoyFeatures,
  extractMainImage,
  importShadertoy,
  shadertoyNodeDefinition,
} from '../shared/shadertoy-import.js';
import { parseUserNodeDefinition } from '../shared/user-nodes.js';
import { setUserNodes, userNodeDefs } from '../shared/nodes.js';
import { compileGraph } from '../client/runtime/codegen.js';

/**
 * 一段「像真的」的 Shadertoy 源码。
 *
 * 故意埋了几个坑：
 *   - `#define` 常量；
 *   - `mainImage` 之前有辅助函数；
 *   - 函数体里有一个**注释里的花括号**（数括号的写法会在这里数错）；
 *   - 一处裸的 `return;`（提前退出）；
 *   - 用了 `iTime` / `iResolution` / `iChannel0`。
 */
const SRC = `// 一个典型的 Shadertoy 片段
#define PI 3.14159265359

float wave(vec2 p, float t) {
  return sin(p.x * 10.0 + t) * 0.5 + 0.5;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.xy;
    // 下面这个注释里有个 '{' —— 数括号的实现会从这里开始数错
    if (uv.x < 0.0) { return; }
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
    col *= wave(uv, iTime);
    col += texture(iChannel0, uv).rgb * 0.1;
    fragColor = vec4(col, 1.0);
}
`;

test('extractMainImage：带 out/in 限定符和裸签名都认得', () => {
  const a = extractMainImage(SRC);
  assert.ok(a, '没切出 mainImage');
  assert.equal(a.fragColor, 'fragColor');
  assert.equal(a.fragCoord, 'fragCoord');
  assert.match(a.body, /fragCoord \/ iResolution\.xy/);

  // Shadertoy 上也有人写成不带限定符的
  const b = extractMainImage('void mainImage(vec4 c, vec2 p) { c = vec4(p, 0.0, 1.0); }');
  assert.ok(b);
  assert.equal(b.fragColor, 'c');
  assert.equal(b.fragCoord, 'p');

  // 参数名不叫 fragColor / fragCoord 也要认
  const c = extractMainImage('void mainImage(out vec4 col, in vec2 uv) { col = vec4(uv, 0.0, 1.0); }');
  assert.ok(c);
  assert.equal(c.fragColor, 'col');
  assert.equal(c.fragCoord, 'uv');
});

test('extractMainImage：切函数体时跳过注释与字符串里的花括号', () => {
  const tricky = [
    'void mainImage(out vec4 o, in vec2 p) {',
    '  // } 这行注释里的右括号不该被算进去',
    '  /* { } { */',
    '  o = vec4(p, 0.0, 1.0);',
    '}',
    'void other() { }',
  ].join('\n');
  const found = extractMainImage(tricky);
  assert.ok(found);
  assert.ok(!found.body.includes('void other'), `切过头了，切到了后面的函数：${found.body}`);
  assert.match(found.body, /o = vec4\(p, 0\.0, 1\.0\);/);
});

test('extractMainImage：找不到 mainImage 时返回 null，不猜', () => {
  assert.equal(extractMainImage('void main() { gl_FragColor = vec4(1.0); }'), null);
  assert.equal(extractMainImage('void mainImage(vec3 p) { }'), null, '签名不对不该硬认');
  assert.equal(extractMainImage(''), null);
  assert.equal(extractMainImage(undefined), null);
});

test('detectShadertoyFeatures：扫出用到的通道 / Buffer / 内建', () => {
  const f = detectShadertoyFeatures(SRC);
  assert.deepEqual(f.channels, ['iChannel0']);
  assert.deepEqual(f.buffers, []);
  assert.equal(f.usesTime, true);
  assert.equal(f.usesFrame, false);
  assert.equal(f.usesMouse, false);

  const heavy = detectShadertoyFeatures(
    'void mainImage(out vec4 o, in vec2 p) { o = texture(iChannel1, p) + texture(iChannel3, p)'
    + ' + texture(BufferA, p) + vec4(iFrame + iMouse.x + iDate.x + iTimeDelta); }',
  );
  assert.deepEqual(heavy.channels, ['iChannel1', 'iChannel3']);
  assert.deepEqual(heavy.buffers, ['BufferA']);
  assert.equal(heavy.usesFrame, true);
  assert.equal(heavy.usesMouse, true);
  assert.equal(heavy.usesDate, true);
  assert.equal(heavy.usesTimeDelta, true);
});

test('包装出的 prelude：有返回值的函数、裸 return 被补上返回值', () => {
  const main = extractMainImage(SRC);
  const { prelude, warnings } = buildShadertoyPrelude(SRC, main);

  assert.match(prelude, new RegExp(`vec4 ${SHADERTOY_ENTRY}\\(vec2 fragCoord\\) \\{`));
  assert.match(prelude, /return fragColor;/, '函数末尾必须 return');
  // 裸的 return; 必须改写成有返回值的，否则 vec4 函数里裸 return 编译不过
  assert.ok(!/\breturn\s*;/.test(prelude), `还有裸的 return;：\n${prelude}`);
  assert.match(prelude, /return fragColor;/);
  assert.ok(warnings.some((w) => /提前 return/.test(w)), `没提示改写过 return：${warnings.join(' / ')}`);

  // mainImage 之外的代码（#define / 辅助函数）要原样留着
  assert.match(prelude, /#define PI 3\.14159265359/);
  assert.match(prelude, /float wave\(vec2 p, float t\)/);

  // 包装函数本身不该叫 main，否则会和生成器的入口撞名
  assert.ok(!/\bvoid\s+main\s*\(/.test(prelude), 'prelude 里出现了 void main(');
});

test('包装出的 prelude：源码自带的 void main() 会被移除并给出警告', () => {
  const withMain = `${SRC}\nvoid main() { mainImage(gl_FragColor, gl_FragCoord.xy); }\n`;
  const main = extractMainImage(withMain);
  const { prelude, warnings } = buildShadertoyPrelude(withMain, main);

  assert.ok(!/\bvoid\s+main\s*\(/.test(prelude), '自带的 void main() 没被移除，会和生成器入口重定义');
  assert.ok(warnings.some((w) => /void main/.test(w)), `没给出移除警告：${warnings.join(' / ')}`);
});

test('节点定义能过用户节点校验，code 是单条表达式且没有分号', () => {
  const main = extractMainImage(SRC);
  const { prelude } = buildShadertoyPrelude(SRC, main);
  const raw = shadertoyNodeDefinition(main, prelude);

  assert.equal(raw.type, SHADERTOY_NODE_TYPE);
  assert.equal(raw.code, `${SHADERTOY_ENTRY}(gl_FragCoord.xy)`);
  assert.ok(!raw.code.includes(';'), 'code 里不能有分号');
  assert.deepEqual(raw.outputs.map((p) => [p.id, p.type]), [['out', 'vec4']]);
  assert.deepEqual(raw.inputs, []);

  // 真过一遍校验器（host 落盘后重扫走的就是这条路）
  const def = parseUserNodeDefinition(raw, 'shadertoyMain.json');
  assert.equal(def.type, SHADERTOY_NODE_TYPE);
  assert.equal(def.userDefined, true);
  assert.match(def.glslPrelude, new RegExp(SHADERTOY_ENTRY));
});

test('importShadertoy：产出两个节点 + 一条边，image pass 里两个都在', () => {
  const r = importShadertoy(SRC, { name: 'demo', sourceUrl: 'https://www.shadertoy.com/view/xxxx' });

  assert.equal(r.graph.nodes.length, 2, '应当是一个 Shadertoy 节点 + 一个 output 终止节点');
  assert.equal(r.graph.edges.length, 1);
  assert.equal(r.graph.metadata.source, 'https://www.shadertoy.com/view/xxxx');

  const kinds = r.graph.nodes.map((n) => n.type).sort();
  assert.deepEqual(kinds, [SHADERTOY_NODE_TYPE, 'output'].sort());

  const pass = r.graph.passes.find((p) => p.name === 'image');
  assert.ok(pass, '没有 image pass');
  assert.deepEqual(
    [...pass.graph].sort(),
    [r.shaderNodeId, r.outputNodeId].sort(),
    'image pass 里应当正好是这两个节点',
  );

  const edge = r.graph.edges[0];
  assert.equal(edge.from.node, r.shaderNodeId);
  assert.equal(edge.from.port, 'out');
  assert.equal(edge.to.node, r.outputNodeId);
  assert.equal(edge.to.port, 'color');
});

test('importShadertoy：空源码 / 没有 mainImage 时给出可读的报错', () => {
  assert.throws(() => importShadertoy(''), /源码是空的/);
  assert.throws(() => importShadertoy('   \n  '), /源码是空的/);
  assert.throws(
    () => importShadertoy('void main() { gl_FragColor = vec4(1.0); }'),
    /找不到 mainImage/,
  );
  // 报错里要带正确的签名，用户才知道该贴什么
  assert.throws(
    () => importShadertoy('float f() { return 1.0; }'),
    /void mainImage\(out vec4 fragColor, in vec2 fragCoord\)/,
  );
});

test('端到端：导入 → 注册成用户节点 → 编译出的 GLSL 真的能跑通', () => {
  const saved = userNodeDefs();
  try {
    const r = importShadertoy(SRC, { name: 'demo' });
    setUserNodes([parseUserNodeDefinition(r.node, 'shadertoyMain.json')]);

    const compiled = compileGraph(r.graph, 'image', {});
    assert.equal(
      compiled.ok,
      true,
      `导入的图编译不过：${(compiled.errors ?? []).map((e) => e.message).join('；')}`,
    );

    const code = compiled.code;
    // 包装函数进了 prelude
    assert.match(code, new RegExp(`vec4 ${SHADERTOY_ENTRY}\\(vec2 fragCoord\\)`));
    // 辅助函数也带进来了
    assert.match(code, /float wave\(vec2 p, float t\)/);
    // 节点表达式真的被调用
    assert.match(code, new RegExp(`${SHADERTOY_ENTRY}\\(gl_FragCoord\\.xy\\)`));
    // 用到的通道被声明成 sampler，否则生成出来的 GLSL 里 iChannel0 是未定义标识符
    assert.ok(
      compiled.channels.includes('iChannel0'),
      `没有收集到 iChannel0：${JSON.stringify(compiled.channels)}`,
    );
    assert.match(code, /uniform sampler2D iChannel0;/);
    // 入口还是生成器那一个，没有重定义
    assert.equal((code.match(/\bvoid\s+main\s*\(/g) ?? []).length, 1, 'main() 出现了不止一次');
  } finally {
    // 注册表是模块级全局，跑完恢复原状，别污染后面的测试文件
    setUserNodes(saved);
  }
});

test('端到端：节点没注册时编译会明确报「不认识的节点」，而不是静默产出坏代码', () => {
  const saved = userNodeDefs();
  try {
    setUserNodes([]);
    const r = importShadertoy(SRC, { name: 'demo' });
    const compiled = compileGraph(r.graph, 'image', {});
    assert.equal(compiled.ok, false, '节点没注册却能编译，说明缺了保护');
    const text = (compiled.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`).join('；');
    assert.match(text, new RegExp(SHADERTOY_NODE_TYPE), `报错里没提到节点类型：${text}`);
  } finally {
    setUserNodes(saved);
  }
});

test('导入时 iFrame / Buffer 的提醒要出现在 warnings 里', () => {
  const src = 'void mainImage(out vec4 o, in vec2 p) { o = texture(BufferA, p) + vec4(float(iFrame)); }';
  const r = importShadertoy(src, { name: 'buf' });
  const text = r.warnings.join(' / ');
  assert.match(text, /iFrame/, `没提醒 iFrame：${text}`);
  assert.match(text, /BufferA/, `没提醒 Buffer：${text}`);
  // 提醒归提醒，导入本身要成功
  assert.equal(r.graph.nodes.length, 2);
});

test('同一个材质名导入两次：节点定义是稳定的（不会越导越乱）', () => {
  const a = importShadertoy(SRC, { name: 'demo' });
  const b = importShadertoy(SRC, { name: 'demo' });
  assert.equal(a.node.type, b.node.type);
  assert.equal(a.prelude, b.prelude, '同样的源码包出来的 prelude 应当逐字相同');
  assert.deepEqual(a.features, b.features);
  // 图里的节点 id 每次新建，所以只比形状不比 id
  assert.equal(a.graph.nodes.length, b.graph.nodes.length);
  assert.equal(a.graph.edges.length, b.graph.edges.length);
});
