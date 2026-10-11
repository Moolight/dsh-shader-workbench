/**
 * Shadertoy 兼容渲染器（WebGL2 手写，零依赖）。
 *
 * 支持：
 *  - 标准 uniform：iTime / iTimeDelta / iFrame / iResolution / iMouse / iDate
 *  - iChannel0..3（图片、canvas、video、另一个 WebGLTexture 都行）
 *  - 多 Pass：image + BufferA..D，Buffer 可以互相采样上一帧
 *
 * 生命周期：`new ShaderToy(canvas)` → `setPasses()` → `start()` → … → `dispose()`
 *
 * @module dsh-shader-workbench/client/runtime/shadertoy
 */

import { compileGraph } from './codegen.js';

/** 顶点着色器：一个铺满屏幕的三角形，用 gl_VertexID 生成，不要 VBO。 */
const VERTEX_SOURCE = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** 默认渲染配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 渲染倍率，1 = 按 CSS 尺寸的物理像素。降到 0.5 就是 1/4 像素量。 */
  scale: 1,
  /** 时钟倍率。 */
  speed: 1,
  /** 时间是否前进（暂停时 iTime 停住，但画面仍然重绘）。 */
  playing: true,
  /** 鼠标按下时 iMouse.xy 的符号行为，true 表示 Shadertoy 原样（松手变负）。 */
  shadertoyMouseSign: true,
});

/**
 * 把 JS 值补成 vec2/vec3/vec4 需要的分量数。
 * @param {any} value
 * @param {number} size
 * @param {number} [alphaFallback]
 * @returns {Float32Array}
 */
function toFloatArray(value, size, alphaFallback = 0) {
  const out = new Float32Array(size);
  const arr = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
  for (let i = 0; i < size; i++) {
    const fallback = i === 3 && size === 4 ? alphaFallback : 0;
    const v = Number(arr[i]);
    out[i] = Number.isFinite(v) ? v : fallback;
  }
  return out;
}

/**
 * 编译一个 WebGL program。
 * @param {WebGL2RenderingContext} gl
 * @param {string} fragSource
 * @returns {{program:WebGLProgram, vertex:WebGLShader, fragment:WebGLShader}}
 */
