#!/usr/bin/env node
/**
 * 一把跑完所有测试。
 *
 * 为什么不用 `node --test tests/`：
 *   那个跑法会为每个测试文件**派生子进程**。在 DSH 的文件沙箱下，
 *   带管道 stdio 的 spawn 会被拒（EPERM），所以这里改成顺序在同一个进程里 import。
 *
 * 跑法：node scripts/run-tests.mjs
 *
 * @module dsh-shader-workbench/scripts/run-tests
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TESTS_DIR = join(PROJECT, 'tests');

const entries = (await readdir(TESTS_DIR, { withFileTypes: true }))
  .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
  .map((e) => e.name)
  .sort();

if (entries.length === 0) {
  console.error('tests/ 下没有找到 *.test.js');
  process.exit(1);
}

console.log(`共 ${entries.length} 个测试文件\n`);

// node:test 在自己被 import 时会挂上进程退出钩子，把所有文件 import 完即可
for (const name of entries) {
  console.log(`── ${name} ──`);
  try {
    await import(pathToFileURL(join(TESTS_DIR, name)).href);
  } catch (error) {
    console.error(`导入失败：${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
