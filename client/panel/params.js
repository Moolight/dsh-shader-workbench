/**
 * 参数面板：自动解析当前图里用到的 uniform 与节点参数，实时调节。
 *
 * 两类控件：
 *   1. 自定义 uniform（图级 `uniforms[]`）—— 滑杆/颜色选择器
 *   2. 选中节点的参数（节点级 `params`）—— 按参数类型出对应控件
 *
 * 参数一改，立刻回灌给渲染器（不等防抖），所以调节手感是连续的。
 *
 * @module dsh-shader-workbench/client/panel/params
 */

import { button, divider, empty, field, h, select, slider } from './dom.js';
import { getNodeDef } from '../../shared/nodes.js';
import { NODE_LIBRARY } from '../../shared/nodes.js';

/**
 * 参数面板。
 */
export class ParamsPanel {
  /**
   * @param {object} opts
   * @param {() => object} opts.getGraph 取当前图
   * @param {(name: string, value: any, type: string) => void} opts.onUniformChange
   * @param {(nodeId: string, key: string, value: any) => void} opts.onParamChange
   * @param {() => string[]} [opts.getSelectedNodeIds]
   * @param {() => void} [opts.onUniformsChanged] 增删 uniform 后通知外部重建面板
   * @param {(label: string, fn: () => void) => void} [opts.commit] 把一次图结构改动记成一步撤销
   */
  constructor(opts) {
    this.getGraph = opts.getGraph;
    this.onUniformChange = opts.onUniformChange;
    this.onParamChange = opts.onParamChange;
    this.getSelectedNodeIds = opts.getSelectedNodeIds ?? (() => []);
    this.onUniformsChanged = opts.onUniformsChanged ?? (() => {});
    // 默认直接执行：不传 commit 的场合（测试、独立使用）行为不变
    this.commit = opts.commit ?? ((_label, fn) => fn());
    this.root = h('div.swb-params');
    this.render();
  }

  /** 重建整个面板。 */
  render() {
    const graph = this.getGraph();
    const pieces = [];

    pieces.push(this._renderCustomUniforms(graph, pieces));
    pieces.push(divider());
    pieces.push(this._renderNodeParams(graph));

    this.root.replaceChildren(...pieces);
  }

  /** 图级自定义 uniform。 */
  _renderCustomUniforms(graph) {
    const uniforms = Array.isArray(graph?.uniforms) ? graph.uniforms : [];
    const body = [];

    if (uniforms.length === 0) {
      body.push(empty('还没有自定义参数。加一个之后，节点里用「自定义参数」节点就能引用它。'));
    } else {
      for (const uniform of uniforms) {
        body.push(this._uniformRow(graph, uniform));
      }
    }

    body.push(
      h('div.swb-row', {}, [
        button('新增参数', () => {
          const used = new Set(uniforms.map((u) => u.name));
          let name = 'uValue';
          let i = 1;
          while (used.has(name)) {
            name = `uValue${i}`;
            i += 1;
          }
          this.commit('新增参数', () => {
            (this.getGraph().uniforms ??= []).push({ name, type: 'float', value: 0, min: 0, max: 1, ui: 'slider' });
          });
          this.onUniformsChanged();
          this.render();
        }, { variant: 'ghost' }),
      ]),
    );

    return sectionWrap('参数', body, { open: true });
  }

