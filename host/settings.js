/**
 * 插件级持久化设置。
 *
 * 为什么需要它：工作区根目录原先只能靠 profile 的 `cordis.patch.yml` 配，
 * 面板里改不了；而且**没有配置时，工具（有会话上下文）和面板（没有会话上下文）
 * 会各自算出不同的根目录** —— agent 把材质写到 A，用户打开面板看的是 B，
 * 资源树永远是空的，一堆按钮因此"点了没反应"。
 *
 * 所以把「用户选定的根目录」落成一份插件自己的设置文件，两侧都读它。
 * 读写都容错：文件不存在、被写坏了、权限不够，一律当"没有设置"，
 * 绝不能让读设置这件事把插件拖垮。
 *
 * 文件位置：`<DSH_HOME>/shader-workbench.json`
 * 可用 `DSH_SHADER_WORKBENCH_SETTINGS` 覆盖（测试用，避免污染用户目录）。
 *
 * @module dsh-shader-workbench/host/settings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * DSH home 目录：优先环境变量，其次 `~/.dsh`。
 * @returns {string}
 */
export function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/**
 * 设置文件路径。
 * @returns {string}
 */
export function settingsPath() {
  const override = process.env.DSH_SHADER_WORKBENCH_SETTINGS;
  if (typeof override === 'string' && override.trim() !== '') return resolve(override);
  return join(dshHomeDir(), 'shader-workbench.json');
}

/**
 * 读设置。读不到/坏了都返回 `{}`。
 * @returns {{workspaceRoot?: string, readOnly?: boolean}}
 */
export function readSettings() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  if (typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim() !== '') {
    out.workspaceRoot = parsed.workspaceRoot.trim();
  }
  if (typeof parsed.readOnly === 'boolean') out.readOnly = parsed.readOnly;
  return out;
}

/**
 * 合并写设置。
 *
 * `workspaceRoot` 传空串 = 清掉这条（回到自动推断）；必须是**绝对路径**——
 * 相对路径在这里没有稳定的基准（面板进程的 cwd 是宿主自己的目录），
 * 猜出来的位置只会让人更困惑，所以直接拒绝。
 *
 * @param {object} [patch]
 * @param {string} [patch.workspaceRoot] 绝对路径；空串表示清除
 * @param {boolean|null} [patch.readOnly] true/false 设置；null 清除
 * @returns {object} 写回后的完整设置
 */
export function writeSettings(patch = {}) {
  const next = { ...readSettings() };

  if (patch.workspaceRoot !== undefined) {
    const value = String(patch.workspaceRoot ?? '').trim();
    if (value === '') {
      delete next.workspaceRoot;
    } else {
      if (value.includes('\0')) throw new Error('路径里有非法字符');
      if (!isAbsolute(value)) throw new Error(`存储位置必须是绝对路径，收到：${value}`);
      next.workspaceRoot = resolve(value);
    }
  }

  if (patch.readOnly !== undefined) {
    if (patch.readOnly === null) delete next.readOnly;
    else next.readOnly = patch.readOnly === true;
  }

  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  // 先写临时文件再改名：别让一次失败的写留下半截 JSON，那会让下次读设置直接坏掉
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return next;
}
