/**
 * 工作区服务测试：路径安全 + 完整读写流程。
 *
 * 跑法：node tests/workspace.test.js
 * 测试用的工作区建在系统临时目录里，跑完清掉。
 *
 * @module dsh-shader-workbench/tests/workspace.test
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { Workspace, assertSafeName } from '../host/workspace.js';
import { makeEdge, makeFrame, makeNode, setPassNodes, makeGraph } from '../shared/graph.js';
import { compileGraph } from '../client/runtime/codegen.js';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-test-'));
const workspace = new Workspace(join(tempRoot, 'ws'));

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test('assertSafeName 挡住路径穿越与保留名', () => {
  assert.equal(assertSafeName('good-name_1'), 'good-name_1');
  assert.throws(() => assertSafeName('..', '材质名'), /不能是/);
  assert.throws(() => assertSafeName('a/b', '材质名'), /非法字符/);
  assert.throws(() => assertSafeName('a\\b', '材质名'), /非法字符/);
  assert.throws(() => assertSafeName('C:evil', '材质名'), /非法字符/);
  assert.throws(() => assertSafeName('con', '材质名'), /保留名/);
  assert.throws(() => assertSafeName('', '材质名'), /不能为空/);
});

test('workspace.path 拒绝越界路径', () => {
  assert.throws(() => workspace.path('..', 'outside'), /越出工作区/);
  assert.throws(() => workspace.path('projects', '..', '..', '..', 'x'), /越出工作区/);
  // 绝对路径按当前平台判：守卫用的是 Node 的 isAbsolute（平台相关）。
  // Windows 认 `C:\` 前缀，POSIX 认 `/` 前缀 —— 写死成其中一种，另一种平台必然红。
  const absolute = process.platform === 'win32' ? 'C:\\Windows' : '/etc/passwd';
  assert.throws(() => workspace.path(absolute), /绝对路径/);
  // 正常路径要能过
  assert.ok(workspace.path('projects', 'demo').includes('projects'));
});

test('完整流程：建工作区 → 建项目 → 建材质 → 存图 → 读回', async () => {
  await workspace.init();
  await workspace.createProject({ name: 'demo', title: '示例项目' });

  const projects = await workspace.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'demo');
  assert.equal(projects[0].title, '示例项目');

  await workspace.createMaterial({ project: 'demo', name: 'plasma', title: '等离子' });
  const materials = await workspace.listMaterials('demo');
  assert.equal(materials.length, 1);
  assert.equal(materials[0].name, 'plasma');

  // 写一张真图
  const uv = makeNode('uv', 0, 0);
  const time = makeNode('time', 0, 120, {});
  const scale = makeNode('scaleP', 220, 0, {});
  const palette = makeNode('palette', 440, 60, {});
  const add = makeNode('add', 660, 60, {});
  const out = makeNode('output', 880, 60);
  const graph = makeGraph({
    name: 'plasma',
    nodes: [uv, time, scale, palette, add, out],
    edges: [
      makeEdge(uv.id, 'out', scale.id, 'p'),
      makeEdge(scale.id, 'out', add.id, 'a'),
      makeEdge(time.id, 'out', palette.id, 't'),
      makeEdge(palette.id, 'out', add.id, 'b'),
      makeEdge(add.id, 'out', out.id, 'color'),
    ],
  });
  setPassNodes(
    graph,
    'image',
    graph.nodes.map((n) => n.id),
  );

  const saved = await workspace.saveMaterial({ project: 'demo', material: 'plasma', graph });
  assert.equal(saved.ok, true);

  const read = await workspace.readMaterial('demo', 'plasma');
  assert.equal(read.graph.nodes.length, 6);
  assert.equal(read.graph.edges.length, 5);

  // 读回来的图必须还能编译通过
  const compiled = compileGraph(read.graph, 'image');
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.match(compiled.code, /void main\(\)/);
});

test('分组框 / 注释跟着图落盘，重开还在（FR-01）', async () => {
  await workspace.init();
  await workspace.createProject({ name: 'anno', title: '批注' });
  await workspace.createMaterial({ project: 'anno', name: 'framed', title: '带批注' });

  const uv = makeNode('uv', 0, 0);
  const out = makeNode('output', 320, 0);
  const graph = makeGraph({ name: 'framed', nodes: [uv, out], edges: [makeEdge(uv.id, 'out', out.id, 'color')] });
  setPassNodes(graph, 'image', [uv.id, out.id]);

  // 装饰件是编辑器层的东西：不进代码生成，但必须落盘
  const pass = graph.passes.find((p) => p.name === 'image');
  pass.frames = [
    makeFrame('frame', -20, 60, { title: '光照部分', color: 'violet', w: 400, h: 240 }),
    makeFrame('note', 460, 380, { text: '这里换成双向反射分布函数试试', color: 'amber' }),
  ];

  const codeBefore = compileGraph(graph, 'image').code;

  await workspace.saveMaterial({ project: 'anno', material: 'framed', graph });
  const read = await workspace.readMaterial('anno', 'framed');
  const readPass = read.graph.passes.find((p) => p.name === 'image');

  assert.equal(readPass.frames.length, 2, `装饰件该跟着图一起存下来：${JSON.stringify(readPass.frames)}`);
  const frame = readPass.frames.find((f) => f.kind === 'frame');
  const note = readPass.frames.find((f) => f.kind === 'note');
  assert.equal(frame.title, '光照部分');
  assert.equal(frame.color, 'violet');
  assert.equal(frame.w, 400);
  assert.equal(note.text, '这里换成双向反射分布函数试试');

  // 装饰件不该改变生成的代码 —— 这是「分组框 ≠ group 元节点」的硬边界
  assert.equal(compileGraph(read.graph, 'image').code, codeBefore, '装饰件不该影响生成的 GLSL');

  // 老材质（没有 frames 字段）读回来也要能用，而不是 undefined 炸掉
  const legacy = makeGraph({ name: 'legacy', nodes: [uv], edges: [] });
  delete legacy.passes.find((p) => p.name === 'image').frames;
  await workspace.createMaterial({ project: 'anno', name: 'legacy', title: '老图' });
  await workspace.saveMaterial({ project: 'anno', material: 'legacy', graph: legacy });
  const legacyRead = await workspace.readMaterial('anno', 'legacy');
  assert.deepEqual(legacyRead.graph.passes.find((p) => p.name === 'image').frames, [], '老图该补成空数组');
});

test('快照与回滚', async () => {
  const snap = await workspace.snapshot({ project: 'demo', material: 'plasma', label: 'v1' });
  assert.equal(snap.ok, true);
  assert.match(snap.id, /v1$/);

  const list = await workspace.listSnapshots({ project: 'demo', material: 'plasma' });
  assert.ok(list.length >= 1);

  // 改坏图，再回滚
  const read = await workspace.readMaterial('demo', 'plasma');
  read.graph.nodes = [];
  read.graph.edges = [];
  await workspace.saveMaterial({ project: 'demo', material: 'plasma', graph: read.graph });
  assert.equal((await workspace.readMaterial('demo', 'plasma')).graph.nodes.length, 0);

  const restored = await workspace.restoreSnapshot({ project: 'demo', material: 'plasma', snapshotId: snap.id });
  assert.equal(restored.graph.nodes.length, 6);

  // 回滚本身也要留下痕迹
  const afterList = await workspace.listSnapshots({ project: 'demo', material: 'plasma' });
  assert.ok(afterList.some((s) => s.id.includes('before-rollback')));
});

test('导入纹理：拷进 textures/ 并写回清单', async () => {
  // 造一张假 PNG（内容不重要，只验文件流转）
  const sourceDir = join(tempRoot, 'source');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = join(sourceDir, 'albedo.png');
  await writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const result = await workspace.importTexture({
    project: 'demo',
    material: 'plasma',
    sourcePath,
    slot: 'iChannel1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.ref.slot, 'iChannel1');
  assert.equal(result.ref.path, 'textures/albedo.png');
  assert.equal(result.ref.meta.source, 'local');

  const read = await workspace.readMaterial('demo', 'plasma');
  // 引用统一在 resources[] 里；`textures` 只是磁盘上 textures/ 的文件清单
  assert.equal(read.manifest.resources.filter((r) => r.type === 'texture').length, 1);
  assert.equal(read.textures.length, 1);

  // 源文件必须原封不动
  assert.equal(existsSync(sourcePath), true);

  // 同槽位再导一次 → 清单里仍只有一条
  await workspace.importTexture({ project: 'demo', material: 'plasma', sourcePath, slot: 'iChannel1' });
  const again = await workspace.readMaterial('demo', 'plasma');
  assert.equal(again.manifest.resources.filter((r) => r.type === 'texture').length, 1);
  assert.equal(again.textures.length, 2, '第二次导入应另存一个带序号的副本');

  // 解绑：只摘清单，不删文件
  const unbound = await workspace.unbindTexture({ project: 'demo', material: 'plasma', slot: 'iChannel1' });
  assert.equal(unbound.removed, 1);
  assert.equal((await workspace.readMaterial('demo', 'plasma')).textures.length, 2, '文件不能被删');
});

test('不支持的文件扩展名被拒', async () => {
  const sourceDir = join(tempRoot, 'source');
  const badPath = join(sourceDir, 'evil.exe');
  await writeFile(badPath, 'nope');
  await assert.rejects(
    () => workspace.importTexture({ project: 'demo', material: 'plasma', sourcePath: badPath, slot: 'iChannel0' }),
    /不支持/,
  );
});

test('纹理路径穿越被拒', () => {
  assert.throws(
    () => workspace.textureAbsolutePath('demo', 'plasma', '../../../../etc/passwd'),
    /非法纹理路径/,
  );
  // 绝对路径按当前平台判（同上：isAbsolute 是平台相关的）
  const absolute = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
  assert.throws(() => workspace.textureAbsolutePath('demo', 'plasma', absolute), /非法纹理路径/);
});

test('归档是移动而不是删除', async () => {
  await workspace.createMaterial({ project: 'demo', name: 'tmp-mat' });
  const result = await workspace.archiveMaterial({ project: 'demo', material: 'tmp-mat' });
  assert.equal(result.ok, true);
  assert.match(result.movedTo, /\.trash\//);
  assert.equal(existsSync(workspace.materialDir('demo', 'tmp-mat')), false);
  assert.equal(existsSync(workspace.path(...result.movedTo.split('/'))), true, '归档目标必须还在');

  const materials = await workspace.listMaterials('demo');
  assert.ok(!materials.some((m) => m.name === 'tmp-mat'), '归档后不该再出现在列表里');
});

test('只读工作区拒绝写入', async () => {
  const readonly = new Workspace(workspace.root, { readOnly: true });
  await assert.rejects(() => readonly.createProject({ name: 'nope' }), /只读模式/);
});

test('预设读写', async () => {
  await workspace.savePreset({ id: 'warm', name: '暖色', data: { exposure: 1.2 } });
  const presets = await workspace.listPresets();
  assert.ok(presets.some((p) => p.id === 'warm'));
  const one = await workspace.readPreset('warm');
  assert.equal(one.data.exposure, 1.2);
});
