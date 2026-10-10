/**
 * 事件总线：Host 与 Client 两侧共用的极简同步 emitter。
 *
 * 刻意不用 Node 的 EventEmitter：这个模块要被浏览器 runtime 直接 import。
 * 事件名与负载形状在 docs/接口契约.md 第 5 节冻结。
 *
 * @module dsh-shader-workbench/shared/events
 */

/** 所有合法事件名。写错名字会在 emit 时报错，而不是静默丢弃。 */
export const EVENT_TYPES = Object.freeze([
  'graph:changed',
  'graph:opened',
  'material:updated',
  'material:deleted',
  'texture:imported',
  'comfy:started',
  'comfy:done',
  'compile:done',
  'compile:failed',
  'preview:hotreload',
  'workspace:changed',
]);

/**
 * 极简事件总线。同步派发，监听器抛错不会打断其它监听器。
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {string[]} 派发中出错的信息，供 UI 显示 */
    this.errors = [];
  }

  /**
   * 订阅一个事件。
   * @param {string} type 事件名，必须是 EVENT_TYPES 之一
   * @param {(payload:any)=>void} fn 监听器
   * @returns {() => void} 退订函数
   */
  on(type, fn) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`未知事件类型：${type}`);
    if (typeof fn !== 'function') throw new Error('监听器必须是函数');
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /**
   * 订阅一次，自动退订。
   * @param {string} type
   * @param {(payload:any)=>void} fn
   * @returns {() => void}
   */
  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /**
   * 派发事件。同步、有序，单个监听器抛错只记录不传播。
   * @param {string} type
   * @param {any} [payload]
   * @returns {number} 实际调用到的监听器数量
   */
  emit(type, payload) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`未知事件类型：${type}`);
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return 0;
    let count = 0;
    for (const fn of [...set]) {
      try {
        fn(payload);
        count += 1;
      } catch (error) {
        this.errors.push(`${type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return count;
  }

  /**
   * 摘掉某个事件的全部监听器（不带参数则清空）。
   * @param {string} [type]
   */
  clear(type) {
    if (type === undefined) this.listeners.clear();
    else this.listeners.delete(type);
  }
}
