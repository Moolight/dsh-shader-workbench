/**
 * 资源类型注册表。
 *
 * 和 `shared/nodes.js` 一个套路：类型定义集中在一个 Map 里，两端共享，
 * 加一个新类型只改这一个文件（加一处 `defineAssetType`），
 * 现有代码里的 `import` 拿到的还是同一个 `ASSET_TYPES` 实例。
 *
 * 与节点库的差别：
 *   - 节点库注册的是「怎么生成 GLSL」，纯函数
 *   - 资源类型注册的是「元数据」（扩展名、是否占槽位、是否单例、放哪个目录），
 *     具体的磁盘操作在 `host/asset-loader.js`、浏览器行为在 `client/panel/asset-binder.js`
 *
 * 这个文件只放**数据**，不放 fs / DOM 相关的东西，所以两端都能 import。
 *
 * @module dsh-shader-workbench/shared/asset-types
 */

/** type → 定义。同一个实例，跨模块共享。 */
export const ASSET_TYPES = new Map();

/**
 * 定义一个资源类型。
 *
 * @param {object} def
 * @param {string} def.type              唯一标识（小写，只允许字母数字下划线）
 * @param {string} [def.title]           显示名，缺省用 type
 * @param {string[]} [def.extensions]    文件扩展名（小写，带点），用于"丢文件即识别"
 * @param {boolean} [def.requiresSlot]   是否占用一个 iChannel 槽位
 * @param {boolean} [def.singleton]      每种材质是否只允许一个（比如歌词）
 * @param {string} [def.defaultSlot]     未指定槽位时的缺省值
 * @param {string|null} [def.directory]  放材质的哪个子目录；null = 材质根目录
 * @returns {string} type
 */
export function defineAssetType(def) {
  if (!def || typeof def.type !== 'string' || def.type === '') {
    throw new Error('资源类型必须有非空 type');
  }
  if (!/^[a-z][a-z0-9_]*$/.test(def.type)) {
    throw new Error(`资源类型的 type 必须是小写标识符：${def.type}`);
  }
  if (ASSET_TYPES.has(def.type)) {
    throw new Error(`资源类型 ${def.type} 已经注册过了`);
  }
  const normalized = Object.freeze({
    title: def.type,
    extensions: [],
    requiresSlot: false,
    singleton: false,
    defaultSlot: 'iChannel0',
    directory: null,
    ...def,
  });
  ASSET_TYPES.set(def.type, normalized);
  return normalized.type;
}

/**
 * 按 type 取定义。
 * @param {string} type
 * @returns {object|null}
 */
export function getAssetType(type) {
  return ASSET_TYPES.get(type) ?? null;
}

/** 列出全部已注册类型（给 UI / 工具描述用）。 */
export function listAssetTypes() {
  return [...ASSET_TYPES.values()];
}

/**
 * 按文件名匹配类型。
 *
 * 这是「丢文件即识别」的入口：扫材质目录时，每个文件按扩展名找类型。
 * 同一个扩展名被两个类型声明时，先注册的赢 —— 所以内置类型要排在前面，
 * 自定义类型用更独特的扩展名。
 *
 * @param {string} fileName
 * @returns {object|null}
 */
export function matchAssetType(fileName) {
  const lower = String(fileName ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  for (const def of ASSET_TYPES.values()) {
    if (def.extensions.includes(ext)) return def;
  }
  return null;
}

/** 生成一个资源 id。 */
function makeAssetId() {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0');
  return `as_${Date.now().toString(36)}${rand}`;
}

/**
 * 归一化一个资源引用。非法输入返回 null。
 *
 * - `path` 一律相对材质目录，用 `/` 分隔
 * - 只有 `requiresSlot` 的类型才有 `slot` 字段
 * - `meta` 里塞类型特有的数据（比如纹理的 `importedAt`），不参与语义
 *
 * @param {any} raw
 * @returns {object|null}
 */
export function normalizeAsset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = ASSET_TYPES.get(raw.type);
  if (!def) return null;
  if (typeof raw.path !== 'string' || raw.path === '') return null;

  const asset = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : makeAssetId(),
    type: raw.type,
    path: raw.path.replaceAll('\\', '/'),
  };
  if (typeof raw.label === 'string' && raw.label !== '') asset.label = raw.label;
  if (def.requiresSlot) {
    asset.slot = /^iChannel[0-3]$/.test(raw.slot) ? raw.slot : def.defaultSlot;
  }
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    asset.meta = { ...raw.meta };
  }
  return asset;
}

/**
 * 归一化一个资源数组。丢掉非法的、按 id 去重。
 * @param {any} raw
 * @returns {object[]}
 */
export function normalizeAssets(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const asset = normalizeAsset(item);
    if (!asset) continue;
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    out.push(asset);
  }
  return out;
}

// ─────────────────────── 内置类型 ───────────────────────
//
// 顺序有意义：同一个扩展名被两个类型声明时先注册的赢。
// 所以要自定义类型覆盖内置的，只能在业务层 `defineAssetType` **之前**插入，
// 或者用更独特的扩展名。

defineAssetType({
  type: 'texture',
  title: '图片',
  extensions: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.dds', '.ktx', '.ktx2', '.hdr'],
  requiresSlot: true,
  // 纹理默认占 iChannel1 —— iChannel0 留给音频，这样即使两个都"丢进目录"
  // 也能同时挂上，不用用户手动改。
  defaultSlot: 'iChannel1',
  directory: 'textures',
});

defineAssetType({
  type: 'audio',
  title: '音频',
  extensions: ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus'],
  requiresSlot: true,
  defaultSlot: 'iChannel0',
  // 音频放材质根目录 —— 保持和旧代码一致，也方便用户手动丢文件
  directory: null,
});

defineAssetType({
  type: 'lyric',
  title: '歌词',
  extensions: ['.lrc', '.txt'],
  singleton: true,
  directory: null,
});
defineAssetType({
  type: 'video',
  title: '视频',
  extensions: ['.mp4', '.webm', '.mov'],
  requiresSlot: true,
  defaultSlot: 'iChannel2',
});