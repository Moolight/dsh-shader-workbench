/**
 * 零依赖 ZIP 打包器测试。
 *
 * ## 这个文件在守什么
 *
 * ZIP 是**外部世界要读的格式**：解压工具、CI、别的机器上的同事。所以「我们的
 * readZip 能读回来」不算数 —— 那只证明编解码自洽，不证明包合规。
 *
 * 于是这里的断言分成三层：
 *   1. **格式层**：三个签名（本地头 / 中央目录 / 结束记录）、EFS 标志位、
 *      store 方法号、条目数与偏移 —— 这些是 ZIP 规范里写死的字节，位置错了
 *      别的解压器就会拒收；
 *   2. **内容层**：CRC-32 对标准向量（`123456789` → `0xCBF43926`），
 *      条目内容逐字节还原；
 *   3. **可复现层**：同样输入产出**逐字节相同**的包。时间戳故意写成固定值，
 *      否则「同一份材质打两次包结果不一样」会让缓存、diff、校验全失效。
 *
 * 还有一条**反向**测试：把数据区改一个字节，`readZip` 必须报 CRC 对不上。
 * 只会说"没问题"的校验器等于没有校验器。
 *
 * ## 验不到的地方（写清楚，不含糊）
 *
 * `readZip` 是**自检工具**，不实现解压（store 模式本来也不需要解压）。
 * 它证明不了「Windows 资源管理器 / unzip / 7-Zip 能打开」—— 那需要真的跑一遍
 * 外部解压器，本机没有可依赖的。所以格式层断言才写得这么细：规范的字节摆在那里。
 *
 * 跑法：node tests/zip.test.js
 *
 * @module dsh-shader-workbench/tests/zip
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, createZip, readZip } from '../shared/zip.js';

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);

/** 把 string / Uint8Array 统一成字节数组，方便逐字节比。 */
const toBytes = (data) => (data instanceof Uint8Array ? data : enc(data));

/** 把字节包成 DataView，用来按偏移读字段。 */
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

test('CRC-32 对得上标准测试向量', () => {
  // 空串
  assert.equal(crc32(enc('')), 0);
  // 这个向量是 CRC-32/ISO-HDLC 的公认值，写死在这里当锚点
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(enc('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  // 二进制（不是文本）也要能算：0x00 开头是最容易被字符串实现坑到的情况
  assert.equal(crc32(new Uint8Array([0])), 0xd202ef8d);
});

test('createZip → readZip：条目名、内容、CRC 全部对得上', () => {
  const files = [
    { name: 'graph.json', data: JSON.stringify({ nodes: [], edges: [] }) },
    { name: 'shader.frag', data: 'void main() { gl_FragColor = vec4(1.0); }\n' },
    { name: 'textures/木纹.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ];
  const zip = createZip(files);
  const { entries, errors } = readZip(zip);

  assert.deepEqual(errors, [], `readZip 报错了：${errors.join('；')}`);
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name), '条目名或顺序变了');
  for (const [i, file] of files.entries()) {
    const want = toBytes(file.data);
    assert.equal(entries[i].size, want.length, `${file.name} 的大小不对`);
    assert.equal(entries[i].crc, crc32(want), `${file.name} 的 CRC 不对`);
    assert.deepEqual([...entries[i].data], [...want], `${file.name} 的内容不对`);
  }
});

test('包结构合规：三个签名、EFS 标志、store 方法号、条目数', () => {
  const zip = createZip([{ name: '中文名.txt', data: '你好，世界' }]);
  const dv = view(zip);

  // 本地文件头
  assert.equal(dv.getUint32(0, true), 0x04034b50, '开头不是本地文件头签名');
  // 通用标志位第 11 位（0x0800）= 文件名是 UTF-8；不置的话中文名在别的解压器里会乱码
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, '没有置 EFS 位，中文文件名会乱码');
  assert.equal(dv.getUint16(8, true), 0, '压缩方法必须是 0（store）');

  // 中央目录结束记录：没有注释时它固定占最后 22 字节
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, '末尾不是中央目录结束记录');
  assert.equal(dv.getUint16(eocd + 10, true), 1, '结束记录里的条目数不对');

  // 中央目录起始偏移必须指到一个真的中央目录头
  const centralStart = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(centralStart, true), 0x02014b50, '中央目录起始偏移指错了地方');

  // 本地头里的偏移必须指回本地头
  assert.equal(dv.getUint32(centralStart + 42, true), 0, '中央目录项里的本地头偏移不对');
});

test('中文文件名走 UTF-8 原样往返', () => {
  const names = ['材质/木纹.png', '说明.txt', '项目/子目录/很深/文件.bin'];
  const { entries, errors } = readZip(createZip(names.map((name) => ({ name, data: name }))));
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.name), names);
  for (const entry of entries) assert.equal(dec(entry.data), entry.name);
});

