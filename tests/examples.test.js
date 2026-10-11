/**
 * 自带示例（`examples/`）测试。
 *
 * 为什么值得测：示例是**随插件分发的交付物**，它一旦坏掉，用户拿到的就是
 * "点了载入示例没反应"。而且示例图引用了节点库里的节点 —— 哪天节点被改名、
 * 删掉、或者 prelude 写坏，这里会立刻炸，而不是等到用户在面板里点。
 *
 * 所以核心那条是「**把每个示例的每个材质都真编译一遍**」，而不是只挑一个。
 *
 * 另外还守着一条纪律：**效果专用节点随示例走**（`examples/<名>/library/nodes/`），
 * 不再往内置节点库里塞。所以编译之前必须先把示例自带的库装进工作区 ——
 * 这正是面板里「载入示例」做的事，这里走的是同一条路。
 *
 * 跑法：node tests/examples.test.js
 *
 * @module dsh-shader-workbench/tests/examples
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { examplesRoot, listExamples, loadExample, listExampleLibrary } from '../host/examples.js';
import { resetNodeLibraryCache, syncUserNodes } from '../host/node-library.js';
import { NODE_LIBRARY, nodeSourceOf, setUserNodes } from '../shared/nodes.js';
import { Workspace } from '../host/workspace.js';
import { compileGraph } from '../client/runtime/codegen.js';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-example-'));
const workspace = new Workspace(join(tempRoot, 'ws'));

/** 需要随插件一起发出去的那几个示例。 */
const EXPECTED = [
  'demo',
  'fourier-series',
  'fourier-spectrum',
  'fourier-epicycles',
  'gaussian-blur',
  'depth-of-field',
  'bezier',
  'music',
];

/**
 * 把所有示例都载入临时工作区 —— 顺便把各自 `library/` 里的用户节点装好。
 * 之后整库同步一次，编译任何示例都认得它的节点。
 */
before(async () => {
  await workspace.init();
  for (const name of EXPECTED) {
    await loadExample(workspace, name, { overwrite: true });
  }
  const sync = syncUserNodes(workspace, { force: true });
  assert.deepEqual(sync.errors, [], `示例自带的库文件有问题：${JSON.stringify(sync.errors)}`);
});

after(async () => {
  setUserNodes([]);
  resetNodeLibraryCache();
  await rm(tempRoot, { recursive: true, force: true });
});

test('插件里带着约定的那几个示例', async () => {
  const examples = await listExamples();
  const names = examples.map((e) => e.name).sort();
  for (const want of EXPECTED) {
    assert.ok(names.includes(want), `少了示例 ${want}，实际有：${names.join(', ') || '（空）'}`);
  }
  const demo = examples.find((e) => e.name === 'demo');
  assert.deepEqual(demo.materials, ['phantom-star']);
  assert.ok(examplesRoot().endsWith('examples'), `examplesRoot 不对：${examplesRoot()}`);
});

test('示例里没有任何"专用节点"——全是通用件搭出来的', async () => {
  // 这几个效果（傅里叶级数 / 频谱 / 本轮 / IFS 隧道）先后做过「内置专用节点」和
  // 「示例自带的用户节点」，两次都是黑盒：画布上展不开、参数改不了。
  // 现在它们被拆成普通节点铺在画布上（`scripts/rebuild-primitive-demos.mjs`），
  // 所以这条断言两件事：不随示例带用户节点，图里也不许出现非内置类型。
  const generic = new Set(NODE_LIBRARY.filter((n) => nodeSourceOf(n.type) === 'builtin').map((n) => n.type));
  for (const example of await listExamples()) {
    const lib = await listExampleLibrary(example.name);
    assert.deepEqual(lib.nodes, [], `${example.name} 带了用户节点：${lib.nodes.join(', ')}（示例不该有黑盒）`);

    for (const material of example.materials) {
      const graph = JSON.parse(
        await readFile(join(examplesRoot(), example.name, 'materials', material, 'graph.json'), 'utf8'),
      );
      /** 组的子图也要一起看。 */
      const walk = (nodes) => {
        for (const node of nodes ?? []) {
          assert.ok(
            generic.has(node.type),
            `${example.name}/${material} 用了非内置节点 ${node.type} —— 效果应该是图，不是黑盒`,
          );
          if (node.params?.graph?.nodes) walk(node.params.graph.nodes);
        }
      };
      walk(graph.nodes);
    }
  }
});

test('每个示例的每个材质都真编译一遍（节点改名 / prelude 写坏都会在这儿炸）', async () => {
  const examples = await listExamples();
  assert.ok(examples.length > 0, '一个示例都没有');

  let checked = 0;
  for (const example of examples) {
    for (const material of example.materials) {
      const graphPath = join(examplesRoot(), example.name, 'materials', material, 'graph.json');
      assert.ok(existsSync(graphPath), `${example.name}/${material} 没有 graph.json`);

      const graph = JSON.parse(await readFile(graphPath, 'utf8'));
      const compiled = compileGraph(graph, 'image', { uniforms: graph.uniforms ?? [] });
      assert.deepEqual(
        compiled.errors,
        [],
        `${example.name}/${material} 编译不过：${JSON.stringify(compiled.errors)}`,
      );
      assert.equal(compiled.ok, true, `${example.name}/${material} ok=false`);
      assert.ok(compiled.code.includes('void main()'), `${example.name}/${material} 没生成 main`);
      checked += 1;
    }
  }
  assert.ok(checked >= EXPECTED.length, `只检查了 ${checked} 个材质，太少了`);
});

