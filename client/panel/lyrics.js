/**
 * 歌词叠加层：解析 LRC、按音频时间同步高亮。
 *
 * ## 为什么是 HTML 层而不是 shader
 *
 * 要在 GLSL 里渲染中文，要么预烤字体纹理（几千行顶点坐标），要么上 SDF
 * （需要外部工具生成）。而这是一个叠在 canvas 上的 HTML 层就能完美解决的事——
 * canvas 负责画面，HTML 负责文字，各司其职，中文完美，还能用 CSS 做
 * KTV 高亮、发光、淡入淡出。
 *
 * ## 为什么独立成文件
 *
 * 和 ParamsPanel / ResourceBrowser 一样，它是一个**自包含**的组件：
 * 自己解析 LRC、自己管 DOM、自己注入 CSS、自己按音频时间同步。
 * workbench.js 只负责实例化 + 接线（mount / update / dispose）。
 *
 * 组件对外接口：
 *   - `root`          挂到 stage 里的 DOM 节点
 *   - `pickFile()`    弹出文件选择，载入 .lrc / .txt，返回行数
 *   - `loadText(t)`   从字符串载入（程序化调用 / 单测）
 *   - `load(lines)`   从 `[{time,text}]` 载入
 *   - `update()`      每帧调用，从 `getAudio()` 拿 currentTime
 *   - `clear()`       清空歌词
 *   - `dispose()`     卸载
 *
 * @module dsh-shader-workbench/client/panel/lyrics
 */

import { h } from './dom.js';

/** 样式标签 id，保证只注入一次。 */
const STYLE_ID = 'dsh-shader-workbench-lyrics-style';

/** 组件样式。刻意和 panel 的 CSS 分开管理：删掉这个文件就干净了。 */
const CSS = `
.swb-lyrics {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 16%;
  z-index: 3;
  text-align: center;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.85), 0 0 6px rgba(0, 0, 0, 0.6);
}
.swb-lyrics__line {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.02em;
  background-image: linear-gradient(
    90deg,
    #7cf0ff 0%,
    #7cf0ff calc(var(--progress, 0) * 100%),
    rgba(255, 255, 255, 0.38) calc(var(--progress, 0) * 100%),
    rgba(255, 255, 255, 0.38) 100%
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}
.swb-lyrics__next {
  margin-top: 6px;
  font-size: 15px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.34);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}
`;

/** 注入组件样式（只注一次）。 */
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  document.head.append(tag);
}

/**
 * 解析 LRC 文本。
 *
 * 支持 `[mm:ss.xx]` 和 `[mm:ss]` 两种时间戳；一行可以有多个时间戳
 * （重复副歌常用写法），会展开成多行。
 *
 * @param {string} text
 * @returns {Array<{time:number, text:string}>} 按 time 升序
 */
export function parseLrc(text) {
  const out = [];
  const stampRe = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const stamps = [];
    let m;
    stampRe.lastIndex = 0;
    while ((m = stampRe.exec(line)) !== null) {
      const sec = Number(String(m[2]).replace(':', '.'));
      if (!Number.isFinite(sec)) continue;
      stamps.push(Number(m[1]) * 60 + sec);
    }
    if (stamps.length === 0) continue;
    const lyric = line.replace(stampRe, '').trim();
    if (lyric === '') continue;
    for (const time of stamps) out.push({ time, text: lyric });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 歌词叠加层。
 */
export class LyricsOverlay {
  /**
   * @param {object} opts
   * @param {() => (HTMLAudioElement|null|undefined)} opts.getAudio 每帧取当前音源
   * @param {(text:string, tone?:'info'|'ok'|'error') => void} [opts.onLog] 日志回调
   */
  constructor(opts = {}) {
    if (typeof opts.getAudio !== 'function') throw new Error('LyricsOverlay 需要 getAudio()');
    this.getAudio = opts.getAudio;
    this.onLog = opts.onLog ?? (() => {});

    /** @type {Array<{time:number, text:string}>} */
    this.lines = [];
    /** 上一次高亮的行号，用来判断要不要重建 DOM */
    this._index = -1;

    this.root = h('div.swb-lyrics', { style: { display: 'none' } });
    ensureStyles();
  }

  /**
   * 挂到某个容器。
   * @param {HTMLElement} parent
   */
  mount(parent) {
    parent.append(this.root);
  }



  /**
   * 从字符串载入。
   * @param {string} text
   * @param {string} [sourceName] 用于日志
   * @returns {number} 载入的行数
   */
  loadText(text, sourceName = '') {
    const lines = parseLrc(text);
    if (lines.length === 0) {
      this.onLog('歌词里没解析出任何带时间戳的行', 'error');
      this.root.style.display = 'none';
      return 0;
    }
    this.lines = lines;
    this._index = -1;
    this.root.replaceChildren();
    this.root.style.display = '';
    this.onLog(`已载入 ${lines.length} 行歌词${sourceName ? `（${sourceName}）` : ''}`, 'ok');
    return lines.length;
  }

  /**
   * 从已解析的行数组载入（程序化调用 / 单测用）。
   * @param {Array<{time:number, text:string}>} lines
   */
  load(lines) {
    this.lines = Array.isArray(lines) ? [...lines].sort((a, b) => a.time - b.time) : [];
    this._index = -1;
    this.root.replaceChildren();
    this.root.style.display = this.lines.length > 0 ? '' : 'none';
  }

  /** 清空。 */
  clear() {
    this.lines = [];
    this._index = -1;
    this.root.replaceChildren();
    this.root.style.display = 'none';
  }

  /**
   * 每帧调用：按音频时间同步高亮。
   *
   * 只在**换行时**重建 DOM；每一帧只改一个 CSS 变量 `--progress`，
   * 触发的是合成层更新，开销很低。
   */
  update() {
    if (this.lines.length === 0) return;
    const audio = this.getAudio();
    if (!audio) return;
    const t = audio.currentTime;

    // 从后往前找第一条 time <= t 的行
    let index = -1;
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      if (this.lines[i].time <= t) { index = i; break; }
    }

    if (index < 0) {
      // 还没到第一句
      if (this._index !== -1) {
        this._index = -1;
        this.root.replaceChildren();
      }
      return;
    }

    const current = this.lines[index];
    const next = this.lines[index + 1];
    const start = current.time;
    const end = next ? next.time : start + 4;
    const progress = Math.min(1, Math.max(0, (t - start) / Math.max(0.2, end - start)));

    if (this._index !== index) {
      this._index = index;
      this.root.replaceChildren(
        h('div.swb-lyrics__line', { text: current.text }),
        next ? h('div.swb-lyrics__next', { text: next.text }) : null,
      );
    }
    this.root.style.setProperty('--progress', String(progress));
  }

  /** 卸载。 */
  dispose() {
    this.clear();
    this.root.remove();
  }
}