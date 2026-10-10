/**
 * codegen 单元测试：节点图 → GLSL。
 *
 * 两种跑法都可以：
 *   node tests/codegen.test.js      ← 直接跑（本沙箱环境只允许这个）
 *   node --test tests/              ← 标准测试收集器
 *
 * 这个文件不碰 WebGL，纯字符串校验，所以无显卡机器也能跑。
 *
 * @module dsh-shader-workbench/tests/codegen.test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeGraph,
  makeNode,
  makeEdge,
  setPassNodes,
  normalizeGraph,
  canConnect,
  conversionKind,
  PORT_TYPES,
} from '../shared/graph.js';
import { compileGraph, castExpr, glslLiteral } from '../client/runtime/codegen.js';

/**
 * 造一张单 Pass 图。
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {object[]} [uniforms]
 * @returns {object}
 */
function graphOf(nodes, edges, uniforms = []) {
  const graph = makeGraph({ nodes, edges, uniforms });
  setPassNodes(
    graph,
    'image',
    nodes.map((n) => n.id),
  );
  return graph;
}

test('最简图：常量接输出，生成完整着色器', () => {
  const c = makeNode('const', 0, 0, { value: [1, 0.5, 0.25], outType: 'vec3' });
  const o = makeNode('output', 200, 0);
  const graph = graphOf([c, o], [makeEdge(c.id, 'out', o.id, 'color')]);

  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /#version|precision highp float/);
  assert.match(result.code, /void main\(\)/);
  // vec3 常量提升成 vec4 时 alpha 必须补 1.0，否则画面全透明
  assert.match(result.code, /st_fragColor = vec4\(\(n_\w+\)\.x, \(n_\w+\)\.y, \(n_\w+\)\.z, 1\.0\);/);
});

test('缺少输出节点时报错而不是崩', () => {
  const uv = makeNode('uv', 0, 0);
  const graph = graphOf([uv], []);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'no-output'));
});

test('空 Pass 报 empty-pass', () => {
  const graph = makeGraph();
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'empty-pass'));
});

test('成环被检测出来，不无限递归', () => {
  const a = makeNode('add', 0, 0);
  const b = makeNode('add', 200, 0);
  const o = makeNode('output', 400, 0);
  const graph = graphOf(
    [a, b, o],
    [
      makeEdge(a.id, 'out', b.id, 'a'),
      makeEdge(b.id, 'out', a.id, 'a'),
      makeEdge(b.id, 'out', o.id, 'color'),
    ],
  );
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'cycle'), JSON.stringify(result.errors));
});

test('uv → scaleP → 输出，能带上 iResolution 与 gl_FragCoord', () => {
  const uv = makeNode('uv', 0, 0);
  const scale = makeNode('scaleP', 200, 0, {});
  const o = makeNode('output', 400, 0);
  const graph = graphOf(
    [uv, scale, o],
    [makeEdge(uv.id, 'out', scale.id, 'p'), makeEdge(scale.id, 'out', o.id, 'color')],
  );
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /gl_FragCoord\.xy \/ iResolution\.xy/);
  assert.match(result.code, /uniform vec3 iResolution;/);
});

