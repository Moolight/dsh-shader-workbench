/**
 * 材质清单（MaterialManifest）与纹理引用（TextureRef）。
 *
 * 一个材质 = 一张节点图 + 一份参数快照 + 一组纹理槽绑定。
 * 磁盘布局见 docs/接口契约.md 第 3 节。
 *
 * @module dsh-shader-workbench/shared/manifest
 */

import { CHANNEL_SLOTS, PASS_NAMES, TEXTURE_SOURCES, TEXTURE_TYPES, makeId } from './graph.js';

/** 材质清单的文件名，固定值（Host 与 Client 都读这个）。 */
export const MATERIAL_FILE = 'material.json';

/** 节点图的文件名，固定值。 */
export const GRAPH_FILE = 'graph.json';

/** 纹理子目录名，固定值。 */
export const TEXTURE_DIR = 'textures';

/**
 * 归一化一个纹理引用。非法输入返回 null（调用方负责报警告）。
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
    shaderFiles: { frag: `${'untitled'}.frag` },
    uniforms: {},
    textures: [],
    passes: ['image'],
    tags: [],
    ...over,
  });
}

/**
 * 归一化材质清单。永不抛错，脏字段补默认值。
 * @param {object} raw
 * @returns {object}
 */
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const textures = [];
  for (const t of Array.isArray(src.textures) ? src.textures : []) {
    const ref = normalizeTextureRef(t);
    if (ref) textures.push(ref);
  }
  const passes = (Array.isArray(src.passes) ? src.passes : ['image']).filter((p) => PASS_NAMES.includes(p));
  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id : makeId('mat'),
    name: typeof src.name === 'string' && src.name !== '' ? src.name : 'untitled',
    graphPath: typeof src.graphPath === 'string' && src.graphPath !== '' ? src.graphPath : GRAPH_FILE,
    shaderFiles: {
      frag: typeof src.shaderFiles?.frag === 'string' ? src.shaderFiles.frag : 'shader.frag',
      vert: typeof src.shaderFiles?.vert === 'string' ? src.shaderFiles.vert : undefined,
    },
    uniforms: src.uniforms && typeof src.uniforms === 'object' ? { ...src.uniforms } : {},
    textures,
    passes: passes.length > 0 ? passes : ['image'],
    comfyWorkflows: Array.isArray(src.comfyWorkflows) ? src.comfyWorkflows.filter((w) => typeof w === 'string') : [],
    tags: Array.isArray(src.tags) ? src.tags.filter((t) => typeof t === 'string') : [],
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : undefined,
  };
}

/**
 * 检查一组纹理引用里有没有重复占用同一个通道槽位。
 * @param {object[]} refs
 * @returns {string[]} 冲突的槽位名
 */
export function findSlotConflicts(refs) {
  const seen = new Map();
  const conflicts = [];
  for (const ref of refs) {
    if (seen.has(ref.slot)) conflicts.push(ref.slot);
    seen.set(ref.slot, ref);
  }
  return [...new Set(conflicts)];
}
