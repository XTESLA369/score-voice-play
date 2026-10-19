/*
 * audio.js — 解码、重采样、波形峰值、时间格式化
 */

let sharedCtx = null;

export function audioContext() {
  if (!sharedCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持 Web Audio');
    sharedCtx = new AC();
  }
  return sharedCtx;
}

export async function resumeAudio() {
  const ctx = audioContext();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  return ctx;
}

/** 把 Blob 解码成 AudioBuffer（失败返回 null） */
export async function decodeBlob(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = audioContext();
  try {
    return await ctx.decodeAudioData(buf.slice(0));
  } catch (err) {
    // 某些浏览器需要先 resume 或对切片敏感，重试一次
    try {
      await resumeAudio();
      return await ctx.decodeAudioData(buf.slice(0));
    } catch {
      console.warn('[audio] 解码失败', err && err.message);
      return null;
    }
  }
}

/** AudioBuffer → 单声道 Float32Array（多声道取平均） */
export function toMono(buffer) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  if (ch === 1) return Float32Array.from(buffer.getChannelData(0));
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += d[i] / ch;
  }
  return out;
}

/** 线性插值重采样到目标采样率 */
export function resample(samples, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || fromRate === toRate || fromRate <= 0) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * 计算波形峰值（min/max 对），用于 canvas 绘制。
 * @returns {Float32Array} 长度 buckets*2，交错 [min,max,...]，值域 -1..1
 */
export function computePeaks(samples, buckets = 3000) {
  const n = samples.length;
  const peaks = new Float32Array(buckets * 2);
  if (!n) return peaks;
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
    let lo = 1;
    let hi = -1;
    for (let i = s; i < e; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo > hi) { lo = 0; hi = 0; }
    peaks[b * 2] = lo;
    peaks[b * 2 + 1] = hi;
  }
  return peaks;
}

/** 轻量降采样，供特征提取（分析在 22050Hz 足够） */
export function prepareForAnalysis(buffer, targetRate = 22050) {
  const mono = toMono(buffer);
  const rate = buffer.sampleRate;
  if (rate > targetRate * 1.6) {
    return { samples: resample(mono, rate, targetRate), sampleRate: targetRate };
  }
  return { samples: mono, sampleRate: rate };
}

/* ------------------------- 时间格式化 ------------------------- */

export function fmtTime(t, { decimals = 2 } = {}) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(decimals);
  return `${m}:${ss.padStart(decimals ? 3 + decimals : 2, '0')}`;
}

export function fmtShort(t) {
  if (!Number.isFinite(t)) return '--';
  return fmtTime(t, { decimals: 2 });
}

export function parseTime(str) {
  if (typeof str !== 'string') return NaN;
  const s = str.trim().replace(/：/g, ':').replace(/~/g, '');
  if (!s) return NaN;
  const parts = s.split(':');
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return NaN;
    return m * 60 + sec;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '--';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** 归一化响度（就地缩放），用于录音电平太小的场景 */
export function normalizeInPlace(samples, targetPeak = 0.92) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return 0;
  const g = Math.min(8, targetPeak / peak);
  if (g > 1.02) for (let i = 0; i < samples.length; i++) samples[i] *= g;
  return g;
}

/** 峰值 / RMS（dBFS），可选只统计一段区间 */
export function loudnessReport(samples, sampleRate, { from = 0, to = null } = {}) {
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(samples.length, Math.ceil((to == null ? samples.length / sampleRate : to) * sampleRate));
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
    n++;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -120);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms), samples: n };
}

/**
 * 计算「把这段录音拉到参考响度」需要的线性增益。
 * @param {{peak:number,rms:number}} take 录音响度
 * @param {number} targetRms 目标 RMS（线性，比如原声同段的 RMS）
 */
export function gainForLoudness(take, targetRms, { maxGain = 16, peakCeiling = 1.35 } = {}) {
  if (!take || !(take.rms > 1e-7) || !(targetRms > 1e-7)) return 1;
  let g = targetRms / take.rms;
  g = Math.min(maxGain, Math.max(1, g));
  // 峰值别冲太狠（后面还有压缩器兜底）
  if (take.peak > 1e-6) g = Math.min(g, Math.max(1, peakCeiling / take.peak));
  return Math.round(g * 100) / 100;
}
