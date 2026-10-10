/**
 * 节点注册表 / 用户节点 / 组（Group）元节点测试。
 *
 * 守的是这个抱怨：**"不可能每次新增节点就要重启"**。
 *
 * 根因是 `shared/nodes.js` 里那三个模块级常量在**首次 import 那一刻**就被算死、
 * 还冻结了；宿主是静态 import，进程活着就永远是旧的一份，只能重启。
 *
 * 现在它们是**同一批对象、原地重建**：注册表一变，所有持有者自动跟着变。
 * 这个文件的核心断言就是"**引用没变、内容变了**"。
 *
 * 跑法：node tests/node-registry.test.js
 *
 * @module dsh-shader-workbench/tests/node-registry
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_BY_TYPE,
  NODE_CATEGORIES,
  NODE_LIBRARY,
  getNodeDef,
  nodeLibraryVersion,
  nodeSourceOf,
  resolvePorts,
  setUserNodes,
  userNodeDefs,
} from '../shared/nodes.js';
import { parseUserNodeDefinition, parseUserNodeFiles } from '../shared/user-nodes.js';
import { makeEdge, makeGraph, makeNode, setPassNodes } from '../shared/graph.js';
import { compileGraph } from '../client/runtime/codegen.js';

// 注册表是进程级的，测完必须还回去，否则同进程跑的其它测试文件会看到多出来的节点
const beforeCount = NODE_LIBRARY.length;
const beforeVersion = nodeLibraryVersion();
after(() => {
  setUserNodes([]);
  assert.equal(NODE_LIBRARY.length, beforeCount, '测试没有把节点库还原');
});

const SAMPLE = {
  type: 'testGlow',
  title: '测试辉光',
  category: '自定义',
  inputs: [{ id: 'uv', type: 'vec2', label: 'uv', def: 0 }],
  outputs: [{ id: 'out', type: 'vec4' }],
  params: { gain: { type: 'float', value: 2, min: 0, max: 4, label: '增益' } },
  glslPrelude: 'vec4 st_testGlow(vec2 uv, float g) { return vec4(uv, 0.25, 1.0) * g; }',
  code: 'st_testGlow($in.uv, $p.gain)',
  defaults: { uv: 0 },
};

test('注册表原地重建：引用不变、内容跟着变（这就是不用重启的原因）', () => {
  const libraryRef = NODE_LIBRARY;
  const byTypeRef = NODE_BY_TYPE;
  const categoriesRef = NODE_CATEGORIES;
  const versionBefore = nodeLibraryVersion();

  const { registered, skipped } = setUserNodes([parseUserNodeDefinition(SAMPLE, 'sample.json')]);
  assert.deepEqual(registered, ['testGlow']);
  assert.deepEqual(skipped, []);

  // ★ 关键：还是同一批对象，没被重新赋值或冻结 —— 所有持有者自动看到新节点
  assert.equal(NODE_LIBRARY, libraryRef, 'NODE_LIBRARY 被换成了新数组，持有者会看不到新节点');
  assert.equal(NODE_BY_TYPE, byTypeRef, 'NODE_BY_TYPE 被换成了新 Map');
  assert.equal(NODE_CATEGORIES, categoriesRef, 'NODE_CATEGORIES 被换成了新数组');

  assert.equal(NODE_LIBRARY.length, beforeCount + 1);
  assert.ok(getNodeDef('testGlow'), 'getNodeDef 拿不到用户节点');
  assert.equal(nodeSourceOf('testGlow'), 'user');
  assert.equal(nodeSourceOf('uv'), 'builtin');
  assert.ok(NODE_CATEGORIES.includes('自定义'));
  assert.ok(nodeLibraryVersion() > versionBefore);
  assert.equal(userNodeDefs().length, 1);
});

test('用户节点不能顶掉内置节点；用户之间重名先到先得', () => {
  const clash = parseUserNodeDefinition({ ...SAMPLE, type: 'uv' }, 'clash.json');
  const dup = parseUserNodeDefinition({ ...SAMPLE, type: 'dup' }, 'a.json');
  const dup2 = parseUserNodeDefinition({ ...SAMPLE, type: 'dup' }, 'b.json');

  const { registered, skipped } = setUserNodes([clash, dup, dup2]);
  assert.deepEqual(registered, ['dup']);
  assert.deepEqual(skipped.sort(), ['dup', 'uv']);
  assert.equal(getNodeDef('uv').userDefined, undefined, '内置 uv 被用户节点覆盖了');
});

test('用户节点校验：写错了要当场报清楚', () => {
  const cases = [
    [{ ...SAMPLE, code: 'a; b' }, /不能有分号/],
    [{ ...SAMPLE, type: '2bad' }, /type 必须是标识符/],
    [{ ...SAMPLE, title: '' }, /title 不能为空/],
    [{ ...SAMPLE, inputs: [{ id: 'uv', type: 'mat4' }] }, /type 非法/],
    [{ ...SAMPLE, params: { g: { type: 'blah' } } }, /params\.g\.type 非法/],
    [{ ...SAMPLE, inputs: [{ id: 'a', type: 'vec2' }, { id: 'a', type: 'vec2' }] }, /重复的端口 id/],
  ];
  for (const [raw, re] of cases) {
    assert.throws(() => parseUserNodeDefinition(raw, 'bad.json'), (error) => {
      assert.match(error.message, re);
      assert.match(error.message, /bad\.json/, '错误信息里要带上是哪个文件');
      return true;
    });
  }
});

test('parseUserNodeFiles：坏文件不拖垮整批', () => {
  const good = SAMPLE;
  const { defs, errors } = parseUserNodeFiles([
    { name: 'good.json', json: good },
    { name: 'broken.json', json: { type: 'x' } },
    { name: 'dup.json', json: good },
  ]);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].type, 'testGlow');
  assert.equal(errors.length, 2);
  assert.match(errors[0].source, /broken\.json/);
  assert.match(errors[1].message, /重复/);
});

test('注册了用户节点之后，建图 + 编译立刻能用（不用重启进程）', () => {
  setUserNodes([parseUserNodeDefinition(SAMPLE, 'sample.json')]);

  const uv = makeNode('uv', 0, 0);
  const mine = makeNode('testGlow', 240, 0);
  const out = makeNode('output', 520, 0);
  const graph = makeGraph({
    name: 'user-node',
    nodes: [uv, mine, out],
    edges: [makeEdge(uv.id, 'out', mine.id, 'uv'), makeEdge(mine.id, 'out', out.id, 'color')],
  });
  setPassNodes(graph, 'image', [uv.id, mine.id, out.id]);

  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  assert.deepEqual(compiled.errors, []);
  assert.equal(compiled.ok, true);
  assert.match(compiled.code, /vec4 st_testGlow\(vec2 uv, float g\)/, 'prelude 没进 shader');
  assert.match(compiled.code, /st_testGlow\(/, '没调用用户节点的 code');
  assert.match(compiled.code, /2\.0/, '参数没替换进去');
});

// ───────────────────────── 组（Group）元节点 ─────────────────────────

/**
 * 造一个"组"节点：子图 = 组输入 → custom → 组输出。
 * @param {object} [opts]
 * @param {boolean} [opts.empty] 造一个空的组（还没打内容）
 * @param {boolean} [opts.dropOutput] 故意不给组输出节点
 * @returns {object} 组节点
 */
