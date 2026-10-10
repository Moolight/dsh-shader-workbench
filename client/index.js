/**
 * dsh-shader-workbench —— 客户端插件入口。
 *
 * 格式说明：DSH 的客户端插件是一段在页面里执行的脚本，形如
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return module.exports } })
 * 这里的 `require` 能拿到 `react` / `react/jsx-runtime` 等宿主提供的模块。
 *
 * 本插件**刻意不用 React 建元素树**：工作台内部全是 canvas / WebGL / 拖拽，
 * 命令式状态和 reconcile 会互相打架。所以只借 React 的挂载/卸载生命周期，
 * 内容用原生 DOM 自管（见 client/panel/）。
 *
 * 导出契约：`inject`（要等哪些客户端服务）+ `apply(ctx)`。
 *
 * @module dsh-shader-workbench/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-shader-workbench',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** 主面板 id：侧栏那一行与 main 槽位共用同一个 key。 */
    const PANEL_ID = 'shader-workbench';

    /** 侧栏里的行序（官方 Plugins 是 0，Schedule 是 10，看板是 20）。 */
    const PANEL_ORDER = 24;

    /** 模块来源：Host 的 webServer 前缀路由。 */
    const MODULE_BASE = '/plugins/dsh-shader-workbench/';

    /**
     * 要等哪些客户端服务。
     *
     * 只需要 `slots`：工作台自己的数据全部走 Host 的 HTTP API，
     * 不依赖会话/工作区控制器，所以注入面越小越不容易因为宿主版本变化而卡住。
     */
    const inject = ['slots'];

    /**
     * 动态 import 一个 URL。
     * 用 Function 构造而不是直接写 import()，避免被外层打包器改写。
     */
    const dynamicImport = new Function('url', 'return import(url);');

    /** 已加载的面板模块，避免每次切面板都重新拉一遍。 */
    let panelModulePromise = null;

    /**
     * 拉面板模块。
     * @returns {Promise<any>}
     */
    function loadPanel() {
      if (!panelModulePromise) {
        panelModulePromise = dynamicImport(`${MODULE_BASE}module/panel/index.js`).catch((error) => {
          panelModulePromise = null;
          throw error;
        });
      }
      return panelModulePromise;
    }

    /**
     * 侧栏那一行的图标。
     *
     * ⚠️ **必须返回 React 元素，不能返回原生 DOM 节点。**
     *
     * 之前这里是 `document.createElementNS` 建一个 SVGElement 直接 return，理由是
     * 「React 能直接渲染 DOM 节点」—— **这个说法是错的**。侧栏槽位把组件返回值当
     * React child 用（`dsh-client-ui-sidebar` 的 PanelRow 里就是
     * `renderSlot('sidebar.panellist', { size, active })`），传 DOM 节点会抛
     * `Minified React error #31 ... [object SVGSVGElement]`，把侧栏渲染整块炸掉。
     *
     * @param {{size:number, active:boolean}} props
     * @returns {import('react').ReactElement}
     */
    function WorkbenchIcon(props) {
      const size = props?.size ?? 16;
      // 一个「节点图」的意象：两个方块 + 一条连线 + 一个输出圆
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          'data-dsh-panel-entry': PANEL_ID,
        },
        React.createElement('rect', { key: 'n1', x: 1.5, y: 3, width: 4, height: 4, rx: 1 }),
        React.createElement('rect', { key: 'n2', x: 1.5, y: 9, width: 4, height: 4, rx: 1 }),
        React.createElement('path', { key: 'wire', d: 'M5.5 5h3.5M5.5 11h3.5M9 5v6' }),
        React.createElement('circle', { key: 'out', cx: 12.5, cy: 8, r: 2.2 }),
      );
    }

    /**
     * 主面板内容。
     *
     * 只负责「给一个容器 + 管生命周期」，内容交给 panel 模块。
     * 注意 ref 回调必须是语句体的箭头函数：箭头函数直接返回 DOM 会被
     * React 19 当成 cleanup 函数处理（React 18 只会告警）。
     *
     * @returns {HTMLElement}
     */
    function WorkbenchPanel() {
      const [host, setHost] = React.useState(null);

      React.useEffect(() => {
        if (!host) return undefined;
        let disposed = false;
        loadPanel()
          .then((mod) => {
            if (disposed) return;
            mod.ensureStyles();
            mod.mountWorkbench(host);
          })
          .catch((error) => {
            if (disposed) return;
            const box = document.createElement('div');
            box.style.cssText =
              'padding:20px;font:13px/1.6 ui-sans-serif,system-ui;color:var(--dsw-alias-label-danger,#f87171);';
            const title = document.createElement('strong');
            title.textContent = 'Shader 工作台加载失败';
            const detail = document.createElement('pre');
            detail.style.cssText = 'white-space:pre-wrap;margin-top:8px;font-size:12px;';
            detail.textContent = String(error?.stack ?? error?.message ?? error);
            box.append(title, detail);
            host.replaceChildren(box);
          });
        return () => {
          disposed = true;
          if (panelModulePromise) {
            panelModulePromise
              .then((mod) => mod.disposeWorkbench())
              .catch(() => {
                // 模块都没加载上，没什么可卸的
              });
          }
        };
      }, [host]);

      return React.createElement('div', {
        className: 'swb-page',
        'data-dsh-plugin': 'shader-workbench',
        style: { flex: '1 1 auto', minHeight: 0, display: 'flex' },
        ref: (node) => {
          setHost(node);
        },
      });
    }

    /**
     * 挂载：往侧栏塞一行，再往 main 槽位塞一页。
     * @param {object} ctx 客户端根 context
     */
    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function') {
        // 宿主太老或槽位服务没起来：静默退出，不要让插件进入 failed
        return;
      }
      const disposers = [];

      try {
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => 'Shader 工作台',
              },
              WorkbenchIcon,
            ),
          ),
        );
      } catch {
        // 这个宿主没有侧栏行槽位，退化成只有主面板
      }

      try {
        disposers.push(
          slots.inject('main', () =>
            slots.register(
              {
                name: 'main',
                key: PANEL_ID,
              },
              WorkbenchPanel,
            ),
          ),
        );
      } catch {
        // 同上
      }

      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            // 清理异常忽略
          }
        }
      };
    }

    exports.name = 'dsh-shader-workbench';
    exports.inject = inject;
    exports.apply = apply;
    exports.WorkbenchIcon = WorkbenchIcon;
    exports.WorkbenchPanel = WorkbenchPanel;
    return module.exports;
  },
});
