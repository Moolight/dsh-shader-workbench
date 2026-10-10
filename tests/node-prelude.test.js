/**
 * `glslPrelude` 机制测试。
 *
 * 生成器的约定是「每个节点 = 一条 `vec4 x = 表达式;`」，循环装不进去，
 * 只能靠 `glslPrelude` 注入到 `main()` 之前。这套机制得有人守着：
 *
 *   1. prelude 只在用到该节点类型时进 shader；
 *   2. 同一类型出现多次也只注入一份（否则函数重定义，编译直接炸）；
 *   3. 它不能污染 helper 闭包；
 *   4. 参数真的替换进了调用点。
 *
 * 探针节点是**测试自己造的**（`loopProbe`），不依赖任何随包发布的节点 ——
 * 效果专用节点已经全部拆成普通节点铺在画布上了（见
 * `scripts/rebuild-primitive-demos.mjs`）。那种"藏在 prelude 里的黑盒"现在是
 * **反面样本**，不该再出现在示例里；机制本身还有用（用户节点靠它），
 * 所以留一个自造样本继续守着。
 *
 * 跑法：node tests/node-prelude.test.js
 *
 * @module dsh-shader-workbench/tests/node-prelude
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { makeEdge, makeGraph, makeNode, setPassNodes } from '../shared/graph.js';
import { NODE_LIBRARY, getNodeDef, nodeSourceOf, setUserNodes } from '../shared/nodes.js';
import { parseUserNodeDefinition } from '../shared/user-nodes.js';
import { compileGraph } from '../client/runtime/codegen.js';

const node = (type, x, y, params) => makeNode(type, x, y, params ?? {});

/** 测试自造的探针节点：带一个 break 的循环 + 两个参数。 */
const PROBE_TYPE = 'loopProbe';
const PROBE = parseUserNodeDefinition(
  {
    type: PROBE_TYPE,
    title: '循环探针',
    category: '自定义',
    inputs: [
      { id: 'uv', type: 'vec2', def: 0 },
      { id: 'time', type: 'float', def: 0 },
    ],
    outputs: [{ id: 'out', type: 'vec4' }],
    params: {
      steps: { type: 'int', value: 64, min: 1, max: 128, label: '步数' },
      gain: { type: 'float', value: 1, min: 0, max: 4, label: '增益' },
    },
    glslPrelude: [
      'vec4 st_loopProbe(vec2 uv, float t, int steps, float gain) {',
      '  float acc = 0.0;',
      '  for (int i = 0; i < 128; i++) {',
      '    if (i >= steps) break;',
      '    acc += sin(float(i) * 0.3 + t) * gain;',
      '  }',
      '  return vec4(uv, acc, 1.0);',
      '}',
    ].join('\n'),
    code: 'st_loopProbe($in.uv, $in.time, $p.steps, $p.gain)',
  },
  'loopProbe.json',
);

// ⚠️ 必须在 before 里注册，不能在模块顶层：run-tests.mjs 是**同一个进程顺序 import**
// 所有测试文件（沙箱下带管道的 spawn 会被拒），模块级副作用会漏给后面的文件，
// 把 node-registry.test.js 的节点计数断言带崩。踩过。
before(() => {
  setUserNodes([PROBE]);
});

after(() => {
  // 注册表是进程级的，测完还回去，别影响同进程跑的其它测试文件
  setUserNodes([]);
});

/**
 * 造一张图：uv / time → N 个探针节点 → output。
 * N=2 时用 add 把两路合起来，专门验 prelude 去重。
 * @param {number} count
 * @param {object} [params] 第一个节点的参数
 * @returns {object}
 */
function graphWithProbes(count, params) {
  const uv = node('uv', 0, 0);
  const time = node('time', 0, 140);
  const made = [];
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    const t = node(PROBE_TYPE, 240, i * 200, i === 0 ? params : undefined);
    made.push(t);
    edges.push(makeEdge(uv.id, 'out', t.id, 'uv'));
    edges.push(makeEdge(time.id, 'out', t.id, 'time'));
  }

  const all = [uv, time, ...made];
  let tail = made[0];
  if (made.length > 1) {
    const add = node('add', 620, 0);
    all.push(add);
    edges.push(makeEdge(made[0].id, 'out', add.id, 'a'));
    edges.push(makeEdge(made[1].id, 'out', add.id, 'b'));
    tail = add;
  }
  const out = node('output', 880, 0);
  all.push(out);
  edges.push(makeEdge(tail.id, 'out', out.id, 'color'));

  const graph = makeGraph({ name: 'prelude-probe', nodes: all, edges });
  setPassNodes(
    graph,
    'image',
    all.map((n) => n.id),
  );
  return graph;
}

