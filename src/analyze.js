/*
 * analyze.js — 纯 DSP / 评分引擎（无 DOM 依赖，可在浏览器与 Node 中运行）
 *
 *  提取: RMS、基频(NSDF/MPM)、12 维色度(chroma)、谱通量(onset)
 *  比对: 带宽约束 DTW 对齐 → 音准分 / 节奏分 / 综合分
 *
 *  钢琴（复音）→ 用 chroma + onset
 *  人声（单音）→ 用 F0(midi) + onset
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export function midiToName(m, withOctave = true) {
  if (!Number.isFinite(m)) return '';
  const r = Math.round(m);
  const name = NOTE_NAMES[((r % 12) + 12) % 12];
  return withOctave ? name + (Math.floor(r / 12) - 1) : name;
}
export function centsBetween(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return (b - a) * 100;
}

/* ------------------------------------------------------------------ *
 *  FFT（radix-2，迭代，原地）
 * ------------------------------------------------------------------ */

const twiddleCache = new Map();

function getTwiddles(n) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev, n };
  twiddleCache.set(n, t);
  return t;
}

/** 原地 FFT / IFFT（长度必须为 2 的幂）。inverse=true 时结果已除以 n。 */
export function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: re/im 长度不一致');
  const { cos, sin, rev, n: tn } = getTwiddles(n);
  if (tn !== n) throw new Error('fft: 长度必须是 2 的幂');
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sin[k] * sign;
        const a = i + j;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

/* ------------------------------------------------------------------ *
 *  基频检测（NSDF / McLeod Pitch Method）
 * ------------------------------------------------------------------ */

const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, w);
  return w;
}

/**
 * 对一个时域帧做 NSDF 基频估计。
 * @returns {{hz:number, clarity:number, rms:number}}
 */
export function detectPitch(frame, sampleRate, { minHz = 65, maxHz = 1200 } = {}) {
  const n = frame.length;
  let mean = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = frame[i] - mean; x[i] = v; energy += v * v; }
  const rms = Math.sqrt(energy / n);
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / minHz));
  if (maxLag <= minLag || rms < 1e-5) return { hz: 0, clarity: 0, rms };

  const size = 1 << Math.ceil(Math.log2(n * 2));
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  // 注意：NSDF 已自带能量归一化，这里不加窗（加窗会压低非零延迟的自相关）
  for (let i = 0; i < n; i++) re[i] = x[i];
  fftInPlace(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fftInPlace(re, im, true);
  const ac = re; // 线性自相关 r[τ]

  // 前缀和用于能量归一化
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i] * x[i];

  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const hi = n - lag;
    const m = (pre[hi] - pre[0]) + (pre[n] - pre[lag]);
    nsdf[lag] = m > 1e-12 ? (2 * ac[lag]) / m : 0;
  }

  let bestLag = -1;
  let bestVal = 0;
  let prevDown = true;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const v = nsdf[lag];
    const next = nsdf[lag + 1];
    if (v > bestVal && v >= nsdf[lag - 1] && v >= next) { bestVal = v; bestLag = lag; }
  }
  if (bestLag < 0 || bestVal <= 0) return { hz: 0, clarity: 0, rms };
  // 抑制倍频错误：取第一个达到最大值 88% 的峰
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    const v = nsdf[lag];
    if (v >= 0.88 * bestVal && v >= nsdf[lag - 1] && v >= nsdf[lag + 1]) { bestLag = lag; bestVal = v; break; }
  }
  // 抛物线插值
  let lagF = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = nsdf[bestLag - 1];
    const b = nsdf[bestLag];
    const c = nsdf[bestLag + 1];
    const denom = 2 * (2 * b - a - c);
    if (Math.abs(denom) > 1e-9) lagF = bestLag + (c - a) / denom;
  }
  const hz = sampleRate / lagF;
  return { hz, clarity: clamp01(bestVal), rms };
}

/* ------------------------------------------------------------------ *
 *  帧级特征提取
 * ------------------------------------------------------------------ */

export const MIN_CHROMA_HZ = 60;
export const MAX_CHROMA_HZ = 2400;

/**
 * @param {Float32Array} samples 单声道
 * @param {number} sampleRate
 * @param {{from?:number,to?:number,minHz?:number,maxHz?:number,maxSeconds?:number}} opts from/to 单位为秒
 */
