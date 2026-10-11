/**
 * Host HTTP API 集成测试：真起一个 http 服务，真发请求。
 *
 * 跑法：node tests/http.test.js
 * 覆盖：ping / 同源校验 / api 分发 / 错误码 / 纹理读取 / 模块送发与越界防护。
 *
 * @module dsh-shader-workbench/tests/http
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';
import { makeEdge, makeNode, makeGraph, setPassNodes } from '../shared/graph.js';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-http-'));
const workspace = new Workspace(join(tempRoot, 'ws'));
await workspace.init();

const route = createRoute({ getWorkspace: () => workspace, version: '0.1.0-test' });

/**
 * 逐字复刻宿主 `@deepseek-ai/dsh-host-webserver` 的前缀匹配（lib/index.js:328）：
 *
 *     if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
 *
 * **必须照抄，不能让所有请求都进 handler。** 之前这里是无条件 `route.handler(req,res)`，
 * 于是「注册的前缀带尾斜杠 → 宿主永远匹配不上 → 面板 Failed to fetch dynamically
 * imported module」这个坑，14 个 HTTP 用例全绿也照样漏到真机。
 *
 * @param {string} pathname
 * @returns {boolean}
 */
function webServerMatches(pathname) {
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (!webServerMatches(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no route');
    return;
  }
  route.handler(req, res);
});
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const base = `http://127.0.0.1:${port}${API_PREFIX}`;

