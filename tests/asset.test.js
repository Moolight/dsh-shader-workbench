/**
 * 资源系统测试：类型注册表、清单归一化、导入 / 列出 / 移除，
 * 以及 workspace 那层 texture / audio / lyric 便捷封装。
 *
 * 为什么值得测：这套东西出过一次**半迁移事故** —— 资源统一进 `resources[]` 之后，
 * 旧的 `manifest.textures` / `manifest.audio` / `manifest.lyric` 三个顶层字段被
 * `normalizeManifest` 移除，但 workspace 的 import / unbind / clear 还在写它们：
 *
 *   - `importTexture` / `unbindTexture`：归一化对象上没有 `textures` →
 *     `manifest.textures.filter(...)` 直接 `TypeError`
 *   - `importAudio`：用了**没 import 的 `statSync`** → `ReferenceError`
 *   - `clearAudio` / `clearLyric`：`delete manifest.audio` 删的是不存在的属性 → 解绑无效
 *   - `readAudio` / `readLyric`：读 `manifest.audio` / `manifest.lyric`（恒 `undefined`）
 *     → "显式指定文件名"那一档永远走不到
 *
 * 一句话纪律：**所有写入都落在 `resources[]` 上，谁也别再碰那三个旧字段。**
 * 这组测试就是钉这条的。
 *
 * 跑法：node tests/asset.test.js
 *
 * @module dsh-shader-workbench/tests/asset
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workspace } from '../host/workspace.js';
import { listAssets, importAsset, removeAsset } from '../host/asset-loader.js';
import {
  getAssetType,
  listAssetTypes,
  matchAssetType,
  normalizeAsset,
} from '../shared/asset-types.js';
import { normalizeManifest } from '../shared/manifest.js';

const tempRoot = await mkdtemp(join(tmpdir(), 'shader-wb-asset-'));
const workspace = new Workspace(join(tempRoot, 'ws'));

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 在临时目录里造一个源文件，返回绝对路径。 */
async function makeSource(name, bytes = 'x') {
  const p = join(tempRoot, name);
  await writeFile(p, bytes);
  return p;
}

/** 建一个干净的材质，返回它的 material.json 绝对路径。 */
async function freshMaterial(project, material) {
  await workspace.init();
  await workspace.createProject({ name: project });
  await workspace.createMaterial({ project, name: material });
  return join(workspace.root, 'projects', project, 'materials', material, 'material.json');
}

/** 读回材质的原始 JSON（**不经过 normalizeManifest**，好直接看磁盘上有什么）。 */
const readRaw = async (manifestPath) => JSON.parse(await readFile(manifestPath, 'utf8'));

// ─────────────────────── 1. 类型注册表 ───────────────────────

test('资源类型注册表：图片 / 音频 / 歌词都在，扩展名能认出来', () => {
  assert.ok(getAssetType('texture'), '缺 texture 类型');
  assert.ok(getAssetType('audio'), '缺 audio 类型');
  assert.ok(getAssetType('lyric'), '缺 lyric 类型');
  assert.ok(listAssetTypes().length >= 3);

  assert.equal(matchAssetType('a.png')?.type, 'texture');
  assert.equal(matchAssetType('b.MP3')?.type, 'audio', '扩展名匹配要不分大小写');
  assert.equal(matchAssetType('c.lrc')?.type, 'lyric');
  assert.equal(matchAssetType('d.unknownext'), null, '认不出的扩展名要返回 null');

  // 默认槽位：音频占 iChannel0、图片让开占 iChannel1（两个都丢进目录也能同时挂上）
  assert.equal(getAssetType('audio').defaultSlot, 'iChannel0');
  assert.equal(getAssetType('texture').defaultSlot, 'iChannel1');
  assert.equal(getAssetType('lyric').singleton, true, '歌词应该是单例');
  assert.equal(getAssetType('lyric').requiresSlot, false, '歌词不占通道槽位');
});

test('normalizeAsset 给出稳定 id、只给占槽位的类型带 slot', () => {
  const tex = normalizeAsset({ type: 'texture', path: 'textures/a.png' });
  assert.equal(tex.type, 'texture');
  assert.equal(tex.slot, 'iChannel1', '没给 slot 要用默认槽');
  assert.ok(tex.id, '要自动生成 id');

  const lyric = normalizeAsset({ type: 'lyric', path: 'lyric.lrc' });
  assert.equal(lyric.slot, undefined, '歌词不该有 slot');

  assert.equal(normalizeAsset({ type: '不存在', path: 'x' }), null);
  assert.equal(normalizeAsset({ type: 'texture', path: '' }), null);
});

