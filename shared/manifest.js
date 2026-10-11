/**
 * 材质清单（MaterialManifest）与资源引用（AssetRef）。
 *
 * 一个材质 = 一张节点图 + 一份参数快照 + 一组资源引用（纹理 / 音频 / 歌词 / …）。
 * 磁盘布局见 docs/接口契约.md 第 3 节。
 *
 * 资源统一进 `resources[]`（见 shared/asset-types.js）。旧的 `textures[]` /
 * `audio` / `lyric` 三个字段**只读兼容**：读的时候归并进 resources，
 * 写的时候不再输出。这样老材质打开不丢东西，新代码只有一套逻辑。
 *
 * @module dsh-shader-workbench/shared/manifest
 */

import { CHANNEL_SLOTS, PASS_NAMES, TEXTURE_SOURCES, TEXTURE_TYPES, makeId } from './graph.js';
import { normalizeAssets, normalizeAsset } from './asset-types.js';

/**
 * 从「类型 + 路径」派生一个稳定 id。
 *
 * 和 `host/asset-loader.js` 的 `stableScanId` 一个思路：旧字段归并发生在每次
 * `normalizeManifest` 调用里，如果 id 是随机的，那么「前端拿到的 id」和
 * 「服务端再读一次时生成的 id」就永远对不上 —— 所有从旧字段归并来的资源
 * 一律 404。用哈希路径做 id 才能两端一致。
 *
 * @param {string} type
 * @param {string} path
 * @returns {string}
 */
function stableLegacyId(type, path) {
  const s = `${type}:${path}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `as_legacy_${(h >>> 0).toString(36)}`;
}


/** 材质清单的文件名，固定值（Host 与 Client 都读这个）。 */
export const MATERIAL_FILE = 'material.json';

/** 节点图的文件名，固定值。 */
export const GRAPH_FILE = 'graph.json';

/** 纹理子目录名，固定值。 */
export const TEXTURE_DIR = 'textures';

/**
 * 归一化一个纹理引用。非法输入返回 null（调用方负责报警告）。
 *
 * 保留这个函数是为了兼容旧调用者（agent 工具的输出里还会用到）。
 * 新代码请直接用 `normalizeAsset`。
 *
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeTextureRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.path !== 'string' || raw.path === '') return null;
  const slot = CHANNEL_SLOTS.includes(raw.slot) ? raw.slot : null;
  if (slot === null) return null;
  return {
    slot,
    // 一律存**相对材质目录**的路径，绝不存绝对路径：换机器、换盘符都不会烂。
    path: raw.path.replaceAll('\\', '/'),
    type: TEXTURE_TYPES.includes(raw.type) ? raw.type : 'image',
    source: TEXTURE_SOURCES.includes(raw.source) ? raw.source : 'local',
    label: typeof raw.label === 'string' ? raw.label : undefined,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : undefined,
  };
}

/**
 * 建一份材质清单。
 * @param {object} over 覆盖字段
 * @returns {object}
 */
export function makeManifest(over = {}) {
  return normalizeManifest({
    id: makeId('mat'),
    name: 'untitled',
    graphPath: GRAPH_FILE,
    shaderFiles: { frag: 'untitled.frag' },
    uniforms: {},
    resources: [],
    passes: ['image'],
    tags: [],
    ...over,
  });
}

/**
 * 归一化材质清单。永不抛错，脏字段补默认值。
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // ── 资源：统一进 resources[] ──
  // 1. 新字段直接读
  const resources = normalizeAssets(src.resources);
  const known = new Set(resources.map((a) => a.path));

  // 2. 旧的 textures[] → texture 类型的 asset
  for (const t of Array.isArray(src.textures) ? src.textures : []) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.path !== 'string' || t.path === '') continue;
    if (known.has(t.path)) continue;
    const asset = normalizeAsset({
        id: stableLegacyId('texture', t.path),           // ← 加这
      type: 'texture',
      path: t.path,
      slot: t.slot,
      label: t.label,
      meta: {
        ...(t.source ? { source: t.source } : {}),
        ...(t.importedAt ? { importedAt: t.importedAt } : {}),
      },
    });
    if (asset) {
      resources.push(asset);
      known.add(asset.path);
    }
  }

  // 3. 旧的 audio 字段 → audio 类型的 asset（绑 iChannel0）
  if (typeof src.audio === 'string' && src.audio !== '' && !known.has(src.audio)) {
    const asset = normalizeAsset({ 
        id: stableLegacyId('audio', src.audio),          // ← 加这行
      type: 'audio',
       path: src.audio,
        slot: 'iChannel0' });
    if (asset) {
      resources.push(asset);
      known.add(asset.path);
    }
  }

  // 4. 旧的 lyric 字段 → lyric 类型的 asset
  if (typeof src.lyric === 'string' && src.lyric !== '' && !known.has(src.lyric)) {
    const asset = normalizeAsset({ 
        id: stableLegacyId('lyric', src.lyric),          // ← 加这行
      type: 'lyric', path: src.lyric });
    if (asset) {
      resources.push(asset);
      known.add(asset.path);
    }
  }

  // ── Passes ──
  const passes = (Array.isArray(src.passes) ? src.passes : ['image']).filter((p) => PASS_NAMES.includes(p));

  // ── 组装 ──
  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id : makeId('mat'),
    name: typeof src.name === 'string' && src.name !== '' ? src.name : 'untitled',
    graphPath: typeof src.graphPath === 'string' && src.graphPath !== '' ? src.graphPath : GRAPH_FILE,
    shaderFiles: {
      frag: typeof src.shaderFiles?.frag === 'string' ? src.shaderFiles.frag : 'shader.frag',
      vert: typeof src.shaderFiles?.vert === 'string' ? src.shaderFiles.vert : undefined,
    },
    uniforms: src.uniforms && typeof src.uniforms === 'object' ? { ...src.uniforms } : {},

    // 统一资源数组（唯一的权威字段）
    resources,

    passes: passes.length > 0 ? passes : ['image'],
    comfyWorkflows: Array.isArray(src.comfyWorkflows)
      ? src.comfyWorkflows.filter((w) => typeof w === 'string')
      : [],
    tags: Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string') : [],
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : undefined,
  };
}

/**
 * 检查一组资源里有没有重复占用同一个通道槽位。
 * @param {object[]} refs
 * @returns {string[]} 冲突的槽位名
 */
export function findSlotConflicts(refs) {
  const seen = new Map();
  const conflicts = [];
  for (const ref of refs) {
    if (!ref || typeof ref.slot !== 'string') continue;
    if (seen.has(ref.slot)) conflicts.push(ref.slot);
    seen.set(ref.slot, ref);
  }
  return [...new Set(conflicts)];
}