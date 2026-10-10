/**
 * 工作台 HTTP API。
 *
 * 为什么走 HTTP 而不是 DSH RPC：
 *   面板要能直接 `import` runtime 的 ESM 模块、要能拿纹理图片的原始字节，
 *   这两件事用同一个 webServer 前缀路由最省事，也不需要引入任何依赖。
 *
 * 路由（全部挂在前缀 `/plugins/dsh-shader-workbench/` 下）：
 *   POST /api        { action, ...args }   →  { ok, ...payload } 或 { ok:false, error }
 *   GET  /ping                             →  { ok, name, version }
 *   GET  /texture?project=&material=&path= →  纹理原始字节
 *   GET  /module/<相对路径>.js             →  client/ 下的 ESM 源码（面板 import 用）
 *
 * 安全检查：同源校验 + 请求体上限 + 模块路径前缀校验。
 *
 * @module dsh-shader-workbench/host/routes
 */

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileGraph } from '../client/runtime/codegen.js';
import { listExamples, loadExample } from './examples.js';
import { nodeLibraryStatus, reloadBuiltinNodes, syncUserNodes } from './node-library.js';

/** 插件 id，也是路由前缀。 */
export const PLUGIN_ID = 'dsh-shader-workbench';
/** API 前缀（**带**尾随斜杠），处理器内部按它切路径。 */
export const API_PREFIX = `/plugins/${PLUGIN_ID}/`;
/**
 * 注册给 webServer 的前缀（**不带**尾随斜杠）。
 *
 * ⚠️ 这两个必须分开：宿主 `@deepseek-ai/dsh-host-webserver` 的前缀匹配是
 *
 *     if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
 *
 * 也就是它会自己去补一个 `/`。注册成带尾斜杠的 `/plugins/x/`，它就去比
 * `'/plugins/x/module/panel/index.js'.startsWith('/plugins/x//')` —— **永远为假**，
 * 路由静默失效，浏览器那侧只看到 `Failed to fetch dynamically imported module`。
 * 2026-10-10 踩过：`route:"ok"`（register 没抛错）但整条前缀一个请求都进不来。
 */
export const ROUTE_PREFIX = API_PREFIX.replace(/\/$/, '');

/** 请求体上限：256 KiB，够传一张大节点图。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 插件根目录。 */
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** client/ 目录的绝对路径。 */
const CLIENT_DIR = resolve(fileURLToPath(new URL('../client/', import.meta.url)));

/** shared/ 目录的绝对路径。 */
const SHARED_DIR = resolve(fileURLToPath(new URL('../shared/', import.meta.url)));

/**
 * `/module/` 允许暴露的根目录白名单。
 *
 * 为什么要三个根：
 *   - `client/`：面板主体，URL 形如 `/module/panel/index.js`
 *   - `shared/`：面板用相对路径 import 的数据模型（`../../shared/x.js`），
 *     浏览器解析出来的 URL 会丢掉 `module/` 那一层，变成 `/shared/x.js`
 *   - 插件根：让 `/shared/x.js` 这类**相对插件根**的路径也能解析到
 *
 * 三个根都做前缀校验，越界一律 404。
 */
const MODULE_ROOTS = Object.freeze([CLIENT_DIR, SHARED_DIR, PLUGIN_ROOT]);

/** 解析失败时用来提示的根目录名。 */
const ROOT_LABELS = new Map([
  [CLIENT_DIR, 'client'],
  [SHARED_DIR, 'shared'],
  [PLUGIN_ROOT, 'plugin root'],
]);

/** 允许通过 /module/ 暴露的扩展名。 */
const MODULE_EXTENSIONS = new Set(['.js', '.mjs']);

/** 扩展名 → MIME。 */
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.dds': 'application/octet-stream',
  '.ktx': 'application/octet-stream',
  '.ktx2': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.frag': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * 给响应加通用头（禁止缓存 API，允许同源读取纹理）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string,string>} [headers]
 */