// ─────────────────────── 2. 清单归一化 ───────────────────────

test('normalizeManifest：旧的 textures / audio / lyric 三个字段都归并进 resources[]', () => {
  const out = normalizeManifest({
    name: 'old',
    textures: [{ slot: 'iChannel2', path: 'textures/t.png', type: 'image' }],
    audio: 'song.mp3',
    lyric: 'lyric.lrc',
  });

  assert.ok(Array.isArray(out.resources));
  const types = out.resources.map((r) => r.type).sort();
  assert.deepEqual(types, ['audio', 'lyric', 'texture'], '三个旧字段都要归并进来');

  // 旧字段本身不再出现在归一化结果里 —— 这是"写的时候不再输出"的前提
  assert.equal(out.textures, undefined);
  assert.equal(out.audio, undefined);
  assert.equal(out.lyric, undefined);

  const tex = out.resources.find((r) => r.type === 'texture');
  assert.equal(tex.slot, 'iChannel2', '旧 textures[] 里指定的槽位要保住');
  assert.equal(out.resources.find((r) => r.type === 'audio').slot, 'iChannel0');
});

test('normalizeManifest：旧字段归并出的 id 是稳定的（前端拿到的和服务端再算的一致）', () => {
  // 如果 id 随机，前端拿到的 id 和服务端再读一次生成的 id 就永远对不上，
  // 所有从旧字段归并来的资源一律 404。
  const src = { name: 'old', textures: [{ slot: 'iChannel1', path: 'textures/t.png' }], lyric: 'l.lrc' };
  const a = normalizeManifest(src).resources.map((r) => r.id).sort();
  const b = normalizeManifest(src).resources.map((r) => r.id).sort();
  assert.deepEqual(a, b, '两次归一化的 id 必须一样');
});

// ─────────────────────── 3. 统一资源 API ───────────────────────

test('asset.import / list / remove：引用一律写进 resources[]', async () => {
  const mp = await freshMaterial('p1', 'm1');
  const png = await makeSource('tex.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { asset } = await importAsset(workspace, {
    project: 'p1', material: 'm1', type: 'texture', sourcePath: png, slot: 'iChannel0',
  });
  assert.equal(asset.type, 'texture');
  assert.equal(asset.slot, 'iChannel0');

  const raw = await readRaw(mp);
  assert.deepEqual(raw.resources.map((r) => r.type), ['texture'], '导入后 resources[] 里要有它');
  assert.equal(raw.textures, undefined, '不该再写出旧的 textures 字段');

  const { resources } = await listAssets(workspace, { project: 'p1', material: 'm1' });
  assert.ok(resources.some((r) => r.id === asset.id));

  const removed = await removeAsset(workspace, { project: 'p1', material: 'm1', id: asset.id });
  assert.equal(removed.removed, 1);
  assert.deepEqual((await readRaw(mp)).resources, []);
});

test('同类型的同槽位只留最新一条（换图不会越挂越多）', async () => {
  const mp = await freshMaterial('p2', 'm2');
  const a = await makeSource('a.png', Buffer.from([1]));
  const b = await makeSource('b.png', Buffer.from([2]));

  await importAsset(workspace, { project: 'p2', material: 'm2', type: 'texture', sourcePath: a, slot: 'iChannel0' });
  await importAsset(workspace, { project: 'p2', material: 'm2', type: 'texture', sourcePath: b, slot: 'iChannel0' });

  const tex = (await readRaw(mp)).resources.filter((r) => r.type === 'texture' && r.slot === 'iChannel0');
  assert.equal(tex.length, 1, '同一个槽位只能留一条');
  assert.ok(tex[0].path.endsWith('b.png'), '留下的应该是最新导入的那个');
});

// ─────────────────────── 4. workspace 便捷封装（回归）───────────────────────

