/**
 * 复现桌面壳的 profile 解析：用**完全相同的参数**调 loadProfileDirectory，
 * 把它内部吞掉的 skippedBundles 打出来。
 *
 * 为什么要这么做：桌面壳是 Electron 工具进程，
 * `reportSkippedBundles` 只把跳过原因写进那个进程的 stderr，
 * 而那个 stderr 没人看得见也不落盘。这里把同一份代码在本地跑一遍，
 * 跳过原因就直接打到我们自己的 stdout 上。
 *
 * 必须用 `ELECTRON_RUN_AS_NODE=1` + Electron 可执行文件跑，
 * 因为 installAnchor 指向 app.asar 内部，普通 Node 读不了 asar。
 */

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

// 都从环境推，别写死 —— 这个仓库是开源的，个人目录路径不该进版本库。
// 需要时用环境变量覆盖：
//   DSH_RUNTIME_DIR   DSH 运行时目录（app.asar 里的 dsh/）
//   DSH_PROFILE_DIR   要探测的 profile 目录
const RUNTIME_DIR = process.env.DSH_RUNTIME_DIR ?? 'D:\\ENV\\Dsh\\resources\\app.asar\\dsh';
const PROJECT_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');

const installAnchor = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const appBootMain = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');

console.log('[probe] runtimeDir   =', RUNTIME_DIR);
console.log('[probe] projectDir   =', PROJECT_DIR);
console.log('[probe] installAnchor=', installAnchor);
console.log('[probe] appBoot      =', appBootMain);
console.log('');

let mod;
try {
  mod = await import(pathToFileURL(appBootMain).href);
  console.log('[probe] 用动态 import 加载 dsh-app-boot 成功');
} catch (error) {
  console.log('[probe] 动态 import 失败：', error.message);
  try {
    const require = createRequire(import.meta.url);
    mod = require(appBootMain);
    console.log('[probe] 退回 require 加载成功');
  } catch (error2) {
    console.log('[probe] require 也失败：', error2.message);
    process.exit(1);
  }
}

console.log('[probe] 导出的相关函数：', ['loadProfileDirectory', 'reportSkippedBundles', 'resolveBundleDir']
  .map((k) => `${k}=${typeof mod[k]}`)
  .join(' '));
console.log('');

const profile = mod.loadProfileDirectory('dsh', PROJECT_DIR, installAnchor);

console.log('=== 成功加载的 bundle 层（顺序） ===');
for (const layer of profile.layers) console.log('  ✓', layer.packageName);

console.log('');
console.log('=== 被跳过的 bundle ===');
if (profile.skippedBundles.length === 0) {
  console.log('  （没有跳过的）');
} else {
  for (const skipped of profile.skippedBundles) {
    console.log(`  ✗ ${skipped.packageName}`);
    console.log(`      reason: ${skipped.reason}`);
  }
}

console.log('');
console.log('=== 结论 ===');
const mine = profile.layers.some((l) => l.packageName === 'dsh-shader-workbench');
const skippedMine = profile.skippedBundles.find((s) => s.packageName === 'dsh-shader-workbench');
if (mine) console.log('  dsh-shader-workbench：作为 bundle 层加载成功');
else if (skippedMine) console.log(`  dsh-shader-workbench：被跳过 → ${skippedMine.reason}`);
else console.log('  dsh-shader-workbench：既没加载也没被跳过（不在 bundles 列表里？）');

// ─────────── 第二阶段：把运行时解析表打出来 ───────────
// 判断断点是「bundle 没加载」还是「模块解析不到」。
if (typeof mod.createRuntimeResolution !== 'function') {
  console.log('');
  console.log('[probe] 这个版本没有导出 createRuntimeResolution，跳过第二阶段');
  process.exit(0);
}

console.log('');
console.log('═══════ 运行时解析表（createRuntimeResolution） ═══════');
const resolution = await mod.createRuntimeResolution({
  installAnchor,
  profile,
  home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
});

const dump = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);

console.log('');
console.log('--- localPackageNames（这些走 native 解析，即「Node 自己在 profile 里找得到」）---');
const locals = [...resolution.localPackageNames];
for (const n of locals) console.log(`    ${n === 'dsh-shader-workbench' ? '★' : ' '} ${n}`);
console.log(`  小计 ${locals.length} 个；含 dsh-shader-workbench = ${locals.includes('dsh-shader-workbench')}`);

console.log('');
console.log('--- linkedRoots（符号链接到 profile 之外的包）---');
for (const root of resolution.linkedRoots) {
  console.log(`    ${root.name === 'dsh-shader-workbench' ? '★' : ' '} ${root.name}  →  ${root.realPath}`);
}

console.log('');
console.log('--- entries（解析器自己兜底供给的包）---');
const entryNames = resolution.entries.map((e) => e.name);
for (const e of resolution.entries) {
  if (e.name.includes('shader') || e.name.includes('image-gen') || e.name.includes('godot') || e.name.includes('three-video')) {
    console.log(`    ★ ${e.name}  scope=${e.scope}  dir=${e.packageDir}`);
  }
}
console.log(`  小计 ${entryNames.length} 个；含 dsh-shader-workbench = ${entryNames.includes('dsh-shader-workbench')}`);

console.log('');
console.log('--- 对照：几个已知能加载的插件在哪儿 ---');
for (const name of ['dsh-image-gen', 'godot-bridge', 'dsh-shader-workbench', 'dsh-three-video']) {
  const inLocal = locals.includes(name);
  const inLinked = resolution.linkedRoots.some((r) => r.name === name);
  const inEntries = entryNames.includes(name);
  const isLayer = profile.layers.some((l) => l.packageName === name);
  console.log(
    `    ${name.padEnd(22)} layer=${isLayer ? 'Y' : 'n'}  local=${inLocal ? 'Y' : 'n'}  linked=${inLinked ? 'Y' : 'n'}  entry=${inEntries ? 'Y' : 'n'}`,
  );
}
