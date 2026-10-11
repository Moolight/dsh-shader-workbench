/**
 * 资源绑定器：把资源挂到工作台（viewer）上。
 *
 * 和 `host/asset-loader.js` 一一对应：
 *   - loader 管"文件从磁盘到材质"（host，Node 环境）
 *   - binder 管"资源从材质到 viewer"（client，浏览器环境）
 *
 * 每个类型的绑定行为写在自己的 handler 里：
 *   - `texture` → new Image → renderer.setChannel
 *   - `audio`   → new Audio → renderer.attachAudio
 *   - `lyric`   → fetch 文本 → lyrics.loadText
 *
 * 加一个新类型（比如 video）：
 *   1. `shared/asset-types.js` 加一处 defineAssetType
 *   2. `host/asset-loader.js` 通常不用改（走通用逻辑）
 *   3. 这里加一个 ASSET_BINDERS 条目
 *
 * @module dsh-shader-workbench/client/panel/asset-binder
 */

import { getAssetType } from '../../shared/asset-types.js';
import { messageOf } from './resources.js';

/**
 * 拼一个资源的 HTTP URL。
 *
 * 走通用 `/asset?id=<assetId>` 端点：不用把路径暴露到 URL 里，
 * 而且 host 侧可以查 manifest 反查类型（MIME 就能按类型给）。
 *
 * @param {string} apiBase
 * @param {object} args
 * @returns {string}
 */
function assetUrl(apiBase, { project, material, asset }) {
  const base = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  return (
    `${base}asset` +
    `?project=${encodeURIComponent(project)}` +
    `&material=${encodeURIComponent(material)}` +
    `&id=${encodeURIComponent(asset.id)}`
  );
}

/**
 * 每个资源类型的浏览器端 handler。
 *
 * 签名：`async (viewer, ctx) => ({ dispose?: () => void } | void)`
 *   - `viewer` 是 Workbench 实例，能访问 `renderer` / `lyrics` / `log`
 *   - `ctx` 是 `{ url, resource, project, material }`
 *   - 返回 `{ dispose }` 时，viewer 会在下次加载/卸载时调用它
 */
export const ASSET_BINDERS = {
  async texture(viewer, { url, resource }) {
    const slot = resource.slot ?? 'iChannel1';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    viewer.renderer?.setChannel(slot, img);
    return {
      dispose: () => {
        try { viewer.renderer?.setChannel(slot, null); } catch { /* ignore */ }
      },
    };
  },

  async audio(viewer, { url, resource }) {
    const slot = resource.slot ?? 'iChannel0';
    const audio = new Audio(url);
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    // 保留引用，`_toggleAudio` 会用到
    viewer._audio = audio;
    await viewer.renderer?.attachAudio(slot, audio, { fftSize: 2048, smoothing: 0.8 });
    return {
      dispose: () => {
        try { audio.pause(); } catch { /* ignore */ }
        try { viewer.renderer?.setChannel(slot, null); } catch { /* ignore */ }
        if (viewer._audio === audio) viewer._audio = null;
      },
    };
  },

  async lyric(viewer, { url }) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    viewer.lyrics?.loadText(text, '');
    return {
      dispose: () => {
        try { viewer.lyrics?.clear(); } catch { /* ignore */ }
      },
    };
    
  },
  async video(viewer, { url, resource }) {
  const v = document.createElement('video');
  v.src = url; v.loop = true; v.muted = true; v.crossOrigin = 'anonymous';
  await v.play();
  viewer.renderer?.setChannel(resource.slot ?? 'iChannel2', v);
  return { dispose: () => { v.pause(); viewer.renderer?.setChannel(resource.slot, null); } };
}
};

/**
 * 把一批资源挂到 viewer 上。
 *
 * 遍历顺序即 manifest.resources[] 的顺序；后面挂的会覆盖前面的（同槽位）。
 * 单个资源挂失败不打断其他资源 —— 一个坏文件不该让整张画面挂不出来。
 *
 * @param {object} viewer Workbench 实例
 * @param {object} args
 * @param {string} args.project
 * @param {string} args.material
 * @param {object[]} args.resources
 * @param {string} [args.apiBase]
 * @returns {Promise<() => void>} 卸载函数（逆序调用各 dispose）
 */
export async function bindAssets(viewer, { project, material, resources, apiBase }) {
  const disposers = [];
  const base = apiBase ?? viewer.apiBase ?? '/plugins/dsh-shader-workbench/';

  for (const resource of resources ?? []) {
    const def = getAssetType(resource.type);
    if (!def) {
      viewer.log?.(`资源类型 ${resource.type} 未注册，跳过 ${resource.path}`, 'warn');
      continue;
    }
    const binder = ASSET_BINDERS[resource.type];
    if (!binder) {
      viewer.log?.(`没有 ${resource.type} 的绑定器，跳过 ${resource.path}`, 'warn');
      continue;
    }

    try {
      const url = assetUrl(base, { project, material, asset: resource });
      const handle = await binder(viewer, { url, resource, project, material });
      if (handle && typeof handle.dispose === 'function') {
        disposers.push(handle.dispose);
      }
      viewer.log?.(`已接上 ${resource.type}：${resource.path}`, 'ok');
    } catch (error) {
      viewer.log?.(`挂 ${resource.type} (${resource.path}) 失败：${messageOf(error)}`, 'error');
    }
  }

  return () => {
    // 逆序卸载：后挂的先卸，避免"新挂的资源还没生效就被旧 dispose 覆盖"
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 卸载异常忽略 */ }
    }
  };
}