export function extractFeatures(samples, sampleRate, opts = {}) {
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? samples.length / sampleRate, samples.length / sampleRate);
  const minHz = opts.minHz ?? 65;
  const maxHz = opts.maxHz ?? 1250;
  const maxSeconds = opts.maxSeconds ?? 240;

  let start = Math.max(0, Math.floor(from * sampleRate));
  let end = Math.min(samples.length, Math.ceil(Math.min(to, from + maxSeconds) * sampleRate));
  if (end - start < 2048) end = Math.min(samples.length, start + 2048);

  const fftSize = 1 << Math.max(9, Math.ceil(Math.log2(Math.max(512, sampleRate * 0.046))));
  const hop = Math.max(64, Math.round(fftSize / 4));
  const total = Math.max(1, Math.floor((end - start - fftSize) / hop) + 1);
  const frameCount = Math.max(1, total);

  const times = new Float32Array(frameCount);
  const chroma = new Float32Array(frameCount * 12);
  const onset = new Float32Array(frameCount);
  const midi = new Float32Array(frameCount).fill(NaN);
  const voiced = new Uint8Array(frameCount);
  const clarity = new Float32Array(frameCount);
  const rms = new Float32Array(frameCount);

  const win = hann(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const binHz = sampleRate / fftSize;
  const minBin = Math.max(1, Math.floor(MIN_CHROMA_HZ / binHz));
  const maxBin = Math.min(fftSize / 2 - 1, Math.ceil(MAX_CHROMA_HZ / binHz));
  const prevMag = new Float32Array(fftSize / 2);
  const mag = new Float32Array(fftSize / 2);
  const frameBuf = new Float32Array(fftSize);

  for (let f = 0; f < frameCount; f++) {
    const off = start + f * hop;
    times[f] = (off + fftSize / 2) / sampleRate;
    let e = 0;
    for (let i = 0; i < fftSize; i++) {
      const v = off + i < samples.length ? samples[off + i] : 0;
      frameBuf[i] = v;
      e += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / fftSize);
    fftInPlace(re, im, false);
    for (let k = 0; k < fftSize / 2; k++) mag[k] = Math.hypot(re[k], im[k]);

    // chroma
    const c = f * 12;
    let csum = 0;
    for (let k = minBin; k <= maxBin; k++) {
      const m = mag[k];
      if (m < 1e-4) continue;
      const freq = k * binHz;
      const pc = ((Math.round(hzToMidi(freq)) % 12) + 12) % 12;
      const w = m; // 线性幅度
      chroma[c + pc] += w;
      csum += w;
    }
    if (csum > 1e-6) {
      // 归一化 + 轻微压缩，避免单一强峰支配
      let sq = 0;
      for (let i = 0; i < 12; i++) { chroma[c + i] /= csum; sq += chroma[c + i] * chroma[c + i]; }
      const nrm = Math.sqrt(sq) || 1;
      for (let i = 0; i < 12; i++) chroma[c + i] /= nrm;
    }

    // 谱通量（onset）；首帧没有前帧可比，直接记 0
    let flux = 0;
    for (let k = minBin; k <= maxBin; k++) {
      const m = mag[k];
      const d = m - prevMag[k];
      if (d > 0) flux += d;
      prevMag[k] = m;
    }
    onset[f] = f === 0 ? 0 : flux;

    // 基频
    const p = detectPitch(frameBuf, sampleRate, { minHz, maxHz });
    clarity[f] = p.clarity;
    if (p.clarity >= 0.62 && p.rms > 2e-4 && p.hz > minHz && p.hz < maxHz) {
      voiced[f] = 1;
      midi[f] = hzToMidi(p.hz);
    }
  }

  // onset 归一化
  let omax = 0;
  for (let i = 0; i < frameCount; i++) omax = Math.max(omax, onset[i]);
  if (omax > 1e-9) for (let i = 0; i < frameCount; i++) onset[i] /= omax;

  return {
    sampleRate, fftSize, hop, frameCount, times,
    chroma, onset, midi, voiced, clarity, rms,
    duration: (end - start) / sampleRate,
  };
}