  /** 单个 uniform 的一行。 */
  _uniformRow(graph, uniform) {
    const type = uniform.type ?? 'float';
    const apply = (value, ui) => {
      // 不在这里直接写 uniform.value —— 交给 onUniformChange 一路走到编辑器的
      // _commit，否则「改动前」快照已经含了新值，撤销栈根本认不出这次改动。
      if (ui) uniform.ui = ui;
      this.onUniformChange(uniform.name, value, type);
    };

    const controls = [
      h('input.swb-input.swb-input--name', {
        type: 'text',
        value: uniform.name,
        title: 'uniform 名（必须是合法 GLSL 标识符，改了会同步到引用的节点）',
        on: {
          change: (e) => {
            const next = String(e.target.value).trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(next)) {
              e.target.value = uniform.name;
              return;
            }
            const old = uniform.name;
            // 同步改掉引用了旧名字的 uniform 节点
            this.commit(`重命名参数 ${old} → ${next}`, () => {
              uniform.name = next;
              for (const node of graph.nodes ?? []) {
                if (node.type === 'uniform' && node.params?.name === old) node.params.name = next;
              }
            });
            this.onUniformsChanged();
            this.render();
          },
        },
      }),
      select(
        [
          { value: 'float', label: 'float' },
          { value: 'vec2', label: 'vec2' },
          { value: 'vec3', label: 'vec3' },
          { value: 'vec4', label: 'vec4' },
        ],
        type,
        (next) => {
          this.commit(`改参数类型 ${type} → ${next}`, () => {
            uniform.type = next;
            const size = next === 'float' ? 1 : Number(next.slice(3));
            uniform.value = size === 1 ? 0 : new Array(size).fill(0).map((_, i) => (i === 3 ? 1 : 0));
          });
          this.onUniformsChanged();
          this.render();
        },
        { title: '类型' },
      ),
      button('×', () => {
        this.commit(`删除参数 ${uniform.name}`, () => {
          graph.uniforms = (graph.uniforms ?? []).filter((u) => u !== uniform);
        });
        this.onUniformsChanged();
        this.render();
      }, { variant: 'ghost', title: '删除这个参数' }),
    ];

    let control;
    if (type === 'float') {
      control = slider({
        min: Number.isFinite(uniform.min) ? uniform.min : 0,
        max: Number.isFinite(uniform.max) ? uniform.max : 1,
        step: 0.001,
        value: Number(uniform.value) || 0,
        onChange: (v) => apply(v, 'slider'),
        format: (v) => Number(v).toFixed(3),
      });
    } else {
      const normalized = normalizeVec(uniform.value, type);
      control = h(
        'span.swb-vec',
        {},
        normalized.map((component, index) =>
          h('input.swb-input.swb-input--num', {
            type: 'number',
            step: '0.01',
            value: String(component),
            on: {
              input: (e) => {
                const next = [...normalizeVec(uniform.value, type)];
                next[index] = Number(e.target.value) || 0;
                apply(next);
              },
            },
          }),
        ),
      );
      if (type === 'vec3') {
        control.append(
          h('input.swb-color', {
            type: 'color',
            value: toHex(normalizeVec(uniform.value, type)),
            title: '按颜色拾取（0..1 映射到 0..255）',
            on: {
              input: (e) => {
                apply(hexToRgb(e.target.value));
                this.render();
              },
            },
          }),
        );
      }
    }

