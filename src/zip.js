/*
 * zip.js — 极简 ZIP 读写（无依赖）
 *  · 写：只做 store（不压缩），音视频本身已压缩，打包/解包快、稳
 *  · 读：支持 store(0) 与 deflate(8)；deflate 用浏览器内建的 DecompressionStream
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function dosTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {Array<{name:string, data: Uint8Array|Blob|string}>} entries
 * @param {(done:number, total:number, name:string)=>void} onProgress
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, onProgress) {
  const { time, day } = dosTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  let done = 0;

  for (const entry of entries) {
    let bytes;
    if (entry.data instanceof Uint8Array) bytes = entry.data;
    else if (typeof entry.data === 'string') bytes = enc.encode(entry.data);
    else if (entry.data instanceof Blob) bytes = new Uint8Array(await entry.data.arrayBuffer());
    else continue;

    const nameBytes = enc.encode(entry.name);
    const crc = crc32(bytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0x0800, true);    // UTF-8 flag
    lv.setUint16(8, 0, true);         // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push(local, bytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);        // version made by
    cv.setUint16(6, 20, true);        // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + bytes.length;
    done++;
    onProgress?.(done, entries.length, entry.name);
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...locals, ...centrals, eocd], { type: 'application/zip' });
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持解开压缩的 zip（请用 Safari 16.4+ / 新版 Chrome）');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 读 zip（只取需要的条目）
 * @returns {Promise<Map<string, {bytes:Uint8Array, method:number}>>}
 */
export async function readZip(arrayBuffer, onProgress) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : await arrayBuffer.arrayBuffer();
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // 找 EOCD（从尾部往前扫，最多 64KB 注释）
  let eocd = -1;
  const minPos = Math.max(0, buf.byteLength - 65557);
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const out = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 本地头
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataStart, dataStart + compSize);
    out.set(name, { raw, method, name });
    onProgress?.(i + 1, count, name);
  }

  // 按需解压
  return {
    names: [...out.keys()],
    has: (n) => out.has(n),
    async bytes(name) {
      const e = out.get(name);
      if (!e) return null;
      if (e.method === 0) return e.raw;
      if (e.method === 8) return inflateRaw(e.raw);
      throw new Error(`不支持的压缩方式 ${e.method}`);
    },
    async text(name) {
      const b = await this.bytes(name);
      return b ? dec.decode(b) : null;
    },
  };
}
