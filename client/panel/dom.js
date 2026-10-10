/**
 * 极简 DOM 构造工具。
 *
 * 为什么不用 React 写工作台内容：
 *   工作台里全是 canvas、拖拽、WebGL 循环这类命令式状态，
 *   套进 React 的 reconcile 只会互相打架（重渲染会把 canvas 干掉）。
 *   所以只在最外层用 React 挂一个容器，里面全部自己管。
 *
 * 只用 document 上的原生 API，不加任何依赖。
 *
 * @module dsh-shader-workbench/client/panel/dom
 */

/**
 * 建元素。
 *
 * 两种调用形式：
 *   h('div.foo', { text: 'x', on: { click } })
 *   h('div.foo', { text: 'x' }, [child1, child2])
 *
 * @param {string} tag 标签名，支持 `div.cls1.cls2` 与 `button#id.cls` 简写
 * @param {object} [props] 属性；特殊键见下
 *   - `class` / `className`：类名，字符串或数组
 *   - `text`：文本内容
 *   - `html`：innerHTML（只在完全可控的静态片段上用）
 *   - `style`：样式对象（`--x` 开头的走 setProperty）
 *   - `dataset`：data-* 映射
 *   - `on`：事件映射，如 `{ click: fn }`
 *   - `children`：子节点数组（也可以走第三个参数）
 *   - 其余键：setAttribute；值为 false/null/undefined 时跳过
 * @param {any[]} [children] 子节点数组，等价于 props.children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = undefined) {
  let name = tag;
  const classes = [];
  let id = '';
  const dot = name.indexOf('.');
  const hash = name.indexOf('#');
  const cut = [dot, hash].filter((i) => i > 0).sort((a, b) => a - b)[0];
  if (cut !== undefined) {
    const rest = name.slice(cut);
    name = name.slice(0, cut);
    for (const part of rest.match(/[.#][A-Za-z0-9_-]+/g) ?? []) {
      if (part[0] === '.') classes.push(part.slice(1));
      else id = part.slice(1);
    }
  }
  const element = document.createElement(name || 'div');
  if (id) element.id = id;

  const {
    class: classProp,
    className,
    text,
    html,
    style,
    dataset,
    on,
    children: childrenProp,
    ref,
    ...rest
  } = props;

  const allClasses = [
    ...classes,
    ...(typeof classProp === 'string' ? [classProp] : Array.isArray(classProp) ? classProp : []),
    ...(typeof className === 'string' ? [className] : Array.isArray(className) ? className : []),
  ].filter(Boolean);
  if (allClasses.length > 0) element.className = allClasses.join(' ');

  if (text !== undefined && text !== null) element.textContent = String(text);
  if (html !== undefined) element.innerHTML = html;

  if (style && typeof style === 'object') {
    for (const [key, value] of Object.entries(style)) {
      if (value === undefined || value === null) continue;
      if (key.startsWith('--')) element.style.setProperty(key, String(value));
      else element.style[key] = value;
    }
  }
  if (dataset && typeof dataset === 'object') {
    for (const [key, value] of Object.entries(dataset)) {
      if (value === undefined || value === null) continue;
      element.dataset[key] = String(value);
    }
  }
  for (const [key, value] of Object.entries(rest)) {
    if (value === false || value === null || value === undefined) continue;
    if (typeof value === 'function') continue;
    // 这三个必须是 DOM 属性，用 setAttribute 不生效
    if (key === 'value' && 'value' in element) {
      element.value = String(value);
      continue;
    }
    if (key === 'checked' && 'checked' in element) {
      element.checked = value === true;
      continue;
    }
    if (key === 'selected' && 'selected' in element) {
      element.selected = value === true;
      continue;
    }
    element.setAttribute(key, value === true ? '' : String(value));
  }
  if (on && typeof on === 'object') {
    for (const [event, handler] of Object.entries(on)) {
      if (typeof handler !== 'function') continue;
      element.addEventListener(event, handler);
    }
  }
  if (ref && typeof ref === 'function') ref(element);
  const kids = children !== undefined ? children : childrenProp;
  if (kids !== undefined && kids !== null) append(element, Array.isArray(kids) ? kids : [kids]);
  return element;
}

/**
 * 批量 append，自动跳过 null / false / undefined 并把非节点转成文本。
 * @param {Element} parent
 * @param {any[]} children
 * @returns {Element}
 */
export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/**
 * 清空并重新填充。
 * @param {Element} parent
 * @param {any[]} children
 * @returns {Element}
 */
export function fill(parent, children) {
  parent.replaceChildren();
  return append(parent, children);
}

/**
 * 一个按钮。
 * @param {string} label
 * @param {() => void} onClick
 * @param {object} [opts] { variant, title, disabled, icon }
 * @returns {HTMLButtonElement}
 */
export function button(label, onClick, opts = {}) {
  const classes = ['swb-btn'];
  if (opts.variant) classes.push(`swb-btn--${opts.variant}`);
  return h('button', {
    class: classes,
    type: 'button',
    title: opts.title ?? label,
    disabled: opts.disabled === true,
    on: { click: onClick },
    children: [opts.icon ? h('span.swb-btn__icon', { text: opts.icon }) : null, h('span.swb-btn__label', { text: label })],
  });
}

/**
 * 一个下拉选择。
 * @param {Array<{value:string,label:string}>|string[]} options
 * @param {string} value
 * @param {(next: string) => void} onChange
 * @param {object} [opts] { title, class }
 * @returns {HTMLSelectElement}
 */
