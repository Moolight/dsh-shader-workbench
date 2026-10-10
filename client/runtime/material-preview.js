/**
 * 材质预览：把一张节点图当作「表面着色器」渲染到球体/平面/盒子网格上。
 *
 * 做法很朴素但够用：把网格的法线/UV 编码进一个离屏 canvas，
 * 作为 iChannel 喂给同一个 Shadertoy 兼容 program——
 * 也就是「用同一个着色器既画屏幕也画网格」，不需要引入 Three.js。
 *
 * 只依赖 WebGL2 + 内置数学，零第三方依赖。
 *
 * @module dsh-shader-workbench/client/runtime/material-preview
 */

/** 预览网格类型。 */
export const PREVIEW_SHAPES = ['quad', 'sphere', 'box', 'torus'];

/**
 * 生成球体网格（顶点位置 + 法线 + uv + 索引）。
 * @param {number} segments
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array, indices:Uint16Array}}
 */
export function buildSphere(segments = 32) {
  const rings = Math.max(4, Math.round(segments / 2));
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      positions.push(nx, ny, nz);
      normals.push(nx, ny, nz);
      uvs.push(u, 1 - v);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * 生成一个轴对齐的盒子网格。
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array, indices:Uint16Array}}
 */
export function buildBox() {
  const f = 0.5;
  /** 6 个面，每个面 4 个顶点 */
  const faces = [
    [[-f, -f, f], [f, -f, f], [f, f, f], [-f, f, f], [0, 0, 1]],
    [[f, -f, -f], [-f, -f, -f], [-f, f, -f], [f, f, -f], [0, 0, -1]],
    [[f, -f, f], [f, -f, -f], [f, f, -f], [f, f, f], [1, 0, 0]],
    [[-f, -f, -f], [-f, -f, f], [-f, f, f], [-f, f, -f], [-1, 0, 0]],
    [[-f, f, f], [f, f, f], [f, f, -f], [-f, f, -f], [0, 1, 0]],
    [[-f, -f, -f], [f, -f, -f], [f, -f, f], [-f, -f, f], [0, -1, 0]],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, i) => {
    const n = face[4];
    for (let k = 0; k < 4; k++) {
      positions.push(face[k][0], face[k][1], face[k][2]);
      normals.push(n[0], n[1], n[2]);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const base = i * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * 生成环面网格。
 * @param {number} major
 * @param {number} minor
 * @returns {{positions:Float32Array, normals:Float32Array, uvs:Float32Array, indices:Uint16Array}}
 */
export function buildTorus(major = 32, minor = 16) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const R = 0.35;
  const r = 0.15;
  for (let j = 0; j <= minor; j++) {
    const v = (j / minor) * Math.PI * 2;
    for (let i = 0; i <= major; i++) {
      const u = (i / major) * Math.PI * 2;
      const x = (R + r * Math.cos(v)) * Math.cos(u);
      const y = r * Math.sin(v);
      const z = (R + r * Math.cos(v)) * Math.sin(u);
      positions.push(x, y, z);
      const nx = Math.cos(v) * Math.cos(u);
      const ny = Math.sin(v);
      const nz = Math.cos(v) * Math.sin(u);
      normals.push(nx, ny, nz);
      uvs.push(i / major, j / minor);
    }
  }
  for (let j = 0; j < minor; j++) {
    for (let i = 0; i < major; i++) {
      const a = j * (major + 1) + i;
      const b = a + major + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * 按类型建网格。
 * @param {string} shape
 * @returns {object}
 */
export function buildMesh(shape) {
  switch (shape) {
    case 'sphere':
      return buildSphere(48);
    case 'box':
      return buildBox();
    case 'torus':
      return buildTorus(48, 24);
    case 'quad':
    default:
      return buildSphere(4);
  }
}

/** 网格顶点着色器：简单的 MVP + 光照，给片元算漫反射方向。 */
const MESH_VERTEX = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUv;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
out vec3 vNormal;
out vec3 vViewPos;
out vec2 vUv;

void main() {
  vNormal = normalize(uNormalMatrix * aNormal);
  vViewPos = (uModelView * vec4(aPosition, 1.0)).xyz;
  vUv = aUv;
  gl_Position = uProjection * vec4(vViewPos, 1.0);
}
`;

/**
 * 预览片元着色器：把用户图的结果当作 albedo 贴到网格上。
 *
 * 用户在节点图里对 `gl_FragCoord.xy / iResolution.xy` 求值得到 uv——
 * 预览时把 `iResolution` 换成网格的纹理坐标空间，所以同一张图
 * 既能当全屏 shader，也能当材质纹理，不需要改图。
 */
const MESH_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vViewPos;
in vec2 vUv;
uniform sampler2D uSurface;
uniform vec3 uLightDir;
out vec4 fragOut;

void main() {
  vec4 albedo = texture(uSurface, vUv);
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDir);
  float lambert = max(dot(n, l), 0.0);
  // 半兰伯特 + 环境项，暗部不至于死黑
  float light = 0.18 + 0.82 * (lambert * 0.5 + 0.5);
  vec3 color = albedo.rgb * light;
  // 轻微边缘高光
  vec3 v = normalize(-vViewPos);
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.25;
  fragOut = vec4(color + spec, albedo.a);
}
`;

/**
 * 材质预览器：把节点图渲染到一张离屏纹理，再贴到网格上成像。
 */
export class UnlitMaterialPreview {
  /**
   * @param {HTMLCanvasElement} canvas 目标画布
   * @param {object} [opts]
   * @param {import('./shadertoy.js').ShaderToy} [opts.surfaceRenderer] 负责出表面纹理的渲染器
   */
  constructor(canvas, opts = {}) {
    if (!canvas) throw new Error('UnlitMaterialPreview 需要一个 canvas');
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('这个环境拿不到 WebGL2 上下文');
    this.gl = gl;
    this.surfaceRenderer = opts.surfaceRenderer ?? null;
    this.shape = opts.shape ?? 'sphere';
    this.rotation = { yaw: 0.6, pitch: 0.25 };
    this.autoSpin = true;
    this.mesh = null;
    this.buffers = null;
    this.program = null;
    this.errors = [];
    this._buildProgram();
    this.setShape(this.shape);
  }

  /** 编译网格 program。 */
  _buildProgram() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`材质预览着色器编译失败：${log}`);
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, MESH_VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, MESH_FRAGMENT);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`材质预览链接失败：${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
  }

  /**
   * 切换网格类型。
   * @param {string} shape
   */
  setShape(shape) {
    if (!PREVIEW_SHAPES.includes(shape)) shape = 'sphere';
    this.shape = shape;
    const gl = this.gl;
    if (this.buffers) {
      gl.deleteBuffer(this.buffers.position);
      gl.deleteBuffer(this.buffers.normal);
      gl.deleteBuffer(this.buffers.uv);
      gl.deleteBuffer(this.buffers.index);
    }
    const mesh = shape === 'quad' ? null : buildMesh(shape);
    this.mesh = mesh;
    if (!mesh) {
      this.buffers = null;
      return;
    }
    const makeBuffer = (data, target) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return buffer;
    };
    this.buffers = {
      position: makeBuffer(mesh.positions, gl.ARRAY_BUFFER),
      normal: makeBuffer(mesh.normals, gl.ARRAY_BUFFER),
      uv: makeBuffer(mesh.uvs, gl.ARRAY_BUFFER),
      index: makeBuffer(mesh.indices, gl.ELEMENT_ARRAY_BUFFER),
      count: mesh.indices.length,
    };
  }

  /**
   * 渲染一帧预览。
   * @param {number} [dt]
   */
  render(dt = 0) {
    const gl = this.gl;
    const surface = this.surfaceRenderer?.passes?.get('image')?.target?.readTexture ?? null;
    if (this.autoSpin) this.rotation.yaw += dt * 0.35;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = Math.max(1, Math.round((this.canvas.clientWidth || 512) * dpr));
    const height = Math.max(1, Math.round((this.canvas.clientHeight || 512) * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.08, 0.09, 0.11, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 平面模式：直接把表面纹理铺满
    if (!this.mesh || !this.buffers) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, surface);
      const loc = gl.getUniformLocation(this.program, 'uSurface');
      if (loc) gl.uniform1i(loc, 0);
      // 平面模式借用一个全屏三角形
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.deleteVertexArray(vao);
      return;
    }

    gl.useProgram(this.program);
    const aspect = width / height;
    const projection = perspective(45, aspect, 0.1, 10);
    const view = lookAt([0, 0, 2.2], [0, 0, 0], [0, 1, 0]);
    const model = multiply(rotationY(this.rotation.yaw), rotationX(this.rotation.pitch));
    const modelView = multiply(view, model);
    const normalMatrix = normalMat3(modelView);

    setUniformMatrix4(gl, this.program, 'uModelView', modelView);
    setUniformMatrix4(gl, this.program, 'uProjection', projection);
    setUniformMatrix3(gl, this.program, 'uNormalMatrix', normalMatrix);
    const lightLoc = gl.getUniformLocation(this.program, 'uLightDir');
    if (lightLoc) gl.uniform3f(lightLoc, -0.4, 0.7, 0.6);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bind = (buffer, name, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const loc = gl.getAttribLocation(this.program, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(this.buffers.position, 'aPosition', 3);
    bind(this.buffers.normal, 'aNormal', 3);
    bind(this.buffers.uv, 'aUv', 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, surface);
    const surfaceLoc = gl.getUniformLocation(this.program, 'uSurface');
    if (surfaceLoc) gl.uniform1i(surfaceLoc, 0);

    gl.drawElements(gl.TRIANGLES, this.buffers.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  /** 释放资源。 */
  dispose() {
    const gl = this.gl;
    if (this.buffers) {
      gl.deleteBuffer(this.buffers.position);
      gl.deleteBuffer(this.buffers.normal);
      gl.deleteBuffer(this.buffers.uv);
      gl.deleteBuffer(this.buffers.index);
    }
    if (this.program) gl.deleteProgram(this.program);
    this.buffers = null;
    this.program = null;
  }
}

// ─────────────────────────── 最小矩阵工具 ───────────────────────────

/**
 * @param {number} fovDeg
 * @param {number} aspect
 * @param {number} near
 * @param {number} far
 * @returns {Float32Array}
 */
export function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

/**
 * @param {number[]} eye
 * @param {number[]} center
 * @param {number[]} up
 * @returns {Float32Array}
 */
export function lookAt(eye, center, up) {
  const z = normalize3(sub3(eye, center));
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

/** @param {number} a */
export function rotationY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

/** @param {number} a */
export function rotationX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

/**
 * 4x4 相乘（列主序）。
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {Float32Array}
 */
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * 取 4x4 的左上 3x3 并用逆转置做法线矩阵。
 * @param {Float32Array|number[]} m
 * @returns {Float32Array}
 */
export function normalMat3(m) {
  return new Float32Array([
    m[0], m[1], m[2],
    m[4], m[5], m[6],
    m[8], m[9], m[10],
  ]);
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {string} name
 * @param {Float32Array} value
 */
function setUniformMatrix4(gl, program, name, value) {
  const loc = gl.getUniformLocation(program, name);
  if (loc) gl.uniformMatrix4fv(loc, false, value);
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {string} name
 * @param {Float32Array} value
 */
function setUniformMatrix3(gl, program, name, value) {
  const loc = gl.getUniformLocation(program, name);
  if (loc) gl.uniformMatrix3fv(loc, false, value);
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