/** 按时间切片（秒），返回新的特征对象。 */
export function sliceFeatures(feat, from, to) {
  const t0 = from;
  const t1 = to;
  const idx = [];
  for (let i = 0; i < feat.frameCount; i++) {
    const t = feat.times[i];
    if (t >= t0 && t <= t1) idx.push(i);
  }
  if (!idx.length) idx.push(clamp(Math.round(((t0 + t1) / 2 / feat.duration) * (feat.frameCount - 1)), 0, feat.frameCount - 1));
  const n = idx.length;
  const out = {
    sampleRate: feat.sampleRate, fftSize: feat.fftSize, hop: feat.hop, frameCount: n,
    times: new Float32Array(n),
    chroma: new Float32Array(n * 12),
    onset: new Float32Array(n),
    midi: new Float32Array(n),
    voiced: new Uint8Array(n),
    clarity: new Float32Array(n),
    rms: new Float32Array(n),
    duration: n * feat.hop / feat.sampleRate,
  };
  for (let i = 0; i < n; i++) {
    const s = idx[i];
    out.times[i] = feat.times[s] - t0;
    out.onset[i] = feat.onset[s];
    out.midi[i] = feat.midi[s];
    out.voiced[i] = feat.voiced[s];
    out.clarity[i] = feat.clarity[s];
    out.rms[i] = feat.rms[s];
    for (let k = 0; k < 12; k++) out.chroma[i * 12 + k] = feat.chroma[s * 12 + k];
  }
  // 重新归一化 onset
  let omax = 0;
  for (let i = 0; i < n; i++) omax = Math.max(omax, out.onset[i]);
  if (omax > 1e-9) for (let i = 0; i < n; i++) out.onset[i] /= omax;
  return out;
}

/**
 * 帧级下采样（factor 帧合成 1 帧）。用于超长段落的比对，
 * 把 DTW 的 n×m 内存压到安全范围（iPad 上很重要）。
 */
export function downsampleFeatures(feat, factor = 2) {
  if (!(factor > 1)) return feat;
  const n = Math.max(1, Math.floor(feat.frameCount / factor));
  const out = {
    sampleRate: feat.sampleRate, fftSize: feat.fftSize, hop: feat.hop * factor,
    frameCount: n, duration: feat.duration,
    times: new Float32Array(n),
    chroma: new Float32Array(n * 12),
    onset: new Float32Array(n),
    midi: new Float32Array(n).fill(NaN),
    voiced: new Uint8Array(n),
    clarity: new Float32Array(n),
    rms: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    let t = 0;
    let on = 0;
    let rmsMax = 0;
    let clar = 0;
    let bestMidi = NaN;
    let bestClar = -1;
    for (let k = 0; k < factor; k++) {
      const s = i * factor + k;
      if (s >= feat.frameCount) break;
      t += feat.times[s];
      if (feat.onset[s] > on) on = feat.onset[s];
      if (feat.rms[s] > rmsMax) rmsMax = feat.rms[s];
      clar += feat.clarity[s];
      if (feat.voiced[s] && feat.clarity[s] > bestClar) { bestClar = feat.clarity[s]; bestMidi = feat.midi[s]; }
      for (let p = 0; p < 12; p++) out.chroma[i * 12 + p] += feat.chroma[s * 12 + p] / factor;
    }
    out.times[i] = t / factor;
    out.onset[i] = on;
    out.rms[i] = rmsMax;
    out.clarity[i] = clar / factor;
    if (bestClar >= 0) { out.voiced[i] = 1; out.midi[i] = bestMidi; }
    let sq = 0;
    for (let p = 0; p < 12; p++) sq += out.chroma[i * 12 + p] * out.chroma[i * 12 + p];
    if (sq > 1e-9) { const nrm = Math.sqrt(sq); for (let p = 0; p < 12; p++) out.chroma[i * 12 + p] /= nrm; }
  }
  return out;
}

export const MAX_DTW_FRAMES = 2000;

/** 帧数过多时自动降采样，避免 DTW 的 n×m 矩阵把内存吃光 */
export function limitFrames(ref, take) {
  const factor = Math.max(1, Math.ceil(Math.max(ref.frameCount, take.frameCount) / MAX_DTW_FRAMES));
  if (factor <= 1) return [ref, take];
  return [downsampleFeatures(ref, factor), downsampleFeatures(take, factor)];
}

/* ------------------------------------------------------------------ *
 *  DTW（带宽约束，步进 1/1、1/0、0/1）
 * ------------------------------------------------------------------ */

