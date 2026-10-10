/**
 * 插件装载测试：用假的 Cordis context 把 Host 侧 apply() 真跑一遍。
 *
 * 这个测试的价值：它能抓住「插件一装上就让 DSH 整个 failed」的那类问题——
 * 比如工具声明缺 `output` 契约、路由注册形状不对、模块顶层抛错。
 * 这些在真机上是致命的（一个工具注册不上，整条插件都起不来）。
 *
 * 跑法：node tests/plugin-load.test.js
 *
 * @module dsh-shader-workbench/tests/plugin-load
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-load-'));
/** 把启动诊断日志重定向到临时目录，别污染用户 ~/.dsh。 */
const BOOT_LOG = join(tempRoot, 'boot.log');
process.env.DSH_SHADER_WORKBENCH_BOOTLOG = BOOT_LOG;

const plugin = await import('../host/index.js');

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  delete process.env.DSH_SHADER_WORKBENCH_BOOTLOG;
});

/**
 * 造一个够用的假 context，并把调用记下来。
 * @param {object} [config]
 * @returns {{ctx:object, tools:object[], routes:object[], effects:string[], logs:string[]}}
 */
function makeFakeContext(config = undefined) {
  const tools = [];
  const routes = [];
  const effects = [];
  const logs = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect(fn, label) {
      effects.push(label ?? 'effect');
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  };
  return { ctx, tools, routes, effects, logs, config };
}

