/**
 * 工作台面板入口：把 Workbench 挂进 DSH 的主面板槽位。
 *
 * 这个文件由 Host 通过 `/plugins/dsh-shader-workbench/module/panel/index.js`
 * 原样送出，浏览器直接 `import()`，走原生 ESM 解析——
 * 所以里面可以用裸相对路径 import，不需要任何打包器。
 *
 * @module dsh-shader-workbench/client/panel
 */

import { CSS } from './style.js';

/** 样式标签的标识。 */
const STYLE_ID = 'dsh-shader-workbench-style';
const STYLE_ATTR = 'data-dsh-plugin-css';

/**
 * 注入样式，只注一次。
 * @returns {void}
 */
export function ensureStyles() {
  if (typeof document === 'undefined') return;
  const existing =
    document.querySelector(`style[${STYLE_ATTR}="dsh-shader-workbench"]`) ?? document.getElementById(STYLE_ID);
  if (existing) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.setAttribute(STYLE_ATTR, 'dsh-shader-workbench');
  tag.textContent = CSS;
  document.head.append(tag);
}

/** 当前挂载的工作台实例（主面板同时只会有一个）。 */
let current = null;

/**
 * 动态 import 一个 URL。
 *
 * 刻意绕开静态 `import()` 语法：部分打包器会把它重写成 require，
 * 而这里要的就是浏览器原生的 ESM 动态导入。
 * @param {string} url
 * @returns {Promise<any>}
 */
const dynamicImport = new Function('url', 'return import(url);');

/**
 * 确保面板模块已加载，返回其命名空间。
 * @param {string} [base] API 基址，缺省同源
 * @returns {Promise<any>}
 */
export function loadPanelModule(base = '/plugins/dsh-shader-workbench/') {
  const url = `${base.replace(/\/+$/, '')}/module/panel/index.js`;
  return dynamicImport(url);
}

/**
 * 挂载工作台到容器。
 * @param {HTMLElement} host
 * @returns {Workbench}
 */
export function mountWorkbench(host) {
  disposeWorkbench();
  // 同步阶段先给出个占位，异步模块到了再换掉
  host.replaceChildren(loadingNode());
  let workbench = null;
  loadPanelModule()
    .then((mod) => {
      mod.ensureStyles();
      workbench = new mod.Workbench();
      current = workbench;
      workbench.mount(host);
    })
    .catch((error) => {
      // 挂载期任何异常都要落到界面上，不能只吞进控制台
      host.replaceChildren(errorNode(error));
    });
  // 返回一个延迟可用的占位对象：dispose 会在真正挂载后也能正确释放
  return {
    get instance() {
      return workbench;
    },
    dispose() {
      workbench?.dispose();
      if (current === workbench) current = null;
    },
  };
}

/**
 * 取当前实例（可能为 null）。
 * @returns {Workbench|null}
 */
export function getWorkbench() {
  return current;
}

/**
 * 卸掉当前实例并释放 WebGL 资源。
 * @returns {void}
 */
export function disposeWorkbench() {
  if (!current) return;
  try {
    current.dispose();
  } catch {
    // 卸载期的异常不该冒出去影响面板切换
  }
  current = null;
}

/** 加载中占位。 */
function loadingNode() {
  const div = document.createElement('div');
  div.className = 'swb-page';
  div.style.cssText =
    'display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#737d8c);font-size:13px;';
  div.textContent = '正在加载 Shader 工作台…';
  return div;
}

/**
 * 加载失败提示。
 * @param {any} error
 * @returns {HTMLElement}
 */
export function errorNode(error) {
  const div = document.createElement('div');
  div.className = 'swb-page';
  div.style.cssText = 'padding:24px;color:var(--dsw-alias-label-danger,#f87171);font:13px/1.6 ui-sans-serif,system-ui;';
  const title = document.createElement('strong');
  title.textContent = 'Shader 工作台加载失败';
  const detail = document.createElement('pre');
  detail.style.cssText = 'white-space:pre-wrap;margin-top:8px;font-size:12px;';
  detail.textContent = String(error?.stack ?? error?.message ?? error);
  div.append(title, detail);
  return div;
}

export { CSS };
export { Workbench } from './workbench.js';
export { NodeEditor } from './editor.js';
export { ParamsPanel } from './params.js';
export { ResourceBrowser } from './resources.js';
export { ShaderToy, HotReload } from '../runtime/index.js';