export function dtwCost(costFn, n, m, bandRatio = 0.25, bandMin = 24) {
  const band = Math.max(bandMin, Math.ceil(bandRatio * Math.max(n, m)));
  const INF = 1e18;
  const width = Math.min(m, 2 * band + 1);
  const D = new Float64Array(n * width).fill(INF);
  const back = new Int8Array(n * width); // 0: diag 1: up(i-1,j) 2: left(i,j-1)
  const at = (i, j) => i * width + (j - i + band);
  const inBand = (i, j) => Math.abs(j - i) <= band && j >= 0 && j < m;

  for (let i = 0; i < n; i++) {
    const jLo = Math.max(0, i - band);
    const jHi = Math.min(m - 1, i + band);
    for (let j = jLo; j <= jHi; j++) {
      const cost = costFn(i, j);
      const idx = at(i, j);
      if (i === 0 && j === 0) { D[idx] = cost; back[idx] = 0; continue; }
      let best = INF;
      let dir = 0;
      // 先看对角：等代价时优先对角线，避免自比时路径漂移
      if (i > 0 && j > 0 && inBand(i - 1, j - 1)) {
        const v = D[at(i - 1, j - 1)];
        if (v < best) { best = v; dir = 0; }
      }
      if (i > 0 && inBand(i - 1, j)) {
        const v = D[at(i - 1, j)];
        if (v < best) { best = v; dir = 1; }
      }
      if (j > 0 && inBand(i, j - 1)) {
        const v = D[at(i, j - 1)];
        if (v < best) { best = v; dir = 2; }
      }
      D[idx] = cost + best;
      back[idx] = dir;
    }
  }
  // 回溯
  const path = [];
  let i = n - 1;
  let j = m - 1;
  while (true) {
    path.push([i, j]);
    if (i === 0 && j === 0) break;
    const dir = back[at(i, j)];
    if (dir === 0) { i -= 1; j -= 1; }
    else if (dir === 1) { i -= 1; }
    else { j -= 1; }
    if (i < 0 || j < 0) break;
  }
  path.reverse();
  return { cost: D[at(n - 1, m - 1)], path, band };
}

/* ------------------------------------------------------------------ *
 *  比对与评分
 * ------------------------------------------------------------------ */

function chromaDot(a, ai, b, bi) {
  let s = 0;
  for (let k = 0; k < 12; k++) s += a[ai + k] * b[bi + k];
  return s;
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx < 1e-9 || syy < 1e-9) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** 有效发声帧掩码（静音帧不参与音准/和声比较） */
export function activityMask(feat) {
  let peak = 0;
  for (let i = 0; i < feat.frameCount; i++) peak = Math.max(peak, feat.rms[i]);
  const thr = Math.max(1e-4, peak * 0.045);
  const act = new Uint8Array(feat.frameCount);
  let count = 0;
  for (let i = 0; i < feat.frameCount; i++) {
    if (feat.rms[i] > thr || feat.voiced[i]) { act[i] = 1; count++; }
  }
  return { act, count, thr, peak };
}

/**
 * 比较参考与录制。
 * @param {'piano'|'voice'} mode
 * @returns {{overall:number,pitch:number,rhythm:number,coverage:number,shift:number,
 *            chromaSim:number,pitchAcc:number,onsetCorr:number,tempoRatio:number,meanAbsCents:number}}
 */