function head(res, status, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
}

/**
 * 回一个 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
export function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  head(res, status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}

/**
 * 回一个错误 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {string} [code]
 */
export function fail(res, status, message, code = 'error') {
  json(res, status, { ok: false, error: { code, message } });
}

/**
 * 同源校验：带 Origin 且不等于 Host 的请求一律拒。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * 读请求体，超限就抛。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 把查询串解析成对象。
 * @param {string} url
 * @returns {Record<string,string>}
 */
function parseQuery(url) {
  const idx = url.indexOf('?');
  const out = {};
  if (idx < 0) return out;
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1))) out[k] = v;
  return out;
}

/**
 * API action 表。每个 action 是 `(args, ctx) => Promise<any>`。
 *
 * 约定：返回值会被塞进 `{ ok: true, ...返回值 }`；抛错会被转成
 * `{ ok: false, error: { code, message } }` 并给 400（除非错误带 status）。
 * @type {Record<string, (args:object, ctx:object) => Promise<any>>}
 */
export const ACTIONS = {
  /** 工作区概览：项目列表、材质数、库计数。 */
  'workspace.overview': async (_args, { workspace }) => workspace.overview(),

  /** 初始化目录结构。 */
  'workspace.init': async (_args, { workspace }) => ({ root: await workspace.init() }),

  /** 建项目。 */
  'project.create': async (args, { workspace }) => workspace.createProject(args),

  /** 读项目。 */
  'project.read': async (args, { workspace }) => workspace.readProject(args.project),

  /** 列材质。 */
  'material.list': async (args, { workspace }) => ({
    materials: await workspace.listMaterials(args.project),
  }),

  /** 建材质。 */
  'material.create': async (args, { workspace }) => workspace.createMaterial(args),

  /** 读材质（清单 + 图 + 纹理）。 */
  'material.read': async (args, { workspace }) => workspace.readMaterial(args.project, args.material),

  /** 存材质（图 / 清单）。 */
  'material.save': async (args, { workspace }) => {
    const result = await workspace.saveMaterial(args);
    // 顺手把生成的 GLSL 落一份到 cache/compiled，方便对照与排查
    if (args.graph) {
      try {
        const compiled = compileGraph(args.graph, 'image', { uniforms: args.uniforms ?? {} });
        if (compiled.ok) await workspace.writeCompiled(`${args.project}.${args.material}`, compiled.code);
      } catch {
        // 落缓存失败不影响保存本身
      }
    }
    return result;
  },

  /** 打快照。 */
  'material.snapshot': async (args, { workspace }) => workspace.snapshot(args),

  /** 列快照。 */
  'material.snapshots': async (args, { workspace }) => ({
    snapshots: await workspace.listSnapshots(args),
  }),

  /** 回滚快照（回滚前自动再打一份）。 */
  'material.restore': async (args, { workspace }) => workspace.restoreSnapshot(args),

  /** 归档材质：移到 .trash，不真删。 */
  'material.archive': async (args, { workspace }) => workspace.archiveMaterial(args),

  /** 导入纹理到某个 iChannel 槽位。 */
  'texture.import': async (args, { workspace }) => workspace.importTexture(args),

  /** 解绑槽位（不删文件）。 */
  'texture.unbind': async (args, { workspace }) => workspace.unbindTexture(args),

  /** 只做代码生成，不落盘。给「查看生成代码」用。 */
  'shader.compile': async (args) => {
    const passName = typeof args.pass === 'string' ? args.pass : 'image';
    const graph = args.graph;
    if (!graph) throw new Error('缺少 graph');
    return compileGraph(graph, passName, { uniforms: args.uniforms ?? {} });
  },

  /** 列预设。 */
  'preset.list': async (_args, { workspace }) => ({ presets: await workspace.listPresets() }),

  /** 存预设。 */
  'preset.save': async (args, { workspace }) => workspace.savePreset(args),

  /** 读预设。 */
  'preset.read': async (args, { workspace }) => ({ preset: await workspace.readPreset(args.id) }),

  /**
   * 读插件设置（存储位置那一层）。
   *
   * 面板要在资源树顶上显示「现在存哪」，还要能告诉用户"你配了环境变量/配置，
   * 在这儿改没用" —— 所以顺带回一个 `overriddenBy`。
   */
  'settings.read': async (_args, { settings }) => {
    if (!settings) throw new Error('这个宿主没有提供 settings 依赖');
    return settings.read();
  },

  /**
   * 改插件设置（目前是存储位置）。
   *
   * 传 `{ workspaceRoot: '' }` = 清掉，回到自动推断。
   */
  'settings.write': async (args, { settings }) => {
    if (!settings) throw new Error('这个宿主没有提供 settings 依赖');
    return settings.write({
      ...(args.workspaceRoot !== undefined ? { workspaceRoot: args.workspaceRoot } : {}),
      ...(args.readOnly !== undefined ? { readOnly: args.readOnly } : {}),
    });
  },

  /**
   * 把一段 GLSL 正文写进材质目录。
   *
   * 用途：面板「导入材质文件」选了 `.frag` 之后，正文得真存下去，
   * 而不是像以前那样只往诊断里写一句「尚未接入预览」就丢掉。
   */
  'shader.write': async (args, { workspace }) => {
    const name = String(args.name ?? '').replace(/[^A-Za-z0-9_.-]/g, '') || 'imported.frag';
    if (!/\.(frag|glsl)$/i.test(name)) throw new Error(`只接受 .frag / .glsl，收到：${name}`);
    const text = typeof args.text === 'string' ? args.text : '';
    if (text.trim() === '') throw new Error('GLSL 内容是空的');
    const full = workspace.materialFile(args.project, args.material, name);
    await workspace.write(full, text);
    return { name, bytes: text.length, path: full };
  },

  /** 插件自带的示例有哪些。 */
  'example.list': async () => ({ examples: await listExamples() }),

  /**
   * 把某个自带示例（`examples/<名字>/`）拷进当前工作区。
   *
   * 示例随插件走，不依赖运行期目录 —— 换机器、重装 profile、
   * 把存储位置改到别处，示例都还在。
   */
  'example.load': async (args, { workspace }) =>
    loadExample(workspace, args.name ?? 'demo', { overwrite: args.overwrite === true }),

  /**
   * 节点库现状。
   *
   * 回给面板的不只是计数，还有**用户节点的完整定义** —— 面板在浏览器侧调
   * `setUserNodes(defs)`，自己的节点库就和宿主一致了。
   */
  'nodelib.status': async (_args, { workspace }) => nodeLibraryStatus(workspace),

  /**
   * 重扫节点库。
   *
   * `builtin: true` 时带查询串重新 import 插件的 `shared/nodelib.js`，
   * 于是**改了内置节点源码也不用重启进程**；不带就只重扫用户节点目录。
   */
  'nodelib.reload': async (args, { workspace }) => {
    let builtin = null;
    if (args.builtin === true) builtin = await reloadBuiltinNodes();
    const user = syncUserNodes(workspace, { force: true });
    return { ...nodeLibraryStatus(workspace), reloaded: { builtin, user } };
  },

  /** 工作区里存了哪些组（Group）模板。 */
  'group.list': async (_args, { workspace }) => ({ groups: await workspace.listGroups() }),

  /**
   * 存一个组模板。
   *
   * 组本身内联在节点里，这里存的是模板 —— 换个材质也能从库里拖出来用。
   * 改模板不影响已有实例（实例持有的是拷贝）。
   */
  'group.save': async (args, { workspace }) => workspace.saveGroup(args),
};