export function select(options, value, onChange, opts = {}) {
  const items = (options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return h(
    'select',
    {
      class: ['swb-select', opts.class].filter(Boolean),
      title: opts.title,
      on: { change: (e) => onChange(e.target.value) },
    },
    items.map((o) =>
      h('option', {
        value: o.value,
        text: o.label,
        selected: o.value === value,
      }),
    ),
  );
}

/**
 * 一行标签 + 控件。
 * @param {string} label
 * @param {Node|Node[]} control
 * @param {object} [opts] { hint }
 * @returns {HTMLElement}
 */
export function field(label, control, opts = {}) {
  return h('label.swb-field', { title: opts.hint }, [
    h('span.swb-field__label', { text: label }),
    ...(Array.isArray(control) ? control : [control]),
  ]);
}

/**
 * 一个带数值显示的滑杆。
 * @param {object} opts { min, max, step, value, onChange, format }
 * @returns {HTMLElement}
 */
export function slider({ min = 0, max = 1, step = 0.001, value = 0, onChange, format }) {
  const readout = h('span.swb-slider__value', { text: format ? format(value) : String(value) });
  const input = h('input.swb-slider__input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    on: {
      input: (e) => {
        const next = Number(e.target.value);
        readout.textContent = format ? format(next) : String(next);
        onChange(next);
      },
    },
  });
  return h('span.swb-slider', {}, [input, readout]);
}

/**
 * 开关。
 * @param {boolean} checked
 * @param {(next: boolean) => void} onChange
 * @returns {HTMLElement}
 */
export function toggle(checked, onChange) {
  return h('input.swb-toggle', {
    type: 'checkbox',
    checked: checked === true,
    on: { change: (e) => onChange(e.target.checked) },
  });
}

/**
 * 小节标题（可折叠）。
 * @param {string} title
 * @param {Node|Node[]} body
 * @param {object} [opts] { open, actions }
 * @returns {HTMLElement}
 */
export function section(title, body, opts = {}) {
  const content = h('div.swb-section__body', {}, Array.isArray(body) ? body : [body]);
  const open = opts.open !== false;
  content.hidden = !open;
  const caret = h('span.swb-section__caret', { text: open ? '▾' : '▸' });
  const header = h('div.swb-section__header', {}, [
    caret,
    h('span.swb-section__title', { text: title }),
    h('span.swb-section__spacer'),
    ...(opts.actions ?? []),
  ]);
  const root = h('div.swb-section', {}, [header, content]);
  header.addEventListener('click', (e) => {
    if (e.target.closest('.swb-btn')) return;
    const next = content.hidden;
    content.hidden = !next;
    caret.textContent = next ? '▾' : '▸';
  });
  return root;
}

/**
 * 空状态提示。
 * @param {string} text
 * @param {Node|Node[]} [extra]
 * @returns {HTMLElement}
 */
export function empty(text, extra = []) {
  return h('div.swb-empty', {}, [h('div.swb-empty__text', { text }), ...(Array.isArray(extra) ? extra : [extra])]);
}

/**
 * 小徽标。
 * @param {string} text
 * @param {string} [tone] info|ok|warn|error|muted
 * @returns {HTMLElement}
 */
export function badge(text, tone = 'info') {
  return h('span', { class: `swb-badge swb-badge--${tone}`, text: String(text ?? '') });
}

/**
 * 一个浮层（用来做右键菜单 / 临时提示）。
 * @param {Node[]} items 已经建好的菜单项
 * @param {number} x
 * @param {number} y
 * @returns {() => void} 关闭函数
 */
export function popup(items, x, y) {
  const root = h('div.swb-popup', { style: { left: `${x}px`, top: `${y}px` } }, items);
  document.body.append(root);
  const close = () => {
    root.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (e) => {
    if (!root.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  // 下一拍再挂，避免触发本次点击
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

/**
 * 一个菜单项。
 * @param {string} label
 * @param {() => void} onClick
 * @param {object} [opts] { disabled, shortcut, tone }
 * @returns {HTMLElement}
 */
export function menuItem(label, onClick, opts = {}) {
  return h('button.swb-menu__item', {
    class: opts.tone ? `swb-menu__item--${opts.tone}` : undefined,
    type: 'button',
    disabled: opts.disabled === true,
    on: {
      click: (e) => {
        e.stopPropagation();
        if (opts.disabled === true) return;
        onClick();
        // 关掉所在浮层
        e.target.closest('.swb-popup')?.remove();
      },
    },
  }, [
    h('span.swb-menu__label', { text: label }),
    opts.shortcut ? h('span.swb-menu__shortcut', { text: opts.shortcut }) : null,
  ]);
}

/** 分隔线。 */
export function divider() {
  return h('div.swb-divider');
}

/**
 * 本地时间戳格式化。
 * @param {string|number|Date} value
 * @returns {string}
 */
export function timeAgo(value) {
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return new Date(then).toLocaleDateString();
}

/**
 * rAF 节流的重绘调度器：同一帧里多次 invalidate 只重画一次。
 */
export class FrameScheduler {
  /**
   * @param {() => void} task
   */
  constructor(task) {
    this.task = task;
    this.handle = 0;
    this.running = false;
    this._tick = this._tick.bind(this);
  }

  /** 请求下一帧重画。 */
  invalidate() {
    if (this.handle) return;
    this.handle = requestAnimationFrame(this._tick);
  }

  /** 启动常驻循环。 */
  start() {
    if (this.running) return;
    this.running = true;
    this.handle = requestAnimationFrame(this._tick);
  }

  /** 停止常驻循环。 */
  stop() {
    this.running = false;
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  /** @param {number} t */
  _tick(t) {
    this.handle = 0;
    this.lastTime = t;
    try {
      this.task(t);
    } finally {
      if (this.running) this.handle = requestAnimationFrame(this._tick);
    }
  }
}