test('模块顶层导出符合 Cordis 插件契约', () => {
  assert.equal(plugin.name, 'dsh-shader-workbench');
  assert.deepEqual(plugin.inject, ['tools', 'webServer']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(
    'default' in plugin,
    false,
    '不能有 default 导出：Include 装载写的是 `module.default || module`，有 default 就只剩裸 apply，inject/Config/name 全丢',
  );
  assert.equal(typeof plugin.Config, 'object');
  assert.equal(
    typeof plugin.Config['~standard']?.validate,
    'function',
    'Config 必须是 Standard Schema：裸 JSON Schema 会让 Cordis 在激活 fiber 时抛 TypeError，插件静默不生效',
  );
});

test('按 Include 的装载方式取插件时，inject / Config / name 必须还在', () => {
  // 逐字复刻 @deepseek-ai/cordis-plugin-include 的装载语句（lib/index.js:157）。
  // 这是本项目最贵的坑：模块一旦有 default 导出，宿主拿到的就是裸 apply 函数，
  // inject 变空 → fiber 不等服务就激活 → apply 里第一句 ctx.tools 抛
  // `cannot get property "tools" without inject`，而且只写进 DSH 自己的 stderr。
  const data = plugin.default || plugin;

  assert.equal(typeof data.apply, 'function');
  assert.deepEqual(
    data.inject,
    ['tools', 'webServer'],
    'inject 丢了：宿主不会等 tools/webServer，apply 一碰 ctx.tools 就炸',
  );
  assert.equal(typeof data.Config?.['~standard']?.validate, 'function', 'Config 丢了：配置校验会抛 TypeError');
  assert.equal(data.name, 'dsh-shader-workbench');
});

/**
 * 逐字复刻 Cordis 的 `resolveConfig`（见 @deepseek-ai/cordis 的 lib/index.js）。
 *
 * 这个函数存在的唯一理由：**真实宿主只在 fiber 激活时才走这段路，
 * 而它抛的错只写进 DSH 自己的 stderr。** 之前用假 context 直接调 apply()，
 * 整条路绕过去了，于是「模块进得来、apply 永不执行、也不报错」的 bug
 * 在 70 个用例全绿的情况下漏到了真机。
 *
 * @param {object} runtime 插件模块命名空间
 * @param {unknown} config 原始配置
 * @returns {unknown} 校验后的配置
 */
function cordisResolveConfig(runtime, config) {
  if (!runtime.Config) return config;
  const result = runtime.Config['~standard'].validate(config);
  if ('then' in result) throw new TypeError('Async config validation is not supported');
  if (result.issues) throw new Error(`invalid config: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.value;
}

test('按 Cordis 的方式解析配置后 apply() 必须真的跑起来（防「模块进了、apply 不跑」）', () => {
  const { ctx, tools, routes } = makeFakeContext();

  // 这两行就是宿主做的事，顺序不能变
  const resolved = cordisResolveConfig(plugin, { workspaceRoot: join(tempRoot, 'ws-cordis') });
  plugin.apply(ctx, resolved);

  assert.equal(tools.length, 9, 'apply 没跑到底：工具没注册齐');
  assert.equal(routes.length, 1);

  // 空配置（patch 行里没写 config）也必须能过
  assert.doesNotThrow(() => cordisResolveConfig(plugin, undefined));
  assert.doesNotThrow(() => cordisResolveConfig(plugin, {}));

  // 类型写错要被挡下来，而不是带着错值往下走
  const bad = plugin.Config['~standard'].validate({ readOnly: 'yes' });
  assert.equal(bad.issues?.length, 1);
  assert.deepEqual(bad.issues[0].path, ['readOnly']);

  // 缺省值由 schema 补齐
  assert.equal(plugin.Config['~standard'].validate({}).value.exposeNodeLibraryTool, true);
});

test('exposeNodeLibraryTool=false 时不注册节点库工具', () => {
  const { ctx, tools } = makeFakeContext();
  const resolved = cordisResolveConfig(plugin, {
    workspaceRoot: join(tempRoot, 'ws-nolib'),
    exposeNodeLibraryTool: false,
  });
  const result = plugin.apply(ctx, resolved);

  assert.equal(tools.length, 8);
  assert.ok(!result.registered.includes('shader_node_library'));
  assert.deepEqual(result.failed, []);
});

test('apply() 能跑通，并注册全部工具 + 一条路由 + 一个 effect', () => {
  const { ctx, tools, routes, effects } = makeFakeContext({
    workspaceRoot: join(tempRoot, 'ws'),
  });

  const result = plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws') });

  const expectedTools = [
    'shader_node_library',
    'shader_workspace',
    'shader_project',
    'shader_material',
    'shader_graph_build',
    'shader_compile',
    'shader_export',
    'shader_snapshot',
    'shader_texture_import',
  ];
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...expectedTools].sort(),
    '注册的工具集合和契约不一致',
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(
    routes[0].path,
    '/plugins/dsh-shader-workbench',
    '注册的前缀不能带尾斜杠：宿主 webserver 会自己补一个 "/" 再比，带尾斜杠就永远匹配不上',
  );
  assert.equal(typeof routes[0].handler, 'function');
  assert.ok(effects.some((e) => e.includes('http api')), `effects 里没有路由那条：${effects.join(', ')}`);

  // apply 返回一份「注册结果」，同时会被写进 boot log —— 这是插件自诊断的入口
  assert.deepEqual(result.registered.sort(), [...expectedTools].sort());
  assert.deepEqual(result.failed, [], `不该有注册失败的：${result.failed.join('; ')}`);
  assert.equal(result.route, 'ok');
});

test('注册的前缀能被宿主 webserver 真正匹配上（面板加载失败的那个坑）', () => {
  const { ctx, routes } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-route') });
  const { path: prefix } = routes[0];

  // 逐字复刻 @deepseek-ai/dsh-host-webserver 的前缀匹配（lib/index.js:328）：
  //   if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
  const matches = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  // 浏览器和面板真正会请求的那些 URL —— 一个都不能漏
  for (const pathname of [
    '/plugins/dsh-shader-workbench/ping',
    '/plugins/dsh-shader-workbench/module/panel/index.js',
    '/plugins/dsh-shader-workbench/module/runtime/index.js',
    '/plugins/dsh-shader-workbench/shared/graph.js',
    '/plugins/dsh-shader-workbench/api',
    '/plugins/dsh-shader-workbench/texture',
  ]) {
    assert.equal(matches(pathname), true, `宿主匹配不到这个 URL：${pathname}（面板会 Failed to fetch dynamically imported module）`);
  }

  // 反面：带尾斜杠的前缀一个都匹配不上 —— 这就是 2026-10-10 现场
  const withSlash = `${prefix}/`;
  assert.equal(
    '/plugins/dsh-shader-workbench/module/panel/index.js'.startsWith(`${withSlash}/`),
    false,
    '带尾斜杠的注册前缀匹配不到任何子路径（多出来一个 //）',
  );
});

test('启动诊断日志会记录 module-loaded / apply-start / apply-ok', async () => {
  const { tools } = makeFakeContext();
  const ctx = {
    tools: { register: (d) => tools.push(d) },
    webServer: { register: () => () => {} },
    effect: () => () => {},
  };
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-log') });

  const text = await readFile(BOOT_LOG, 'utf8');
  const lines = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const phases = lines.map((entry) => entry.phase);
  assert.ok(phases.includes('module-loaded'), `boot log 里没有 module-loaded：${phases.join(',')}`);
  assert.ok(phases.includes('apply-start'), `boot log 里没有 apply-start：${phases.join(',')}`);
  assert.ok(phases.includes('apply-ok'), `boot log 里没有 apply-ok：${phases.join(',')}`);
  assert.ok(phases.includes('tool-register-failed') === false, '不该有工具注册失败');

  const ok = lines.filter((entry) => entry.phase === 'apply-ok').pop();
  assert.equal(ok.hasTools, true);
  assert.equal(ok.hasWebServer, true);
  assert.equal(ok.route, 'ok');
  assert.equal(ok.registered.length, 9);
});

test('单个工具注册失败不会拖垮其它工具', () => {
  const { tools } = makeFakeContext();
  const rejected = [];
  const ctx = {
    tools: {
      register(definition) {
        // 模拟 DSH 的 schema 校验拒绝某一个工具
        if (definition.name === 'shader_snapshot') throw new TypeError('tool "shader_snapshot" must declare output { schema, render }');
        tools.push(definition);
      },
    },
    webServer: { register: () => () => {} },
    effect: () => () => {},
    logger: { error: (m) => rejected.push(m) },
  };

  const result = plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-resilient') });

  // 8 个成功、1 个失败，路由照常
  assert.equal(result.registered.length, 8, `成功数不对：${result.registered.join(',')}`);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /shader_snapshot/);
  assert.equal(result.route, 'ok', '一个工具失败不该影响路由注册');
  assert.equal(tools.length, 8);
  assert.equal(rejected.length, 1, '失败原因要报给 logger');
});

test('路由注册失败时工具仍然可用', () => {
  const { tools } = makeFakeContext();
  const ctx = {
    tools: { register: (d) => tools.push(d) },
    webServer: {
      register() {
        throw new Error('webServer: route conflict');
      },
    },
    effect: (fn) => {
      fn();
      return () => {};
    },
  };

  const result = plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-route-fail') });
  assert.equal(result.registered.length, 9, '工具应该全部注册成功');
  assert.match(result.route, /^failed: /);
});

test('每个工具都声明了必填的 output 契约（缺了整条插件会 failed）', () => {
  const { ctx } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws2') });
  void ctx;
  const { tools } = makeFakeContext();
  const ctx2 = {
    tools: { register: (d) => tools.push(d) },
    webServer: { register: () => () => {} },
    effect: () => () => {},
  };
  plugin.apply(ctx2, { workspaceRoot: join(tempRoot, 'ws2') });

  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string', '工具有没有名字的');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺 description`);
    assert.ok(tool.description.length > 20, `${tool.name} 的 description 太短，agent 看不懂`);
    assert.equal(typeof tool.parameters, 'object', `${tool.name} 缺 parameters schema`);
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的 parameters 不是 object schema`);
    assert.ok(tool.output && typeof tool.output === 'object', `${tool.name} 缺 output 契约`);
    assert.equal(typeof tool.output.schema, 'object', `${tool.name} 的 output.schema 不是对象`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 的 output.render 不是函数`);
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`);
  }
});

/**
 * 复刻宿主 `@deepseek-ai/dsh-tools` 拿到工具返回值之后做的事。
 *
 * `createSuccessResult` 里是 `content = tool.output.render(args, value)`，
 * 也就是说 **`render` 的返回值直接就是 `result.content`**；之后宿主会执行
 *
 *     result.content.some((block) => block.type === "image")
 *
 * 所以 `render` 返回字符串的话，这一句就是 `content.some is not a function`。
 *
 * @param {object} tool
 * @param {object} args
 * @param {unknown} value
 * @returns {object[]} 归一化后的 content
 */
function dshToolContent(tool, args, value) {
  const content = tool.output.render(args, value);
  assert.ok(
    Array.isArray(content),
    `${tool.name}: output.render 必须返回 ContentBlock[]（宿主会对它调 .some），拿到的是 ${typeof content}`,
  );
  assert.doesNotThrow(() => content.some((block) => block.type === 'image'), `${tool.name}: 宿主那句 content.some 会炸`);
  for (const block of content) {
    assert.equal(block?.type, 'text', `${tool.name}: content block 的 type 应该是 text`);
    assert.equal(typeof block.text, 'string', `${tool.name}: content block 缺 text`);
  }
  return content;
}

test('工具返回值过一遍宿主的 output.render + content.some 不能炸（线上 9 个工具全挂的那个坑）', async () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-content') });

  // ① 能独立跑的工具：拿真实返回值过一遍宿主流程
  const runnable = [
    ['shader_node_library', {}],
    ['shader_workspace', {}],
    ['shader_project', { action: 'list' }],
    ['shader_material', { action: 'list', project: 'demo' }],
  ];
  for (const [name, args] of runnable) {
    const tool = tools.find((t) => t.name === name);
    const value = await tool.execute(args, {});
    const content = dshToolContent(tool, args, value);
    assert.ok(content.length > 0, `${name}: 渲染出来是空的`);
    assert.ok(content[0].text.length > 0, `${name}: 渲染出来是空字符串`);
  }

  // ② 其余几个喂代表性 value + 空值，形状必须一致
  for (const tool of tools) {
    dshToolContent(tool, {}, { ok: true, sample: [1, 2, 3] });
    dshToolContent(tool, {}, undefined);
  }
});

test('shader_node_library 的 markdown 正文不被 JSON 转义', () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws-md') });
  const tool = tools.find((t) => t.name === 'shader_node_library');
  const content = dshToolContent(tool, {}, { ok: true, format: 'markdown', content: '# 标题\n\n- 一行\n' });
  assert.equal(content[0].text, '# 标题\n\n- 一行\n', 'markdown 应该原样交给模型');
});

test('shader_node_library 能真正执行并返回节点手册', async () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws3') });
  const tool = tools.find((t) => t.name === 'shader_node_library');
  const result = await tool.execute({}, {});
  assert.equal(result.ok, true);
  assert.match(result.content, /Shader Workbench 节点库/);
  // 关键节点都要出现在手册里，否则 agent 写不出图
  for (const type of ['uv', 'output', 'palette', 'texture', 'bufferSample', 'custom', 'split']) {
    assert.ok(result.content.includes(`\`${type}\``), `节点手册里少了 ${type}`);
  }
  // 通道与 Pass 说明也要在
  assert.match(result.content, /iChannel0/);
  assert.match(result.content, /BufferA/);
});