    return h('div.swb-uniform', {}, [
      h('div.swb-uniform__head', {}, controls),
      h('div.swb-uniform__control', {}, [control]),
    ]);
  }

  /** 选中节点的参数。 */
  _renderNodeParams(graph) {
    const ids = this.getSelectedNodeIds();
    const nodes = (graph?.nodes ?? []).filter((n) => ids.includes(n.id));
    if (nodes.length === 0) {
      return sectionWrap('节点参数', [empty('在画布上点一个节点，这里就会出现它的参数。')], { open: true });
    }
    if (nodes.length > 1) {
      return sectionWrap(
        '节点参数',
        [empty(`选中了 ${nodes.length} 个节点。单选一个节点才能改参数。`)],
        { open: true },
      );
    }

    const node = nodes[0];
    const def = getNodeDef(node.type);
    if (!def) {
      return sectionWrap('节点参数', [empty(`不认识的节点类型：${node.type}`)], { open: true });
    }
    const entries = Object.entries(def.params ?? {});
    const inner = node.params?.graph;
    const body = [
      h('div.swb-node-head', {}, [
        h('strong', { text: def.title }),
        h('code', { text: node.type }),
      ]),
      def.doc ? h('p.swb-hint', { text: def.doc }) : null,
      // 组是元节点，内部子图内联在 params.graph 里。必须把"怎么展开"写出来 ——
      // 不然用户只会看到一颗改不了参数的节点，然后卡住（这坑踩过）。
      node.type === 'group'
        ? h('p.swb-hint', {
            text:
              `这个组里有 ${inner?.nodes?.length ?? 0} 个节点。` +
              '想在画布上编辑内部：右键这颗节点 →「拆开组」，子图会还原成普通节点。',
          })
        : null,
      node.type === 'custom'
        ? h('p.swb-hint', { text: '表达式会原样拼进 `vec4 x = <表达式>;`，所以只能写单条表达式（循环走 glslPrelude 或展开成多个节点）。' })
        : null,
    ];

    if (entries.length === 0) {
      body.push(empty('这个节点没有可调参数。'));
    } else {
      for (const [key, meta] of entries) {
        body.push(field(meta.label ?? key, this._paramControl(node, key, meta), { hint: `${key} · ${meta.type}` }));
      }
    }

    // 端口缺省值：没接线的输入可以直接在这里改
    const unconnected = def.inputs.filter((p) => !(graph.edges ?? []).some((e) => e.to.node === node.id && e.to.port === p.id));
    if (unconnected.length > 0) {
      body.push(
        h('details.swb-details', {}, [
          h('summary', { text: `未接线的输入缺省值（${unconnected.length}）` }),
          ...unconnected.map((p) =>
            field(
              p.label ?? p.id,
              this._portDefaultControl(node, p),
              { hint: `${p.id} · ${p.type} · 接上线以后这里就不生效了` },
            ),
          ),
        ]),
      );
    }

    return sectionWrap('节点参数', body, { open: true });
  }

  /** 按参数类型出控件。 */
  _paramControl(node, key, meta) {
    const value = node.params?.[key] ?? meta.value;
    const set = (next) => {
      this.onParamChange(node.id, key, next);
      // 表达式类参数不用重建面板，否则输入框会丢焦点
      if (meta.type !== 'text') this.render();
    };

    switch (meta.type) {
      case 'bool':
        return h('input', {
          type: 'checkbox',
          checked: value === true,
          on: { change: (e) => set(e.target.checked) },
        });
      case 'int':
        return h('input.swb-input.swb-input--num', {
          type: 'number',
          step: '1',
          value: String(value ?? 0),
          on: { input: (e) => set(Math.trunc(Number(e.target.value) || 0)) },
        });
      case 'select':
        return select(
          (meta.options ?? []).map((o) => ({ value: o, label: o })),
          String(value ?? meta.options?.[0] ?? ''),
          set,
        );
      case 'text':
        return h('textarea.swb-input.swb-input--code', {
          rows: String(meta.value?.length > 40 ? 4 : 2),
          value: String(value ?? ''),
          spellcheck: 'false',
          on: {
            change: (e) => set(e.target.value),
            blur: (e) => set(e.target.value),
          },
        });
      case 'color': {
        const rgb = normalizeVec(value ?? [1, 0, 0], 'vec3');
        return h('span.swb-vec', {}, [
          h('input.swb-color', {
            type: 'color',
            value: toHex(rgb),
            on: { input: (e) => set(hexToRgb(e.target.value)) },
          }),
          ...rgb.map((component, index) =>
            h('input.swb-input.swb-input--num', {
              type: 'number',
              step: '0.01',
              value: String(component),
              on: {
                input: (e) => {
                  const next = [...normalizeVec(node.params?.[key] ?? [1, 0, 0], 'vec3')];
                  next[index] = Number(e.target.value) || 0;
                  set(next);
                },
              },
            }),
          ),
        ]);
      }
      case 'vec2':
      case 'vec3':
      case 'vec4': {
        const vec = normalizeVec(value, meta.type);
        return h(
          'span.swb-vec',
          {},
          vec.map((component, index) =>
            h('input.swb-input.swb-input--num', {
              type: 'number',
              step: '0.01',
              value: String(component),
              on: {
                input: (e) => {
                  const next = [...normalizeVec(node.params?.[key] ?? vec, meta.type)];
                  next[index] = Number(e.target.value) || 0;
                  set(next);
                },
              },
            }),
          ),
        );
      }
      default: {
        const min = Number.isFinite(meta.min) ? meta.min : 0;
        const max = Number.isFinite(meta.max) ? meta.max : 1;
        return slider({
          min,
          max,
          step: (max - min) / 1000 || 0.001,
          value: Number(value) || 0,
          onChange: set,
          format: (v) => Number(v).toFixed(3),
        });
      }
    }
  }

  /** 未接线端口的缺省值控件。 */
  _portDefaultControl(node, port) {
    const stored = node.params?.__defaults?.[port.id];
    const current = stored !== undefined ? stored : port.def;
    const commit = (next) => {
      // 同样不在这里直接写 —— 让 onParamChange 走到编辑器里入栈，
      // 否则快照已经含新值，这次改动在撤销栈里是隐形的
      this.onParamChange(node.id, '__defaults', { ...(node.params?.__defaults ?? {}), [port.id]: next });
      this.render();
    };
    if (port.type === 'float') {
      return h('input.swb-input.swb-input--num', {
        type: 'number',
        step: '0.01',
        value: String(Number(current) || 0),
        on: { input: (e) => commit(Number(e.target.value) || 0) },
      });
    }
    const vec = normalizeVec(current, port.type);
    return h(
      'span.swb-vec',
      {},
      vec.map((component, index) =>
        h('input.swb-input.swb-input--num', {
          type: 'number',
          step: '0.01',
          value: String(component),
          on: {
            input: (e) => {
              const next = [...normalizeVec(node.params?.__defaults?.[port.id] ?? vec, port.type)];
              next[index] = Number(e.target.value) || 0;
              commit(next);
            },
          },
        }),
      ),
    );
  }

  /**
   * 按名字找节点定义（给外部用）。
   * @param {string} type
   */
  static findDef(type) {
    return NODE_LIBRARY.find((n) => n.type === type);
  }
}

