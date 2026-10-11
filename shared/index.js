/**
 * shared 包统一出口。
 *
 * 注意：跨平台转译那一套（`cross-compile` / `glsl-parse` / `glsl-eval` / `spirv` /
 * `spirv-gen`）**故意不在这里 `export *`**，原因有两条：
 *   1. 这些模块之间有几个同名导出（比如 `widthOf`、`ENTRY_NAME`），
 *      `export *` 撞名时会静默丢掉那个名字，排查起来很痛；
 *   2. 面板（client）不需要转译器，导出去只会让浏览器包白白变大。
 * 需要的话按文件 import：`import { crossCompile } from '../shared/cross-compile.js'`。
 *
 * @module dsh-shader-workbench/shared
 */
export * from './graph.js';
export * from './manifest.js';
export * from './events.js';
export * from './nodes.js';
export * from './user-nodes.js';
export * from './glsl-helpers.js';
export * from './asset-types.js';