test('未知 workdir 时 shader_workspace 也能跑（会自动建目录）', async () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws4') });
  const tool = tools.find((t) => t.name === 'shader_workspace');
  const result = await tool.execute({}, {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.root, join(tempRoot, 'ws4'));
  assert.deepEqual(result.projects, []);
});

test('shader_project / shader_material / shader_graph_build 串起来能出图', async () => {
  const root = join(tempRoot, 'ws5');
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: root });
  const call = (name, args) => tools.find((t) => t.name === name).execute(args, {});

  const project = await call('shader_project', { action: 'create', name: 'demo' });
  assert.equal(project.ok, true, JSON.stringify(project));

  const material = await call('shader_material', { action: 'create', project: 'demo', material: 'plasma' });
  assert.equal(material.ok, true, JSON.stringify(material));

  const built = await call('shader_graph_build', {
    project: 'demo',
    material: 'plasma',
    name: 'plasma',
    nodes: [
      { id: 'uv0', type: 'uv', x: 0, y: 0 },
      { id: 't0', type: 'time', x: 0, y: 160 },
      { id: 'pal', type: 'palette', x: 220, y: 80 },
      { id: 'out0', type: 'output', x: 460, y: 80 },
    ],
    edges: [
      { from: 'uv0.out', to: 'pal.t' },
      { from: 't0.out', to: 'pal.t' },
      { from: 'pal.out', to: 'out0.color' },
    ],
  });
  // 两条线接到同一个输入端口：图里都留着，但生成器只认第一条
  // （normalizeGraph 按 `上游.端口->下游.端口` 去重，两条来源不同所以不会互相顶掉）
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.edgeCount, 3, '同一个输入端口的多条来线应该都保留在图里');

  const built2 = await call('shader_graph_build', {
    project: 'demo',
    material: 'plasma',
    nodes: [
      { id: 'uv0', type: 'uv' },
      { id: 'sc', type: 'scaleP' },
      { id: 'pal', type: 'palette' },
      { id: 'out0', type: 'output' },
    ],
    edges: [
      { from: 'uv0.out', to: 'sc.p' },
      { from: 'sc.out', to: 'pal.t' },
      { from: 'pal.out', to: 'out0.color' },
    ],
  });
  assert.equal(built2.ok, true, JSON.stringify(built2));
  assert.equal(built2.nodeCount, 4);
  assert.equal(built2.compiled.image.ok, true);

  const read = await call('shader_material', { action: 'read', project: 'demo', material: 'plasma' });
  assert.equal(read.graph.nodes.length, 4);
  assert.equal(read.graph.edges.length, 3);

  const compiled = await call('shader_compile', { project: 'demo', material: 'plasma' });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.match(compiled.code, /^#version 300 es/);

  const snapshot = await call('shader_snapshot', { project: 'demo', material: 'plasma', label: 't1' });
  assert.equal(snapshot.ok, true);

  const exported = await call('shader_export', { project: 'demo', material: 'plasma' });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.match(exported.shader, /void main\(\)/);
});

