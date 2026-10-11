/**
 * dsh-shader-workbench —— DSH Shader 工作台（Host 侧）。
 *
 * 职责：
 *   1. 注册 agent 工具（工作区 / 项目 / 材质 / 节点图 / 编译 / 快照）
 *   2. 挂 webServer 前缀路由，给工作台面板提供 API 与 runtime 模块
 *   3. 通过客户端插件注册侧栏入口 + 中间主面板
 *
 * 依赖的 Host Service：`tools`、`webServer`。
 * 客户端部分见 client/index.js，通过 package.json 的 dsh.client 挂载。
 *
 * @module dsh-shader-workbench
 */

import { join, resolve } from 'node:path';
import { existsSync, appendFileSync } from 'node:fs';

import { Workspace } from './workspace.js';
import { createRoute, PLUGIN_ID, guard } from './routes.js';
import { dshHomeDir, readSettings, settingsPath, writeSettings } from './settings.js';
import { nodeLibraryStatus, reloadBuiltinNodes, syncUserNodes } from './node-library.js';
import {
  BUFFER_NAMES,
  CHANNEL_SLOTS,
  NODE_CATEGORIES,
  NODE_LIBRARY,
  PASS_NAMES,
  PORT_TYPES,
  makeEdge,
  makeGraph,
  makeNode,
  normalizeGraph,
  setPassNodes,
} from '../shared/index.js';
import { compileGraph } from '../client/runtime/codegen.js';
import { crossCompile, listExportTargets } from '../shared/cross-compile.js';
import { importShadertoy } from '../shared/shadertoy-import.js';

/** Cordis 插件名。 */
export const name = PLUGIN_ID;

/** 依赖的 Host Service。 */
export const inject = ['tools', 'webServer'];

/** 版本号，/ping 与工具输出里用。 */
export const version = '0.1.0';

/**
 * 启动诊断日志的路径。
 *
 * 为什么要自己留一份：**插件加载失败时 DSH 只把原因写进自己的 stderr，不落盘。**
 * 桌面壳里那个 stderr 没人看得见，于是「插件为什么没生效」变成一个查不动的问题。
 * 这个文件把「模块是否被 import」「apply 是否被调用」「注册结果」记下来，
 * 一出问题看一行就知道卡在哪一步。
 *
 * 路径可以用 `DSH_SHADER_WORKBENCH_BOOTLOG` 覆盖（测试用它避免污染用户目录）。
 *
 * @returns {string}
 */
export function bootLogPath() {
  // 一旦定下来就缓存：跑起来之后没人会去改这个环境变量，而「落点会变」本身
  // 就是个坑 —— 同进程跑的测试文件会互相把日志抢走（settings.test.js 改了这个
  // 变量，plugin-load.test.js 的启动日志断言就跟着挂）。
  if (bootLogPathCache !== null) return bootLogPathCache;
  const override = process.env.DSH_SHADER_WORKBENCH_BOOTLOG;
  bootLogPathCache =
    typeof override === 'string' && override.trim() !== ''
      ? resolve(override)
      : join(dshHomeDir(), 'shader-workbench-boot.log');
  return bootLogPathCache;
}

/** bootLogPath 的进程级缓存。 */
let bootLogPathCache = null;

/**
 * 追加一行启动日志。**任何异常都必须吞掉**——诊断不能影响插件本身。
 * @param {string} phase
 * @param {object} [extra]
 */