function makeGroupNode(opts = {}) {
  const graph = opts.empty
    ? null
    : {
        name: '把 uv 变成颜色',
        inputs: [{ id: 'uv', label: 'uv', type: 'vec2' }],
        outputs: [{ id: 'out', label: 'color', type: 'vec4' }],
        nodes: [
          { id: 'gi', type: 'groupInput', x: 0, y: 0, params: { port: 'uv', type: 'vec2' } },
          { id: 'c1', type: 'custom', x: 160, y: 0, params: { expr: 'vec4($in.a, 0.25, 1.0)' } },
          ...(opts.dropOutput
            ? []
            : [{ id: 'go', type: 'groupOutput', x: 320, y: 0, params: { port: 'out', type: 'vec4' } }]),
        ],
        edges: [
          { from: { node: 'gi', port: 'out' }, to: { node: 'c1', port: 'a' } },
          ...(opts.dropOutput ? [] : [{ from: { node: 'c1', port: 'out' }, to: { node: 'go', port: 'color' } }]),
        ],
      };
  return makeNode('group', 0, 0, { graph });
}

test('组节点：端口由子图定义决定', () => {
  const groupNode = makeGroupNode();
  assert.deepEqual(
    resolvePorts(groupNode, 'in').map((p) => `${p.id}:${p.type}`),
    ['uv:vec2'],
  );
  assert.deepEqual(
    resolvePorts(groupNode, 'out').map((p) => `${p.id}:${p.type}`),
    ['out:vec4'],
  );
  // 没内容的组不该有端口，也不该崩
  assert.deepEqual(resolvePorts(makeGroupNode({ empty: true }), 'in'), []);
});