function buildProgram(gl, fragSource) {
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertex, VERTEX_SOURCE);
  gl.compileShader(vertex);
  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(vertex) ?? '未知错误';
    gl.deleteShader(vertex);
    throw new Error(`顶点着色器编译失败：${log}`);
  }

  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragment, fragSource);
  gl.compileShader(fragment);
  if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(fragment) ?? '未知错误';
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    const error = new Error(`片元着色器编译失败：${log}`);
    error.shaderLog = log;
    throw error;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '未知错误';
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败：${log}`);
  }
  gl.deleteShader(fragment);
  return { program, vertex, fragment };
}

/**
 * 一个 Pass 的 GPU 资源。Buffer Pass 需要 FBO 做双缓冲乒乓。
 */
class PassTarget {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {string} name
   * @param {boolean} isImage
   */
  constructor(gl, name, isImage) {
    this.gl = gl;
    this.name = name;
    this.isImage = isImage;
    /** 双缓冲：read 是上一帧结果，write 是本帧要写的 */
    this.textures = [];
    this.fbos = [];
    this.width = 0;
    this.height = 0;
    this.index = 0;
  }

  /**
   * 按需重建尺寸。
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    const gl = this.gl;
    if (this.isImage) {
      this.width = width;
      this.height = height;
      return;
    }
    if (this.width === width && this.height === height && this.textures.length === 2) return;
    this.dispose();
    this.width = width;
    this.height = height;
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.textures.push(texture);
      this.fbos.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** 上一帧写好的纹理（也就是本帧要采样的那张）。 */
  get readTexture() {
    return this.textures[this.index] ?? null;
  }

  /** 本帧要写进的 FBO。 */
  get writeFbo() {
    return this.fbos[1 - this.index] ?? null;
  }

  /** 写完一帧后调用，交换读写缓冲。 */
  swap() {
    this.index = 1 - this.index;
  }

  /** 释放 GPU 资源。 */
  dispose() {
    const gl = this.gl;
    for (const fbo of this.fbos) gl.deleteFramebuffer(fbo);
    for (const tex of this.textures) gl.deleteTexture(tex);
    this.fbos = [];
    this.textures = [];
    this.width = 0;
    this.height = 0;
    this.index = 0;
  }
}

/**
 * Shadertoy 兼容渲染器。
 */
export class ShaderToy {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [config]
   */
  constructor(canvas, config = {}) {
    if (!canvas) throw new Error('ShaderToy 需要一个 canvas');
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('这个环境拿不到 WebGL2 上下文');
    this.gl = gl;
    // 只支持 RGBA16F 可渲染的设备才开浮点 FBO
    this.floatBuffersOk = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.linearFloatOk = Boolean(gl.getExtension('OES_texture_float_linear'));

    this.config = { ...DEFAULT_CONFIG, ...config };
    /** pass 名 → { fragment, uniforms, program resources, target } */
    this.passes = new Map();
    /** pass 名 → 编译结果 */
    this.compiles = new Map();
    /** iChannel 槽位 → 用户提供的纹理源 */
    this.channels = new Map();
    /** 上传过的通道纹理，{ texture, width, height } */
    this.channelTextures = new Map();
       /** 绑定的音频源，{ slot, analyser, texture, width, gain, node } */
    this._audioSources = [];
    /** 懒创建的 AudioContext */
    this.audioContext = null;
    /** 自定义 uniform 值 */
    this.uniforms = new Map();
       /** 当前图的 id，用来区分「换图」和「同图热重载」 */
    this.currentGraphId = null;
    /** 用到的 uniform 位置缓存：pass 名 → Map<name, location> */
    this.locations = new Map();

    this.time = 0;
    this.frame = 0;
    this.lastTimestamp = 0;
    this.mouse = { downX: 0, downY: 0, curX: 0, curY: 0, down: false, inside: false, hasEverPressed: false };
    this.rafId = 0;
    this.running = false;
    this.disposed = false;
    this.errors = [];
    this.onError = null;

    this._tick = this._tick.bind(this);
  }

  // ─────────────────────────── 编译 ───────────────────────────

  /**
   * 设置（或热替换）一个 Pass 的源码。
   *
   * 与 Shadertoy 一致：**所有 Pass 必须全部编译成功才开始渲染**。
   * 编译失败时保留上一份能跑的 program，并把错误记进 `this.errors`。
   *
   * @param {string} name 'image' | 'BufferA'..'BufferD'
   * @param {string} fragmentSource 完整 GLSL ES 3.00 片元着色器
   * @returns {{ok:boolean, errors:string[], shaderLog?:string}}
   */
  setPass(name, fragmentSource) {
    const gl = this.gl;
    const source = String(fragmentSource ?? '');
    const sourceKey = `${name}:${source}`;
    const existing = this.passes.get(name);

    // 源码没变就直接返回，避免每帧重编译
    if (existing && existing.sourceKey === sourceKey) return { ok: true, errors: [] };

    let built;
    try {
      built = buildProgram(gl, source);
    } catch (error) {
      const log = error.shaderLog ?? (error instanceof Error ? error.message : String(error));
      const message = `${name}: ${log}`;
      this.errors = this.errors.filter((e) => !e.startsWith(`${name}: `)).concat(message);
      if (this.onError) this.onError({ pass: name, log });
      return { ok: false, errors: [log], shaderLog: log };
    }

    const program = built.program;
    const isImage = name === 'image';
    const target = existing?.target ?? new PassTarget(gl, name, isImage);
    target.isImage = isImage;

    if (existing) {
      gl.deleteProgram(existing.program);
      gl.deleteShader(existing.vertex);
      // 片元着色器在 buildProgram 链接成功后已经删掉了
    }

    this.passes.set(name, {
      name,
      program,
      vertex: built.vertex,
      sourceKey,
      source,
      target,
      uniforms: new Map(),
    });
    this.locations.set(name, new Map());
    this.errors = this.errors.filter((e) => !e.startsWith(`${name}: `));
    return { ok: true, errors: [] };
  }

  /**
   * 用节点图一次性设置多个 Pass：内部先做代码生成再编译。
   *
   * @param {object} graph 归一化后的 ShaderGraph
   * @param {object} [opts] { uniforms }
   * @returns {{ok:boolean, errors:object[], compiled:Record<string,object>}}
   */
  setGraph(graph, opts = {}) {
      // 区分「换图」和「热重载」：换图要清空 Buffer，热重载要保留拖尾。
    // 判据用 graph.id —— 同一张图反复编译时 id 不变，换材质/换示例时 id 会变。
    const graphId = typeof graph?.id === 'string' ? graph.id : null;
    const isSwitch = this.currentGraphId !== null && this.currentGraphId !== graphId;
    this.currentGraphId = graphId;
    const uniformValues = opts.uniforms ?? Object.fromEntries(this.uniforms);
    const compiled = {};
    const errors = [];
    const active = [];

    for (const pass of graph.passes ?? []) {
      const result = compileGraph(graph, pass.name, { uniforms: uniformValues });
      compiled[pass.name] = result;
      if (!result.ok) {
        errors.push(...result.errors.map((e) => ({ ...e, pass: pass.name })));
        continue;
      }
      active.push(pass.name);
    }

    if (errors.length > 0) {
      this.compiles = compiled;
      for (const err of errors) this.errors.push(`${err.pass}: ${err.message}`);
        if (isSwitch) this._clearCanvas();  
      return { ok: false, errors, compiled };
    }

    // 全部编译通过才整体替换
    const results = [];
    for (const name of active) {
      const res = this.setPass(name, compiled[name].code);
      if (!res.ok) {
        errors.push({ code: 'shader-compile', pass: name, message: res.errors.join('\n') });
      }
      results.push({ name, ...res });
    }
    if (errors.length > 0) {
      this.compiles = compiled;
        if (isSwitch) this._clearCanvas();  
      return { ok: false, errors, compiled };
    }

    // 清掉不再存在的 Buffer Pass
    for (const name of [...this.passes.keys()]) {
      if (name !== 'image' && !active.includes(name)) {
        this._disposePass(name);
      }
    }
     // 切图：把上一份图留在所有 Buffer Pass 里的内容清掉。
    // 不清的话，两份图都用 BufferA 时会读到上一份的最后一帧（因为 PassTarget
    // 是按 pass 名复用的），拖尾效果会带着老图一起拖。
    if (isSwitch) this._clearAllBuffers();
    this.compiles = compiled;
    return { ok: true, errors: [], compiled };
  }

  /**
   * 只做代码生成，不碰 GPU。给编辑器「查看生成代码」用。
   * @param {object} graph
   * @param {object} [opts]
   * @returns {Record<string, object>}
   */
  static generate(graph, opts = {}) {
    const out = {};
    for (const pass of graph.passes ?? []) {
      out[pass.name] = compileGraph(graph, pass.name, opts);
    }
    return out;
  }

  // ─────────────────────────── 资源 ───────────────────────────

  /**
   * 绑一个 iChannel 纹理源。
   *
   * 源可以是：HTMLImageElement / HTMLCanvasElement / HTMLVideoElement /
   * ImageBitmap / WebGLTexture / { data: Uint8Array, width, height }。
   * 传 null 或 undefined 表示解绑。
   *
   * @param {string} slot 'iChannel0'..'iChannel3'
   * @param {any} source
   * @returns {boolean} 是否接受
   */
  setChannel(slot, source) {
    if (!/^iChannel[0-3]$/.test(slot)) throw new Error(`非法通道名：${slot}`);
    if (source === null || source === undefined) {
      this.channels.delete(slot);
      const held = this.channelTextures.get(slot);
      if (held) {
        this.gl.deleteTexture(held.texture);
        this.channelTextures.delete(slot);
      }
      return true;
    }
    // 换源时必须先把上一张上传的纹理删掉。
    // 只 delete 记录不 delete 纹理会漏 GPU 显存——换几轮图就积一堆。
    const previous = this.channelTextures.get(slot);
    if (previous) {
      this.gl.deleteTexture(previous.texture);
      this.channelTextures.delete(slot);
    }
    this.channels.set(slot, source);
    return true;
  }

   /**
   * 把一个音频源绑到某个 iChannel 槽位。
   *
   * 纹理布局与 Shadertoy 一致：宽 = fftSize/2，高 2。
   *   y = 0（底行）  FFT 频谱（灰度）
   *   y = 1（顶行）  波形（居中于 0.5）
   *
   * 必须在用户手势里调用（浏览器的自动播放策略）。
   *
   * @param {string} slot 'iChannel0'..'iChannel3'
   * @param {HTMLAudioElement|HTMLVideoElement|MediaStreamAudioSourceNode} source
   * @param {object} [opts] { fftSize, smoothing, gain }
   */
  async attachAudio(slot, source, opts = {}) {
    if (!/^iChannel[0-3]$/.test(slot)) throw new Error(`非法通道名：${slot}`);

    const ctx = (this.audioContext ??= new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') await ctx.resume();

    // 已有同槽位的音频源：先撤掉
    const previous = this._audioSources.findIndex((a) => a.slot === slot);
    if (previous >= 0) this._detachAudioAt(previous);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = opts.fftSize ?? 2048;
    analyser.smoothingTimeConstant = opts.smoothing ?? 0.8;

    // 从 <audio>/<video> 建 MediaElementSource 只能建一次，否则抛 InvalidStateError
    let node;
    if (typeof MediaStreamAudioSourceNode !== 'undefined' && source instanceof MediaStreamAudioSourceNode) {
      node = source;
    } else if (source.__dshAudioNode) {
      node = source.__dshAudioNode;
    } else {
      node = ctx.createMediaElementSource(source);
      source.__dshAudioNode = node;
    }

    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    node.connect(analyser);
    node.connect(gain);
    gain.connect(ctx.destination);

    const gl = this.gl;
    const width = analyser.frequencyBinCount;   // = fftSize / 2
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // R8 单通道：采样回来的 .x 就是 0..1
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, 2, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._audioSources.push({ slot, analyser, texture, width, gain, node, buf: null });
    // WebGLTexture 会被 _channelTexture 直接透传，不经过图片上传那条路
    this.setChannel(slot, texture);
    return { analyser, texture, width };
  }

  /** 解绑一个槽位上的音频源（不碰 AudioContext 本身）。 */
  _detachAudioAt(index) {
    const entry = this._audioSources[index];
    if (!entry) return;
    try { entry.node.disconnect(); entry.gain.disconnect(); } catch { /* 已断开 */ }
    this.gl.deleteTexture(entry.texture);
    this.channels.delete(entry.slot);
    this._audioSources.splice(index, 1);
  }

  /** 每帧把 AnalyserNode 的数据刷进纹理。 */
  _updateAudioTextures() {
    if (this._audioSources.length === 0) return;
    const gl = this.gl;
    for (const src of this._audioSources) {
      const buf = src.buf ?? (src.buf = new Uint8Array(src.width));

      // y = 0：频谱
      src.analyser.getByteFrequencyData(buf);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, src.width, 1, gl.RED, gl.UNSIGNED_BYTE, buf);

      // y = 1：波形（0..255，居中于 128 → 采样回来是 0..1）
      src.analyser.getByteTimeDomainData(buf);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, src.width, 1, gl.RED, gl.UNSIGNED_BYTE, buf);
    }
  }

  /**
   * 设置一个自定义 uniform 的值。
   * @param {string} name
   * @param {number|number[]} value
   * @param {string} [type] float | vec2 | vec3 | vec4
   */
  setUniform(name, value, type = 'float') {
    this.uniforms.set(name, { value, type });
  }

  /**
   * 批量设置。
   * @param {Record<string, any>} values
   */
  setUniforms(values) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (value && typeof value === 'object' && 'value' in value && 'type' in value) {
        this.uniforms.set(name, { value: value.value, type: value.type });
      } else {
        const type = Array.isArray(value) ? `vec${value.length}` : 'float';
        this.uniforms.set(name, { value, type });
      }
    }
  }

  /**
   * 上传通道纹理（懒上传：只有用到才上传）。
   * @param {string} slot
   * @returns {WebGLTexture|null}
   */
  _channelTexture(slot) {
    const gl = this.gl;
    const held = this.channelTextures.get(slot);
    const source = this.channels.get(slot);
    if (!source) return null;

    // 已经是 WebGLTexture 就直接用
    if (typeof WebGLTexture !== 'undefined' && source instanceof WebGLTexture) return source;

    const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    const width = source.width ?? source.videoWidth ?? 0;
    const height = source.height ?? source.videoHeight ?? 0;
    if (!width || !height) return held?.texture ?? null;

    if (held && held.width === width && held.height === height && !isVideo) return held.texture;

    const texture = held?.texture ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // 图片以左上角为原点，而 GL 的 uv 原点在左下角，所以要翻转。
    // 这个 flag 是全局状态，用完必须还原，否则会影响别的上传。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = isPowerOfTwo(width) && isPowerOfTwo(height) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.channelTextures.set(slot, { texture, width, height });
    return texture;
  }

  // ─────────────────────────── 渲染 ───────────────────────────

  /**
   * 按显示尺寸同步画布的后备缓冲尺寸。
   * @returns {{width:number, height:number}}
   */
  _syncSize() {
    const canvas = this.canvas;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const cssW = canvas.clientWidth || canvas.width || 640;
    const cssH = canvas.clientHeight || canvas.height || 360;
    const width = Math.max(1, Math.round(cssW * dpr * this.config.scale));
    const height = Math.max(1, Math.round(cssH * dpr * this.config.scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height };
  }

  /**
   * 渲染一帧。
   * @param {number} [dt] 距上一帧的秒数；不传按当前时间与上一帧的差算
   */
  render(dt = 0) {
    if (this.disposed) return;
    const gl = this.gl;
    const { width, height } = this._syncSize();
 this._updateAudioTextures();
    if (this.config.playing) {
      this.time += dt * this.config.speed;
      this.frame += 1;
    }

    // 1) 先跑所有 Buffer Pass（顺序执行，后面的可以采样前面的上一帧）
    for (const [name, pass] of this.passes) {
      if (name === 'image') continue;
      this._renderPass(name, pass, width, height, true);
    }

  // 2) 再跑 image Pass 到默认帧缓冲
    const image = this.passes.get('image');
    if (image) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      // 必须清屏：WebGL2 上下文开了 preserveDrawingBuffer，不清的话
      // 上一帧会透过新 shader 没覆盖到的像素显示出来 —— 切图/切材质时
      // 表现为「旧画面残留在新画面边缘」。
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._drawPass('image', image, width, height);
    }

    // 3) 交换所有 Buffer 的读写缓冲
    for (const [name, pass] of this.passes) {
      if (name !== 'image') pass.target.swap();
    }
  }

  /**
   * 渲染一个 Buffer Pass 到它自己的 FBO。
   * @param {string} name
   * @param {object} pass
   * @param {number} width
   * @param {number} height
   * @param {boolean} offscreen
   */
  _renderPass(name, pass, width, height, offscreen) {
    const gl = this.gl;
    pass.target.resize(width, height);
    if (offscreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pass.target.writeFbo);
      gl.viewport(0, 0, pass.target.width, pass.target.height);
    }
    this._drawPass(name, pass, width, height);
  }

   /**
   * 清空所有离屏 Pass 的双缓冲纹理。
   *
   * 用于「换图」：`PassTarget` 是按 pass 名维护的，切到一份也用了 BufferA
   * 的新图时会复用老 target，不清空的话新图第一帧会读到上一份图的残留。
   *
   * @private
   */
  _clearAllBuffers() {
    const gl = this.gl;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.clearColor(0, 0, 0, 0);
    for (const [name, pass] of this.passes) {
      if (name === 'image') continue;
      const target = pass.target;
      if (!target || target.fbos.length === 0) continue;
      for (const fbo of target.fbos) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  }
   /** 清空默认帧缓冲（切图失败时用，避免用户看到上一个材质的画面）。 */
  _clearCanvas() {
    const gl = this.gl;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  }

  /**
   * 画一个 Pass（假定 FBO 与 viewport 已经设好）。
   * @param {string} name
   * @param {object} pass
   * @param {number} width
   * @param {number} height
   */
  _drawPass(name, pass, width, height) {
    const gl = this.gl;
    gl.useProgram(pass.program);

    const targetW = pass.target.isImage ? width : pass.target.width;
    const targetH = pass.target.isImage ? height : pass.target.height;

    let loc = this.locations.get(name);
    if (!loc) {
      loc = new Map();
      this.locations.set(name, loc);
    }
    const locationOf = (uniformName) => {
      if (!loc.has(uniformName)) loc.set(uniformName, gl.getUniformLocation(pass.program, uniformName));
      return loc.get(uniformName);
    };

    const set1f = (uniformName, value) => {
      const l = locationOf(uniformName);
      if (l) gl.uniform1f(l, value);
    };
    const set3f = (uniformName, a, b, c) => {
      const l = locationOf(uniformName);
      if (l) gl.uniform3f(l, a, b, c);
    };
    const set4f = (uniformName, a, b, c, d) => {
      const l = locationOf(uniformName);
      if (l) gl.uniform4f(l, a, b, c, d);
    };

    set3f('iResolution', targetW, targetH, 1);
    set1f('iTime', this.time);
    set1f('iTimeDelta', this.lastDelta ?? 0);
    set1f('iFrame', this.frame);
    const now = new Date();
    set4f(
      'iDate',
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds(),
    );

    // Shadertoy 的 iMouse 口径：
    //   xy = 最近一次按下的位置，从没按过则取负
    //   zw = 当前拖动位置，在画布外取负
    const m = this.mouse;
    const hasClick = m.down || m.hasEverPressed === true;
    const xy = hasClick ? [m.downX, targetH - m.downY] : [-Math.abs(m.downX) - 1, -Math.abs(m.downY) - 1];
    const inside = m.inside || m.down;
    const zw = inside ? [m.curX, targetH - m.curY] : [-Math.abs(m.curX) - 1, -Math.abs(m.curY) - 1];
    set4f('iMouse', xy[0], xy[1], zw[0], zw[1]);
    if (m.down || m.inside) m.hasEverPressed = true;

    // 自定义 uniform
    for (const [uniformName, entry] of this.uniforms) {
      const l = locationOf(uniformName);
      if (!l) continue;
      switch (entry.type) {
        case 'vec2': {
          const v = toFloatArray(entry.value, 2);
          gl.uniform2f(l, v[0], v[1]);
          break;
        }
        case 'vec3': {
          const v = toFloatArray(entry.value, 3);
          gl.uniform3f(l, v[0], v[1], v[2]);
          break;
        }
        case 'vec4': {
          const v = toFloatArray(entry.value, 4, 1);
          gl.uniform4f(l, v[0], v[1], v[2], v[3]);
          break;
        }
        default:
          gl.uniform1f(l, Number(entry.value) || 0);
      }
    }

    // 纹理通道 + 其它 Buffer
    let unit = 0;
    for (let i = 0; i < 4; i++) {
      const slot = `iChannel${i}`;
      const l = locationOf(slot);
      if (!l) continue;
      const bound = this._channelTexture(slot) ?? this._fallbackTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, bound);
      gl.uniform1i(l, unit);
      unit += 1;
    }
    for (const bufferName of ['BufferA', 'BufferB', 'BufferC', 'BufferD']) {
      const l = locationOf(bufferName);
      if (!l) continue;
      const source = this.passes.get(bufferName);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, source ? source.target.readTexture : null);
      gl.uniform1i(l, unit);
      unit += 1;
    }

    gl.bindVertexArray(this._vao());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * 共享的空 VAO（顶点完全由 gl_VertexID 生成）。
   * @returns {WebGLVertexArrayObject}
   */
  _vao() {
    if (!this._vaoHandle) this._vaoHandle = this.gl.createVertexArray();
    return this._vaoHandle;
  }

  /**
   * 1x1 中灰兜底纹理。
   * @returns {WebGLTexture}
   */
  _fallbackTexture() {
    if (this._fallback) return this._fallback;
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([32, 32, 32, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this._fallback = texture;
    return texture;
  }

  // ─────────────────────────── 循环 ───────────────────────────

  /**
   * 启动 requestAnimationFrame 循环。
   * 页面不可见（document.hidden）时自动跳过渲染，符合「隐藏时 CPU < 1%」的验收要求。
   */
  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTimestamp = 0;
    this._visibilityHandler = () => {
      // 回到前台时重置时间基准，避免 dt 爆炸式跳变
      this.lastTimestamp = 0;
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
    this.rafId = requestAnimationFrame(this._tick);
  }

  /** 停止循环。 */
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
  }

  /**
   * @param {number} timestamp
   */
  _tick(timestamp) {
    if (!this.running || this.disposed) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) {
      // 隐藏时不渲染，但仍然排下一帧（几乎不耗 CPU）
      this.lastTimestamp = timestamp;
      this.rafId = requestAnimationFrame(this._tick);
      return;
    }
    const dt = this.lastTimestamp === 0 ? 0 : Math.min(0.1, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    this.lastDelta = dt;
    try {
      this.render(dt);
    } catch (error) {
      this.errors.push(`渲染异常：${error instanceof Error ? error.message : String(error)}`);
      if (this.onError) this.onError({ pass: null, log: String(error) });
    }
    this.rafId = requestAnimationFrame(this._tick);
  }

  /**
   * 立刻渲染一帧（即使暂停中）。
   */
  step() {
    this.render(0);
  }

  // ─────────────────────────── 鼠标 ───────────────────────────

  /**
   * 把浏览器事件坐标换算成画布内的物理像素坐标。
   * @param {MouseEvent} event
   * @returns {{x:number, y:number}}
   */
  eventToPixels(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, rect.width);
    const scaleY = this.canvas.height / Math.max(1, rect.height);
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  /**
   * 自动挂鼠标事件。返回解绑函数。
   * @returns {() => void}
   */
  attachMouse() {
    const canvas = this.canvas;
    const onMove = (event) => {
      const p = this.eventToPixels(event);
      this.mouse.curX = p.x;
      this.mouse.curY = p.y;
      this.mouse.inside = true;
      if (this.mouse.down) {
        this.mouse.downX = p.x;
        this.mouse.downY = p.y;
      }
    };
    const onDown = (event) => {
      const p = this.eventToPixels(event);
      this.mouse.down = true;
      this.mouse.inside = true;
      this.mouse.downX = p.x;
      this.mouse.downY = p.y;
      this.mouse.curX = p.x;
      this.mouse.curY = p.y;
      canvas.focus?.();
    };
    const onUp = () => {
      this.mouse.down = false;
    };
    const onLeave = () => {
      this.mouse.inside = false;
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchstart', onDown, { passive: true });

    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('touchstart', onDown);
    };
  }

  // ─────────────────────────── 收尾 ───────────────────────────

  /**
   * 释放某个 Pass。
   * @param {string} name
   */
  _disposePass(name) {
    const pass = this.passes.get(name);
    if (!pass) return;
    this.gl.deleteProgram(pass.program);
    this.gl.deleteShader(pass.vertex);
    pass.target.dispose();
    this.passes.delete(name);
    this.locations.delete(name);
  }

  /** 释放全部 GPU 资源。 */
  dispose() {
    if (this.disposed) return;
    this.stop();
    
    for (const name of [...this.passes.keys()]) this._disposePass(name);
    for (const held of this.channelTextures.values()) this.gl.deleteTexture(held.texture);
      for (let i = this._audioSources.length - 1; i >= 0; i -= 1) this._detachAudioAt(i);
    this.audioContext?.close?.().catch(() => {});
    this.audioContext = null;
    this.channelTextures.clear();
    if (this._fallback) this.gl.deleteTexture(this._fallback);
    if (this._vaoHandle) this.gl.deleteVertexArray(this._vaoHandle);
    this.disposed = true;
  }

  /**
   * 运行时统计。
   * @returns {object}
   */
  stats() {
    return {
      time: this.time,
      frame: this.frame,
      passes: [...this.passes.keys()],
      channels: [...this.channels.keys()],
      errors: [...this.errors],
      floatBuffers: this.floatBuffersOk,
      size: { width: this.canvas.width, height: this.canvas.height },
    };
  }
}

/**
 * 是不是 2 的幂（决定纹理 wrap 模式）。
 * @param {number} n
 * @returns {boolean}
 */
function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * 从节点图直接建一个渲染器（常用组合）。
 * @param {HTMLCanvasElement} canvas
 * @param {object} graph
 * @param {object} [opts]
 * @returns {ShaderToy}
 */
export function createFromGraph(canvas, graph, opts = {}) {
  const toy = new ShaderToy(canvas, opts.config);
  if (opts.uniforms) toy.setUniforms(opts.uniforms);
  toy.setGraph(graph, { uniforms: opts.uniforms });
  return toy;
}