export function compareTakes(refIn, takeIn, { mode = 'piano', allowTranspose = false } = {}) {
  const [ref, take] = limitFrames(refIn, takeIn);
  const n = ref.frameCount;
  const m = take.frameCount;
  const empty = { overall: 0, pitch: 0, rhythm: 0, coverage: 0, shift: 0, chromaSim: 0, pitchAcc: 0, onsetCorr: 0, tempoRatio: 1, meanAbsCents: NaN, ok: false };
  if (n < 4 || m < 4) return empty;

  const refAct = activityMask(ref).act;
  const takeAct = activityMask(take).act;

  // 人声：先做八度/移调校正（默认只校正八度，避免低八度演唱被误判）
  let shift = 0;
  if (mode === 'voice') {
    const diffs = [];
    const k = Math.min(n, m);
    for (let i = 0; i < k; i++) {
      const a = ref.midi[i];
      const b = take.midi[i];
      if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(b - a);
    }
    if (diffs.length >= 6) {
      diffs.sort((x, y) => x - y);
      const med = diffs[Math.floor(diffs.length / 2)];
      shift = allowTranspose ? Math.round(med * 2) / 2 : Math.round(med / 12) * 12;
    }
  }

  const costFn = (i, j) => {
    const onsetTerm = Math.abs(ref.onset[i] - take.onset[j]);
    const bothQuiet = !refAct[i] && !takeAct[j];
    if (bothQuiet) return 0.04 + onsetTerm * 0.2;
    const halfQuiet = !refAct[i] || !takeAct[j];
    if (mode === 'voice') {
      const a = ref.midi[i];
      const b = take.midi[j] - shift;
      let pitchTerm;
      if (Number.isFinite(a) && Number.isFinite(b)) pitchTerm = Math.min(Math.abs(a - b) / 2, 1);
      else if (!Number.isFinite(a) && !Number.isFinite(b)) pitchTerm = 0.15;
      else pitchTerm = 0.55;
      return (halfQuiet ? Math.min(pitchTerm, 0.3) : pitchTerm) * 0.8 + onsetTerm * 0.2;
    }
    const sim = chromaDot(ref.chroma, i * 12, take.chroma, j * 12);
    const chromaTerm = clamp01(1 - Math.max(0, sim));
    return (halfQuiet ? Math.min(chromaTerm, 0.35) : chromaTerm) * 0.8 + onsetTerm * 0.2;
  };

  const { path } = dtwCost(costFn, n, m, 0.28, 24);
  if (!path.length) return empty;

  const refOn = [];
  const takeOn = [];
  const cents = [];
  let voicedBoth = 0;
  let voicedRef = 0;
  let chromaSum = 0;
  let chromaSamples = 0;
  let activeRef = 0;
  let activeAligned = 0;
  for (const [i, j] of path) {
    refOn.push(ref.onset[i]);
    takeOn.push(take.onset[j]);
    if (refAct[i]) {
      activeRef++;
      if (takeAct[j]) activeAligned++;
    }
    if (mode === 'piano' && refAct[i] && takeAct[j]) {
      chromaSum += clamp01(chromaDot(ref.chroma, i * 12, take.chroma, j * 12));
      chromaSamples++;
    }
    const a = ref.midi[i];
    const b = take.midi[j] - shift;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      voicedBoth++;
      if (Number.isFinite(a)) voicedRef++;
      // 只有单音（人声）比较音分才有意义；复音钢琴的 F0 会跳到不同泛音上
      if (mode === 'voice') cents.push(Math.abs(a - b) * 100);
    }
  }

  const chromaSim = chromaSamples ? chromaSum / chromaSamples : 0;
  const pitchAccRaw = cents.length
    ? cents.reduce((s, c) => s + clamp01(1 - c / 200), 0) / cents.length
    : 0;
  const coverage = mode === 'voice'
    ? (voicedRef ? voicedBoth / voicedRef : 0)
    : (activeRef ? activeAligned / activeRef : clamp01(path.length / Math.max(n, m)));

  let pitchScore;
  if (mode === 'voice') {
    pitchScore = clamp01((pitchAccRaw - 0.15) / 0.75) * (0.45 + 0.55 * coverage);
  } else {
    pitchScore = clamp01((chromaSim - 0.28) / 0.62);
  }
  // 节奏：起音对齐（召回/精确/数量） + 包络相关
  const align = onsetAlignment(ref, take, path);
  const onsetCorr = clamp01((pearson(smoothEnv(refOn, 1), smoothEnv(takeOn, 1)) + 0.15) / 1.15);
  const rhythmScore = clamp01(0.68 * align.score + 0.32 * onsetCorr);
  const overall = clamp01(0.64 * pitchScore + 0.36 * rhythmScore);

  return {
    ok: true,
    mode,
    overall: Math.round(overall * 100),
    pitch: Math.round(pitchScore * 100),
    rhythm: Math.round(rhythmScore * 100),
    coverage: Math.round(coverage * 100),
    shift,
    chromaSim,
    pitchAcc: pitchAccRaw,
    onsetCorr,
    onsetRecall: align.recall,
    onsetPrecision: align.precision,
    tempoRatio: m / n,
    meanAbsCents: cents.length ? cents.reduce((s, c) => s + c, 0) / cents.length : NaN,
    refOnsets: align.refOnsets,
    takeOnsets: align.takeOnsets,
  };
}

/**
 * 人声 vs 参考（原声或自己的钢琴录音）。
 *  · 音准：把每个唱出的音高类别与该时刻参考的和声（chroma）对照（chroma 天然忽略八度）
 *  · 节奏：起音包络相关 + 起音数匹配（≈ 歌词/咬字是否落在琴声的拍点上）
 * @param {object} ref 参考特征（可以是复音）
 * @param {object} take 人声特征（单音）
 */