test('工具在参数缺失时返回 ok:false 而不是抛错', async () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws6') });
  const tool = tools.find((t) => t.name === 'shader_material');

  // 非法项目名：被名字白名单挡住
  const evil = await tool.execute({ action: 'read', project: '../../evil', material: 'x' }, {});
  assert.equal(evil.ok, false);
  assert.match(evil.error, /不能是|非法字符|越出工作区/);

  // 合法项目但没给材质名：报人话
  const noName = await tool.execute({ action: 'read', project: 'demo' }, {});
  assert.equal(noName.ok, false);
  assert.match(noName.error, /需要 material/);

  // 目录不存在：报人话而不是崩
  const missing = await tool.execute({ action: 'read', project: 'demo', material: 'nope' }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /材质不存在/);
});

test('只读配置下写操作被拒', async () => {
  const { ctx, tools } = makeFakeContext();
  plugin.apply(ctx, { workspaceRoot: join(tempRoot, 'ws7'), readOnly: true });
  const tool = tools.find((t) => t.name === 'shader_project');
  const result = await tool.execute({ action: 'create', name: 'nope' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /只读/);
});

test('buildGraphFromSpec 的界面写法与完整写法都吃', () => {
  const viaAlias = plugin.buildGraphFromSpec({
    nodes: [
      { id: 'uv0', type: 'uv' },
      { id: 'out0', type: 'output' },
    ],
    edges: [{ from: 'uv0.out', to: 'out0.color' }],
  });
  assert.equal(viaAlias.nodes.length, 2);
  assert.equal(viaAlias.edges.length, 1);

  // 没给 id 别名时，边的引用必须是真实 id
  const direct = plugin.buildGraphFromSpec({
    nodes: [
      { id: 'a', type: 'uv' },
      { id: 'b', type: 'output' },
    ],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'color' } }],
  });
  assert.equal(direct.edges.length, 1);
});

test('buildGraphFromSpec 对坏输入报人话', () => {
  assert.throws(() => plugin.buildGraphFromSpec({ nodes: [{ type: '' }] }), /都要有 type/);
  assert.throws(
    () => plugin.buildGraphFromSpec({ nodes: [{ id: 'a', type: 'uv' }], edges: [{ from: 'nosuchdot', to: 'a.out' }] }),
    /节点id\.端口id/,
  );
});
