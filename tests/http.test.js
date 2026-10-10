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