/**
 * 包一个小节壳。
 * @param {string} title
 * @param {any[]} body
 * @param {object} opts
 * @returns {HTMLElement}
 */
function sectionWrap(title, body, opts = {}) {
  const content = h('div.swb-section__body', {}, body);
  const open = opts.open !== false;
  content.hidden = !open;
  const caret = h('span.swb-section__caret', { text: open ? '▾' : '▸' });
  const header = h('div.swb-section__header', {}, [
    caret,
    h('span.swb-section__title', { text: title }),
  ]);
  const root = h('div.swb-section', {}, [header, content]);
  header.addEventListener('click', () => {
    const next = content.hidden;
    content.hidden = !next;
    caret.textContent = next ? '▾' : '▸';
  });
  return root;
}

/**
 * 把任意值补成对应长度的数字数组。
 * @param {any} value
 * @param {string} type float|vec2|vec3|vec4
 * @returns {number[]}
 */
export function normalizeVec(value, type) {
  const size = type === 'float' ? 1 : Number(String(type).slice(3)) || 1;
  const arr = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
  return Array.from({ length: size }, (_, i) => {
    const fallback = size === 4 && i === 3 ? 1 : 0;
    const v = Number(arr[i]);
    return Number.isFinite(v) ? v : fallback;
  });
}

/**
 * 0..1 的 rgb → #rrggbb。
 * @param {number[]} rgb
 * @returns {string}
 */
export function toHex(rgb) {
  const channel = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  return `#${[rgb[0], rgb[1], rgb[2]].map((v) => channel(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * #rrggbb → 0..1 的 rgb。
 * @param {string} hex
 * @returns {number[]}
 */
export function hexToRgb(hex) {
  const text = String(hex).replace('#', '');
  if (text.length !== 6) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(text.slice(i, i + 2), 16) / 255);
}
