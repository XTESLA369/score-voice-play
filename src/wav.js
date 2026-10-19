/*
 * wav.js — 把 Float32 单声道样本编码成 16-bit PCM WAV
 * 用途：录音响度标准化后写回本机，播放时不再需要 WebAudio 增益（iOS 上会掉采样）
 */

/** 峰值软限幅：小幅信号完全线性，超过 knee 的部分平滑压缩，避免爆音又不"抽气" */
export function softLimitInPlace(samples, knee = 0.7) {
  const t = Math.max(0.1, Math.min(0.98, knee));
  const span = 1 - t;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const a = x < 0 ? -x : x;
    if (a <= t) continue;
    const shaped = t + span * Math.tanh((a - t) / span);
    samples[i] = x < 0 ? -shaped : shaped;
  }
  return samples;
}

/**
 * @param {Float32Array} samples 单声道 [-1,1]
 * @param {number} sampleRate
 * @returns {Blob} audio/wav
 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);       // PCM 头长度
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // 位深
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** 解析 WAV（只支持 16-bit PCM，够用于自测/导入校验） */
export function decodeWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const str = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('不是 WAV');
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= view.byteLength) {
    const id = str(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 结构不完整');
  if (fmt.bits !== 16 || fmt.format !== 1) throw new Error('只支持 16-bit PCM');
  const frames = Math.floor(dataLen / 2 / fmt.channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const v = view.getInt16(dataOff + (i * fmt.channels + c) * 2, true);
      sum += v < 0 ? v / 0x8000 : v / 0x7fff;
    }
    samples[i] = sum / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
}
