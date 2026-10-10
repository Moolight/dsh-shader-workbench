/**
 * 模块图校验：把面板用到的每一个 ESM 模块都真正解析一遍。
 *
 * 为什么需要这个测试：面板走的是浏览器原生 ESM，Host 只负责把源码原样送出。
 * 一个写错的相对路径在 Node 单测里是看不出来的（那些测试没 import 面板），
 * 但一到浏览器就是白屏。这里用 `import()` 把整张图拉起来，等价于浏览器的解析。
 *
 * 跑法：node tests/module-graph.test.js
 *
 * @module dsh-shader-workbench/tests/module-graph
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, posix } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Workspace } from '../host/workspace.js';
import { createRoute, API_PREFIX } from '../host/routes.js';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT_DIR = join(PROJECT, 'client');

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-mod-'));
const workspace = new Workspace(join(tempRoot, 'ws'));
await workspace.init();
const route = createRoute({ getWorkspace: () => workspace, version: 'test' });
const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const base = `http://127.0.0.1:${port}${API_PREFIX}`;

after(async () => {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(tempRoot, { recursive: true, force: true });
});

/**
 * 递归列出一个目录下所有 .js 文件（相对 client/ 的 posix 风格路径）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listJsFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(relative(CLIENT_DIR, full).split(sep).join('/'));
  }
  return out;
}

/**
 * 从源码里抠出所有 import / export-from 的说明符。
 * @param {string} source
 * @returns {string[]}
 */
