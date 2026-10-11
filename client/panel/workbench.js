/**
 * 工作台主控制器：把编辑器 / 预览 / 参数 / 资源 / 诊断串起来。
 *
 * 数据流（单向，好追）：
 *   编辑器改图 → HotReload（防抖 120ms）→ renderer.setGraph → GLSL 重编译并热替换
 *   参数改动   → 立即 renderer.setUniform → 下一帧生效（不走防抖，手感才连续）
 *   编译结果   → 诊断面板 + 状态栏
 *
 * @module dsh-shader-workbench/client/panel/workbench
 */

import { badge, button, divider, empty, h, select, slider } from './dom.js';
import { NodeEditor } from './editor.js';
import { ParamsPanel } from './params.js';
import { ResourceBrowser, messageOf } from './resources.js';
import { ShaderToy } from '../runtime/shadertoy.js';
import { HotReload, normalizeErrors } from '../runtime/hotreload.js';
import { UnlitMaterialPreview, PREVIEW_SHAPES } from '../runtime/material-preview.js';
import { compileGraph } from '../runtime/codegen.js';
import { makeGraph } from '../../shared/graph.js';
import { setUserNodes } from '../../shared/nodes.js';
import { LyricsOverlay } from './lyrics.js';
import { bindAssets } from './asset-binder.js';
/** API 前缀。 */
const API_PREFIX = '/plugins/dsh-shader-workbench/';

/** 开源仓库地址（导航按钮用；和 package.json 里的 repository 是同一份事实）。 */
const REPO_URL = 'https://github.com/Moolight/dsh-shader-workbench';

/**
 * 这些改动只影响画布长相、不影响生成的 GLSL，所以不用重编译也不用重画参数面板。
 *
 * 分组框 / 注释是编辑器层的装饰件，压根不进代码生成；挪节点只改坐标。
 * 漏一个在这里的代价是「拖一下框，整个右侧闪一下」——不致命但很廉价地烦人。
 */
const GRAPH_ONLY_VISUAL_REASONS = new Set([
  'move-node',
  'move-frame',
  'resize-frame',
  'add-frame',
  'delete-frame',
  'update-frame',
]);

/**
 * 一个"打开外部链接"的按钮。
 *
 * 用 `window.open(url, '_blank', 'noopener,noreferrer')` —— DSH 自己的聊天界面
 * 也是这么开外链的，所以在桌面壳和网页壳里都能用。别改成 `<a href>` 不带 target：
 * 那样会把整个工作台导航走。
 *
 * @param {string} label
 * @param {string} url
 * @param {string} [title]
 */
function linkButton(label, url, title) {
  return button(label, () => window.open(url, '_blank', 'noopener,noreferrer'), {
    variant: 'ghost',
    title: title ?? url,
  });
}

/**
 * 工作台。
 */