export function compareVocal(refIn, takeIn, { lowConfidenceNoteRatio = 0.6 } = {}) {
  const [ref, take] = limitFrames(refIn, takeIn);
  const n = ref.frameCount;
  const m = take.frameCount;
  const empty = { ok: false, mode: 'vocal', overall: 0, pitch: 0, rhythm: 0, coverage: 0, harmony: 0, onsetCorr: 0, tempoRatio: 1, refOnsets: 0, takeOnsets: 0, voicedRatio: 0 };
  if (n < 4 || m < 4) return empty;

  const refAct = activityMask(ref).act;
  const takeAct = activityMask(take).act;

  const costFn = (i, j) => {
    const onsetTerm = Math.abs(ref.onset[i] - take.onset[j]);
    const sim = Math.max(0, chromaDot(ref.chroma, i * 12, take.chroma, j * 12));
    const chromaTerm = clamp01(1 - sim);
    const quiet = !refAct[i] || !takeAct[j];
    return (quiet ? Math.min(chromaTerm, 0.4) : chromaTerm) * 0.78 + onsetTerm * 0.22;
  };

  const { path } = dtwCost(costFn, n, m, 0.3, 26);
  if (!path.length) return empty;

  const refOn = [];
  const takeOn = [];
  let harmonySum = 0;
  let harmonyCount = 0;
  let activeTake = 0;
  let activeRefAligned = 0;
  for (const [i, j] of path) {
    refOn.push(ref.onset[i]);
    takeOn.push(take.onset[j]);
    if (takeAct[j]) {
      activeTake++;
      if (refAct[i]) activeRefAligned++;
    }
    if (take.voiced[j] && refAct[i]) {
      const pc = ((Math.round(take.midi[j]) % 12) + 12) % 12;
      const base = i * 12;
      let maxR = 0;
      for (let k = 0; k < 12; k++) maxR = Math.max(maxR, ref.chroma[base + k]);
      if (maxR > 1e-6) {
        const rel = clamp01(ref.chroma[base + pc] / maxR);
        // 该音高类在参考和声中的相对强度 → 和谐度
        harmonySum += clamp01((rel - 0.12) / 0.72);
        harmonyCount++;
      }
    }
  }

  const harmony = harmonyCount ? harmonySum / harmonyCount : 0;
  const voicedRatio = activeTake ? harmonyCount / activeTake : 0;
  const coverage = clamp01(path.length / Math.max(n, m));
  const align = onsetAlignment(ref, take, path);
  const onsetCorr = clamp01((pearson(smoothEnv(refOn, 1), smoothEnv(takeOn, 1)) + 0.15) / 1.15);

  // 唱得太少（大量无音高）时打折，避免“只唱两个音”得高分
  const singFactor = clamp01(voicedRatio / lowConfidenceNoteRatio);
  const pitchScore = clamp01(harmony * (0.35 + 0.65 * singFactor));
  const rhythmScore = clamp01(0.7 * align.score + 0.3 * onsetCorr) * (0.35 + 0.65 * singFactor);
  const overall = clamp01(0.62 * pitchScore + 0.38 * rhythmScore);

  return {
    ok: true,
    mode: 'vocal',
    overall: Math.round(overall * 100),
    pitch: Math.round(pitchScore * 100),
    rhythm: Math.round(rhythmScore * 100),
    harmony,
    coverage: Math.round(coverage * 100),
    voicedRatio,
    onsetCorr,
    onsetRecall: align.recall,
    onsetPrecision: align.precision,
    tempoRatio: m / n,
    refOnsets: align.refOnsets,
    takeOnsets: align.takeOnsets,
    activeAligned: activeRefAligned,
  };
}

/* ------------------------- 起音对齐 ------------------------- */

/** 平滑后的起音包络（3 点滑动平均，抑制颤音造成的碎峰） */
export function smoothEnv(env, radius = 1) {
  const n = env.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = i + k;
      if (idx < 0 || idx >= n) continue;
      s += env[idx];
      c++;
    }
    out[i] = c ? s / c : 0;
  }
  return out;
}

