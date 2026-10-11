/**
 * 资源加载器：把磁盘上的文件识别成资源、导入材质、解析路径。
 *
 * 三类操作：
 *   - `listAssets`    读 manifest.resources[] ∪ 扫目录发现的文件
 *   - `importAsset`   从磁盘复制一个文件进材质，登记进 manifest
 *   - `removeAsset`   从 manifest 摘掉一条（**不删文件**）
 *
 * 之所以"扫目录"和"读 manifest"并存：用户可能
 *   1. 通过面板的「导入」按钮 → 走 importAsset，进 manifest
 *   2. 直接拖文件到材质目录 → 打开材质时被扫到，但不进 manifest
 * 两种用法都该能用，所以 list 时并集。
 *
 * @module dsh-shader-workbench/host/asset-loader
 */

import { existsSync, statSync } from 'node:fs';
import { readdir, copyFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { getAssetType, matchAssetType, normalizeAsset } from '../shared/asset-types.js';
import { MATERIAL_FILE, normalizeManifest } from '../shared/manifest.js';

/** 单个文件的大小上限：1 GB。 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/**
 * 列出一个材质里所有可用的资源。
 *
 * `manifest.resources[]` 是权威来源，扫目录发现的文件当作"未登记的候选"，
 * 两者按 path 去重合并。**扫描结果不写回 manifest** —— 只有 importAsset 才写，
 * 免得用户只是把文件放在目录里就被自动登记。
 *
 * @param {object} workspace
 * @param {object} args { project, material }
 * @returns {Promise<{manifest:object, resources:object[]}>}
 */
export async function listAssets(workspace, { project, material }) {
  const dir = workspace.materialDir(project, material);
  if (!existsSync(dir)) throw new Error(`材质不存在：${project}/${material}`);

  const manifestPath = join(dir, MATERIAL_FILE);
  const manifest = normalizeManifest((await workspace.readJson(manifestPath)) ?? { name: material });

  const byPath = new Map();
  for (const asset of manifest.resources ?? []) {
    byPath.set(asset.path, asset);
  }

  for (const asset of await discoverAssets(dir)) {
    if (byPath.has(asset.path)) continue;
    byPath.set(asset.path, asset);
  }

  return { manifest, resources: [...byPath.values()] };
}

/**
 * 从「类型 + 相对路径」派生一个稳定 id。
 *
 * 为什么不用 makeAssetId：扫目录发现的资源**没进 manifest**，每次 list 都会
 * 重新走 normalizeAsset。用随机 id 会导致「前端拿到的 id」和「服务端再查时
 * 生成的 id」对不上 → 所有未登记的资源一律 404。
 *
 * hash 不需要密码学强度，只要两端一致就行。
 *
 * @param {object} def
 * @param {string} relPath
 * @returns {string}
 */
function stableScanId(def, relPath) {
  const s = `${def.type}:${relPath}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `as_scan_${(h >>> 0).toString(36)}`;
}
/**
 * 扫材质目录，按扩展名识别出资源。
 *
 * 分两处扫：
 *   - 材质根目录：匹配 `directory: null` 的类型（audio / lyric / 用户自定义）
 *   - `textures/`：匹配 `directory: 'textures'` 的类型（texture）
 *
 * @param {string} materialDir
 * @returns {Promise<object[]>}
 */
async function discoverAssets(materialDir) {
  const out = [];
  await scanDir(materialDir, '', out);
  const texDir = join(materialDir, 'textures');
  if (existsSync(texDir)) await scanDir(texDir, 'textures', out);
  return out;
}

/**
 * 扫一个目录。
 * @param {string} absDir
 * @param {string} prefix 相对材质目录的前缀（'' 或 'textures'）
 * @param {object[]} out
 */
async function scanDir(absDir, prefix, out) {
    let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const def = matchAssetType(entry.name);
    if (!def) continue;
    if ((def.directory ?? '') !== prefix) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const asset = normalizeAsset({
      id: stableScanId(def, rel),
      type: def.type,
      path: rel,
      slot: def.requiresSlot ? def.defaultSlot : undefined,
    });
    if (asset) out.push(asset);
  }
}

/**
 * 从磁盘导入一个文件到材质。
 *
 * @param {object} workspace
 * @param {object} args
 * @param {string} args.project
 * @param {string} args.material
 * @param {string} args.type 资源类型（必须在 ASSET_TYPES 里）
 * @param {string} args.sourcePath 源文件绝对路径
 * @param {string} [args.slot] iChannel 槽位（仅 requiresSlot 的类型用）
 * @param {string} [args.label] 显示名
 * @returns {Promise<{asset:object, filePath:string, manifest:object}>}
 */
export async function importAsset(workspace, { project, material, type, sourcePath, slot, label, meta }) {
  const def = getAssetType(type);
  if (!def) throw new Error(`不认识的资源类型：${type}`);

  const dir = workspace.materialDir(project, material);
  if (!existsSync(dir)) throw new Error(`材质不存在：${project}/${material}`);

  const src = resolve(String(sourcePath ?? '').replace(/^file:\/\//, ''));
  if (!existsSync(src)) throw new Error(`源文件不存在：${src}`);
  if (!statSync(src).isFile()) throw new Error(`源路径不是文件：${src}`);

  const info = statSync(src);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过 1 GB：${(info.size / 1024 / 1024).toFixed(0)} MB`);
  }

  const ext = extname(src).toLowerCase();
  if (def.extensions.length > 0 && !def.extensions.includes(ext)) {
    throw new Error(`${def.title} 不支持 ${ext}；支持的扩展名：${def.extensions.join(' ')}`);
  }

  // 目标子目录（texture → textures/，其他 → 材质根目录）
  const targetDir = def.directory ? await workspace.ensureDir(
    'projects', project, 'materials', material, def.directory,
  ) : dir;

  // 文件名去重（不覆盖已有文件）
  const base = basename(src, ext).replace(/[^A-Za-z0-9_.\-\u4e00-\u9fff]/g, '_') || def.type;
  let fileName = `${base}${ext}`;
  let counter = 1;
  while (existsSync(join(targetDir, fileName))) {
    fileName = `${base}_${counter}${ext}`;
    counter += 1;
    if (counter > 999) throw new Error('同名文件太多，换个名字');
  }
  await copyFile(src, join(targetDir, fileName));

  const relPath = def.directory ? `${def.directory}/${fileName}` : fileName;
  const asset = normalizeAsset({
    type,
    path: relPath,
    slot: def.requiresSlot ? slot : undefined,
    label,
    meta,
  });
  if (!asset) throw new Error('资源引用归一化失败（type / path 不合法）');

  // 写回 manifest
  const manifestPath = join(dir, MATERIAL_FILE);
  const manifest = normalizeManifest((await workspace.readJson(manifestPath)) ?? { name: material });
  let next = manifest.resources ?? [];

  // 单例：同类型只留一份（不删文件）
  if (def.singleton) next = next.filter((r) => r.type !== type);
  // 占槽位的类型：同一槽位只留最新
  if (def.requiresSlot && asset.slot) {
    next = next.filter((r) => !(r.type === type && r.slot === asset.slot));
  }
  next = [...next, asset];

  manifest.resources = next;
  manifest.updatedAt = new Date().toISOString();
  await workspace.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { asset, filePath: relPath, manifest };
}