test('示例里存的 .frag 与当前节点库生成的结果一致（防止改了图忘了重生成）', async () => {
  const examples = await listExamples();
  for (const example of examples) {
    for (const material of example.materials) {
      const dir = join(examplesRoot(), example.name, 'materials', material);
      const stored = join(dir, `${material}.frag`);
      if (!existsSync(stored)) continue; // 允许示例不带 .frag
      const graph = JSON.parse(await readFile(join(dir, 'graph.json'), 'utf8'));
      const compiled = compileGraph(graph, 'image', { uniforms: graph.uniforms ?? [] });
      assert.equal(
        await readFile(stored, 'utf8'),
        compiled.code,
        `${example.name}/${material} 里的 .frag 和现在生成的不一样，重跑对应的 build 脚本`,
      );
    }
  }
});

test('载入示例：整棵目录进工作区，材质读得回来', async () => {
  const result = await loadExample(workspace, 'demo', { overwrite: true });
  assert.equal(result.project, 'demo');
  assert.deepEqual(result.materials, ['phantom-star']);
  assert.equal(result.overwritten, true);
  // 示例不带库文件了：效果全在图的普通节点里，没有需要额外安装的黑盒
  assert.deepEqual(result.library, []);

  const material = await workspace.readMaterial('demo', 'phantom-star');
  // 99 步累积是一个**重复组**（循环体只写一遍），不是 99 份复制 ——
  // 复制那版是 801 节点 / 676 KB 着色器 / 2 MB 图，加载直接卡住。
  assert.ok(material.graph.nodes.length < 30, `demo 有 ${material.graph.nodes.length} 个节点，循环又写成复制了？`);
  const loop = material.graph.nodes.find((n) => n.type === 'group' && Number(n.params?.repeat) > 1);
  assert.ok(loop, 'demo 里应该有一个重复组（repeat > 1）');
  assert.equal(Number(loop.params.repeat), 99, '循环次数应该是原版的 99 步');
  assert.ok((material.manifest.name ?? '').includes('Phantom Star'));

  // 预览图和生成的 .frag 也要跟着走（示例得是自包含的）
  for (const rel of ['preview.png', 'phantom-star.frag']) {
    const info = await stat(join(workspace.root, 'projects', 'demo', 'materials', 'phantom-star', rel));
    assert.ok(info.size > 0, `${rel} 没拷过来`);
  }
});

test('傅里叶那三个示例：全部由普通节点铺开，没有黑盒', async () => {
  // 这几个效果原来是一个节点里藏一段 GLSL（循环写在 prelude 里），展不开也改不了。
  // 现在循环被**展开**成节点链：加一项就是多加一个节点，全都在画布上。
  const expect = {
    'fourier-series': { minNodes: 10 },
    'fourier-spectrum': { minNodes: 12 },
    'fourier-epicycles': { minNodes: 25, pass: 'BufferA' },
  };
  for (const [example, want] of Object.entries(expect)) {
    const dir = join(examplesRoot(), example, 'materials');
    const materials = await readdir(dir, { withFileTypes: true });
    const material = materials.find((m) => m.isDirectory());
    assert.ok(material, `${example} 没有材质目录`);
    const graph = JSON.parse(await readFile(join(dir, material.name, 'graph.json'), 'utf8'));

    assert.ok(
      graph.nodes.length >= want.minNodes,
      `${example} 只有 ${graph.nodes.length} 个节点 —— 像是又缩回成一个黑盒了`,
    );
    // 只许用最基础的那几种（custom 是"直接写 GLSL 表达式"的通用件）
    const allowed = new Set(['uv', 'time', 'custom', 'output', 'bufferSample']);
    for (const node of graph.nodes) {
      assert.ok(allowed.has(node.type), `${example} 用了 ${node.type} —— 应该只用基础件搭`);
    }
    // 一个 prelude 都不许有：循环必须在图上展开
    for (const node of graph.nodes) {
      assert.equal(
        node.params?.glslPrelude,
        undefined,
        `${example}/${node.id} 带着 glslPrelude —— 循环要展开成节点`,
      );
    }
    if (want.pass) {
      const pass = (graph.passes ?? []).find((p) => p.name === want.pass);
      assert.ok(pass && pass.graph.length > 0, `${example} 缺 ${want.pass} Pass（轨迹靠它攒）`);
    }
  }
});

