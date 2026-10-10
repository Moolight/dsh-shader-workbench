/**
 * 存储位置（插件设置）测试。
 *
 * 守的是这个 bug：**面板和 agent 曾经各算各的根目录** ——
 * 工具带着会话上下文，算出 `<会话目录>/shader-workbench`；
 * 面板走 HTTP、没有会话上下文，算出 `<宿主进程目录>/shader-workbench`。
 * 结果 agent 把材质写进 A，用户在面板里看的是 B（空的），资源树永远空、
 * 一堆按钮点了没反应。修法是加一层**两边共用**的持久化设置。
 *
 * 所以这里不只测读写文件，更要测「设置写下去之后，面板和工具看到的是同一个根」。
 *
 * 跑法：node tests/settings.test.js
 *
 * @module dsh-shader-workbench/tests/settings
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-settings-'));
// 必须在 import 插件之前设好：插件顶层就会写启动日志
process.env.DSH_SHADER_WORKBENCH_SETTINGS = join(tempRoot, 'shader-workbench.json');
process.env.DSH_SHADER_WORKBENCH_BOOTLOG = join(tempRoot, 'boot.log');
delete process.env.DSH_SHADER_WORKBENCH_ROOT;

const settings = await import('../host/settings.js');
const plugin = await import('../host/index.js');

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  delete process.env.DSH_SHADER_WORKBENCH_SETTINGS;
  delete process.env.DSH_SHADER_WORKBENCH_BOOTLOG;
});

/** 够用的假 Cordis context，把注册结果接住。 */
function makeFakeContext() {
  const tools = [];
  const routes = [];
  return {
    tools,
    routes,
    ctx: {
      tools: { register: (d) => tools.push(d) },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
      effect: (fn) => {
        const dispose = fn();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

test('设置文件的读写：绝对路径能存能读，相对路径被拒，空串清掉', () => {
  const target = join(tempRoot, 'ws');

  const written = settings.writeSettings({ workspaceRoot: target });
  assert.equal(written.workspaceRoot, target);
  assert.equal(settings.readSettings().workspaceRoot, target);

  assert.throws(() => settings.writeSettings({ workspaceRoot: 'relative/path' }), /绝对路径/);

  settings.writeSettings({ workspaceRoot: '' });
  assert.equal(settings.readSettings().workspaceRoot, undefined);
  assert.deepEqual(settings.readSettings(), {});
});

test('设置文件坏掉时当「没设置」，不能让读设置把插件带崩', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(settings.settingsPath(), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(settings.readSettings(), {});
  // 坏文件还能被下一次写覆盖回来
  const target = join(tempRoot, 'ws-recover');
  settings.writeSettings({ workspaceRoot: target });
  assert.equal(settings.readSettings().workspaceRoot, target);
});

test('写进设置的存储位置，面板和工具必须看到同一个根（就是那个"两边不是一个目录"的坑）', async () => {
  const { tools, routes, ctx } = makeFakeContext();
  plugin.apply(ctx, {});
  assert.ok(routes.length > 0, '没拿到路由');

  const server = createServer((req, res) => routes[0].handler(req, res));
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;

  /** 调一次 API。 */
  const api = async (action, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-shader-workbench/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }),
    });
    return response.json();
  };

  try {
    const target = join(tempRoot, 'unified-ws');

    const write = await api('settings.write', { workspaceRoot: target });
    assert.equal(write.ok, true, `settings.write 失败：${JSON.stringify(write)}`);
    assert.equal(write.root, target);

    // ① 面板侧（HTTP，没有会话上下文）
    const overview = await api('workspace.overview');
    assert.equal(overview.root, target, '面板没跟着设置走');

    // ② 工具侧（带一个完全不同的会话 cwd，也必须听设置的）
    const tool = tools.find((t) => t.name === 'shader_workspace');
    assert.ok(tool, '没有 shader_workspace 工具');
    const toolResult = await tool.execute({}, { agent: { session: { header: { cwd: join(tempRoot, 'somewhere-else') } } } });
    assert.equal(toolResult.root, target, '工具没跟着设置走 —— 面板和 agent 又会各写各的');

    // ③ settings.read 要能告诉 UI 现在用的是哪一层
    const info = await api('settings.read');
    assert.equal(info.ok, true);
    assert.equal(info.settings.workspaceRoot, target);
    assert.equal(info.root, target);
    assert.equal(info.overriddenBy, null, '没有配置/环境变量压过设置时不该报 overridden');
    assert.ok(typeof info.path === 'string' && info.path.endsWith('shader-workbench.json'));

    // ④ 清掉设置：设置层没了，面板回到「跟着最近一次工具解析出的根」——
    //    这正是让两侧不靠设置也能一致的那条兜底，所以 root 仍可能指向同一个目录。
    const cleared = await api('settings.write', { workspaceRoot: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.settings.workspaceRoot, undefined, '清掉之后设置文件里不该还留着 workspaceRoot');
    const afterClear = await api('settings.read');
    assert.equal(afterClear.settings.workspaceRoot, undefined);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test('没配任何东西时，面板跟着最近一次工具解析出的根走（不靠设置也能一致）', async () => {
  settings.writeSettings({ workspaceRoot: '' });
  const { tools, routes, ctx } = makeFakeContext();
  plugin.apply(ctx, {});

  const server = createServer((req, res) => routes[0].handler(req, res));
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const port = server.address().port;

  const api = async (action, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-shader-workbench/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }),
    });
    return response.json();
  };

  try {
    const sessionCwd = join(tempRoot, 'session-cwd');
    const tool = tools.find((t) => t.name === 'shader_workspace');
    const toolResult = await tool.execute({}, { agent: { session: { header: { cwd: sessionCwd } } } });
    assert.equal(toolResult.root, join(sessionCwd, 'shader-workbench'));

    const overview = await api('workspace.overview');
    assert.equal(
      overview.root,
      join(sessionCwd, 'shader-workbench'),
      '面板没有跟着工具走，用户打开面板又会看到空目录',
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