test('importTexture / unbindTexture：写 resources[]，不再碰 manifest.textures', async () => {
  const mp = await freshMaterial('p3', 'm3');
  const png = await makeSource('tex2.png', Buffer.from([0x89, 0x50]));

  const { ref } = await workspace.importTexture({
    project: 'p3', material: 'm3', sourcePath: png, slot: 'iChannel2',
  });
  assert.equal(ref.slot, 'iChannel2', '返回的 ref 要带槽位（面板要用它打日志）');
  assert.ok(ref.path.startsWith('textures/'), '纹理要落在 textures/ 下');

  let raw = await readRaw(mp);
  assert.equal(raw.textures, undefined, '回归：不许再写 manifest.textures');
  assert.equal(raw.resources.filter((r) => r.type === 'texture').length, 1);
  assert.equal(raw.resources[0].meta?.source, 'local', '来源信息进 meta');

  const un = await workspace.unbindTexture({ project: 'p3', material: 'm3', slot: 'iChannel2' });
  assert.equal(un.removed, 1);
  raw = await readRaw(mp);
  assert.equal(raw.resources.filter((r) => r.type === 'texture').length, 0);
});

test('importAudio / readAudio / clearAudio：整条链路走 resources[]（回归：statSync 崩溃）', async () => {
  const mp = await freshMaterial('p4', 'm4');
  const mp3 = await makeSource('song.mp3', 'not-really-audio');

  // 旧实现在这里抛 ReferenceError: statSync is not defined
  const imported = await workspace.importAudio({ project: 'p4', material: 'm4', sourcePath: mp3 });
  assert.equal(imported.audio, 'song.mp3', '音频落在材质根目录、用原名');
  assert.equal((await readRaw(mp)).audio, undefined, '回归：不许再写顶层 audio 字段');

  const audioRes = (await readRaw(mp)).resources.filter((r) => r.type === 'audio');
  assert.equal(audioRes.length, 1);
  assert.equal(audioRes[0].slot, 'iChannel0', '音频默认占 iChannel0');

  assert.deepEqual(await workspace.readAudio('p4', 'm4'), { audio: 'song.mp3' });

  const cleared = await workspace.clearAudio({ project: 'p4', material: 'm4' });
  assert.equal(cleared.cleared, 'song.mp3', '清掉要回报摘掉的是哪个');
  assert.equal((await readRaw(mp)).resources.filter((r) => r.type === 'audio').length, 0);
});

test('importLyric / readLyric / clearLyric：登记 resources[]，且是单例', async () => {
  const mp = await freshMaterial('p5', 'm5');

  const first = await workspace.importLyric({
    project: 'p5', material: 'm5', content: '[00:01.00]第一句',
  });
  assert.equal(first.lyric, 'lyric.lrc', '歌词用固定文件名，重复导入即替换');

  let lyrics = (await readRaw(mp)).resources.filter((r) => r.type === 'lyric');
  assert.equal(lyrics.length, 1);
  assert.equal((await readRaw(mp)).lyric, undefined, '回归：不许再写顶层 lyric 字段');

  // 再导一次：单例，还是只有一条
  await workspace.importLyric({ project: 'p5', material: 'm5', content: '[00:02.00]换一版' });
  lyrics = (await readRaw(mp)).resources.filter((r) => r.type === 'lyric');
  assert.equal(lyrics.length, 1, '歌词是单例，重复导入不该越攒越多');

  const read = await workspace.readLyric('p5', 'm5');
  assert.equal(read.lyric, 'lyric.lrc');
  assert.match(read.content, /换一版/);

  const cleared = await workspace.clearLyric({ project: 'p5', material: 'm5' });
  assert.equal(cleared.cleared, 'lyric.lrc');
  assert.equal((await readRaw(mp)).resources.filter((r) => r.type === 'lyric').length, 0);
});

test('读歌词有扫目录兜底：文件在目录里就算没登记也读得到（"文件即事实来源"）', async () => {
  await freshMaterial('p6', 'm6');
  const dir = join(workspace.root, 'projects', 'p6', 'materials', 'm6');
  await writeFile(join(dir, '随便一首.lrc'), '[00:03.00]手动丢进去的');

  const read = await workspace.readLyric('p6', 'm6');
  assert.equal(read.lyric, '随便一首.lrc', '没登记也要能靠扫目录认出 .lrc');
  assert.match(read.content, /手动丢进去的/);
});
