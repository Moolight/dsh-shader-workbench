/**
 * 工作台样式。
 *
 * 用 DSH 的主题变量（--dsw-*）优先，拿不到就走兜底色值，
 * 这样换皮肤时工作台跟着变，但独立打开也不会瞎。
 *
 * 以纯字符串导出，由 panel/index.js 注入 <style>，不需要构建步骤。
 *
 * @module dsh-shader-workbench/client/panel/style
 */

/** 样式表内容。 */
export const CSS = `
.swb {
  --swb-bg: var(--dsw-alias-bg-layer-1, #14161a);
  --swb-bg-2: var(--dsw-alias-bg-layer-2, #1a1d23);
  --swb-bg-3: var(--dsw-alias-bg-layer-3, #21252c);
  --swb-border: var(--dsw-alias-border-l1, rgba(255,255,255,0.10));
  --swb-border-2: var(--dsw-alias-border-l2, rgba(255,255,255,0.16));
  --swb-fg: var(--dsw-alias-label-primary, #e8eaee);
  --swb-fg-2: var(--dsw-alias-label-secondary, #a8b0bd);
  --swb-fg-3: var(--dsw-alias-label-tertiary, #737d8c);
  --swb-accent: var(--dsw-alias-state-business-primary, #5b9bff);
  --swb-ok: var(--dsw-alias-state-success-primary, #3ecf8e);
  --swb-warn: var(--dsw-alias-state-warning-primary, #f5b942);
  --swb-danger: var(--dsw-alias-label-danger, #f87171);
  --swb-radius: var(--dsw-radius-sm, 6px);
  --swb-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--swb-bg);
  color: var(--swb-fg);
  font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}

.swb *, .swb *::before, .swb *::after { box-sizing: border-box; }

/* ── 顶栏 ── */
.swb-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--swb-border);
  background: var(--swb-bg-2);
  flex: 0 0 auto;
  flex-wrap: wrap;
}
.swb-bar__title { font-weight: 600; letter-spacing: 0.02em; }
.swb-bar__name {
  font-family: var(--swb-mono);
  font-size: 12px;
  color: var(--swb-fg-2);
  padding: 2px 8px;
  border: 1px solid var(--swb-border);
  border-radius: 999px;
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.swb-bar__spacer, .swb-toolbar__spacer, .swb-section__spacer { flex: 1 1 auto; }

/* ── 三列布局 ── */
.swb-cols {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(360px, 1fr) minmax(240px, 320px);
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;
}
@media (max-width: 1180px) {
  .swb-cols { grid-template-columns: minmax(190px, 220px) 1fr; }
  .swb-col--right { display: none; }
}
.swb-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.swb-col--left { border-right: 1px solid var(--swb-border); background: var(--swb-bg-2); }
.swb-col--right { border-left: 1px solid var(--swb-border); background: var(--swb-bg-2); }
.swb-scroll { overflow: auto; min-height: 0; flex: 1 1 auto; }
.swb-col--left > .swb-scroll:first-child { flex: 0 0 38%; }
.swb-col--left > .swb-scroll:last-child { flex: 1 1 auto; }
.swb-stage { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }

/* ── 底部状态 ── */
.swb-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  border-top: 1px solid var(--swb-border);
  background: var(--swb-bg-2);
  color: var(--swb-fg-2);
  font-size: 12px;
  flex: 0 0 auto;
  flex-wrap: wrap;
}

/* ── 按钮 / 输入 ── */
.swb-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  padding: 4px 10px;
  color: var(--swb-fg);
  background: var(--swb-bg-3);
  border: 1px solid var(--swb-border-2);
  border-radius: var(--swb-radius);
  cursor: pointer;
  white-space: nowrap;
}
.swb-btn:hover:enabled { border-color: var(--swb-accent); }
.swb-btn:disabled { opacity: 0.5; cursor: default; }
.swb-btn--primary { background: var(--swb-accent); border-color: var(--swb-accent); color: #fff; }
.swb-btn--ghost { background: transparent; }
.swb-btn__icon { opacity: 0.8; }

.swb-input, .swb-select {
  font: inherit;
  font-size: 12.5px;
  padding: 3px 7px;
  color: var(--swb-fg);
  background: var(--swb-bg);
  border: 1px solid var(--swb-border-2);
  border-radius: var(--swb-radius);
  min-width: 0;
}
.swb-input--num { width: 68px; }
.swb-input--name { width: 118px; font-family: var(--swb-mono); }
.swb-input--code {
  width: 100%;
  font-family: var(--swb-mono);
  font-size: 12px;
  resize: vertical;
}
.swb-toggle { width: 15px; height: 15px; }
.swb-color { width: 30px; height: 24px; padding: 0; border: 1px solid var(--swb-border-2); background: none; border-radius: 4px; }

.swb-slider { display: inline-flex; align-items: center; gap: 8px; width: 100%; }
.swb-slider__input { flex: 1 1 auto; min-width: 60px; accent-color: var(--swb-accent); }
.swb-slider__value { font-family: var(--swb-mono); font-size: 11.5px; color: var(--swb-fg-2); min-width: 46px; text-align: right; }

.swb-field { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.swb-field__label { flex: 0 0 84px; color: var(--swb-fg-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swb-vec { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.swb-row { display: flex; align-items: center; gap: 8px; padding-top: 6px; }
.swb-hint { color: var(--swb-fg-3); font-size: 11.5px; margin: 4px 0; }
.swb-divider { height: 1px; background: var(--swb-border); margin: 6px 0; }
.swb-details summary { cursor: pointer; color: var(--swb-fg-2); font-size: 12px; padding: 4px 0; }

/* ── 小节 ── */
.swb-section { border-bottom: 1px solid var(--swb-border); }
.swb-section__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--swb-bg-2);
}
.swb-section__title { font-weight: 600; font-size: 12.5px; }
.swb-section__caret { color: var(--swb-fg-3); width: 12px; }
.swb-section__body { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 4px; }

/* ── 空状态 / 徽标 ── */
.swb-empty { padding: 12px 4px; color: var(--swb-fg-3); font-size: 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.swb-empty__text { line-height: 1.6; }
.swb-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--swb-border-2);
  color: var(--swb-fg-2);
}
.swb-badge--ok { color: var(--swb-ok); border-color: color-mix(in srgb, var(--swb-ok) 45%, transparent); }
.swb-badge--warn { color: var(--swb-warn); border-color: color-mix(in srgb, var(--swb-warn) 45%, transparent); }
.swb-badge--error { color: var(--swb-danger); border-color: color-mix(in srgb, var(--swb-danger) 45%, transparent); }
.swb-badge--muted { color: var(--swb-fg-3); }

/* ── 编辑器 ── */
.swb-editor { display: flex; flex-direction: column; min-height: 0; flex: 1 1 60%; border-bottom: 1px solid var(--swb-border); }
.swb-editor__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--swb-bg-2);
  border-bottom: 1px solid var(--swb-border);
  flex: 0 0 auto;
}
.swb-editor__tabs { display: flex; gap: 3px; flex-wrap: wrap; }
.swb-tab {
  font: inherit;
  font-size: 12px;
  padding: 3px 9px;
  color: var(--swb-fg-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--swb-radius) var(--swb-radius) 0 0;
  cursor: pointer;
}
.swb-tab:hover { color: var(--swb-fg); border-color: var(--swb-border); }
.swb-tab--active { color: var(--swb-fg); background: var(--swb-bg-3); border-color: var(--swb-border-2); }
.swb-tab--add { color: var(--swb-fg-3); border-style: dashed; border-color: var(--swb-border); }
.swb-editor__status { font-family: var(--swb-mono); font-size: 11.5px; color: var(--swb-fg-3); }
.swb-editor__status[data-tone="error"] { color: var(--swb-danger); }
.swb-editor__main { display: flex; flex: 1 1 auto; min-height: 0; }
.swb-editor__side {
  flex: 0 0 178px;
  border-right: 1px solid var(--swb-border);
  background: var(--swb-bg-2);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.swb-editor__side-head { padding: 6px; border-bottom: 1px solid var(--swb-border); }
.swb-editor__side-head .swb-input { width: 100%; }
.swb-editor__library { overflow: auto; flex: 1 1 auto; padding: 4px 0 12px; }
.swb-editor__stage { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; }
.swb-editor__canvas { display: block; width: 100%; height: 100%; outline: none; touch-action: none; }

.swb-lib-group { padding: 4px 0; }
.swb-lib-group__title {
  font-size: 11px;
  color: var(--swb-fg-3);
  padding: 4px 8px 2px;
  text-transform: none;
  letter-spacing: 0.05em;
}
.swb-lib-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--swb-fg);
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  cursor: grab;
}
.swb-lib-item:hover { background: var(--swb-bg-3); border-left-color: var(--swb-accent); }
/* 多级分类：可折叠的标题（category 里写斜杠就有层级） */
.swb-lib-group__title--fold { cursor: pointer; user-select: none; }
.swb-lib-group__title--fold:hover { color: var(--swb-accent); }
.swb-bar__sep { width: 1px; height: 16px; margin: 0 6px; background: var(--swb-bg-3); display: inline-block; }
.swb-lib-item__type { font-family: var(--swb-mono); font-size: 10.5px; color: var(--swb-fg-3); }
/* 用户节点标记：来自 <工作区>/library/nodes/，不是插件自带的 */
.swb-lib-item__badge {
  margin-left: auto;
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--swb-accent);
  border: 1px solid color-mix(in srgb, var(--swb-accent) 45%, transparent);
}

/* ── 预览 ── */
.swb-preview { display: flex; flex-direction: column; flex: 1 1 40%; min-height: 0; }
.swb-preview__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  background: var(--swb-bg-2);
  border-bottom: 1px solid var(--swb-border);
  flex-wrap: wrap;
  flex: 0 0 auto;
}
.swb-preview__label { color: var(--swb-fg-3); font-size: 12px; }
.swb-preview__head .swb-slider { width: 130px; }
.swb-preview__stage { position: relative; flex: 1 1 auto; min-height: 120px; background: #0b0d10; }
.swb-preview__canvas { display: block; width: 100%; height: 100%; outline: none; }
.swb-preview__error {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  max-height: 45%;
  overflow: auto;
  padding: 8px 10px;
  font-family: var(--swb-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  color: #ffd9d9;
  background: rgba(80, 20, 24, 0.92);
  border: 1px solid rgba(248, 113, 113, 0.5);
  border-radius: var(--swb-radius);
}
.swb-preview__error[data-tone="hint"] {
  color: var(--swb-fg-2);
  background: rgba(24, 28, 34, 0.92);
  border-color: var(--swb-border-2);
  font-family: ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
}
.swb-preview__foot {
  padding: 4px 8px;
  font-family: var(--swb-mono);
  font-size: 11px;
  color: var(--swb-fg-3);
  background: var(--swb-bg-2);
  border-top: 1px solid var(--swb-border);
  flex: 0 0 auto;
}

/* ── 参数 ── */
.swb-params { padding: 0 0 8px; }
.swb-uniform { display: flex; flex-direction: column; gap: 4px; padding: 5px 0; border-bottom: 1px dashed var(--swb-border); }
.swb-uniform:last-of-type { border-bottom: 0; }
.swb-uniform__head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.swb-uniform__control { display: flex; align-items: center; gap: 6px; }
.swb-node-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px; }
.swb-node-head code { font-family: var(--swb-mono); font-size: 11px; color: var(--swb-fg-3); }

/* ── 资源树 ── */
.swb-res { padding: 0 0 8px; }
.swb-res__toolbar { display: flex; gap: 6px; padding: 6px 8px; }
.swb-res__body { padding: 0 4px; }
/* 存储位置那一行：面板和 agent 共用同一个根，得让用户一眼看见现在存哪 */
.swb-res__root {
  margin: 0 8px 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--swb-border);
  border-radius: var(--swb-radius);
  background: var(--swb-bg-2);
}
.swb-res__roothead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.swb-res__rootlabel { font-size: 11px; color: var(--swb-fg-3); flex: none; }
.swb-res__rootpath {
  font-family: var(--swb-mono);
  font-size: 11px;
  color: var(--swb-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 100%;
}
.swb-res__roottools { display: flex; gap: 6px; }
.swb-res__status {
  padding: 5px 10px;
  font-size: 11px;
  color: var(--swb-fg-3);
  border-top: 1px solid var(--swb-border);
  word-break: break-all;
}
.swb-res__status[data-tone="error"] { color: var(--swb-danger); }
.swb-res__status[data-tone="ok"] { color: var(--swb-ok); }
.swb-tree { display: flex; flex-direction: column; }
.swb-tree__row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12.5px;
}
.swb-tree__row:hover { background: var(--swb-bg-3); }
.swb-tree__row--current { background: color-mix(in srgb, var(--swb-accent) 22%, transparent); }
.swb-tree__row--material { padding-left: 22px; }
.swb-tree__row--action { color: var(--swb-fg-3); font-size: 12px; }
.swb-tree__row--folder { color: var(--swb-fg-2); font-weight: 600; }
.swb-tree__caret { width: 14px; color: var(--swb-fg-3); font-size: 11px; flex: 0 0 auto; }
.swb-tree__name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swb-tree__children { display: flex; flex-direction: column; }
.swb-tree__hint { padding: 3px 8px 3px 22px; color: var(--swb-fg-3); font-size: 11.5px; }
.swb-snap {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: min(420px, 80%);
  max-height: 60%;
  overflow: auto;
  background: var(--swb-bg-2);
  border: 1px solid var(--swb-border-2);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.45);
  padding: 10px;
  z-index: 30;
}
.swb-snap__head { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding-bottom: 8px; }
.swb-snap__row { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 5px 0; border-top: 1px dashed var(--swb-border); }
.swb-snap__meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.swb-snap__meta code { font-family: var(--swb-mono); font-size: 11.5px; word-break: break-all; }

/* ── 诊断 ── */
.swb-diag { padding: 4px 0 8px; }
.swb-diag__head { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 6px 10px; }
.swb-diag__list { display: flex; flex-direction: column; }
.swb-log { display: flex; gap: 7px; padding: 3px 10px; font-size: 11.5px; align-items: baseline; }
.swb-log__time { color: var(--swb-fg-3); font-family: var(--swb-mono); flex: 0 0 auto; }
.swb-log__text { word-break: break-word; }
.swb-log[data-tone="error"] .swb-log__text { color: var(--swb-danger); }
.swb-log[data-tone="ok"] .swb-log__text { color: var(--swb-ok); }
.swb-code {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--swb-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--swb-fg-2);
  white-space: pre;
  overflow: auto;
  max-height: 46vh;
  tab-size: 2;
}

/* ── 浮层 / 菜单 ── */
.swb-popup {
  position: fixed;
  z-index: 9999;
  min-width: 190px;
  padding: 4px;
  background: var(--swb-bg-2, #1a1d23);
  border: 1px solid var(--swb-border-2, rgba(255,255,255,0.16));
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
}
.swb-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 5px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--swb-fg, #e8eaee);
  background: transparent;
  border: 0;
  border-radius: 5px;
  text-align: left;
  cursor: pointer;
}
.swb-menu__item:hover:enabled { background: var(--swb-accent, #5b9bff); color: #fff; }
.swb-menu__item:disabled { opacity: 0.45; cursor: default; }
.swb-menu__item--danger { color: var(--swb-danger, #f87171); }
.swb-menu__item--danger:hover:enabled { background: var(--swb-danger, #f87171); color: #fff; }
.swb-menu__shortcut { color: var(--swb-fg-3, #737d8c); font-size: 11px; }
.swb-menu__sep { height: 1px; background: var(--swb-border, rgba(255,255,255,0.1)); margin: 4px 2px; }

/* ── 页面级容器（DSH 主面板槽位） ── */
.swb-page { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; }
`;