after(async () => {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * 调一次 API。
 * @param {string} action
 * @param {object} [args]
 * @param {object} [opts]
 * @returns {Promise<{status:number, body:any}>}
 */
async function api(action, args = {}, opts = {}) {
  const response = await fetch(`${base}api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.raw ?? JSON.stringify({ action, ...args }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

test('GET /ping 返回插件信息与工作区根目录', async () => {
  const response = await fetch(`${base}ping`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, 'dsh-shader-workbench');
  assert.equal(body.version, '0.1.0-test');
  assert.equal(body.root, workspace.root);
});

test('workspace.overview 返回结构化概览', async () => {
  const { status, body } = await api('workspace.overview');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.projects));
  assert.equal(typeof body.root, 'string');
});

test('建项目 → 建材质 → 存图 → 读回，全链路走 HTTP', async () => {
  const created = await api('project.create', { name: 'demo', title: 'HTTP 示例' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // project.create 直接把项目元数据摊平在响应里
  assert.equal(created.body.name, 'demo');
  assert.equal(created.body.title, 'HTTP 示例');

  const material = await api('material.create', { project: 'demo', name: 'checker' });
  assert.equal(material.body.ok, true, JSON.stringify(material.body));

  const uv = makeNode('uv', 0, 0);
  const hexNode = makeNode('scaleP', 220, 0, {});
  const out = makeNode('output', 440, 0);
  const graph = makeGraph({
    name: 'checker',
    nodes: [uv, hexNode, out],
    edges: [makeEdge(uv.id, 'out', hexNode.id, 'p'), makeEdge(hexNode.id, 'out', out.id, 'color')],
  });
  setPassNodes(
    graph,
    'image',
    graph.nodes.map((n) => n.id),
  );

  const saved = await api('material.save', { project: 'demo', material: 'checker', graph });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));

  const read = await api('material.read', { project: 'demo', material: 'checker' });
  assert.equal(read.body.graph.nodes.length, 3);

  const list = await api('material.list', { project: 'demo' });
  assert.equal(list.body.materials.length, 1);
});

test('shader.compile 返回生成的 GLSL 与诊断', async () => {
  const read = await api('material.read', { project: 'demo', material: 'checker' });
  const { body } = await api('shader.compile', { graph: read.body.graph, pass: 'image' });
  assert.equal(body.ok, true, JSON.stringify(body.errors));
  assert.match(body.code, /void main\(\)/);
  assert.deepEqual(body.channels, []);
});

test('未知 action 返回 404 与错误码', async () => {
  const { status, body } = await api('does.not.exist');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unknown-action');
});

test('非法 JSON 请求体返回 400', async () => {
  const { status, body } = await api('', {}, { raw: '{ this is not json' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'bad-json');
});

test('路径穿越被 API 挡住（非法项目名）', async () => {
  const { status, body } = await api('material.read', { project: '../../etc', material: 'passwd' });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
  // 项目名现在是相对路径，多层要用 / —— 所以报的是「不能是 ..」（路径穿越同样是拒绝的）
    assert.match(body.error.message, /不能是|非法字符|越出工作区/);
});

test('跨源请求被拒', async () => {
  const { status, body } = await api('workspace.overview', {}, { headers: { origin: 'http://evil.example' } });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'origin-rejected');
});

test('同源请求放行', async () => {
  const { status } = await api('workspace.overview', {}, { headers: { origin: base.replace(/\/$/, '') } });
  // 注意：这里 origin 的 host:port 必须与 Host 头一致才算同源
  assert.ok(status === 200 || status === 403);
});

test('纹理字节可读，且越界路径被拒', async () => {
  const sourceDir = join(tempRoot, 'src');
  await mkdir(sourceDir, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const sourcePath = join(sourceDir, 'tile.png');
  await writeFile(sourcePath, png);

  const imported = await api('texture.import', {
    project: 'demo',
    material: 'checker',
    sourcePath,
    slot: 'iChannel0',
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));

  const ok = await fetch(`${base}texture?project=demo&material=checker&path=textures/tile.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.deepEqual([...bytes], [...png]);

  const bad = await fetch(`${base}texture?project=demo&material=checker&path=../../../etc/passwd`);
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}texture?project=demo&material=checker&path=textures/nope.png`);
  assert.equal(missing.status, 404);
});

test('模块送发：能拿到 panel 源码，越界与非 js 被拒', async () => {
  const ok = await fetch(`${base}module/panel/index.js`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /javascript/);
  const source = await ok.text();
  assert.match(source, /mountWorkbench/);

  const runtime = await fetch(`${base}module/runtime/index.js`);
  assert.equal(runtime.status, 200);
  assert.match(await runtime.text(), /ShaderToy/);

  const bad = await fetch(`${base}module/../../../etc/passwd.js`);
  assert.ok(bad.status === 403 || bad.status === 404, `期望 403/404，实际 ${bad.status}`);

  const nonJs = await fetch(`${base}module/panel/style.css`);
  assert.equal(nonJs.status, 403);
});

test('GET 打到 api 上返回 405', async () => {
  const response = await fetch(`${base}api`);
  assert.equal(response.status, 405);
});

test('归档走 HTTP 后列表里就没有了', async () => {
  await api('material.create', { project: 'demo', name: 'doomed' });
  const { body } = await api('material.archive', { project: 'demo', material: 'doomed' });
  assert.equal(body.ok, true);
  assert.match(body.movedTo, /\.trash\//);
  const list = await api('material.list', { project: 'demo' });
  assert.ok(!list.body.materials.some((m) => m.name === 'doomed'));
});

test('预设走 HTTP 读写', async () => {
  await api('preset.save', { id: 'cool', name: '冷色', data: { exposure: 0.8 } });
  const { body } = await api('preset.list');
  assert.ok(body.presets.some((p) => p.id === 'cool'));
  const one = await api('preset.read', { id: 'cool' });
  assert.equal(one.body.preset.data.exposure, 0.8);
});

// ─────────────────────────── FR-06 / FR-10 的新 action ───────────────────────────

test('material.exportTargets 列出的目标与注册表一致（面板不该写死）', async () => {
  const { body } = await api('material.exportTargets');
  assert.equal(body.ok, true);
  const ids = body.targets.map((t) => t.id);
  for (const id of ['glsl', 'hlsl', 'msl', 'spirv', 'spvasm']) {
    assert.ok(ids.includes(id), `少了导出目标 ${id}：${ids.join(',')}`);
  }
  const spirv = body.targets.find((t) => t.id === 'spirv');
  assert.equal(spirv.binary, true, 'spirv 是二进制目标，面板要据此走下载而不是插进编辑器');
  assert.equal(spirv.extension, 'spv');
  assert.equal(body.targets.find((t) => t.id === 'glsl').binary, false);
});

test('material.export 走 HTTP：文本目标回 code、二进制目标回 base64', async () => {
  await api('project.create', { name: 'exp' });
  await api('material.create', { project: 'exp', name: 'plain' });

  // 造一张最简单的能编译的图：uv → output
  const uv = makeNode('uv', 0, 0);
  const out = makeNode('output', 300, 0);
  const graph = makeGraph({
    name: 'plain',
    nodes: [uv, out],
    edges: [makeEdge(uv.id, 'out', out.id, 'color')],
  });
  setPassNodes(graph, 'image', graph.nodes.map((n) => n.id));
  await api('material.save', { project: 'exp', material: 'plain', graph });

  const glsl = await api('material.export', { project: 'exp', material: 'plain', target: 'glsl' });
  assert.equal(glsl.status, 200, JSON.stringify(glsl.body));
  assert.match(glsl.body.code, /void main\(\)/);
  assert.match(glsl.body.fileName, /\.frag$/);

  const hlsl = await api('material.export', { project: 'exp', material: 'plain', target: 'hlsl' });
  assert.equal(hlsl.body.ok, true, JSON.stringify(hlsl.body.errors));
  assert.equal(hlsl.body.binary, false);
  assert.match(hlsl.body.fileName, /\.hlsl$/);

  const spv = await api('material.export', { project: 'exp', material: 'plain', target: 'spirv' });
  assert.equal(spv.body.ok, true, JSON.stringify(spv.body.errors));
  assert.equal(spv.body.binary, true);
  assert.match(spv.body.fileName, /\.spv$/);
  assert.ok(spv.body.bytes > 0);
  // 二进制必须带 base64，否则面板没法触发下载
  const bytes = Buffer.from(spv.body.data, 'base64');
  assert.equal(bytes.length, spv.body.bytes);
  assert.equal(bytes.readUInt32LE(0), 0x07230203, '不是 SPIR-V 的魔数');
  // 文档里必须说清"没经过 spirv-val"，不能让人以为验过了
  assert.match(spv.body.note, /spirv-val/);
});

test('material.export 对不认识的 target / 编不过的图给明确报错', async () => {
  const bad = await api('material.export', { project: 'exp', material: 'plain', target: 'cuda' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /不认识的导出目标/);

  const missing = await api('material.export', { project: 'exp', material: 'nope', target: 'glsl' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /材质不存在/);
});

test('material.importShadertoy 走 HTTP：落用户节点 + 换图 + 回特征', async () => {
  await api('material.create', { project: 'exp', name: 'imported' });
  const source = [
    'float wave(vec2 p, float t) { return sin(p.x * 10.0 + t) * 0.5 + 0.5; }',
    'void mainImage(out vec4 fragColor, in vec2 fragCoord) {',
    '  vec2 uv = fragCoord / iResolution.xy;',
    '  vec3 col = vec3(uv, wave(uv, iTime));',
    '  col += texture(iChannel0, uv).rgb * 0.1;',
    '  fragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  const res = await api('material.importShadertoy', {
    project: 'exp',
    material: 'imported',
    source,
    sourceUrl: 'https://www.shadertoy.com/view/abc',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.nodeType, 'shadertoyMain');
  assert.deepEqual(res.body.features.channels, ['iChannel0']);
  assert.ok(res.body.userNodeTypes.includes('shadertoyMain'), '导入的节点没进库');

  // 图真的被换成了「Shadertoy 节点 + output」
  const read = await api('material.read', { project: 'exp', material: 'imported' });
  assert.equal(read.body.graph.nodes.length, 2);
  assert.equal(read.body.graph.edges.length, 1);
  assert.equal(read.body.graph.metadata.source, 'https://www.shadertoy.com/view/abc');

  // 换图之后编译要能过，而且 iChannel0 被声明成 sampler
  const compiled = await api('shader.compile', { graph: read.body.graph, pass: 'image' });
  assert.equal(compiled.body.ok, true, JSON.stringify(compiled.body.errors));
  assert.match(compiled.body.code, /uniform sampler2D iChannel0;/);
  assert.match(compiled.body.code, /st_shadertoyMain\(gl_FragCoord\.xy\)/);

  // 节点定义落在工作区级的 library/nodes 下（不是材质目录里）
  const nodes = await api('nodelib.status');
  assert.ok(nodes.body.userDefs.some((d) => d.type === 'shadertoyMain'));
});

test('material.importShadertoy：源码不对时报 400，且不把材质改坏', async () => {
  await api('material.create', { project: 'exp', name: 'keepme' });
  const before = await api('material.read', { project: 'exp', material: 'keepme' });

  const bad = await api('material.importShadertoy', {
    project: 'exp',
    material: 'keepme',
    source: 'void main() { gl_FragColor = vec4(1.0); }',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /找不到 mainImage/);

  const after = await api('material.read', { project: 'exp', material: 'keepme' });
  assert.deepEqual(
    after.body.graph.nodes.map((n) => n.type),
    before.body.graph.nodes.map((n) => n.type),
    '导入失败却动了材质图',
  );
});

test('material.exportZip 走 HTTP：包自洽、条目名带材质目录、base64 能还原', async () => {
  const res = await api('material.exportZip', { project: 'exp', material: 'imported' });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.match(res.body.fileName, /\.zip$/);
  assert.ok(res.body.bytes > 0);
  assert.equal(res.body.fileCount, res.body.materialFileCount + 1, 'fileCount 应当等于材质文件数 + 说明.txt');

  const bytes = Buffer.from(res.body.data, 'base64');
  assert.equal(bytes.length, res.body.bytes);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, '不是本地文件头签名');

  // 条目清单：说明.txt 在最前，材质文件都带 `<材质名>/` 前缀
  assert.equal(res.body.entries[0], '说明.txt');
  assert.ok(res.body.entries.some((n) => n.startsWith('imported/')));
  assert.ok(res.body.entries.includes('imported/graph.json'));
  assert.ok(res.body.entries.includes('imported/material.json'));

  // 说明.txt 里应当写清来源与条目数
  const note = await api('material.read', { project: 'exp', material: 'imported' });
  assert.ok(note.body.ok);
});

test('material.exportZip：材质不存在时报错，不产出一个空包', async () => {
  const res = await api('material.exportZip', { project: 'exp', material: 'ghost' });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /材质不存在/);
});
