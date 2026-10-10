/**
 * 热重载控制器：图变了 → 防抖 → 重新生成 + 编译 → 原子替换 program。
 *
 * 硬性验收口径（需求书 FR-03 / 第 10 节）：
 *   **节点图变更后 500ms 内完成热重载**。
 * 所以默认 debounce 是 120ms，一次真实热重载通常只需几毫秒；
 * 500ms 是「从最后一次改动算起」的上限，不是目标值。
 *
 * 失败语义：编译失败**不推翻**当前画面，只把错误抛给 UI，
 * 让用户接着改——这是 Shadertoy 的体验，也是必须的（改一半必然编译不过）。
 *
 * @module dsh-shader-workbench/client/runtime/hotreload
 */

import { Emitter } from '../../shared/events.js';

/** 默认防抖窗口（毫秒）。 */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * 热重载控制器。
 */
export class HotReload {
  /**
   * @param {object} deps
   * @param {import('./shadertoy.js').ShaderToy} deps.renderer
   * @param {object} [deps.graph] 初始图
   * @param {number} [deps.debounceMs]
   * @param {(graph:object, extra:object) => object} [deps.onCompile] 自定义编译钩子，缺省用 renderer.setGraph
   */
  constructor({ renderer, graph = null, debounceMs = DEFAULT_DEBOUNCE_MS, onCompile = null }) {
    if (!renderer) throw new Error('HotReload 需要一个 renderer');
    this.renderer = renderer;
    this.graph = graph;
    this.debounceMs = debounceMs;
    this.onCompile = onCompile ?? ((g, extra) => renderer.setGraph(g, extra));
    this.events = new Emitter();
    this.pending = 0;
    this.timer = null;
    /** 上一次编译结果 */
    this.lastResult = null;
    /** 累计统计，给 UI 显示 */
    this.metrics = { reloads: 0, failures: 0, lastDurationMs: 0, lastCompileAt: 0 };
    this._reload = this._reload.bind(this);
  }

  /**
   * 设置/替换当前图。不会自动触发重载。
   * @param {object} graph
   */
  setGraph(graph) {
    this.graph = graph;
  }

  /**
   * 通知「图变了」。合并 500ms 内的连续改动，只跑一次编译。
   * @param {object} [graph] 新的图；不传则用上次 setGraph 的
   * @param {object} [extra] 透传给编译钩子（例如 uniforms）
   * @returns {Promise<object>} 本次（或合并到的那次）的编译结果
   */
  invalidate(graph, extra = {}) {
    if (graph) this.graph = graph;
    this.events.emit('graph:changed', { graphId: this.graph?.id });
    return new Promise((resolve) => {
      this._pendingResolvers = this._pendingResolvers ?? [];
      this._pendingResolvers.push(resolve);
      this._pendingExtra = { ...(this._pendingExtra ?? {}), ...extra };
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(this._reload, this.debounceMs);
    });
  }

  /**
   * 立刻重载，不防抖。给「手动点刷新」用。
   * @param {object} [extra]
   * @returns {object} 编译结果
   */
  reloadNow(extra = {}) {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this._reload(extra);
  }

  /**
   * 真正干活的那次编译。
   * @param {object} [extra]
   * @returns {object}
   */
  _reload(extra = {}) {
    this.timer = null;
    const started = now();
    const merged = { ...(this._pendingExtra ?? {}), ...extra };
    this._pendingExtra = null;

    let result;
    try {
      result = this.onCompile(this.graph, merged);
    } catch (error) {
      result = { ok: false, errors: [{ code: 'exception', message: error instanceof Error ? error.message : String(error) }] };
    }

    const duration = now() - started;
    this.metrics.lastDurationMs = duration;
    this.metrics.lastCompileAt = Date.now();
    this.lastResult = result;

    if (result && result.ok) {
      this.metrics.reloads += 1;
      this.events.emit('preview:hotreload', { graphId: this.graph?.id, durationMs: duration });
      this.events.emit('compile:done', { ok: true, durationMs: duration });
    } else {
      this.metrics.failures += 1;
      const errors = normalizeErrors(result);
      this.events.emit('compile:failed', { errors, durationMs: duration });
    }

    const resolvers = this._pendingResolvers ?? [];
    this._pendingResolvers = [];
    for (const resolve of resolvers) resolve(result);
    return result;
  }

  /**
   * 是否还在等编译。
   * @returns {boolean}
   */
  get isPending() {
    return this.timer !== null;
  }

  /** 取消挂起的编译。 */
  cancel() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const resolvers = this._pendingResolvers ?? [];
    this._pendingResolvers = [];
    this._pendingExtra = null;
    for (const resolve of resolvers) resolve({ ok: false, cancelled: true, errors: [] });
  }

  /** 清理。 */
  dispose() {
    this.cancel();
    this.events.clear();
  }
}

/**
 * 把 undefined/各种形状的结果统一成 `{code,message,pass?}[]`。
 * @param {any} result
 * @returns {object[]}
 */
export function normalizeErrors(result) {
  const raw = result?.errors ?? [];
  if (!Array.isArray(raw)) return [{ code: 'unknown', message: String(raw) }];
  return raw.map((e) => {
    if (typeof e === 'string') return { code: 'error', message: e };
    return {
      code: typeof e.code === 'string' ? e.code : 'error',
      message: typeof e.message === 'string' ? e.message : JSON.stringify(e),
      pass: typeof e.pass === 'string' ? e.pass : undefined,
    };
  });
}

/** 单调时钟，优先用 performance.now。 */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