test('组节点：生成时子图被内联展开，外层输入真的接进去了', () => {
  const uv = makeNode('uv', 0, 0);
  const groupNode = makeGroupNode();
  const out = makeNode('output', 520, 0);
  const graph = makeGraph({
    name: 'group-inline',
    nodes: [uv, groupNode, out],
    edges: [makeEdge(uv.id, 'out', groupNode.id, 'uv'), makeEdge(groupNode.id, 'out', out.id, 'color')],
  });
  setPassNodes(graph, 'image', [uv.id, groupNode.id, out.id]);

  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  assert.deepEqual(compiled.errors, [], `组展开报错：${JSON.stringify(compiled.errors)}`);
  assert.equal(compiled.ok, true);
  // 外层的 uv 表达式应该被喂进子图（uv 节点的 GLSL 就是 gl_FragCoord / iResolution）
  assert.match(compiled.code, /gl_FragCoord\.xy \/ iResolution\.xy/, '外层输入没接进组');
  assert.match(compiled.code, /vec4\(/, '子图里的 custom 没被展开');
  // 内部标记不该漏进最终 GLSL
  assert.ok(!compiled.code.includes('GROUP_INPUT'), 'GROUP_INPUT 占位符漏进 shader');
  assert.ok(!compiled.code.includes('GROUP_OUTPUT'), 'GROUP_OUTPUT 占位符漏进 shader');
});

test('组节点：空组 / 缺组输出都给出能看懂的报错', () => {
  const build = (groupNode) => {
    const out = makeNode('output', 520, 0);
    const graph = makeGraph({
      name: 'group-bad',
      nodes: [groupNode, out],
      edges: [makeEdge(groupNode.id, 'out', out.id, 'color')],
    });
    setPassNodes(graph, 'image', [groupNode.id, out.id]);
    return compileGraph(graph, 'image', { uniforms: {} });
  };

  const empty = build(makeGroupNode({ empty: true }));
  assert.equal(empty.ok, false);
  assert.ok(
    empty.errors.some((e) => e.code === 'empty-group'),
    `空组没报 empty-group：${JSON.stringify(empty.errors)}`,
  );

  const missing = build(makeGroupNode({ dropOutput: true }));
  assert.equal(missing.ok, false);
  assert.ok(
    missing.errors.some((e) => e.code === 'group-output-missing'),
    `缺组输出没报错：${JSON.stringify(missing.errors)}`,
  );
});

test('重复组：循环体只写一遍，生成 for 循环（不是复制 N 份）', () => {
  // 性能护栏的核心：把「重复」写成「复制」，99 步就是 676 KB 着色器、面板加载卡死。
  const step = {
    name: '累加一步',
    carries: ['acc'],
    inputs: [
      { id: 'k', label: '步长', type: 'float' },
      { id: 'acc', label: '累加', type: 'vec4' },
    ],
    outputs: [{ id: 'acc', label: '累加', type: 'vec4' }],
    nodes: [
      { id: 'gi_k', type: 'groupInput', x: 0, y: 0, params: { port: 'k', type: 'float' } },
      { id: 'gi_acc', type: 'groupInput', x: 0, y: 120, params: { port: 'acc', type: 'vec4' } },
      { id: 'i', type: 'loopIndex', x: 200, y: 240 },
      { id: 'add', type: 'custom', x: 200, y: 0, params: { expr: 'vec4($in.a.x + $in.b.x * $in.c, 0.0, 0.0, 1.0)' } },
      { id: 'go', type: 'groupOutput', x: 460, y: 0, params: { port: 'acc', type: 'vec4' } },
    ],
    edges: [
      { from: { node: 'gi_acc', port: 'out' }, to: { node: 'add', port: 'a' } },
      { from: { node: 'gi_k', port: 'out' }, to: { node: 'add', port: 'b' } },
      { from: { node: 'i', port: 'out' }, to: { node: 'add', port: 'c' } },
      { from: { node: 'add', port: 'out' }, to: { node: 'go', port: 'color' } },
    ],
  };

  const uv = makeNode('uv', 0, 0);
  const kconst = makeNode('custom', 0, 160, { expr: 'vec4(0.5)' });
  const seed = makeNode('custom', 0, 300, { expr: 'vec4(0.0)' });
  const loop = makeNode('group', 300, 0, { repeat: 99, graph: step });
  const out = makeNode('output', 620, 0);
  const graph = makeGraph({
    name: 'repeat-probe',
    nodes: [uv, kconst, seed, loop, out],
    edges: [
      makeEdge(kconst.id, 'out', loop.id, 'k'),
      makeEdge(seed.id, 'out', loop.id, 'acc'),
      makeEdge(loop.id, 'acc', out.id, 'color'),
    ],
  });
  setPassNodes(graph, 'image', [uv.id, kconst.id, seed.id, loop.id, out.id]);

  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  assert.deepEqual(compiled.errors, [], `重复组编译不过：${JSON.stringify(compiled.errors)}`);
  assert.equal(compiled.ok, true);

  const body = compiled.code.slice(compiled.code.indexOf('void main()'));
  assert.equal((body.match(/for \(int /g) ?? []).length, 1, '应该只有一个 for 循环');
  assert.match(body, /< 99;/, '循环次数应该是 99');
  assert.match(body, /float\([A-Za-z0-9_]+_i\)/, 'loopIndex 没进表达式');

  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const declIdx = lines.findIndex((l) => l.startsWith('vec4 ') && /_c_[A-Za-z0-9_]*acc = /.test(l));
  const forIdx = lines.findIndex((l) => l.startsWith('for (int '));
  assert.ok(declIdx >= 0, '没有 carry 变量的声明');
  assert.ok(forIdx > declIdx, 'carry 要在循环之前声明');
  assert.ok(
    lines.slice(forIdx).some((l) => /_c_[A-Za-z0-9_]*acc = /.test(l)),
    '循环里没有把新值写回 carry',
  );
});

test('loopIndex 放在循环外面会明确报错', () => {
  const idx = makeNode('loopIndex', 200, 0);
  const out = makeNode('output', 500, 0);
  const graph = makeGraph({
    name: 'loop-index-outside',
    nodes: [idx, out],
    edges: [makeEdge(idx.id, 'out', out.id, 'color')],
  });
  setPassNodes(graph, 'image', [idx.id, out.id]);
  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  assert.equal(compiled.ok, false);
  assert.ok(
    compiled.errors.some((e) => e.code === 'loop-index-outside'),
    `报错不对：${JSON.stringify(compiled.errors)}`,
  );
});

test('多输出节点按端口分别缓存（split 的 x 和 y 不能是同一个表达式）', () => {
  const uv = makeNode('uv', 0, 0);
  const split = makeNode('split', 200, 0);
  const add = makeNode('add', 400, 0);
  const out = makeNode('output', 620, 0);
  const graph = makeGraph({
    name: 'multi-out',
    nodes: [uv, split, add, out],
    edges: [
      makeEdge(uv.id, 'out', split.id, 'in'),
      makeEdge(split.id, 'x', add.id, 'a'),
      makeEdge(split.id, 'y', add.id, 'b'),
      makeEdge(add.id, 'out', out.id, 'color'),
    ],
  });
  setPassNodes(graph, 'image', [uv.id, split.id, add.id, out.id]);

  const compiled = compileGraph(graph, 'image', { uniforms: {} });
  assert.deepEqual(compiled.errors, []);
  // 只在 main 里找调用点，别抓到 helper 的定义行
  const body = compiled.code.slice(compiled.code.indexOf('void main()'));
  const line = body.split('\n').find((l) => l.includes('st_add(')) ?? '';
  assert.match(line, /\)\.x/, `没有取 x 分量：${line}`);
  assert.match(line, /\)\.y/, `没有取 y 分量（缓存串了）：${line}`);
});