function extractSpecifiers(source) {
  const specifiers = [];
  // 静态 import：import x from '...' / import '...' / import {a} from '...'
  const importRe = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  // 再导出：export * from '...' / export {a} from '...'
  const exportRe = /(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  for (const re of [importRe, exportRe]) {
    let match;
    while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

test('client/ 下每个文件的相对 import 都能解析到真实文件', async () => {
  const files = await listJsFiles(CLIENT_DIR);
  assert.ok(files.length >= 8, `client 下模块太少（${files.length}），路径可能不对`);

  const missing = [];
  for (const rel of files) {
    const source = await (await fetch(`${base}module/${rel}`)).text();
    assert.ok(source.length > 0, `${rel} 是空的`);
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith('.')) continue; // 裸说明符交给宿主，不在这里查
      const target = resolve(join(CLIENT_DIR, posix.dirname(rel)), spec);
      if (!existsSync(target) || !statSync(target).isFile()) {
        missing.push(`${rel} → ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, [], `有解析不到的 import：\n${missing.join('\n')}`);
});

test('每个 client 模块都能被真正 import（等价于浏览器解析）', async () => {
  // Node 的默认 ESM loader 只吃 file:/data:，所以走磁盘文件 URL。
  // 依赖链的形状与浏览器里通过 Host 送发时完全一致，所以一样能抓到错误的 import 路径。
  const files = await listJsFiles(CLIENT_DIR);
  const failures = [];
  for (const rel of files) {
    // client/index.js 依赖 window.__ModuleLoader__，由下面的专门测试静态校验
    if (rel === 'index.js') continue;
    const url = `${pathToFileURL(join(CLIENT_DIR, rel)).href}?t=${Date.now()}`;
    try {
      const mod = await import(url);
      assert.equal(typeof mod, 'object', `${rel} 的 import 结果不是模块`);
    } catch (error) {
      failures.push(`${rel}: ${error?.message ?? error}`);
    }
  }
  assert.deepEqual(failures, [], `有模块 import 失败：\n${failures.join('\n')}`);
});

test('runtime 模块导出契约齐全', async () => {
  const runtime = await import(`${pathToFileURL(join(CLIENT_DIR, 'runtime/index.js')).href}?t=${Date.now()}`);
  for (const key of ['ShaderToy', 'createFromGraph', 'compileGraph', 'castExpr', 'glslLiteral', 'shadertoyHeader', 'HotReload', 'UnlitMaterialPreview']) {
    assert.equal(typeof runtime[key] === 'function' || typeof runtime[key] === 'object', true, `runtime 少了导出 ${key}`);
  }
});

test('panel 模块导出契约齐全', async () => {
  const panel = await import(`${pathToFileURL(join(CLIENT_DIR, 'panel/index.js')).href}?t=${Date.now()}`);
  assert.equal(typeof panel.ensureStyles, 'function');
  assert.equal(typeof panel.mountWorkbench, 'function');
  assert.equal(typeof panel.disposeWorkbench, 'function');
  assert.equal(typeof panel.NodeEditor, 'function');
  assert.equal(typeof panel.ParamsPanel, 'function');
  assert.equal(typeof panel.ResourceBrowser, 'function');
});

test('client/index.js 的 __ModuleLoader__ 载荷能被求值并导出正确契约', async () => {
  // client/index.js 不在 client/ 目录下，直接从磁盘读
  const entry = join(PROJECT, 'client', 'index.js');
  assert.equal(existsSync(entry), true, 'client/index.js 不存在');
  const code = await readFile(entry, 'utf8');

  let captured = null;
  // 造一个最小的 window.__ModuleLoader__ 沙箱
  const fakeWindow = {
    __ModuleLoader__: {
      load(options) {
        captured = options;
      },
    },
  };
  const fakeRequire = (name) => {
    if (name === 'react') {
      return {
        // 标记版 createElement：用来验证组件返回的是 React 元素而不是 DOM 节点
        createElement: (type, props, ...children) => ({ __reactElement: true, type, props, children }),
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
      };
    }
    throw new Error(`测试环境没有提供模块：${name}`);
  };

  // 这段代码在浏览器里是普通脚本，所以在沙箱里也用 Function 求值
  const evaluate = new Function('window', `${code}\nreturn window.__ModuleLoader__;`);
  evaluate(fakeWindow);

  assert.ok(captured, '没有调用 __ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-shader-workbench');
  assert.equal(typeof captured.factory, 'function');

  const exported = captured.factory(fakeRequire);
  assert.equal(exported.name, 'dsh-shader-workbench');
  assert.deepEqual(exported.inject, ['slots']);
  assert.equal(typeof exported.apply, 'function');
  assert.equal(typeof exported.WorkbenchIcon, 'function');
  assert.equal(typeof exported.WorkbenchPanel, 'function');

  // 侧栏槽位把组件返回值当 React child 用，所以图标必须返回 **React 元素**。
  // 旧实现用 document.createElementNS 建了 DOM 节点直接 return：这个假环境里
  // 没有 document，一点就炸；真浏览器里则是 Minified React error #31
  // （[object SVGSVGElement]），侧栏整块渲染挂掉。
  const icon = exported.WorkbenchIcon({ size: 18, active: false });
  assert.equal(icon.__reactElement, true, 'WorkbenchIcon 必须返回 React 元素，不能返回 DOM 节点');
  assert.equal(icon.type, 'svg');
  assert.equal(icon.children.length, 4, '两个方块 + 一条连线 + 一个输出圆');
  assert.equal(icon.props.width, 18, 'size 要透传到 svg 宽度');
});

test('apply 在没有 slots 服务时静默退出而不是抛错', async () => {
  const entry = join(PROJECT, 'client', 'index.js');
  const code = await readFile(entry, 'utf8');
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (o) => {
        captured = o;
      },
    },
  };
  new Function('window', `${code}\nreturn window.__ModuleLoader__;`)(fakeWindow);
  const exported = captured.factory(() => ({ createElement: () => ({}) }));

  // 空 ctx：不该抛
  assert.equal(exported.apply({}), undefined);

  // 有 slots：应该往两个槽位各注入一次，并返回 dispose
  const calls = [];
  const dispose = exported.apply({
    slots: {
      inject: (key, cb) => {
        calls.push(key);
        // 真的执行回调，验证 register 的调用形状
        cb();
        return () => {};
      },
      register: () => () => {},
    },
  });
  assert.deepEqual(calls.sort(), ['main', 'sidebar.panellist']);
  assert.equal(typeof dispose, 'function');
  dispose();
});