test('未接线的输入用端口缺省值（scale 端口 def=4）', () => {
  const p = makeNode('scaleP', 0, 0, {});
  const o = makeNode('output', 200, 0);
  const graph = graphOf([p, o], [makeEdge(p.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // p 没接线 → vec2(0.0)；scale 端口 def=4 → 4.0；vec2 提到 vec4 时 z 补 0、w 补 1
  assert.match(result.code, /vec2 n_\w+ = \(vec2\(0\.0\)\) \* \(4\.0\);/);
  assert.match(result.code, /st_fragColor = vec4\(\(n_\w+\)\.x, \(n_\w+\)\.y, 0\.0, 1\.0\);/);
});

test('纹理节点会登记 iChannel 并生成 sampler 声明', () => {
  const tex = makeNode('texture', 0, 0, { channel: 'iChannel2' });
  const o = makeNode('output', 200, 0);
  const graph = graphOf([tex, o], [makeEdge(tex.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.channels, ['iChannel2']);
  assert.match(result.code, /uniform sampler2D iChannel2;/);
  assert.match(result.code, /texture\(iChannel2,/);
  // 没登记的通道不能出现
  assert.doesNotMatch(result.code, /uniform sampler2D iChannel0;/);
});

test('Buffer 采样生成 BufferA 声明', () => {
  const buf = makeNode('bufferSample', 0, 0, { buffer: 'BufferB' });
  const o = makeNode('output', 200, 0);
  const graph = graphOf([buf, o], [makeEdge(buf.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /uniform sampler2D BufferB;/);
  assert.deepEqual(result.buffers, ['BufferB']);
});

test('noise 节点自动带上 st_hash 与 st_noise 依赖', () => {
  const noise = makeNode('noise', 0, 0);
  const o = makeNode('output', 200, 0);
  const graph = graphOf([noise, o], [makeEdge(noise.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.helpers, ['st_hash', 'st_noise']);
  assert.match(result.code, /float st_hash\(vec2 p\)/);
  assert.match(result.code, /float st_noise\(vec2 p\)/);
  // fbm 的辅助函数不该被拖进来
  assert.doesNotMatch(result.code, /st_fbm/);
});

test('mat4 类型端口转换：float 输入接 vec3 输出时取 .x', () => {
  const rgb = makeNode('rgb', 0, 0, { color: [1, 0, 0] });
  const mul = makeNode('mul', 200, 0);
  const o = makeNode('output', 400, 0);
  // rgb.out 是 vec3，mul.a 是 vec4 → 应补 vec4(vec3, 1.0)（alpha 补 1）
  const graph = graphOf(
    [rgb, mul, o],
    [makeEdge(rgb.id, 'out', mul.id, 'a'), makeEdge(mul.id, 'out', o.id, 'color')],
  );
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /vec4\(\(n_\w+\)\.x, \(n_\w+\)\.y, \(n_\w+\)\.z, 1\.0\)/);
});

test('多 Pass：BufferA 与 image 各自独立编译', () => {
  const t = makeNode('time', 0, 0, {});
  const bufOut = makeNode('output', 200, 0);
  const bufSample = makeNode('bufferSample', 0, 200, { buffer: 'BufferA' });
  const imgOut = makeNode('output', 200, 200);
  const graph = makeGraph({
    nodes: [t, bufOut, bufSample, imgOut],
    edges: [makeEdge(t.id, 'out', bufOut.id, 'color'), makeEdge(bufSample.id, 'out', imgOut.id, 'color')],
  });
  setPassNodes(graph, 'BufferA', [t.id, bufOut.id]);
  setPassNodes(graph, 'image', [bufSample.id, imgOut.id]);

  const bufferA = compileGraph(graph, 'BufferA');
  const image = compileGraph(graph, 'image');
  assert.equal(bufferA.ok, true, JSON.stringify(bufferA.errors));
  assert.equal(image.ok, true, JSON.stringify(image.errors));
  assert.match(bufferA.code, /uniform int iFrame;/);
  assert.doesNotMatch(image.code, /uniform int iFrame;/);
  assert.match(image.code, /uniform sampler2D BufferA;/);
});

test('自定义 uniform 会写进声明', () => {
  const u = makeNode('uniform', 0, 0, { name: 'uSpeed', outType: 'float' });
  const o = makeNode('output', 200, 0);
  const graph = graphOf([u, o], [makeEdge(u.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image', { uniforms: { uSpeed: 1.5 } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /uniform float uSpeed;/);
  assert.match(result.code, /uSpeed/);
});

test('split 节点输出的分量映射正确', () => {
  const mouse = makeNode('mouse', 0, 0);
  const split = makeNode('split', 200, 0);
  const o = makeNode('output', 400, 0);
  const graph = graphOf(
    [mouse, split, o],
    [makeEdge(mouse.id, 'out', split.id, 'in'), makeEdge(split.id, 'y', o.id, 'color')],
  );
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /\(n_\w+\)\.y/);
});

test('未知节点类型报 unknown-node', () => {
  const weird = makeNode('not-a-real-node', 0, 0);
  const o = makeNode('output', 200, 0);
  const graph = graphOf([weird, o], [makeEdge(weird.id, 'out', o.id, 'color')]);
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'unknown-node'));
});

test('castExpr 各种组合', () => {
  assert.equal(castExpr('x', 'float', 'float'), 'x');
  assert.equal(castExpr('x', 'float', 'vec3'), 'vec3(x)');
  assert.equal(castExpr('x', 'vec3', 'float'), '(x).x');
  assert.equal(castExpr('x', 'vec2', 'vec4'), 'vec4((x).x, (x).y, 0.0, 1.0)');
  assert.equal(castExpr('x', 'vec4', 'vec2'), 'vec2((x).x, (x).y)');
});

test('glslLiteral 补位规则：vec4 第四位缺省补 1', () => {
  assert.equal(glslLiteral([1, 0, 0], 'vec4'), 'vec4(1.0, 0.0, 0.0, 1.0)');
  assert.equal(glslLiteral(3, 'float'), '3.0');
  assert.equal(glslLiteral(0.5, 'vec2'), 'vec2(0.5, 0.0)');
  assert.equal(glslLiteral(undefined, 'vec3'), 'vec3(0.0)');
});

test('normalizeGraph 丢掉非法数据且不抛错', () => {
  const normalized = normalizeGraph({
    nodes: [{ id: 'a', type: 'uv' }, null, { id: 'a', type: 'uv' }, { type: '' }],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'ghost', port: 'color' } }],
  });
  assert.equal(normalized.nodes.length, 1);
  assert.equal(normalized.edges.length, 0);
  assert.ok(normalized.warnings.length >= 2);
});

// ───────────────────── 连接规则 ─────────────────────
// 这组用例的来由：编辑器的 canConnect 曾经只允许「同类型或带 float」，
// 而生成器 castExpr 对 4×4 种组合都有确定规则——两边不一致，
// 导致 uv(vec2) → output(vec4) 这种最基本的连法在 UI 上被拒绝，
// 而内置模板又绕过检查直接连。下面把「编辑器允许的」和「生成器能生成的」锁在一起。

test('canConnect 对任意两种合法类型都放行（与生成器能力一致）', () => {
  for (const from of PORT_TYPES) {
    for (const to of PORT_TYPES) {
      assert.equal(canConnect(from, to), true, `${from} → ${to} 应该可连`);
    }
  }
  assert.equal(canConnect('vec2', 'vec5'), false, '非法类型名要拒');
  assert.equal(canConnect(undefined, 'vec4'), false);
});

test('conversionKind 描述每种转换的种类', () => {
  assert.equal(conversionKind('vec3', 'vec3'), 'exact');
  assert.equal(conversionKind('float', 'float'), 'exact');
  assert.equal(conversionKind('float', 'vec4'), 'broadcast');
  assert.equal(conversionKind('vec2', 'vec4'), 'extend');
  assert.equal(conversionKind('vec3', 'vec4'), 'extend');
  assert.equal(conversionKind('vec4', 'vec2'), 'truncate');
  assert.equal(conversionKind('vec3', 'float'), 'truncate');
  assert.equal(conversionKind('vec2', 'vec5'), 'invalid');
});

test('canConnect 放行的每一种组合都能真的生成出 GLSL 并编译', () => {
  // 用「常量 → 输出」把 16 种组合全跑一遍：只要 canConnect 说能连，
  // 生成器就必须能产出代码（这是两边的一致性契约）
  for (const from of PORT_TYPES) {
    for (const to of PORT_TYPES) {
      const source = makeNode('const', 0, 0, {
        value: from === 'float' ? 0.5 : Array.from({ length: Number(from.slice(3)) }, (_, i) => (i + 1) / 4),
        outType: from,
      });
      const sink = makeNode('custom', 200, 0, { expr: '$in.a' });
      const out = makeNode('output', 400, 0);
      const graph = makeGraph({
        nodes: [source, sink, out],
        edges: [
          makeEdge(source.id, 'out', sink.id, 'a'),
          makeEdge(sink.id, 'out', out.id, 'color'),
        ],
      });
      setPassNodes(
        graph,
        'image',
        graph.nodes.map((n) => n.id),
      );
      const result = compileGraph(graph, 'image');
      assert.equal(
        result.ok,
        true,
        `canConnect 放行的 ${from} → ${to} 生成失败：${JSON.stringify(result.errors)}`,
      );
      // 生成的代码里必须能看到一次针对 sink.a 端口的转换
      assert.match(result.code, /void main\(\)/, `${from} → ${to} 没生成出 main`);
    }
  }
});

test('uv(vec2) 直连 output(vec4) 能编译，且 alpha 补 1 而不是 0', () => {
  // 这是踩过的那个坑：alpha 补 0 会让整个画面全透明
  const uv = makeNode('uv', 0, 0);
  const out = makeNode('output', 200, 0);
  const graph = makeGraph({ nodes: [uv, out], edges: [makeEdge(uv.id, 'out', out.id, 'color')] });
  setPassNodes(
    graph,
    'image',
    graph.nodes.map((n) => n.id),
  );
  const result = compileGraph(graph, 'image');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.code, /st_fragColor = vec4\(\(n_\w+\)\.x, \(n_\w+\)\.y, 0\.0, 1\.0\);/);
});