test('同样输入产出逐字节相同的包（时间戳是固定值）', () => {
  const build = () => createZip([
    { name: 'a.txt', data: 'A' },
    { name: 'b/c.txt', data: 'C' },
  ]);
  assert.deepEqual([...build()], [...build()], '两次打包结果不一样，包不可复现');

  // 换个"当前时间"再打一次也必须一样 —— 说明包内容真的和时钟无关
  const realNow = Date.now;
  try {
    Date.now = () => 1;
    const one = build();
    Date.now = () => 1_800_000_000_000;
    const two = build();
    assert.deepEqual([...one], [...two], '包内容跟着时钟变了');
  } finally {
    Date.now = realNow;
  }
});

test('文件名规范化：反斜杠换成 /，去掉开头的 /', () => {
  const { entries, errors } = readZip(createZip([
    { name: '\\a.png', data: 'x' },
    { name: 'textures\\b.png', data: 'y' },
  ]));
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.name), ['a.png', 'textures/b.png']);
});

test('空内容条目也是合法条目（大小 0、CRC 0）', () => {
  const { entries, errors } = readZip(createZip([{ name: 'empty.txt', data: '' }]));
  assert.deepEqual(errors, []);
  assert.equal(entries[0].size, 0);
  assert.equal(entries[0].crc, 0);
  assert.equal(entries[0].data.length, 0);
});

test('坏输入当场报错，不产出坏包', () => {
  assert.throws(() => createZip([]), /至少要有一个条目/);
  assert.throws(() => createZip('不是数组'), /至少要有一个条目/);
  assert.throws(() => createZip([{ name: '', data: 'x' }]), /文件名不能为空/);
  assert.throws(() => createZip([{ name: '../逃逸.txt', data: 'x' }]), /不能包含 \.\./);
  assert.throws(() => createZip([{ name: 'a/b/../c.txt', data: 'x' }]), /不能包含 \.\./);
  assert.throws(() => createZip([{ name: 'x.bin', data: 42 }]), /必须是字符串/);
  assert.throws(() => createZip([{ name: 'x.bin', data: null }]), /必须是字符串/);
});

test('内容被改坏时 readZip 报 CRC 对不上（校验器真的在校验）', () => {
  const zip = createZip([{ name: 'a.txt', data: 'hello world' }]);
  // 本地头 30 字节 + 文件名，之后就是数据区
  const dataAt = 30 + enc('a.txt').length;
  const broken = zip.slice();
  broken[dataAt + 3] ^= 0xff;

  const { entries, errors } = readZip(broken);
  assert.equal(entries.length, 1, '条目还是应该能列出来');
  assert.ok(
    errors.some((e) => /CRC 对不上/.test(e)),
    `改坏了内容却没报 CRC 错误：${errors.join('；') || '（没有错误）'}`,
  );
});

test('readZip 拿到非 zip 数据不抛异常，而是明确说找不到结束记录', () => {
  for (const junk of ['这不是一个 zip', '', 'PK', 'x'.repeat(200)]) {
    const { entries, errors } = readZip(enc(junk));
    assert.deepEqual(entries, []);
    assert.deepEqual(errors, ['找不到中央目录结束记录'], `输入 ${JSON.stringify(junk.slice(0, 12))} 时的报错不对`);
  }
});

test('条目多的时候中央目录照样走得完（顺序与内容都不乱）', () => {
  const files = Array.from({ length: 200 }, (_, i) => ({
    name: `materials/demo/file-${String(i).padStart(3, '0')}.txt`,
    data: `第 ${i} 个文件\n`,
  }));
  const { entries, errors } = readZip(createZip(files));
  assert.deepEqual(errors, []);
  assert.equal(entries.length, files.length);
  assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
  assert.equal(dec(entries[137].data), '第 137 个文件\n');
});

test('导出 ZIP 的形状：说明.txt 在最前、材质文件带目录前缀', () => {
  // 这条钉的是 host 侧 material.exportZip 的条目约定 —— 换实现也得守
  const material = 'demo';
  const files = [
    { rel: 'graph.json', full: '/x/graph.json' },
    { rel: 'shader.frag', full: '/x/shader.frag' },
    { rel: 'textures/a.png', full: '/x/textures/a.png' },
  ];
  const entries = [
    { name: '说明.txt', data: '材质：demo\n' },
    ...files.map((f) => ({ name: `${material}/${f.rel}`, data: f.rel })),
  ];
  const { entries: back, errors } = readZip(createZip(entries));
  assert.deepEqual(errors, []);
  assert.equal(back[0].name, '说明.txt');
  assert.deepEqual(back.slice(1).map((e) => e.name), [
    'demo/graph.json',
    'demo/shader.frag',
    'demo/textures/a.png',
  ]);
});