function bootLog(phase, extra) {
  try {
    appendFileSync(
      bootLogPath(),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version, phase, ...extra })}\n`,
    );
  } catch {
    // 诊断失败就算了，绝不能因此让插件挂掉
  }
}

/** 把任意错误压成一行可读文本。 */
function messageOfError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// 模块顶层就记一笔：能区分「模块压根没被 import」和「apply 抛了」。
bootLog('module-loaded', {
  node: process.version,
  electron: process.versions?.electron ?? null,
  dshHome: dshHomeDir(),
});

/**
 * 插件配置字段表。
 */
const CONFIG_FIELDS = {
  workspaceRoot: {
    type: 'string',
    description: '工作区根目录（绝对路径）。缺省落在 Session 工作目录下的 shader-workbench/。',
  },
  readOnly: {
    type: 'boolean',
    description: '只读模式：所有写入操作都会被拒绝，用于巡检已有工作区。',
  },
  exposeNodeLibraryTool: {
    type: 'boolean',
    description: '是否注册 shader_node_library 工具（返回完整节点库，输出较长）。默认 true。',
  },
};

/**
 * 校验并归一化插件配置。
 *
 * @param {unknown} value 原始配置（可能是 undefined）
 * @returns {{value: object} | {issues: {message: string, path: string[]}[]}}
 */
function validateConfig(value) {
  const input = value !== null && typeof value === 'object' ? value : {};
  const issues = [];
  for (const [key, meta] of Object.entries(CONFIG_FIELDS)) {
    const given = input[key];
    if (given === undefined || given === null) continue;
    if (typeof given !== meta.type) {
      issues.push({ message: `必须是 ${meta.type}，收到 ${typeof given}`, path: [key] });
    }
  }
  if (issues.length > 0) return { issues };
  const normalized = { ...input };
  if (normalized.exposeNodeLibraryTool === undefined) normalized.exposeNodeLibraryTool = true;
  return { value: normalized };
}

/**
 * 插件配置 schema。
 *
 * ⚠️ **必须是 Standard Schema（`~standard.validate`），不能写成裸 JSON Schema。**
 *
 * Cordis 激活 fiber 时无条件执行 `Config['~standard'].validate(config)`
 * （见 `@deepseek-ai/cordis` 的 `resolveConfig`）。裸对象没有 `~standard`，
 * 这一步抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 而 fiber 把它吞进 `ctx.logger.error` —— DSH 桌面壳里那个 stderr 没人看得见。
 * 现场表现极具误导性：**模块 import 了（boot log 有 `module-loaded`）、
 * `apply()` 永远不跑（没有 `apply-start`）、侧栏什么都不出现、也不报错。**
 * 2026-10-10 就是这么整整排查了一轮。
 *
 * 之所以不引 schemastery：本插件用 `link:` 装在 profile 之外（项目目录），
 * `@deepseek-ai/schemastery` 从插件目录解析不到，静态 import 会让插件连模块都进不来。
 * 所以这里手写一个最小 Standard Schema（v1），零依赖。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-shader-workbench',
    validate: validateConfig,
  },
};

// 自检：Config 一旦退回裸 JSON Schema，宿主会在激活 fiber 时抛错且**只写进它自己的
// stderr**。这里提前把「schema 不合契约」记进我们自己的 boot log，
// 免得下次又变成「模块进了、apply 没跑、什么日志都没有」。
if (typeof Config['~standard']?.validate !== 'function') {
  bootLog('config-schema-invalid', {
    note: 'Config 必须是 Standard Schema（~standard.validate），否则 Cordis 的 resolveConfig 会抛 TypeError 并且永远不会调用 apply()',
  });
}

/**
 * 工具的统一输出契约。
 *
 * DSH 的 tools registry 强制要求每个工具声明 `output: { schema, render }`，
 * 缺了会直接抛错并让整条插件进入 failed 状态、一个工具都注册不上。
 *
 * ⚠️ **`render` 必须返回 `ContentBlock[]`，不能返回字符串。**
 * 官方类型就是这么写的（`dsh-tool-cordis/lib/types/api-catalog.js`）：
 *
 *     interface ToolOutputDefinition {
 *       readonly schema: JsonSchemaNode;
 *       render(args: unknown, value: JsonValue): ContentBlock[];
 *     }
 *
 * 宿主会把 `render` 的返回值直接当 `result.content` 用，后面还有
 * `result.content.some((block) => block.type === 'image')` 之类的处理。
 * 返回字符串 → `content.some is not a function`，**9 个工具一调用就全挂**
 * （注册阶段完全正常，所以 boot log 一路 apply-ok，只有真正调工具时才炸）。
 * 2026-10-10 踩过：`plugin-load.test.js` 只断言了 `typeof render === 'function'`
 * 并直接调它，从来没走宿主的 result 成形流程，所以又一次全绿漏过。
 *
 * @returns {object}
 */
function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      description: '结构化返回：ok 状态、路径、图/清单数据与错误信息。',
    },
    render(_args, value) {
      if (value === undefined || value === null) return [];
      // markdown 类的结果直接把正文交给模型，别套一层 JSON（换行会被转义成一坨 \n）
      if (typeof value === 'object' && value.format === 'markdown' && typeof value.content === 'string') {
        return [{ type: 'text', text: value.content }];
      }
      let text;
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      return [{ type: 'text', text }];
    },
  };
}

/**
 * 最近一次「带会话上下文」解析出来的根目录。
 *
 * 面板走 HTTP，请求里没有 Session，算不出 agent 的会话工作目录。所以工具每解析
 * 一次就记下来，面板在没有显式设置时跟着用同一个 —— 否则两边各写各的：
 * agent 把材质写进 A，用户打开面板看到的是 B（空的），一堆按钮因此"点了没反应"。
 * @type {string|null}
 */
let lastResolvedRoot = null;

/**
 * 记下工具侧解析出来的根目录。
 * @param {string} root
 * @returns {string}
 */
export function rememberWorkspaceRoot(root) {
  lastResolvedRoot = root;
  return root;
}

/**
 * 解析工作区根目录。
 *
 * 优先级：
 *   1. 显式配置（profile 的 `cordis.patch.yml` 里的 `workspaceRoot`）
 *   2. 环境变量 `DSH_SHADER_WORKBENCH_ROOT`
 *   3. **用户在面板里选定的位置**（`<DSH_HOME>/shader-workbench.json`）
 *   4. 会话工作目录 / shader-workbench（仅工具；面板跟着最近一次结果走）
 *   5. 进程 cwd / shader-workbench
 *
 * 第 3 条是面板和工具**共用**的那一层，也是「存储位置可以自定义」的落点。
 *
 * @param {object} config
 * @param {object} [exec] 工具执行上下文；面板侧没有
 * @returns {string}
 */
export function resolveWorkspaceRoot(config, exec) {
  const configured = config?.workspaceRoot;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured);
  const fromEnv = process.env.DSH_SHADER_WORKBENCH_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv);
  const saved = readSettings().workspaceRoot;
  if (typeof saved === 'string' && saved.trim() !== '') return resolve(saved);
  const sessionCwd = exec?.agent?.session?.header?.cwd;
  if (typeof sessionCwd === 'string' && sessionCwd !== '') return join(resolve(sessionCwd), 'shader-workbench');
  if (lastResolvedRoot !== null) return lastResolvedRoot;
  return join(resolve(process.cwd()), 'shader-workbench');
}

/**
 * 只读开关：显式配置优先，其次设置文件。
 * @param {object} config
 * @returns {boolean}
 */
function effectiveReadOnly(config) {
  if (typeof config?.readOnly === 'boolean') return config.readOnly;
  return readSettings().readOnly === true;
}

/**
 * 把工具参数里的「友好节点写法」转成正式 ShaderGraph。
 *
 * 友好写法：
 *   nodes: [{ id: 'uv0', type: 'uv', x: 0, y: 0, params: {} }]
 *   edges: [{ from: 'uv0.out', to: 'out0.color' }]        ← `节点id.端口id`
 *
 * 也接受已经完整的图（有 `from: {node, port}` 形式），两种都吃。
 *
 * @param {object} spec
 * @returns {object} 归一化后的图
 */
export function buildGraphFromSpec(spec = {}) {
  const idMap = new Map();
  const nodes = (Array.isArray(spec.nodes) ? spec.nodes : []).map((n) => {
    const type = String(n?.type ?? '');
    if (type === '') throw new Error('每个节点都要有 type');
    const created = makeNode(
      type,
      Number.isFinite(n.x) ? n.x : 0,
      Number.isFinite(n.y) ? n.y : 0,
      n.params && typeof n.params === 'object' ? n.params : {},
    );
    if (typeof n.id === 'string' && n.id !== '') idMap.set(n.id, created.id);
    return created;
  });

  /** 解析 `别名.端口` 或 `{node,port}`。 */
  const parseRef = (ref, what) => {
    if (ref && typeof ref === 'object' && typeof ref.node === 'string') {
      return { node: idMap.get(ref.node) ?? ref.node, port: String(ref.port ?? '') };
    }
    const text = String(ref ?? '');
    const dot = text.lastIndexOf('.');
    if (dot <= 0) throw new Error(`${what} 的写法应该是 "节点id.端口id"，收到：${text}`);
    const alias = text.slice(0, dot);
    return { node: idMap.get(alias) ?? alias, port: text.slice(dot + 1) };
  };

  const edges = (Array.isArray(spec.edges) ? spec.edges : []).map((e) => {
    const from = parseRef(e?.from, 'edge.from');
    const to = parseRef(e?.to, 'edge.to');
    return makeEdge(from.node, from.port, to.node, to.port);
  });

  const graph = makeGraph({
    name: typeof spec.name === 'string' && spec.name !== '' ? spec.name : 'untitled',
    nodes,
    edges,
    uniforms: Array.isArray(spec.uniforms) ? spec.uniforms : [],
  });

  // Pass 归属：显式给了 passes 就用，否则全部塞进 image
  if (spec.passes && typeof spec.passes === 'object') {
    for (const [passName, list] of Object.entries(spec.passes)) {
      if (!PASS_NAMES.includes(passName)) throw new Error(`非法 Pass 名：${passName}`);
      const ids = (Array.isArray(list) ? list : []).map((alias) => idMap.get(String(alias)) ?? String(alias));
      setPassNodes(graph, passName, ids);
    }
    // 没点名归属的节点默认进 image
    const assigned = new Set(Object.values(spec.passes).flat().map((a) => idMap.get(String(a)) ?? String(a)));
    const leftovers = graph.nodes.filter((n) => !assigned.has(n.id)).map((n) => n.id);
    if (leftovers.length > 0) {
      const current = graph.passes.find((p) => p.name === 'image')?.graph ?? [];
      setPassNodes(graph, 'image', [...current, ...leftovers]);
    }
  } else {
    setPassNodes(
      graph,
      'image',
      graph.nodes.map((n) => n.id),
    );
  }

  return normalizeGraph(graph);
}

/**
 * 把节点图导出成可读的 shader.frag 文本。
 * @param {object} graph
 * @param {string} passName
 * @returns {object}
 */
function exportShader(graph, passName = 'image') {
  const compiled = compileGraph(graph, passName, {});
  return compiled;
}

/**
 * 节点库的精简描述，给 agent 当参考手册用。
 * @param {object} [opts]
 * @param {boolean} [opts.full] 是否带上完整 GLSL 代码
 * @returns {string}
 */
function describeNodeLibrary({ full = false } = {}) {
  const lines = [];
  lines.push('# Shader Workbench 节点库');
  lines.push('');
  lines.push(`端口类型：${PORT_TYPES.join(' / ')}（float 与 vecN 之间可互连，生成器自动广播或取 .x）`);
  lines.push(`纹理槽位：${CHANNEL_SLOTS.join(' ')}`);
  lines.push(`Buffer Pass：${BUFFER_NAMES.join(' ')}`);
  lines.push('');
  for (const category of NODE_CATEGORIES) {
    const nodes = NODE_LIBRARY.filter((n) => n.category === category);
    lines.push(`## ${category}`);
    for (const node of nodes) {
      const ins = node.inputs.map((p) => `${p.id}:${p.type}`).join(', ') || '-';
      const outs = node.outputs.map((p) => `${p.id}:${p.type}`).join(', ') || '-';
      lines.push(`- \`${node.type}\` ${node.title}  入(${ins}) 出(${outs})`);
      if (node.doc) lines.push(`    说明：${node.doc}`);
      const params = Object.entries(node.params ?? {});
      if (params.length > 0) {
        lines.push(
          `    参数：${params
            .map(([key, meta]) => {
              const options = meta.options ? ` 可选值 ${meta.options.join('|')}` : '';
              const range =
                meta.min !== undefined || meta.max !== undefined ? ` 范围 ${meta.min ?? '-∞'}..${meta.max ?? '+∞'}` : '';
              return `${key}(${meta.type}，默认 ${JSON.stringify(meta.value)}${options}${range})`;
            })
            .join('；')}`,
        );
      }
      if (full) lines.push(`    GLSL：\`${node.code}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 拿到一个工作区之后做的准备工作。
 *
 * 目前只有一件事，但它是"不重启就能加节点"的关键：把 `<工作区>/library/nodes/*.json`
 * 同步进节点注册表。宿主每次用到工作区都会走一遍（签名没变时只花一次 readdir），
 * 所以**丢一个 JSON 进去就多一个节点**，不用重启进程。
 *
 * @param {Workspace} workspace
 * @returns {Workspace}
 */
function prepareWorkspace(workspace) {
  try {
    const sync = syncUserNodes(workspace);
    if (sync.changed && (sync.registered.length > 0 || sync.skipped.length > 0 || sync.errors.length > 0)) {
      bootLog('user-nodes', {
        dir: join(workspace.root, 'library', 'nodes'),
        registered: sync.registered,
        skipped: sync.skipped,
        errors: sync.errors,
      });
    }
  } catch (error) {
    // 用户节点读坏了不能把插件带崩：内置节点照常用
    bootLog('user-nodes-failed', { message: messageOfError(error) });
  }
  return workspace;
}

/**
 * 用 workspace 与工具上下文建一个「当前工作区」解析器。
 * 每个 Session 的工作区根可能不同，所以按 exec 现算并缓存。
 * @param {() => object} getConfig
 * @returns {(exec:object) => Workspace}
 */
function makeWorkspaceResolver(getConfig) {
  const cache = new Map();
  return (exec) => {
    // 记下工具侧解析出的根，面板（没有 Session 上下文）会跟着用它
    const root = rememberWorkspaceRoot(resolveWorkspaceRoot(getConfig(), exec));
    let workspace = cache.get(root);
    if (!workspace) {
      workspace = new Workspace(root, { readOnly: effectiveReadOnly(getConfig()) });
      cache.set(root, workspace);
    }
    return prepareWorkspace(workspace);
  };
}

/**
 * Cordis 插件主体。
 *
 * 内部拆成两层：`apply` 只负责「记诊断 + 兜住异常」，真正的注册在 `applyInner`。
 * 这样无论注册在哪一步炸，都能在 boot log 里留下一行带原因的记录，
 * 而不是只让 DSH 把错误写进没人看得见的 stderr。
 *
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const report = {
    hasTools: typeof ctx?.tools?.register === 'function',
    hasWebServer: typeof ctx?.webServer?.register === 'function',
    hasEffect: typeof ctx?.effect === 'function',
  };
  bootLog('apply-start', report);
  try {
    const result = applyInner(ctx, config);
    bootLog('apply-ok', { ...report, ...result });
    return result;
  } catch (error) {
    bootLog('apply-error', {
      ...report,
      message: messageOfError(error),
      stack: String(error?.stack ?? '').split('\n').slice(0, 12).join('\n'),
    });
    // 重新抛出去：让 DSH 依然把这条 fiber 标成失败，而不是假装成功
    throw error;
  }
}

/**
 * 真正的注册逻辑。
 * @param {object} ctx
 * @param {object} config
 * @returns {{registered: string[], failed: string[], route: string}}
 */
function applyInner(ctx, config = {}) {
  /** 注册成功的工具名。 */
  const registered = [];
  /** 注册失败的工具名（`名字: 原因`）。 */
  const failed = [];

  /**
   * 注册一个工具。
   *
   * **逐个 try/catch**：一个工具的 schema 不合规不该让另外八个也上不去。
   * 失败原因同时记进 boot log 与 ctx.logger，出问题能直接看到是哪个。
   * @param {object} definition
   */
  const registerTool = (definition) => {
    try {
      ctx.tools.register(definition);
      registered.push(definition.name);
    } catch (error) {
      const detail = `${definition.name}: ${messageOfError(error)}`;
      failed.push(detail);
      bootLog('tool-register-failed', { tool: definition.name, message: messageOfError(error) });
      try {
        ctx.logger?.error?.(`[${PLUGIN_ID}] 工具注册失败 → ${detail}`);
      } catch {
        // logger 不可用也不能影响流程
      }
    }
  };

  const getConfig = () => (typeof config === 'object' && config !== null ? config : {});
  const workspaceFor = makeWorkspaceResolver(getConfig);

  // 面板（无 Session 上下文）用的工作区。
  //
  // ⚠️ **不能只建一次就缓存住。** 面板可以在设置里改存储位置，
  // 缓存住的话改完还是老目录，用户会以为"改了没生效"。
  // 这里按 根目录 + 只读 做键缓存：同一个键复用同一个 Workspace 实例，
  // 键变了就换新的。
  const defaultWorkspaces = new Map();
  const rootWorkspace = () => {
    const root = resolveWorkspaceRoot(getConfig(), null);
    const readOnly = effectiveReadOnly(getConfig());
    const key = `${root}\u0000${readOnly ? 'ro' : 'rw'}`;
    let workspace = defaultWorkspaces.get(key);
    if (!workspace) {
      workspace = new Workspace(root, { readOnly });
      defaultWorkspaces.set(key, workspace);
    }
    return prepareWorkspace(workspace);
  };

  // ─────────────────────── 工具 ───────────────────────

  // 配置项 exposeNodeLibraryTool 可以关掉这个工具（它返回整份节点库，输出较长）。
  // 之前这个配置只写在 schema 里、代码里没人读，是个空承诺；顺手补上。
  if (getConfig().exposeNodeLibraryTool !== false) {
    registerTool({
      name: 'shader_node_library',
      description:
        'Return the Shader Workbench node library: every node type with its ports, params, defaults and doc. Call this before hand-writing a node graph or a shader_graph_build payload, or when a graph was rejected and you need the exact node type or param name.',
      parameters: {
        type: 'object',
        properties: {
          full: {
            type: 'boolean',
            description: 'Include each node\'s GLSL expression template. Defaults to false (shorter).',
          },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      async execute(args) {
        return { ok: true, format: 'markdown', content: describeNodeLibrary({ full: args?.full === true }) };
      },
    });
  }

  registerTool({
    name: 'shader_workspace',
    description:
      'Inspect the Shader Workbench local workspace: root path, projects, material count and library counters. Call it first to see what already exists before creating projects or materials.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(_args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        await workspace.init();
        const overview = await workspace.overview();
        return { ...overview, exists: existsSync(overview.root) };
      });
    },
  });

  registerTool({
    name: 'shader_project',
    description:
      'List or create Shader Workbench projects inside the workspace. Projects group materials; each material owns a node graph plus a textures/ folder.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'read'], description: 'list (default) | create | read' },
        name: { type: 'string', description: 'Project name for create/read. Letters, digits, _ and - only.' },
        title: { type: 'string', description: 'Human readable title (create only).' },
        description: { type: 'string', description: 'Free-form description (create only).' },
      },
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      const action = args?.action ?? 'list';
      return guard(async () => {
        await workspace.init();
        if (action === 'create') return { project: await workspace.createProject(args) };
        if (action === 'read') return { project: await workspace.readProject(args.name) };
        return { projects: await workspace.listProjects() };
      });
    },
  });

  registerTool({
    name: 'shader_material',
    description:
      'Create, read, list, save or archive a Shader Workbench material. A material is a node graph (graph.json) plus a manifest (material.json) and a textures/ folder. Archiving moves the folder to .trash instead of deleting it, so nothing is ever lost.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'read', 'save', 'archive'],
          description: 'Defaults to list.',
        },
        project: { type: 'string', description: 'Project name.' },
        material: { type: 'string', description: 'Material name (folder name).' },
        name: {
          type: 'string',
          description: 'Material name for action=create. Accepted as an alias of `material` so both spellings work.',
        },
        title: { type: 'string', description: 'Human readable name (create only).' },
        graph: {
          type: 'object',
          description:
            'Full ShaderGraph to save (action=save). Prefer shader_graph_build to construct one from a friendlier spec.',
          additionalProperties: true,
        },
        manifest: {
          type: 'object',
          description: 'Partial MaterialManifest patch to merge (action=save): tags, uniforms, passes...',
          additionalProperties: true,
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Shortcut for manifest.tags (action=save).' },
      },
      required: ['action', 'project'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      // `material` 与 `name` 互为别名：create 用 name 更自然，read/save 用 material 更自然
      const materialName = args.material ?? args.name;
      const withName = { ...args, material: materialName };
      return guard(async () => {
        await workspace.init();
        const action = args.action;
        if (action === 'create') {
          if (!materialName) throw new Error('create 需要 material（或 name）');
          return workspace.createMaterial(withName);
        }
        if (!materialName) throw new Error(`${action} 需要 material`);
        if (action === 'read') return workspace.readMaterial(args.project, materialName);
        if (action === 'archive') return workspace.archiveMaterial(withName);
        if (action === 'save') {
          const manifest = { ...(args.manifest ?? {}) };
          if (Array.isArray(args.tags)) manifest.tags = args.tags;
          return workspace.saveMaterial({
            project: args.project,
            material: materialName,
            graph: args.graph,
            manifest,
          });
        }
        return { materials: await workspace.listMaterials(args.project) };
      });
    },
  });

  registerTool({
    name: 'shader_graph_build',
    description:
      'Build a ShaderGraph from a compact spec and write it into a material. The spec uses node aliases and "alias.port" edge references, which is far less error-prone than hand-writing ids. Call shader_node_library first for valid node types and port names.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name.' },
        material: { type: 'string', description: 'Material name. Created if missing.' },
        name: { type: 'string', description: 'Graph display name.' },
        nodes: {
          type: 'array',
          description: 'Node list: [{ id: "uv0", type: "uv", x, y, params: {} }]. id is a local alias.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              params: { type: 'object', additionalProperties: true },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
        edges: {
          type: 'array',
          description: 'Edge list: [{ from: "uv0.out", to: "out0.color" }].',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
            additionalProperties: false,
          },
        },
        uniforms: {
          type: 'array',
          description: 'Custom uniforms: [{ name, type, value, min, max }].',
          items: { type: 'object', additionalProperties: true },
        },
        passes: {
          type: 'object',
          description:
            'Optional pass assignment: { image: ["out0"], BufferA: ["outA"] }. Unlisted nodes fall into image.',
          additionalProperties: true,
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, build and compile but do not write to disk.',
        },
      },
      required: ['project', 'material', 'nodes'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        const graph = buildGraphFromSpec(args);
        const compiled = {};
        for (const pass of graph.passes) {
          const result = compileGraph(graph, pass.name, { uniforms: Object.fromEntries((graph.uniforms ?? []).map((u) => [u.name, u.value])) });
          compiled[pass.name] = {
            ok: result.ok,
            channels: result.channels,
            buffers: result.buffers,
            helpers: result.helpers,
            errors: result.errors,
            warnings: result.warnings,
            code: result.code,
          };
        }
        const allOk = Object.values(compiled).every((c) => c.ok);
        if (args.dryRun === true) {
          return { ok: allOk, dryRun: true, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, compiled };
        }
        await workspace.init();
        // 材质不存在就建一个
        try {
          await workspace.readMaterial(args.project, args.material);
        } catch {
          await workspace.createMaterial({ project: args.project, name: args.material, title: args.name });
        }
        await workspace.saveMaterial({ project: args.project, material: args.material, graph });
        await workspace.snapshot({ project: args.project, material: args.material, label: 'graph-build' });
        return {
          ok: allOk,
          project: args.project,
          material: args.material,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          compiled,
        };
      });
    },
  });

  registerTool({
    name: 'shader_compile',
    description:
      'Compile one pass of a Shader Workbench node graph to GLSL ES 3.00 without touching the GPU, and optionally write the result to the workspace cache. Use it to verify a graph compiles before opening the workbench panel, or to read the generated shader.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (when reading from disk).' },
        material: { type: 'string', description: 'Material name (when reading from disk).' },
        graph: { type: 'object', description: 'Inline ShaderGraph; when given, project/material are ignored.', additionalProperties: true },
        pass: { type: 'string', enum: PASS_NAMES, description: 'Which pass to compile. Defaults to image.' },
        writeCache: { type: 'boolean', description: 'Write the generated GLSL into cache/compiled. Defaults to false.' },
      },
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        let graph = args.graph;
        if (!graph) {
          if (!args.project || !args.material) throw new Error('要么给 graph，要么给 project + material');
          const material = await workspace.readMaterial(args.project, args.material);
          graph = material.graph;
        }
        const passName = args.pass ?? 'image';
        const result = compileGraph(graph, passName, {
          uniforms: Object.fromEntries((graph.uniforms ?? []).map((u) => [u.name, u.value])),
        });
        let cachePath;
        if (args.writeCache === true && args.project && args.material) {
          cachePath = await workspace.writeCompiled(`${args.project}.${args.material}.${passName}`, result.code);
        }
        return {
          ok: result.ok,
          pass: passName,
          channels: result.channels,
          buffers: result.buffers,
          helpers: result.helpers,
          errors: result.errors,
          warnings: result.warnings,
          cachePath,
          code: result.code,
        };
      });
    },
  });

  registerTool({
    name: 'shader_export',
    description:
      'Export a material for use outside the workbench: compiles a pass and writes the result into the material folder. '
      + 'Targets: glsl (shader.frag, the generated GLSL), hlsl (Shader Model 5.0), msl (Metal), spirv (.spv binary), '
      + 'spvasm (readable SPIR-V assembly), json (a self-contained bundle of manifest + graph). '
      + 'The HLSL / MSL / SPIR-V output is produced by this plugin\'s own source-level translator and binary encoder — '
      + 'no external shader toolchain is required or used. '
      + 'IMPORTANT: the .spv binary has only been checked for structural self-consistency (id bounds, block termination, '
      + 'branch targets, encoder/decoder round-trip). No spirv-val was available, so it is NOT guaranteed to be accepted '
      + 'by a real driver — validate it with `spirv-val` on a machine that has the Vulkan SDK before shipping it.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name.' },
        material: { type: 'string', description: 'Material name.' },
        pass: { type: 'string', enum: PASS_NAMES, description: 'Pass to export. Defaults to image.' },
        target: {
          type: 'string',
          enum: [...listExportTargets().map((t) => t.id), 'json'],
          description:
            'Export format. Defaults to glsl. Use shader_export_targets to list the currently registered targets '
            + '(the registry is extensible, so this enum may grow).',
        },
      },
      required: ['project', 'material'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        const material = await workspace.readMaterial(args.project, args.material);
        const passName = args.pass ?? 'image';
        const targetId = args.target ?? 'glsl';
        const generatedAt = new Date().toISOString();

        // json 不转译：它就是「图 + 清单」的自包含快照
        if (targetId === 'json') {
          const bundle = {
            material: material.manifest,
            graph: material.graph,
            pass: passName,
            generatedAt,
            generator: `${PLUGIN_ID}@${version}`,
          };
          const bundleName = `${args.material}.${passName}.bundle.json`;
          const bundlePath = await workspace.write(
            workspace.materialFile(args.project, args.material, bundleName),
            `${JSON.stringify(bundle, null, 2)}\n`,
          );
          return { ok: true, target: 'json', path: bundlePath, fileName: bundleName };
        }

        const compiled = exportShader(material.graph, passName);
        if (!compiled.ok) {
          return { ok: false, errors: compiled.errors, note: '图还没编译通过，没有写出文件' };
        }

        const target = listExportTargets().find((t) => t.id === targetId);
        if (!target) {
          return {
            ok: false,
            errors: [{ message: `不认识的导出目标：${targetId}` }],
            available: listExportTargets().map((t) => t.id),
          };
        }

        const converted = crossCompile(compiled.code, targetId, {
          source: `${args.project}/${args.material}::${passName}`,
          generatedAt,
        });
        if (!converted.ok) {
          return {
            ok: false,
            errors: converted.errors,
            note: `导出 ${targetId} 失败：${converted.errors.map((e) => e.message).join('；')}`,
          };
        }

        // glsl 沿用材质清单里声明的文件名，其余按目标扩展名命名
        const fileName = targetId === 'glsl'
          ? (material.manifest.shaderFiles?.frag || 'shader.frag')
          : `${args.material}.${passName}.${target.extension}`;
        const full = await workspace.write(
          workspace.materialFile(args.project, args.material, fileName),
          converted.code,
        );

        const result = {
          ok: true,
          target: targetId,
          path: full,
          fileName,
          binary: target.binary,
          warnings: converted.warnings,
        };
        if (target.binary) {
          result.bytes = converted.code.byteLength;
          result.note = 'SPIR-V 只做过结构自洽校验，没有经过 spirv-val。上真机前请自己验一遍。';
        } else {
          result.code = converted.code;
        }
        return result;
      });
    },
  });

  registerTool({
    name: 'shader_export_targets',
    description:
      'List the export targets currently registered by the Shader Workbench (id, label, file extension, whether the '
      + 'output is binary). Targets are pluggable, so this is the authoritative list — use it instead of assuming.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: toolOutput(),
    async execute() {
      return {
        targets: listExportTargets().map((t) => ({
          id: t.id,
          label: t.label,
          extension: t.extension,
          binary: t.binary,
        })),
      };
    },
  });

  registerTool({
    name: 'shader_shadertoy_import',
    description:
      'Import a Shadertoy shader into a Shader Workbench material. Paste the full Shadertoy source (the one that '
      + 'contains `void mainImage(out vec4 fragColor, in vec2 fragCoord)`); the import finds mainImage, wraps it into a '
      + 'value-returning function, registers the wrapped GLSL as a reusable **user node** in the workspace library, and '
      + 'replaces the target material\'s graph with a two-node graph (the imported node wired to the output terminal). '
      + 'Shadertoy builtins iTime / iResolution / iMouse / iDate / iChannel0-3 / iFrame are already provided by the '
      + 'generated header, so most shaders work unchanged. '
      + 'Notes: a source-supplied `void main()` is stripped (it would clash with the generated entry point); naked '
      + '`return;` statements are rewritten to `return fragColor;`; iChannel usage is reported so you know which texture '
      + 'slots to bind. The graph is REPLACED, not merged — snapshot the material first if you want to keep the old one.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name.' },
        material: { type: 'string', description: 'Material to overwrite with the imported graph.' },
        source: { type: 'string', description: 'The full Shadertoy GLSL source text.' },
        nodeType: {
          type: 'string',
          description: 'Override the generated user-node type name. Defaults to `shadertoyMain`.',
        },
        sourceUrl: { type: 'string', description: 'Optional origin URL, recorded in the graph metadata.' },
      },
      required: ['project', 'material', 'source'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        const imported = importShadertoy(args.source, {
          name: args.material,
          ...(args.nodeType ? { nodeType: args.nodeType } : {}),
          ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
        });

        const nodePath = await workspace.writeUserNode(imported.node.type, imported.node);
        await workspace.saveMaterial({
          project: args.project,
          material: args.material,
          graph: imported.graph,
        });
        syncUserNodes(workspace, { force: true });

        return {
          ok: true,
          nodeType: imported.node.type,
          nodePath: workspace.rel(nodePath),
          features: imported.features,
          warnings: imported.warnings,
          nodeCount: imported.graph.nodes.length,
          edgeCount: imported.graph.edges.length,
          userNodeTypes: nodeLibraryStatus(workspace).user,
          note: '材质图已被替换；原来的图如果还要，请从 .snapshots 里恢复。',
        };
      });
    },
  });

  registerTool({
    name: 'shader_snapshot',
    description:
      'Version control for a Shader Workbench material: snapshot (copy graph.json + material.json into .snapshots/<timestamp>), list snapshots, or restore one. Restoring takes a "before-rollback" snapshot first, so a restore is itself reversible.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'restore'], description: 'Defaults to create.' },
        project: { type: 'string' },
        material: { type: 'string' },
        label: { type: 'string', description: 'Optional tag appended to the snapshot folder name (create only).' },
        snapshotId: { type: 'string', description: 'Snapshot folder name (restore only).' },
      },
      required: ['project', 'material'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(async () => {
        const action = args.action ?? 'create';
        if (action === 'list') return { snapshots: await workspace.listSnapshots(args) };
        if (action === 'restore') {
          if (!args.snapshotId) throw new Error('restore 需要 snapshotId');
          return workspace.restoreSnapshot(args);
        }
        return workspace.snapshot(args);
      });
    },
  });

  registerTool({
    name: 'shader_texture_import',
    description:
      'Copy an existing image file from disk into a material\'s textures/ folder and bind it to an iChannel slot (iChannel0..3). Only the copy inside the workspace is written; the source file is never modified. Use this to feed local PBR maps into the preview.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        material: { type: 'string' },
        sourcePath: { type: 'string', description: 'Absolute path of the image on disk.' },
        slot: { type: 'string', enum: CHANNEL_SLOTS, description: 'Target channel. Defaults to iChannel0.' },
        label: { type: 'string', description: 'Optional human readable label stored in the manifest.' },
        source: { type: 'string', enum: ['local', 'comfyui'], description: 'Provenance recorded in the manifest.' },
      },
      required: ['project', 'material', 'sourcePath'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      const workspace = workspaceFor(exec);
      return guard(() => workspace.importTexture({ ...args, slot: args.slot ?? 'iChannel0' }));
    },
  });

  // ─────────────────────── webServer 路由 ───────────────────────

  /** 路由注册结果，回给 apply 记进 boot log。 */
  let route = 'none';
  try {
    ctx.effect(
      () =>
        ctx.webServer.register(
          createRoute({
            // 每个请求进来时才决定用哪个工作区：根目录可能刚被用户在面板里改过
            getWorkspace: () => rootWorkspace(),
            version,
            // 面板的「存储位置」改了要落盘，并让下一次解析立刻用上新值
            settings: {
              read: () => ({
                settings: readSettings(),
                path: settingsPath(),
                root: rootWorkspace().root,
                readOnly: effectiveReadOnly(getConfig()),
                // 命令行/配置层压过设置文件时，UI 要告诉用户"改了也不生效"
                overriddenBy: (() => {
                  if (typeof getConfig()?.workspaceRoot === 'string' && getConfig().workspaceRoot.trim() !== '') return 'config';
                  if (typeof process.env.DSH_SHADER_WORKBENCH_ROOT === 'string' && process.env.DSH_SHADER_WORKBENCH_ROOT.trim() !== '') return 'env';
                  return null;
                })(),
              }),
              write: (patch) => {
                const next = writeSettings(patch);
                defaultWorkspaces.clear();
                return { settings: next, root: rootWorkspace().root };
              },
            },
          }),
        ),
      'shader-workbench: http api',
    );
    route = 'ok';
  } catch (error) {
    // 路由失败不该连带把已经注册好的工具废掉
    route = `failed: ${messageOfError(error)}`;
    bootLog('route-register-failed', { message: messageOfError(error) });
    try {
      ctx.logger?.error?.(`[${PLUGIN_ID}] 路由注册失败 → ${route}`);
    } catch {
      // ignore
    }
  }

  try {
    ctx.logger?.info?.(
      `[${PLUGIN_ID}] 工作区根目录：${resolveWorkspaceRoot(getConfig(), null)}；工具 ${registered.length}/${registered.length + failed.length} 注册成功`,
    );
  } catch {
    // logger 不可用不影响
  }

  return { registered, failed, route, workspaceRoot: resolveWorkspaceRoot(getConfig(), null) };
}

// ⚠️ 这里**故意没有** `export default apply`。
//
// `@deepseek-ai/cordis-plugin-include` 装载一个包时是这么取插件的
// （lib/index.js:157）：
//
//     const module = await import(specifier);
//     data = module.default || module;
//
// 也就是说：**只要模块有 default 导出，宿主就只拿 default，`inject` / `Config` /
// `name` 全部丢掉。** 于是 fiber 的 inject 是空的（不等服务就激活），
// `apply()` 里第一句 `ctx.tools` 直接抛
// `Error: cannot get property "tools" without inject`，
// 而这个错只写进 DSH 自己的 stderr —— 现场又是「模块进了、什么都不工作、不报错」。
//
// 2026-10-10 排查实录：这个错和上面 `Config` 那个是**两个独立的 bug，两个都得修**。
// 去掉 default 之后宿主才会读到 `inject`，也才会去读 `Config` —— 所以 Config
// 必须是 Standard Schema（见上文），否则换上它立刻抛 `TypeError`。
//
// 判断依据：同 profile 里能正常工作的 `dsh-image-gen` 就没有 default 导出。