/**
 * 解析一个资源的绝对路径。给 webServer 送字节流用。
 *
 * @param {object} workspace
 * @param {object} args { project, material, asset }
 * @returns {string}
 */
export function assetAbsolutePath(workspace, { project, material, asset }) {
  const rel = String(asset?.path ?? '').replaceAll('\\', '/');
  if (rel === '' || rel.includes('..') || isAbsolute(rel)) {
    throw new Error(`非法资源路径：${rel}`);
  }
  return workspace.path('projects', project, 'materials', material, rel);
}

/**
 * 从 manifest 移除一个资源。**不删文件** —— 用户后悔了还能手动找回来。
 *
 * @param {object} workspace
 * @param {object} args { project, material, id }
 * @returns {Promise<{ok:boolean, removed:number}>}
 */
export async function removeAsset(workspace, { project, material, id }) {
  const dir = workspace.materialDir(project, material);
  if (!existsSync(dir)) throw new Error(`材质不存在：${project}/${material}`);

  const manifestPath = join(dir, MATERIAL_FILE);
  const manifest = normalizeManifest((await workspace.readJson(manifestPath)) ?? { name: material });
  const before = (manifest.resources ?? []).length;
  manifest.resources = (manifest.resources ?? []).filter((r) => r.id !== id);
  if (manifest.resources.length === before) return { ok: false, removed: 0 };

  manifest.updatedAt = new Date().toISOString();
  await workspace.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, removed: before - manifest.resources.length };
}