export class Workbench {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiBase] API 基址，缺省同源相对路径
   */
  constructor(opts = {}) {
    this.apiBase = opts.apiBase ?? API_PREFIX;
    this.current = { project: '', material: '' };
    this.graph = makeGraph({ passes: [{ name: 'image', graph: [] }] });
    this.dirty = false;
    this.mode = 'shader'; // shader | material
    this.shape = 'sphere';
    this.disposed = false;
    this.logs = [];

    this.root = h('div.swb');
    this._build();
    // 焦点在工作台里（画布 / 滑杆 / 按钮…）时 Ctrl+Z 都能用，出了工作台不管
    this.root.addEventListener('keydown', (e) => this._onRootKeyDown(e));
  }

  // ─────────────────────── 搭建 ───────────────────────

  /** 建整体 DOM 骨架。 */
  _build() {
    // 预览
    this.previewCanvas = h('canvas.swb-preview__canvas', { tabindex: '0' });
    this.previewStats = h('div.swb-preview__stats');
    this.previewError = h('div.swb-preview__error');
    this.previewError.hidden = true;
   // 歌词叠加层：自包含组件，这里只负责实例化 + 接线
    this.lyrics = new LyricsOverlay({
      getAudio: () => this._audio,
      onLog: (text, tone) => this.log(text, tone),
    });
    // 编辑器
    this.editor = new NodeEditor({
      graph: this.graph,
      pass: 'image',
      onChange: (graph, meta) => this._onGraphChange(graph, meta),
    });
    this.editor.onNodeDoubleClick = (node) => this._focusNode(node);
    // 节点库右上角那个 ⟳：用户节点写在 <工作区>/library/nodes/，
    // 内置节点源码也在改 —— 都不该逼用户重启 DSH
    this.editor.onReloadNodes = () => this.refreshNodeLibrary({ builtin: true });

    // 参数
    this.params = new ParamsPanel({
      getGraph: () => this.graph,
      getSelectedNodeIds: () => [...this.editor.selection],
      onUniformChange: (name, value, type) => this._applyUniform(name, value, type),
      onParamChange: (nodeId, key, value) => this._applyNodeParam(nodeId, key, value),
      onUniformsChanged: () => this._onUniformsChanged(),
      // 增删/改名 uniform 也算一步撤销
      commit: (label, fn) => this.editor.commitGraph(label, fn),
    });

    // 资源
    this.resources = new ResourceBrowser({
      call: (action, args) => this.call(action, args),
      getCurrent: () => this.current,
      handlers: {
        onOpen: (project, material) => this.openMaterial(project, material),
        onSaveTo: (project, material) => this.saveMaterial(project, material),
        onRestored: (project, material) => this.openMaterial(project, material),
        onImportTexture: (project, material, file, slot) => this.importTexture(project, material, file, slot),
        onImportedShader: (project, material, name, text) => this.storeImportedShader(project, material, name, text),
        onWorkspaceChanged: (root) =>
          this.log(`存储位置已切到 ${root}。当前打开的材质仍来自旧目录，要挪过来就重新存一次。`, 'ok'),
        // 载入示例可能把示例自带的用户节点装进工作区（ifsTunnel / fourierSeries…），
        // 面板这边必须跟着同步一次，否则本地节点库里没有它，一打开就报「不认识的节点类型」
        onNodeLibraryChanged: () => this.refreshNodeLibrary(),
      },
    });

    // 诊断
    this.diagnostics = h('div.swb-diag');
    this.codeView = h('pre.swb-code', { text: '// 图改了以后这里会显示生成的 GLSL' });

    this.statusBar = h('div.swb-status');

    this.root.append(
      h('div.swb-bar', {}, [
        h('span.swb-bar__title', { text: 'Shader 工作台' }),
        h('span.swb-bar__name', { text: '（未打开材质）' }),
        h('span.swb-bar__spacer'),
        button('存图', () => this.saveMaterial(), { variant: 'primary', title: 'Ctrl+S' }),
        (this._snapshotBtn = button('快照', () => this.snapshot())),
        (this._exportBtn = button('导出 GLSL', () => this.exportShader())),
        button('插入示例', () => this.editor.insertTemplate('plasma'), { variant: 'ghost' }),
        button('适应视图', () => this.editor.fitView(), { variant: 'ghost' }),
        h('span.swb-bar__sep'),
        // 仓库 / 问题导航：DSH 的聊天界面自己也是用 window.open 开外链的，照做
        linkButton('仓库', REPO_URL, '打开 GitHub 仓库'),
        linkButton('问题', `${REPO_URL}/issues`, '查看 / 提 issue'),
      ]),
      h('div.swb-cols', {}, [
        // 左列：资源 + 参数
        h('div.swb-col.swb-col--left', {}, [
          h('div.swb-scroll', {}, [this.resources.root]),
          divider(),
          h('div.swb-scroll', {}, [this.params.root]),
        ]),
        // 中列：编辑器 + 预览
        h('div.swb-col.swb-col--center', {}, [
          h('div.swb-stage', {}, [
            this.editor.root,
            this._previewPanel(),
          ]),
        ]),
        // 右列：诊断 + 代码
        h('div.swb-col.swb-col--right', {}, [
          h('div.swb-scroll', {}, [this.diagnostics, divider(), this.codeView]),
        ]),
      ]),
      this.statusBar,
    );

    this._materialLabelEl = this.root.querySelector('.swb-bar__name');
    this._buildDiagnostics();
  }

  /** 预览面板。 */
  _previewPanel() {
    const playBtn = button('暂停', () => this._togglePlay(), { variant: 'ghost' });
    this._playBtn = playBtn;

    const modeSelect = select(
      [
        { value: 'shader', label: '全屏 Shader' },
        { value: 'material', label: '材质网格' },
      ],
      this.mode,
      (next) => this._setMode(next),
      { title: '预览模式' },
    );

    const shapeSelect = select(
      PREVIEW_SHAPES.map((s) => ({ value: s, label: shapeLabel(s) })),
      this.shape,
      (next) => {
        this.shape = next;
        this.materialPreview?.setShape(next);
      },
      { title: '预览网格' },
    );
    this._shapeSelect = shapeSelect;

    this.speedSlider = slider({
      min: 0,
      max: 4,
      step: 0.01,
      value: 1,
      onChange: (v) => {
        if (!this.renderer) return;
        this.renderer.config.speed = v;
      },
      format: (v) => `${Number(v).toFixed(2)}×`,
    });

    this.qualitySelect = select(
      [
        { value: '0.5', label: '0.5× 省电' },
        { value: '1', label: '1× 正常' },
        { value: '1.5', label: '1.5× 清晰' },
        { value: '2', label: '2× 极致' },
      ],
      '1',
      (next) => {
        if (!this.renderer) return;
        this.renderer.config.scale = Number(next);
      },
      { title: '渲染分辨率倍率' },
    );

    return h('div.swb-preview', {}, [
      h('div.swb-preview__head', {}, [
        modeSelect,
        shapeSelect,
        playBtn,
        button('截图', () => this._capture(), { variant: 'ghost' }),
        button('载入音频', () => this._importAudio(), { variant: 'ghost', title: '选一个本地音频复制进材质并接上 iChannel0' }),
        button('播放/暂停', () => this._toggleAudio(), { variant: 'ghost' }),
         button('载入歌词', () => this._importLyric(), { variant: 'ghost' }),
        h('span.swb-bar__spacer'),
        h('span.swb-preview__label', { text: '速度' }),
        this.speedSlider,
        this.qualitySelect,
      ]),
        h('div.swb-preview__stage', {}, [this.previewCanvas, this.lyrics.root, this.previewError]),
      h('div.swb-preview__foot', {}, [this.previewStats]),
    ]);
  }

  async _playAudioFile(file) {
    this._audio?.pause();
    const audio = new Audio(URL.createObjectURL(file));
    audio.loop = true;
    audio.crossOrigin = 'anonymous';
    this._audio = audio;
    try {
      await audio.play();
      await this.renderer?.attachAudio('iChannel0', audio, { fftSize: 2048, smoothing: 0.8 });
      this.log(`已接上音频 ${file.name} → iChannel0（y=0 频谱 / y=1 波形）`, 'ok');
    } catch (error) {
      this.log(`接音频失败：${messageOf(error)}（浏览器要求先点页面再播放）`, 'error');
    }
  }

  _toggleAudio() {
    if (!this._audio) return this.log('还没载入音频', 'error');
     this.log(`音频状态：paused=${this._audio.paused} readyState=${this._audio.readyState} src=${this._audio.src}`, 'info');
     if (this._audio.paused) {
      this._audio.play().then(
        () => this.log(`播放已启动（${this._audio.src.split('/').pop()}）`, 'ok'),
        (error) => this.log(`播放被拒：${error.name} - ${error.message}`, 'error'),
      );
    } else {
      this._audio.pause();
      this.log('已暂停', 'info');
    }
  }

  /** 诊断面板骨架。 */
  _buildDiagnostics() {
    this.diagList = h('div.swb-diag__list');
    this.diagnostics.replaceChildren(
      h('div.swb-diag__head', {}, [
        h('strong', { text: '诊断' }),
        button('清空日志', () => {
          this.logs = [];
          this._renderDiagnostics();
        }, { variant: 'ghost' }),
      ]),
      this.diagList,
    );
    this._renderDiagnostics();
  }

  // ─────────────────────── 生命周期 ───────────────────────

  /**
   * 挂载到容器：建渲染器、启动循环。
   * @param {HTMLElement} host
   */
  mount(host) {
    host.replaceChildren(this.root);
    this._initRenderer();
    // 节点库与 Pass 标签要等 DOM 建好之后显式渲染一次
    // （编辑器自己是懒的，不在构造里碰 DOM，方便单测）
    this.editor.renderLibrary('');
    this.editor.syncPassTabs();
    this.editor.invalidate();
    this.editor.fitView();
    // 拉一次节点库状态：用户节点是宿主从 <工作区>/library/nodes/ 读出来的，
    // 面板这边也要把它们装进自己的注册表，两边才一致（不用重启）
    void this.refreshNodeLibrary();
  }

  /**
   * 同步节点库。
   *
   * 这是我们想要的效果：**加一个节点不需要重启任何东西** ——
   * 用户节点写在 `<工作区>/library/nodes/*.json`，宿主按目录签名变化重读，
   * 面板点一下这里（或重开面板）就跟上。`builtin: true` 还会让宿主重新 import
   * 插件的 `shared/nodelib.js`，连改内置节点源码都不用重启进程。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.builtin] 是否连内置库一起热重载
   */
  async refreshNodeLibrary({ builtin = false } = {}) {
    try {
      const status = await this.call('nodelib.reload', { builtin });
      setUserNodes(Array.isArray(status.userDefs) ? status.userDefs : []);
      this.editor.renderLibrary(this.editor.libraryFilter ?? '');
      const userCount = Array.isArray(status.user) ? status.user.length : 0;
      this.log(
        `节点库已同步：共 ${status.total} 个（内置 ${status.builtin}，用户 ${userCount}）${builtin ? '，内置库已热重载' : ''}`,
        'ok',
      );
      for (const problem of status.errors ?? []) {
        this.log(`用户节点 ${problem.source}：${problem.message}`, 'error');
      }
    } catch (error) {
      this.log(`同步节点库失败：${messageOf(error)}`, 'error');
    }
  }

  /** 建 WebGL 渲染器与热重载控制器。 */
  _initRenderer() {
    try {
      this.renderer = new ShaderToy(this.previewCanvas, { scale: 1, speed: 1 });
    } catch (error) {
      this._showPreviewError(`WebGL2 初始化失败：${messageOf(error)}`);
      return;
    }
    this.renderer.onError = (info) => this.log(`${info.pass ?? 'renderer'}: ${info.log}`, 'error');
    this.detachMouse = this.renderer.attachMouse();

    this.hotreload = new HotReload({
      renderer: this.renderer,
      graph: this.graph,
      debounceMs: 120,
    });
    this.hotreload.events.on('compile:done', (payload) => {
      this._clearPreviewError();
      this.log(`热重载完成，用时 ${payload.durationMs.toFixed(1)} ms`, 'ok');
      this._renderDiagnostics();
      this._updateCodeView();
    });
    this.hotreload.events.on('compile:failed', (payload) => {
      const errors = normalizeErrors({ errors: payload.errors });
      // 空图不是错误，是「还没开始画」。给一句提示就够了，别一打开就红一片。
      const onlyEmpty = errors.length > 0 && errors.every((e) => e.code === 'empty-pass');
      if (onlyEmpty) {
        this._showPreviewHint('这个 Pass 还是空的 —— 从左边节点库拖一个节点进来，或者点顶栏「插入示例」');
        this._renderDiagnostics();
        return;
      }
      for (const err of errors) this.log(`${err.pass ? `${err.pass}: ` : ''}${err.message}`, 'error');
      this._showPreviewError(errors.map((e) => e.message).join('\n'));
      this._renderDiagnostics();
    });

    this.renderer.start();
    this.hotreload.reloadNow();
  }

  /** 建材质预览器（第一次切到材质模式时才建）。 */
  _ensureMaterialPreview() {
    if (this.materialPreview) return this.materialPreview;
    try {
      const canvas = h('canvas.swb-preview__canvas');
      this.materialCanvas = canvas;
      this.materialPreview = new UnlitMaterialPreview(canvas, { surfaceRenderer: this.renderer, shape: this.shape });
      this.materialPreview.setShape(this.shape);
    } catch (error) {
      this._showPreviewError(`材质预览初始化失败：${messageOf(error)}`);
      return null;
    }
    return this.materialPreview;
  }

  /** 换预览模式。 */
  _setMode(mode) {
    this.mode = mode;
    const stage = this.previewCanvas.parentElement;
    if (mode === 'material') {
      const preview = this._ensureMaterialPreview();
      if (!preview) return;
       stage.replaceChildren(this.materialCanvas, this.lyrics.root, this.previewError);
      if (this._shapeSelect) this._shapeSelect.disabled = false;
    } else {
      stage.replaceChildren(this.previewCanvas, this.lyrics.root, this.previewError);
      if (this._shapeSelect) this._shapeSelect.disabled = true;
    }
    this._startLoop();
  }

  /** 启一个统一的渲染循环，管两个 canvas。 */
  _startLoop() {
    if (this._loopHandle) return;
    const tick = (t) => {
      if (this.disposed) return;
      const dt = this._lastTick ? Math.min(0.1, (t - this._lastTick) / 1000) : 0;
      this._lastTick = t;
      try {
        if (this.mode === 'material' && this.materialPreview) this.materialPreview.render(dt);
      } catch (error) {
        this._showPreviewError(`材质预览渲染出错：${messageOf(error)}`);
      }
       this.lyrics.update();   // ← 加这行
      const stats = this.renderer?.stats();
      if (stats) {
        this.previewStats.textContent = `iTime ${stats.time.toFixed(2)}s · 第 ${stats.frame} 帧 · Pass [${stats.passes.join(', ') || '无'}] · ${stats.size.width}×${stats.size.height}${stats.channels.length > 0 ? ` · 通道 [${stats.channels.join(', ')}]` : ''}`;
      }
      this._loopHandle = requestAnimationFrame(tick);
    };
    this._loopHandle = requestAnimationFrame(tick);
  }

  /** 暂停/继续。 */
  _togglePlay() {
    if (!this.renderer) return;
    this.renderer.config.playing = !this.renderer.config.playing;
    this._playBtn.querySelector('.swb-btn__label').textContent = this.renderer.config.playing ? '暂停' : '继续';
  }

  /** 截图。 */
  _capture() {
    const canvas = this.mode === 'material' && this.materialCanvas ? this.materialCanvas : this.previewCanvas;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const link = h('a', { href: dataUrl, download: `${this.current.material || 'shader'}-${Date.now()}.png` });
      document.body.append(link);
      link.click();
      link.remove();
      this.log('已下载截图');
    } catch (error) {
      this._showPreviewError(`截图失败：${messageOf(error)}`);
    }
  }

  // ─────────────────────── 图变更 ───────────────────────

  /**
   * 编辑器改了图。
   * @param {object} graph
   * @param {object} meta
   */
  _onGraphChange(graph, meta) {
    this.graph = graph;
    this.dirty = true;
    this._markDirty();
    // 只动画面不动语义的操作（挪节点、拖/改分组框与注释）不用重编译，
    // 连参数面板都不用重画 —— 不然拖一下分组框整个右侧就闪一次。
    if (GRAPH_ONLY_VISUAL_REASONS.has(meta?.reason)) {
      this._updateStatus();
      return;
    }
    this.params.render();
    this.hotreload?.invalidate(graph, { uniforms: this._uniformValues() });
    this._updateStatus();
  }

  /** 参数面板增删 uniform 后需要重编译（声明变了）。 */
  _onUniformsChanged() {
    this.dirty = true;
    this._markDirty();
    this.hotreload?.invalidate(this.graph, { uniforms: this._uniformValues() });
    this.params.render();
  }

  /**
   * 改自定义 uniform：立即生效，不走防抖。
   * @param {string} name
   * @param {any} value
   * @param {string} type
   */
  _applyUniform(name, value, type) {
    const uniform = (this.graph.uniforms ?? []).find((u) => u.name === name);
    if (!uniform) return;
    // 和图里那份值同步（并存进撤销栈）。以前只塞给 renderer：
    // 值不会随存盘落盘，撤销一次还会被上一步快照悄悄带回旧值。
    if (this.editor && this.editor.graph === this.graph) this.editor.setUniformValue(name, value);
    else uniform.value = value;
    this.renderer?.setUniform(name, value, type);
    this.dirty = true;
    this._markDirty();
    this._updateStatus();
  }

  /**
   * 改节点参数：立即重编译（结构可能变了，比如 outType）。
   * @param {string} nodeId
   * @param {string} key
   * @param {any} value
   */
  _applyNodeParam(nodeId, key, value) {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // 走编辑器的 setParam：参数改动也进撤销栈。
    // silent —— 否则 editor 会 emit → 这里 params.render() → 正在拖的滑杆被换掉，手感直接断。
    if (this.editor && this.editor.graph === this.graph) this.editor.setParam(nodeId, key, value, { silent: true });
    else node.params = { ...node.params, [key]: value };
    this.dirty = true;
    this._markDirty();
    // 端口类型/通道这类改动会影响生成的声明，必须整体重编译
    this.hotreload?.invalidate(this.graph, { uniforms: this._uniformValues() });
    this._updateStatus();
  }

  /**
   * 工作台范围内的快捷键。
   *
   * 画布自己有 `_onKeyDown`，但焦点在参数面板的滑杆上时它收不到事件 ——
   * 事件从聚焦元素往上冒，冒到 `this.root` 为止，正好是我们要的范围：
   * 焦点在工作台里才响应，焦点在聊天框里不抢。
   *
   * @param {KeyboardEvent} e
   */
  _onRootKeyDown(e) {
    // 画布已经处理过（它 preventDefault 了），别撤两次
    if (e.defaultPrevented) return;
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      if (this.editor.undo()) e.preventDefault();
      return;
    }
    if ((key === 'z' && e.shiftKey) || key === 'y') {
      if (this.editor.redo()) e.preventDefault();
    }
  }

  /** 取所有 uniform 的当前值。 */
  _uniformValues() {
    const out = {};
    for (const uniform of this.graph.uniforms ?? []) {
      out[uniform.name] = uniform.value;
    }
    return out;
  }

  // ─────────────────────── 材质读写 ───────────────────────

  /**
   * 调 Host API。
   * @param {string} action
   * @param {object} [args]
   * @returns {Promise<any>}
   */
  async call(action, args = {}) {
    const response = await fetch(`${this.apiBase}api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Host 返回了非 JSON（HTTP ${response.status}）`);
    }
    if (!payload || payload.ok !== true) {
      const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      error.code = payload?.error?.code;
      throw error;
    }
    return payload;
  }

  /**
   * 打开一个材质。
   * @param {string} project
   * @param {string} material
   */
  async openMaterial(project, material) {
    try {
      const data = await this.call('material.read', { project, material });
      this.current = { project, material };
      this.graph = data.graph;
      this.editor.setGraph(this.graph, this.graph.passes?.[0]?.name ?? 'image');
      this.params.render();
      if (this.renderer) {
        this.renderer.setUniforms(this._uniformValues());
        this.hotreload?.invalidate(this.graph, { uniforms: this._uniformValues() });
      }
      this.dirty = false;
      this._markClean();
      this._materialLabelEl.textContent = `${project} / ${material}`;
      this.log(`已打开 ${project}/${material}（${this.graph.nodes.length} 节点）`);
      await this._loadMaterialAssets(project, material);
      this._updateStatus();
    } catch (error) {
      this.log(`打开失败：${messageOf(error)}`, 'error');
    }
  }

  /**
   * 存图。
   * @param {string} [project]
   * @param {string} [material]
   */
  async saveMaterial(project = this.current.project, material = this.current.material) {
    if (!project || !material) {
      const p = window.alert('保存到项目（留空则新建）');
      if (!p) return;
      const m = window.alert('材质名');
      if (!m) return;
      project = p.trim();
      material = m.trim();
      try {
        await this.call('material.create', { project, name: material });
      } catch {
        // 已存在就继续
      }
    }
    // 存之前先把 __defaults 合并进端口缺省值，保证生成器读到的是用户改过的值
    const graph = this._withPortDefaults();
    try {
      await this.call('material.save', { project, material, graph });
      this.current = { project, material };
      this.graph = graph;
      // 存盘只是把 __defaults 拍平进图，不该把用户的撤销历史清掉
      this.editor.setGraph(graph, this.editor.pass, { keepHistory: true });
      this.dirty = false;
      this._markClean();
      this._materialLabelEl.textContent = `${project} / ${material}`;
      await this.resources.reload();
      this.log(`已保存 ${project}/${material}`, 'ok');
      this._updateStatus();
    } catch (error) {
      this.log(`保存失败：${messageOf(error)}`, 'error');
    }
  }

  /**
   * 把节点上的 `params.__defaults` 落到端口定义里。
   *
   * 为什么要这一步：端口缺省值存在节点库定义上（只读），
   * 用户改的是节点实例的一份覆盖表。存盘前把它固化进 node.params，
   * 生成器才知道该用哪个值。
   * @returns {object} 处理过的图的深拷贝
   */
  _withPortDefaults() {
    const graph = JSON.parse(JSON.stringify(this.graph));
    for (const node of graph.nodes ?? []) {
      if (node.params?.__defaults === undefined) continue;
      node.paramDefaults = { ...(node.paramDefaults ?? {}), ...node.params.__defaults };
      delete node.params.__defaults;
    }
    return graph;
  }

  /** 打快照。 */
  async snapshot() {
    if (!this.current.project || !this.current.material) {
      this.log('先打开一个材质再打快照', 'error');
      return;
    }
    try {
      const result = await this.call('material.snapshot', {
        project: this.current.project,
        material: this.current.material,
        label: 'panel',
      });
      this.log(`已打快照 ${result.id}`, 'ok');
    } catch (error) {
      this.log(`打快照失败：${messageOf(error)}`, 'error');
    }
  }

  /** 导出 GLSL：把生成结果下载下来。 */
  exportShader() {
    const passName = this.editor.pass;
    const compiled = compileGraph(this.graph, passName, { uniforms: this._uniformValues() });
    if (!compiled.ok) {
      this.log(`导出失败，图还没编译通过：${compiled.errors.map((e) => e.message).join('；')}`, 'error');
      return;
    }
    const name = `${this.current.material || 'shader'}.${passName}.frag`;
    const blob = new Blob([compiled.code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    this.log(`已导出 ${name}`, 'ok');
  }

  /**
   * 导入纹理：浏览器里没有文件绝对路径，所以走「读成 base64 → 交给 Host 落盘」不现实，
   * 这里改走让用户填路径的方式（DSH 是本地桌面应用，路径是可达的）。
   * 真正的拖拽上传留给后续版本。
   * @param {string} project
   * @param {string} material
   * @param {File} file
   * @param {string} slot
   */
  async importTexture(project, material, file, slot) {
    const path = window.alert(
      `浏览器拿不到文件绝对路径。\n请填「${file.name}」在磁盘上的完整路径：`,
      `D:\\`,
    );
    if (!path) return;
    try {
      const result = await this.call('asset.import', { project, material, type: 'texture', sourcePath: path.trim(), slot });
      this.log(`已导入纹理 ${result.asset.path} → ${result.asset.slot}`, 'ok');
      await this.resources.reload();
    } catch (error) {
      this.log(`导入纹理失败：${messageOf(error)}`, 'error');
    }
  }

  /**
   * 存下「导入材质文件」里选的 GLSL 正文。
   *
   * 以前这里只往诊断里写一句「尚未接入预览」就把内容丢了 —— 那是面板里唯一
   * 真正没实现的动作。现在正文会落进材质目录（走 `shader.write`）；
   * 同时照实说明：**预览只认节点图生成的代码，这份 .frag 不参与预览。**
   *
   * @param {string} project
   * @param {string} material
   * @param {string} name
   * @param {string} text
   */
  async storeImportedShader(project, material, name, text) {
    try {
      const result = await this.call('shader.write', { project, material, name, text });
      this.log(`已存入 ${result.name}（${result.bytes} 字符）。注意：预览只认节点图生成的代码，这份文件不参与预览。`, 'ok');
      await this.resources.reload();
    } catch (error) {
      this.log(`导入 GLSL 失败：${messageOf(error)}`, 'error');
    }
  }

  /** 选中节点时把参数面板滚过去。 */
  _focusNode(node) {    this.params.render();
    this.log(`选中节点 ${node.id}（${node.type}）`);
  }


    /**
   * 从材质里读歌词，塞进叠加层。
   *
   * 没绑定或文件丢了就清空歌词层——**不报错**，因为「这个材质没配歌词」
   * 是正常状态，不是失败。
   *
   * @param {string} project
   * @param {string} material
   */
  async _loadMaterialAssets(project, material) {
 // 先卸载旧的
  this._assetsDispose?.();
  this._assetsDispose = null;
  this._audio?.pause();
  this._audio = null;
  this.lyrics?.clear();

  try {
    const { resources } = await this.call('asset.list', { project, material });
    this._assetsDispose = await bindAssets(this, {
      project,
      material,
      resources,
      apiBase: this.apiBase,
    });
  } catch (error) {
    this.log(`加载资源失败：${messageOf(error)}`, 'error');
  }
  }

    _importAudio() {
    const input = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      // Electron 的 File 对象带 .path；浏览器里没有，那就退回让用户填
      const sourcePath = file.path;
      if (!sourcePath) {
        this.log('浏览器环境拿不到文件路径，请在 Electron 面板里操作', 'error');
        return;
      }
      try {
        await this.call('asset.import', {
          project: this.current.project,
          material: this.current.material,
          type: 'audio',
          sourcePath,
        });
        this.log(`音频已存入 ${this.current.material}/`, 'ok');
        await this._loadMaterialAssets(this.current.project, this.current.material);
      } catch (error) {
        this.log(`导入音频失败：${messageOf(error)}`, 'error');
      }
    });
    input.click();
  }
  /**
   * 载入歌词：读文件 → 立刻生效 → 有打开的材质就顺手存进去。
   *
   * 「立刻生效」和「存进材质」是两件事：前者保证用户选完文件马上能看到效果，
   * 后者只在有打开材质时才发生。没打开材质就是纯预览，不落盘。
   */
  _importLyric() {
    const input = h('input', {
      type: 'file',
      accept: '.lrc,.txt,text/plain',
      style: { display: 'none' },
    });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;

      let text;
      try {
        text = await file.text();
      } catch (error) {
        this.log(`读歌词文件失败：${messageOf(error)}`, 'error');
        return;
      }

      // 先让用户在预览里看到效果
      const lines = this.lyrics.loadText(text, file.name);
      if (lines === 0) return;

      // 有打开的材质才持久化
      if (!this.current.project || !this.current.material) {
        this.log('没有打开的材质，歌词只在本次会话生效', 'info');
        return;
      }
      try {
        await this.call('lyric.import', {
          project: this.current.project,
          material: this.current.material,
          content: text,
        });
        this.dirty = true;
        this._markDirty();
        this.log(`歌词已存进 ${this.current.material}/lyric.lrc`, 'ok');
      } catch (error) {
        this.log(`歌词存盘失败（已临时载入）：${messageOf(error)}`, 'error');
      }
    });
    input.click();
  }

  // ─────────────────────── 诊断 / 状态 ───────────────────────

  /**
   * 记一条日志。
   * @param {string} text
   * @param {'info'|'ok'|'error'} [tone]
   */
  log(text, tone = 'info') {
    this.logs.unshift({ text, tone, at: new Date().toISOString() });
    if (this.logs.length > 120) this.logs.length = 120;
    this._renderDiagnostics();
  }

  /** 重画诊断列表。 */
  _renderDiagnostics() {
    if (this.logs.length === 0) {
      this.diagList.replaceChildren(empty('还没有日志。改一下节点或参数就会出东西。'));
      return;
    }
    this.diagList.replaceChildren(
      ...this.logs.map((entry) =>
        h('div.swb-log', { dataset: { tone: entry.tone } }, [
          h('span.swb-log__time', { text: new Date(entry.at).toLocaleTimeString() }),
          h('span.swb-log__text', { text: entry.text }),
        ]),
      ),
    );
  }

  /** 更新生成的代码视图。 */
  _updateCodeView() {
    const passName = this.editor.pass;
    const compiled = compileGraph(this.graph, passName, { uniforms: this._uniformValues() });
    this.codeView.textContent = compiled.ok ? compiled.code : `// 编译未通过：\n${compiled.errors.map((e) => `// ${e.message}`).join('\n')}`;
  }

  /** 显示预览错误浮层。 */
  _showPreviewError(text) {
    this.previewError.hidden = false;
    this.previewError.dataset.tone = 'error';
    this.previewError.textContent = text;
  }

  /** 显示预览提示（不是错误）。 */
  _showPreviewHint(text) {
    this.previewError.hidden = false;
    this.previewError.dataset.tone = 'hint';
    this.previewError.textContent = text;
  }

  /** 清掉错误浮层。 */
  _clearPreviewError() {
    this.previewError.hidden = true;
    this.previewError.textContent = '';
    delete this.previewError.dataset.tone;
  }

  /** 更新底部状态栏。 */
  _updateStatus() {
    const passName = this.editor.pass;
    const metrics = this.hotreload?.metrics;
    this.statusBar.replaceChildren(
      h('span', { text: `${this.current.project || '（未打开项目）'}${this.current.material ? ` / ${this.current.material}` : ''}` }),
      badge(this.dirty ? '有未保存改动' : '已保存', this.dirty ? 'warn' : 'ok'),
      h('span', { text: `Pass ${passName}` }),
      h('span', { text: `${this.graph.nodes?.length ?? 0} 节点` }),
      metrics
        ? h('span', {
            text: `热重载 ${metrics.reloads} 次 / 失败 ${metrics.failures} 次 / 上次 ${metrics.lastDurationMs.toFixed(1)} ms`,
          })
        : null,
      h('span.swb-bar__spacer'),
      h('span', { text: this.hotreload ? `防抖 ${this.hotreload.debounceMs} ms` : '' }),
    );
    this._syncToolbar();
    this._updateCodeView();
  }

  /**
   * 没打开材质时，把「只有材质能用」的按钮置灰。
   *
   * 这些按钮以前永远是亮的，点了只会往右栏诊断里写一行字 —— 看起来就像
   * "按钮没实现"。置灰 + 说明原因，比静默无反应诚实得多。
   */
  _syncToolbar() {
    const opened = Boolean(this.current.project && this.current.material);
    for (const [btn, label] of [
      [this._snapshotBtn, '快照'],
      [this._exportBtn, '导出 GLSL'],
    ]) {
      if (!btn) continue;
      btn.disabled = !opened;
      btn.title = opened ? label : `${label}（先打开或保存一个材质）`;
    }
  }

  /** 标脏。 */
  _markDirty() {
    this._updateStatus();
  }

  /** 标干净。 */
  _markClean() {
    this._updateStatus();
  }

  /** 释放全部资源。 */
  dispose() {
    this.disposed = true;
    this._audio?.pause();
     this.lyrics?.dispose();
     this._assetsDispose?.();
this._assetsDispose = null;
    if (this._loopHandle) cancelAnimationFrame(this._loopHandle);
    this.detachMouse?.();
    this.hotreload?.dispose();
    this.renderer?.dispose();
    this.materialPreview?.dispose();
    this.editor.dispose();
    this.logs = [];
  }
}

/**
 * 网格名中文。
 * @param {string} shape
 * @returns {string}
 */
function shapeLabel(shape) {
  const table = { quad: '平面', sphere: '球体', box: '立方体', torus: '圆环' };
  return table[shape] ?? shape;
}
