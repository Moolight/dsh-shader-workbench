/**
 * runtime 包统一出口：Shadertoy 兼容渲染核心，零依赖、不依赖 React。
 * @module dsh-shader-workbench/client/runtime
 */
export { ShaderToy, createFromGraph, DEFAULT_CONFIG } from './shadertoy.js';
export {
  compileGraph,
  castExpr,
  glslLiteral,
  shadertoyHeader,
} from './codegen.js';
export { HotReload, DEFAULT_DEBOUNCE_MS, normalizeErrors } from './hotreload.js';
export { UnlitMaterialPreview } from './material-preview.js';