/** 峰值帧索引（带最小间隔约束） */
export function peakFrames(env, { minSep = 5, thresh = 0.1, smooth = 1 } = {}) {
  const e = smooth > 0 ? smoothEnv(env, smooth) : env;
  const idx = [];
  for (let i = 1; i < e.length - 1; i++) {
    if (e[i] < thresh) continue;
    if (!(e[i] >= e[i - 1] && e[i] > e[i + 1])) continue;
    if (idx.length && i - idx[idx.length - 1] < minSep) {
      if (e[i] > e[idx[idx.length - 1]]) idx[idx.length - 1] = i;
      continue;
    }
    idx.push(i);
  }
  return idx;
}

/** 由 DTW 路径构造双向帧映射（平均值） */
export function pathMapping(path, n, m) {
  const sumJ = new Float64Array(n);
  const cntJ = new Int32Array(n);
  const sumI = new Float64Array(m);
  const cntI = new Int32Array(m);
  for (let p = 0; p < path.length; p++) {
    const i = path[p][0];
    const j = path[p][1];
    sumJ[i] += j; cntJ[i]++;
    sumI[j] += i; cntI[j]++;
  }
  const i2j = new Float64Array(n).fill(-1);
  const j2i = new Float64Array(m).fill(-1);
  for (let i = 0; i < n; i++) if (cntJ[i]) i2j[i] = sumJ[i] / cntJ[i];
  for (let j = 0; j < m; j++) if (cntI[j]) j2i[j] = sumI[j] / cntI[j];
  return { i2j, j2i };
}

/**
 * 起音对齐质量：参考乐句里的每个起音，录制是否在 ±tolFrames 内也有起音（召回），
 * 以及录制的起音是否有对应的参考起音（精确），用于节奏/咬字评分。
 */
export function onsetAlignment(ref, take, path, { tolFrames = 11, thresh = 0.12 } = {}) {
  const n = ref.frameCount;
  const m = take.frameCount;
  const refIdx = peakFrames(ref.onset, { minSep: 5, thresh });
  const takeIdx = peakFrames(take.onset, { minSep: 5, thresh });
  const { i2j, j2i } = pathMapping(path, n, m);

  const near = (arr, v, tol) => {
    // arr 已升序
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v - tol) lo = mid + 1;
      else if (arr[mid] > v + tol) hi = mid - 1;
      else return true;
    }
    return false;
  };

  let recallHits = 0;
  for (const i of refIdx) {
    const j = i2j[i];
    if (j >= 0 && near(takeIdx, j, tolFrames)) recallHits++;
  }
  let precisionHits = 0;
  for (const j of takeIdx) {
    const i = j2i[j];
    if (i >= 0 && near(refIdx, i, tolFrames)) precisionHits++;
  }
  const recall = refIdx.length ? recallHits / refIdx.length : 0;
  const precision = takeIdx.length ? precisionHits / takeIdx.length : 0;
  const countRatio = refIdx.length && takeIdx.length
    ? clamp01(1 - Math.abs(refIdx.length - takeIdx.length) / Math.max(refIdx.length, takeIdx.length))
    : 0.4;
  return {
    recall, precision, countRatio,
    refOnsets: refIdx.length,
    takeOnsets: takeIdx.length,
    score: clamp01(0.5 * recall + 0.28 * precision + 0.22 * countRatio),
  };
}

export function countOnsets(env, { rel = 0.28, abs = 0.06 } = {}) {  let n = 0;
  let localMax = 0;
  for (let i = 1; i < env.length - 1; i++) {
    localMax = Math.max(localMax, env[i]);
    if (env[i] > abs && env[i] >= env[i - 1] && env[i] > env[i + 1] && env[i] >= localMax * (1 - rel * 0.35) && env[i] > 0.25) n++;
  }
  if (!n) for (let i = 1; i < env.length; i++) if (env[i] > abs) n++;
  return n;
}

/** 取一段录音里最可信的基频序列（用于绘制音高曲线） */
export function pitchCurve(feat, { maxPoints = 600 } = {}) {
  const step = Math.max(1, Math.floor(feat.frameCount / maxPoints));
  const out = [];
  for (let i = 0; i < feat.frameCount; i += step) {
    out.push({ t: feat.times[i], midi: feat.voiced[i] ? feat.midi[i] : null, rms: feat.rms[i] });
  }
  return out;
}

/** 录音的总体电平信息（用于 UI 提示太小声） */
export function levelStats(feat) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < feat.frameCount; i++) {
    peak = Math.max(peak, feat.rms[i]);
    sum += feat.rms[i];
  }
  return { peak, mean: sum / Math.max(1, feat.frameCount) };
}
