/**
 * 零依赖 ZIP 打包器（只实现 store 模式，不压缩）。
 *
 * ## 为什么自己写
 *
 * 工作台是**零依赖 + 全离线**的插件，不能为了导出一个 zip 就拉 `archiver` / `jszip`。
 * 而 ZIP 的 store 模式（不压缩）结构很简单：本地头 + 数据 + 中央目录 + 目录结束记录，
 * 一共三种记录，几百行就够。
 *
 * ## 为什么用 store 而不是 deflate
 *
 * 导出的是 `graph.json` / `.frag` / `.hlsl` 这类文本和图片，本来就不大；
 * 而且 Node 的 `zlib` 是内置的但浏览器不是，用 store 就能**两端同一份代码**。
 * 真要压缩，交给用户的解压工具即可（ZIP 客户端会自己处理）。
 *
 * ## 兼容性
 *
 * - 文件名用 UTF-8，并在通用标志位里置 `0x0800`（EFS 位），中文文件名不会乱码；
 * - 不写 zip64，条目数与总大小超 4GB 会明确报错而不是悄悄产出一个坏包；
 * - 时间戳用固定值（1980-01-01），保证**同样输入产出逐字节相同的 zip**，
 *   这样测试可以直接比对字节，而不是「看起来差不多」。
 *
 * @module dsh-shader-workbench/shared/zip
 */

/** CRC-32 查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 算 CRC-32。
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP 允许的最大值（不写 zip64 的硬上限）。 */
const MAX_UINT32 = 0xffffffff;

/** 固定的 DOS 时间戳：1980-01-01 00:00:00，保证可复现。 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 年偏移 0（1980）+ 月 1 + 日 1

/** 把内容统一成字节。 */
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('ZIP：内容必须是字符串 / Uint8Array / ArrayBuffer');
}

/** 文件名规范化：ZIP 一律用 `/`，且不能以 `/` 开头。 */
function normalizeName(name) {
  const cleaned = String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned) throw new Error('ZIP：文件名不能为空');
  if (cleaned.includes('..')) throw new Error(`ZIP：文件名不能包含 ..（${name}）`);
  return cleaned;
}

/** 一个小端写入器。 */
class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  /** 写一个 Uint8Array。 */
  bytes(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }

  /** 写一个 16 位小端整数。 */
  u16(value) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, true);
    return this.bytes(buf);
  }

  /** 写一个 32 位小端整数。 */
  u32(value) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0, true);
    return this.bytes(buf);
  }

  /** 合并成一份。 */
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/**
 * 打包成一个 ZIP。
 *
 * @param {Array<{name:string, data:string|Uint8Array|ArrayBuffer}>} entries
 * @returns {Uint8Array}
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP：至少要有一个条目');
  if (entries.length > 0xffff) throw new Error(`ZIP：条目数 ${entries.length} 超过 65535（未实现 zip64）`);

  const files = entries.map((entry) => {
    const name = normalizeName(entry.name);
    const nameBytes = new TextEncoder().encode(name);
    const data = toBytes(entry.data);
    if (data.length > MAX_UINT32) throw new Error(`ZIP：${name} 超过 4GB（未实现 zip64）`);
    return { name, nameBytes, data, crc: crc32(data), offset: 0 };
  });

  const out = new ByteWriter();

  // ── 本地文件头 + 数据 ──
  for (const file of files) {
    file.offset = out.length;
    out.u32(0x04034b50);          // 本地文件头签名
    out.u16(20);                  // 解压所需版本 2.0
    out.u16(0x0800);              // 通用标志：文件名为 UTF-8
    out.u16(0);                   // 压缩方法：0 = store
    out.u16(DOS_TIME);
    out.u16(DOS_DATE);
    out.u32(file.crc);
    out.u32(file.data.length);    // 压缩后大小（store 模式等于原始大小）
    out.u32(file.data.length);    // 原始大小
    out.u16(file.nameBytes.length);
    out.u16(0);                   // 扩展字段长度
    out.bytes(file.nameBytes);
    out.bytes(file.data);
  }

  // ── 中央目录 ──
  const centralStart = out.length;
  for (const file of files) {
    out.u32(0x02014b50);          // 中央目录头签名
    out.u16(20);                  // 制作版本
    out.u16(20);                  // 解压所需版本
    out.u16(0x0800);              // 通用标志
    out.u16(0);                   // 压缩方法
    out.u16(DOS_TIME);
    out.u16(DOS_DATE);
    out.u32(file.crc);
    out.u32(file.data.length);
    out.u32(file.data.length);
    out.u16(file.nameBytes.length);
    out.u16(0);                   // 扩展字段长度
    out.u16(0);                   // 注释长度
    out.u16(0);                   // 起始磁盘号
    out.u16(0);                   // 内部属性
    out.u32(0);                   // 外部属性
    out.u32(file.offset);         // 本地头偏移
    out.bytes(file.nameBytes);
  }
  const centralSize = out.length - centralStart;

  // ── 中央目录结束记录 ──
  out.u32(0x06054b50);
  out.u16(0);                     // 本磁盘号
  out.u16(0);                     // 中央目录所在磁盘号
  out.u16(files.length);          // 本磁盘条目数
  out.u16(files.length);          // 总条目数
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0);                     // 注释长度

  return out.done();
}

/**
 * 读一个自己产出的 ZIP 的条目清单（**只用于测试和自检**）。
 *
 * 它不实现解压，只走一遍中央目录把「名字 / 大小 / CRC / 偏移」读出来，
 * 再按偏移把数据切出来核对 CRC。所以它能证明包是自洽的，
 * 但不能替代真正的解压器 —— 文档里写明了这一点。
 *
 * @param {Uint8Array} bytes
 * @returns {{entries:Array<{name:string, size:number, crc:number, data:Uint8Array}>, errors:string[]}}
 */
export function readZip(bytes) {
  const errors = [];
  const entries = [];
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 从尾部找「中央目录结束记录」（它是最长 22 + 注释 65535 字节的尾部结构）
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { entries, errors: ['找不到中央目录结束记录'] };

  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset + centralSize > buf.length) errors.push('中央目录越出文件末尾');

  let at = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length) { errors.push(`第 ${i} 个中央目录项越界`); break; }
    if (view.getUint32(at, true) !== 0x02014b50) { errors.push(`第 ${i} 个中央目录项签名不对`); break; }
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLength));

    // 顺着本地头把数据切出来
    let data = new Uint8Array(0);
    if (localOffset + 30 <= buf.length && view.getUint32(localOffset, true) === 0x04034b50) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      data = buf.subarray(start, start + size);
      if (crc32(data) !== crc) errors.push(`${name} 的 CRC 对不上`);
    } else {
      errors.push(`${name} 的本地文件头不对`);
    }

    entries.push({ name, size, crc, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, errors };
}