/**
 * 安全地取工作区根目录：取不到就回一个说明字符串，不让 /ping 抛错。
 * @param {() => {root:string}} getWorkspace
 * @returns {string}
 */
function safeRoot(getWorkspace) {
  try {
    return getWorkspace().root;
  } catch (error) {
    return `<不可用：${error instanceof Error ? error.message : String(error)}>`;
  }
}

/**
 * 分发一个 API 请求。
 * @param {object} args
 * @param {import('node:http').IncomingMessage} args.req
 * @param {import('node:http').ServerResponse} args.res
 * @param {object} args.ctx { workspace }
 */
async function handleApi({ req, res, ctx }) {
  const raw = await readBody(req);
  let body;
  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch (error) {
    return fail(res, 400, `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, 'bad-json');
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const handler = ACTIONS[action];
  if (!handler) {
    return fail(res, 404, `未知 action：${action || '(空)'}`, 'unknown-action');
  }
  try {
    const payload = await handler(body, ctx);
    return json(res, 200, { ok: true, action, ...(payload ?? {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number.isInteger(error?.status) ? error.status : 400;
    return fail(res, status, message, error?.code ?? 'action-failed');
  }
}

/**
 * 送一个纹理文件。
 * @param {object} args
 */
async function handleTexture({ req, res, ctx, query }) {
  const { project, material, path } = query;
  if (!project || !material || !path) return fail(res, 400, '缺 project / material / path 参数');
  let full;
  try {
    full = ctx.workspace.textureAbsolutePath(project, material, path);
  } catch (error) {
    return fail(res, 400, error instanceof Error ? error.message : String(error), 'bad-path');
  }
  if (!existsSync(full) || !statSync(full).isFile()) return fail(res, 404, `纹理不存在：${path}`, 'not-found');
  const data = await readFile(full);
  head(res, 200, {
    'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(data.length),
    'cache-control': 'private, max-age=60',
  });
  return res.end(data);
}

/**
 * 送一个 ESM 模块源码，让面板可以直接 `import()`。
 *
 * 路径解析为什么要「先拼成物理路径再穿越」：
 *   磁盘布局是  client/panel/foo.js  →  ../../shared/graph.js
 *   而 HTTP 前缀是 /module/panel/foo.js ，浏览器把 `../../` 解析掉之后
 *   会去请求 /shared/graph.js —— 中间的 `module/` 层级把深度对不上了。
 *   所以这里不按 URL 层级切目录，而是把 `module/` 后面的**整条路径**
 *   拼成物理路径再规范化：`module/panel/../../shared/graph.js` → `shared/graph.js`。
 *
 * 安全：规范化之后仍要落在白名单根目录内，且扩展名只允许 .js / .mjs。
 *
 * @param {object} args
 * @param {string} args.rel URL 里的相对路径（已去掉前缀）
 */
async function handleModule({ res, rel }) {
  const ext = extname(rel).toLowerCase();
  if (!MODULE_EXTENSIONS.has(ext)) return fail(res, 403, `只允许 .js / .mjs：${rel}`, 'bad-extension');

  const normalized = normalize(rel);
  const resolved = resolveUnderRoots(normalized);
  if (!resolved) {
    const roots = [...ROOT_LABELS.values()].join(' / ');
    return fail(res, 404, `模块不存在或越界：${rel}（只在 ${roots} 下查找）`, 'not-found');
  }
  return sendModule(res, resolved);
}

/**
 * 在 MODULE_ROOTS 白名单里解析一个相对路径，命中真实文件才返回。
 * @param {string} normalized 已经 normalize 过的相对路径
 * @returns {string|null}
 */
function resolveUnderRoots(normalized) {
  for (const root of MODULE_ROOTS) {
    const candidate = resolve(root, normalized);
    if (candidate !== root && !candidate.startsWith(root + sep)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * 把文件送出去。
 * @param {import('node:http').ServerResponse} res
 * @param {string} fullPath
 */
async function sendModule(res, fullPath) {
  const source = await readFile(fullPath, 'utf8');
  head(res, 200, { 'content-type': MIME['.js'], 'content-length': String(Buffer.byteLength(source)) });
  return res.end(source);
}

/**
 * 建一个 webServer 路由对象。
 *
 * `getWorkspace` 是个取值函数而不是实例：不同 Session 的工作区根目录可能不同，
 * 所以要在**每个请求进来时**才决定用哪个工作区。
 *
 * @param {object} deps
 * @param {() => import('./workspace.js').Workspace} deps.getWorkspace
 * @param {string} [deps.version] 插件版本，/ping 用
 * @param {{read: Function, write: Function}} [deps.settings] 设置读写（面板的「存储位置」用）
 * @returns {{kind:'prefix', path:string, handler:(req:any,res:any)=>void|Promise<void>}}
 */
export function createRoute({ getWorkspace, version = '0.1.0', settings = undefined }) {
  if (typeof getWorkspace !== 'function') throw new Error('createRoute 需要 getWorkspace 函数');
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const url = req.url ?? '/';
        const pathname = url.split('?')[0];

        if (pathname === `${API_PREFIX}ping`) {
          // ping 不碰工作区，避免为了一个存活探针去建目录
          return json(res, 200, {
            ok: true,
            name: PLUGIN_ID,
            version,
            root: safeRoot(getWorkspace),
          });
        }

        // 不带尾斜杠的裸前缀也匹配（webserver 会放它进来），给它一个索引而不是 404
        if (pathname === ROUTE_PREFIX || pathname === API_PREFIX) {
          return json(res, 200, { ok: true, name: PLUGIN_ID, version, hint: `${API_PREFIX}ping` });
        }

        if (!isSameOrigin(req)) return fail(res, 403, '拒绝跨源请求', 'origin-rejected');

        if (pathname.startsWith(`${API_PREFIX}module/`)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '只允许 GET');
          return handleModule({ res, rel: decodeURIComponent(pathname.slice(`${API_PREFIX}module/`.length)) });
        }

        // 别名：相对 import 跨越 client/ → shared/ 时，浏览器解析出来的
        // URL 会丢掉 `module/` 这一层（深度对不上），所以这里再开一条直路。
        // 支持带 ../ 的写法，因为 `runtime/../../shared/x.js` 会落到这个前缀下。
        if (pathname.startsWith(`${API_PREFIX}shared/`)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '只允许 GET');
          const rel = decodeURIComponent(pathname.slice(API_PREFIX.length));
          const resolved = resolveUnderRoots(normalize(rel));
          if (!resolved) return fail(res, 404, `模块不存在：${rel}`, 'not-found');
          return sendModule(res, resolved);
        }

        if (pathname === `${API_PREFIX}texture`) {
          if (req.method !== 'GET') return fail(res, 405, '只允许 GET');
          return handleTexture({ req, res, ctx: { workspace: getWorkspace() }, query: parseQuery(url) });
        }

        if (pathname === `${API_PREFIX}api`) {
          if (req.method !== 'POST') return fail(res, 405, '只允许 POST');
          // workspace 走 getter：`settings.write` 改完存储位置之后，
          // 同一次请求里后续（以及下一次请求）读到的必须是**新**目录。
          // 早早算一份缓存住的话，用户会看到"改了没生效"。
          return handleApi({
            req,
            res,
            ctx: {
              get workspace() {
                return getWorkspace();
              },
              settings,
            },
          });
        }

        return fail(res, 404, `未知路径：${pathname}`, 'not-found');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(res, 500, message, 'internal');
      }
    },
  };
}

/**
 * 给工具用的薄封装：把 workspace 的方法包成「永不抛错、返回结构化结果」的形式。
 * @param {() => Promise<any>} fn
 * @returns {Promise<object>}
 */
export async function guard(fn) {
  try {
    const value = await fn();
    return { ok: true, ...(value && typeof value === 'object' ? value : { value }) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code ?? 'error',
    };
  }
}

export { assertSafeName, Workspace } from './workspace.js';
