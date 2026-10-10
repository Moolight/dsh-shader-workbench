/**
 * 宿主侧的节点库管理：把「用户节点」从磁盘读进注册表，以及热重载内置库。
 *
 * 这一层存在的唯一理由：**别让"加一个节点"等于"重启 DSH"**。
 *
 *   - 用户节点：`<工作区>/library/nodes/*.json`。宿主每次用到工作区时按
 *     文件名+mtime+size 的签名比对，变了就重读 —— 加节点就是丢一个 JSON 文件，
 *     宿主和面板同时生效，**零重启**。
 *   - 内置节点：改 `shared/nodelib.js` 之后用带查询串的动态 import 拿一份新副本，
 *     再原地重建注册表（见 shared/nodes.js 的注释）。这条是开发期便利，
 *     走 `nodelib.reload` 触发。
 *
 * 用的是同步 fs：目录很小，而调用点是"每次工具调用/每个请求"，异步会把
 * 调用链染成 async，得不偿失。签名没变时只花一次 readdir + 几个 stat。
 *
 * @module dsh-shader-workbench/host/node-library
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { NODE_LIBRARY, nodeLibraryInfo, setBuiltinNodes, setUserNodes } from '../shared/nodes.js';
import { parseUserNodeFiles } from '../shared/user-nodes.js';

/** 上次扫描的签名，用来判断目录有没有变。 */
let lastSignature = null;
/** 上次扫描收集到的错误，会在 nodelib.status 里回给面板。 */
let lastErrors = [];

/**
 * 用户节点目录。
 * @param {{root:string}} workspace
 * @returns {string}
 */
export function userNodesDir(workspace) {
  return join(workspace.root, 'library', 'nodes');
}

/**
 * 扫一遍目录，算一个"变了没有"的签名。
 * @param {string} dir
 * @returns {{signature:string, files:string[]}}
 */
function scan(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort();
  } catch {
    return { signature: '', files: [] };
  }
  const parts = [];
  for (const name of names) {
    try {
      const info = statSync(join(dir, name));
      parts.push(`${name}:${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  return { signature: parts.join('|'), files: names };
}

/**
 * 把工作区里的用户节点同步进注册表。
 *
 * @param {{root:string}} workspace
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略签名，强制重读
 * @returns {{changed:boolean, registered:string[], skipped:string[], errors:Array<{source:string,message:string}>}}
 */
export function syncUserNodes(workspace, { force = false } = {}) {
  const dir = userNodesDir(workspace);
  const { signature, files } = scan(dir);

  if (!force && signature === lastSignature) {
    return { changed: false, registered: [], skipped: [], errors: lastErrors };
  }
  lastSignature = signature;

  const entries = [];
  const errors = [];
  for (const name of files) {
    try {
      entries.push({ name, json: JSON.parse(readFileSync(join(dir, name), 'utf8')) });
    } catch (error) {
      errors.push({ source: name, message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  const parsed = parseUserNodeFiles(entries);
  const { registered, skipped } = setUserNodes(parsed.defs);
  lastErrors = [...errors, ...parsed.errors];

  return { changed: true, registered, skipped, errors: lastErrors };
}

/**
 * 热重载内置节点库。
 *
 * 带查询串的动态 import 会拿到**一份新的模块实例**（Node 的 ESM 缓存按完整 URL 算），
 * 于是 `shared/nodelib.js` 里新加的节点立刻可见 —— 不需要重启进程。
 *
 * 注意：`shared/nodes.js` 本身不重新 import（它就是注册表），
 * 这样所有已持有 `NODE_LIBRARY` / `NODE_BY_TYPE` 的模块都自动看到新内容。
 *
 * @returns {Promise<object>} 新的节点库概要
 */
export async function reloadBuiltinNodes() {
  const url = new URL('../shared/nodelib.js', import.meta.url);
  const fresh = await import(`${url.href}?rev=${Date.now()}`);
  if (!Array.isArray(fresh.NODE_LIBRARY_RAW) || fresh.NODE_LIBRARY_RAW.length === 0) {
    throw new Error('重载内置节点库失败：新模块没导出 NODE_LIBRARY_RAW');
  }
  setBuiltinNodes(fresh.NODE_LIBRARY_RAW);
  return nodeLibraryInfo();
}

/**
 * 节点库现状（给面板 / 工具输出用）。
 * @param {{root:string}} [workspace]
 * @returns {object}
 */
export function nodeLibraryStatus(workspace) {
  const info = nodeLibraryInfo();
  return {
    ...info,
    builtinCount: info.builtin,
    // 面板拿到这些定义之后在浏览器侧调 setUserNodes，本地库就和宿主一致了
    userDefs: NODE_LIBRARY.filter((def) => def.userDefined === true),
    errors: lastErrors,
    dir: workspace ? userNodesDir(workspace) : null,
  };
}

/** 测试用：把"上次签名"清掉，强制下一次真的重扫。 */
export function resetNodeLibraryCache() {
  lastSignature = null;
  lastErrors = [];
}