test('三个效果示例的重活都藏在组里（画布上没几个节点）', async () => {
  // 这三个示例是「用现有组件搭效果」的样板：管线用 group 元节点包起来，
  // 画布上只留输入/组/输出。摊开来是几十个节点，包起来才是人看的图。
  const expect = {
    'gaussian-blur': { minInner: 20, pass: 'BufferA' },
    'depth-of-field': { minInner: 20, pass: 'BufferA' },
    // bezier 的 24 段现在是**重复组**：循环体 16 个节点，不是 24 份复制
    // （复制那版生成 51 KB 着色器，加载卡）
    bezier: { minInner: 10, pass: 'image', repeat: 24 },
  };
  for (const [example, want] of Object.entries(expect)) {
    const dir = join(examplesRoot(), example, 'materials');
    const materials = await readdir(dir, { withFileTypes: true });
    const material = materials.find((m) => m.isDirectory());
    assert.ok(material, `${example} 没有材质目录`);
    const graph = JSON.parse(await readFile(join(dir, material.name, 'graph.json'), 'utf8'));

    // 画布上应该很干净
    assert.ok(graph.nodes.length <= 14, `${example} 画布上有 ${graph.nodes.length} 个节点，太挤了`);

    const groupNode = graph.nodes.find((n) => n.type === 'group');
    assert.ok(groupNode, `${example} 里没有 group 节点`);
    const inner = groupNode.params?.graph;
    assert.ok(
      Array.isArray(inner?.nodes) && inner.nodes.length >= want.minInner,
      `${example} 的组里只有 ${inner?.nodes?.length ?? 0} 个节点，太少（重活应该在里面）`,
    );
    assert.ok(Array.isArray(inner.inputs) && inner.inputs.length > 0, `${example} 的组没有输入端口`);
    assert.ok(Array.isArray(inner.outputs) && inner.outputs.length > 0, `${example} 的组没有输出端口`);
    if (want.repeat) {
      assert.equal(Number(groupNode.params?.repeat), want.repeat, `${example} 的重复次数不对（循环写成了复制？）`);
    }

    // 多 Pass 的示例要真的有第二个 Pass
    if (want.pass !== 'image') {
      const pass = (graph.passes ?? []).find((p) => p.name === want.pass);
      assert.ok(pass && pass.graph.length > 0, `${example} 缺 ${want.pass} Pass`);
    }

    // 展开之后不能有占位符漏进 GLSL
    const compiled = compileGraph(graph, 'image', { uniforms: graph.uniforms ?? [] });
    assert.deepEqual(compiled.errors, [], `${example} 带着组编译不过`);
    for (const marker of ['GROUP_INPUT', 'GROUP_OUTPUT', '::']) {
      assert.ok(!compiled.code.includes(marker), `${example} 的 GLSL 里漏出了 ${marker}`);
    }
  }
});

test('性能护栏：示例不许把「重复」写成「复制」', async () => {
  // 踩过的坑：IFS 隧道 99 步展开 = 801 节点 / 676 KB 着色器 / 2 MB 图 / codegen 352 ms，
  // 面板一打开就卡；贝塞尔 24 段展开 = 51 KB 着色器。重复是语言结构（组的「重复次数」），
  // 不是复制粘贴。这条把它们钉住。
  const LIMITS = { nodes: 60, shaderKB: 32, jsonKB: 60 };
  for (const example of await listExamples()) {
    for (const material of example.materials) {
      const dir = join(examplesRoot(), example.name, 'materials', material);
      const raw = await readFile(join(dir, 'graph.json'), 'utf8');
      const graph = JSON.parse(raw);
      const compiled = compileGraph(graph, 'image', { uniforms: graph.uniforms ?? [] });

      assert.ok(
        graph.nodes.length <= LIMITS.nodes,
        `${example.name}/${material} 画布上 ${graph.nodes.length} 个节点（上限 ${LIMITS.nodes}）—— 循环是不是又展开成复制了？`,
      );
      assert.ok(
        raw.length / 1024 <= LIMITS.jsonKB,
        `${example.name}/${material} 的 graph.json 有 ${(raw.length / 1024).toFixed(0)} KB（上限 ${LIMITS.jsonKB}）`,
      );
      assert.ok(
        compiled.code.length / 1024 <= LIMITS.shaderKB,
        `${example.name}/${material} 生成的着色器 ${(compiled.code.length / 1024).toFixed(0)} KB（上限 ${LIMITS.shaderKB}）—— 用重复组，别复制`,
      );
    }
  }
});

test('重复载入会拒绝，带 overwrite 才覆盖', async () => {
  await assert.rejects(
    () => loadExample(workspace, 'demo'),
    (error) => error.code === 'example-exists' && /已经存在/.test(error.message),
  );

  const again = await loadExample(workspace, 'demo', { overwrite: true });
  assert.equal(again.overwritten, true);
  assert.deepEqual(again.materials, ['phantom-star']);
});

test('示例名字挡住路径穿越与空名字', async () => {
  for (const bad of ['..', '../secret', 'a/b', 'a\\b', '', '  ']) {
    await assert.rejects(() => loadExample(workspace, bad), /示例名字只允许/);
  }
  await assert.rejects(() => loadExample(workspace, 'nope'), /没有这个示例/);
});