test('示例里不许再出现"藏 prelude 的专用节点"', () => {
  // 那次拆分留下的护栏：那几个效果专用节点先后做过「内置节点」和「示例自带的
  // 用户节点」，两次都是黑盒（画布上展不开、改不了）。现在它们被拆成了普通节点，
  // 谁都不许再把黑盒塞回来。
  for (const type of ['ifsTunnel', 'fourierSeries', 'epicycles']) {
    assert.notEqual(nodeSourceOf(type), 'builtin', `${type} 又回到内置节点库里了`);
    assert.equal(nodeSourceOf(type), null, `${type} 又作为用户节点被注册了 —— 示例不该带黑盒`);
  }
});

test('用户节点带着 prelude 时，定义能正常解析出来', () => {
  const def = getNodeDef(PROBE_TYPE);
  assert.ok(def, '注册表里没有探针节点');
  assert.equal(def.userDefined, true);
  assert.deepEqual(
    def.inputs.map((p) => p.id),
    ['uv', 'time'],
  );
  assert.ok(def.glslPrelude.length > 100, 'prelude 太短，像是没写完');
  assert.match(def.glslPrelude, /vec4 st_loopProbe\(/);
  // 表达式里不能有 for —— 生成器只会把它拼进 `vec4 x = <表达式>;`
  assert.ok(!/for\s*\(/.test(def.code), 'code 必须是单条表达式，循环要放 glslPrelude');
});

test('成图：编译通过、循环进 prelude、helper 闭包干净', () => {
  const result = compileGraph(graphWithProbes(1), 'image', { uniforms: {} });

  assert.deepEqual(result.errors, [], `不该有错：${JSON.stringify(result.errors)}`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.helpers, [], '这个节点不该拖进任何 st_* helper');

  assert.equal(
    (result.code.match(/vec4 st_loopProbe\(vec2/g) ?? []).length,
    1,
    'prelude 里应该有且只有一份定义',
  );
  assert.match(result.code, /=\s*st_loopProbe\(/, 'main 里应该真的调用了它');
  assert.match(result.code, /for \(int i = 0; i < 128; i\+\+\)/, '循环应该在生成的代码里');
  assert.match(result.code, /if \(i >= steps\) break;/, 'break 守卫应该在生成的代码里');
  assert.ok(
    result.code.indexOf('vec4 st_loopProbe(vec2') < result.code.indexOf('void main()'),
    'prelude 必须在 main() 之前',
  );
});

test('同一类型出现两个节点时，prelude 只注入一次', () => {
  const result = compileGraph(graphWithProbes(2), 'image', { uniforms: {} });
  assert.deepEqual(result.errors, []);
  assert.equal(
    (result.code.match(/vec4 st_loopProbe\(vec2/g) ?? []).length,
    1,
    '注入了两份定义 → GLSL 函数重定义，编译会炸',
  );
  assert.equal((result.code.match(/=\s*st_loopProbe\(/g) ?? []).length, 2, '两个节点应该各调用一次');
});

test('节点参数替换进调用点', () => {
  const result = compileGraph(graphWithProbes(1, { steps: 7, gain: 5.5 }), 'image', { uniforms: {} });
  assert.deepEqual(result.errors, []);
  // 注意别匹配到 prelude 里的函数定义，要的是 main 里的调用点
  const call = result.code.match(/=\s*st_loopProbe\([^;]*;/)?.[0] ?? '';
  assert.match(call, /,\s*7,\s*5\.5\)/, `参数没替换进去：${call}`);
});

test('不用这个节点时，prelude 一个字符都不进 shader', () => {
  const uv = node('uv', 0, 0);
  const out = node('output', 300, 0);
  const graph = makeGraph({ name: 'plain', nodes: [uv, out], edges: [makeEdge(uv.id, 'out', out.id, 'color')] });
  setPassNodes(graph, 'image', [uv.id, out.id]);
  const result = compileGraph(graph, 'image', { uniforms: {} });
  assert.deepEqual(result.errors, []);
  assert.ok(!result.code.includes('st_loopProbe'), '没用到却把 prelude 塞进去了');
});

test('没装这个用户节点时，图会明确报「不认识的节点类型」', () => {
  // "忘了装库文件" 是用户节点唯一的失败模式，得给一句能看懂的话
  setUserNodes([]);
  try {
    const result = compileGraph(graphWithProbes(1), 'image', { uniforms: {} });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.code === 'unknown-node' && e.message.includes(PROBE_TYPE)),
      `报错没说清楚：${JSON.stringify(result.errors)}`,
    );
  } finally {
    setUserNodes([PROBE]);
  }
});

test('内置库里带 prelude 的只剩通用件', () => {
  const withPrelude = NODE_LIBRARY.filter((n) => n.glslPrelude && nodeSourceOf(n.type) === 'builtin').map((n) => n.type);
  assert.deepEqual(withPrelude, ['hsv'], `内置库里出现了效果专用 prelude：${withPrelude.join(', ')}`);
});
