/*
 * recorder.js — 麦克风录音（钢琴 / 人声）+ 实时电平、音高、节拍预备
 */

import { audioContext, resumeAudio } from './audio.js';
import { detectPitch, hzToMidi, midiToName } from './analyze.js';

const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return '';
}

export function recorderSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

export function describeMediaError(err) {
  const name = err && err.name;
  const secure = window.isSecureContext;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return secure
      ? '麦克风权限被拒绝：请在 Safari 地址栏「ᴀA」→ 网站设置 中允许麦克风，然后刷新页面。'
      : '当前页面不是安全上下文（HTTPS），Safari 会禁止麦克风。请用 https:// 访问，或改用「添加到主屏幕」后从主屏打开。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风设备。';
  if (name === 'NotReadableError') return '麦克风被其它 App 占用，请关闭后再试。';
  return `录音启动失败：${(err && err.message) || err}`;
}

export class Recorder extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.analyser = null;
    this.sourceNode = null;
    this.meterTimer = 0;
    this.startedAt = 0;
    this.samples = 0;
    this.buf = null;
    this.kind = null;
  }

  get active() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }

  /**
   * @param {{kind:'piano'|'voice', processing?:boolean}} opts processing=true 时启用系统降噪/回声消除
   */
  async start({ kind = 'piano', processing = false } = {}) {
    if (!recorderSupported()) throw new Error('当前浏览器不支持录音（需要 Safari 14.3+ / iOS 14.3+）');
    if (this.active) throw new Error('已经在录音中');
    await resumeAudio();

    const audioConstraints = {
      channelCount: 1,
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      throw new Error(describeMediaError(err));
    }

    this.kind = kind;
    this.chunks = [];
    this.samples = 0;
    const mime = pickMime();
    const options = mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : {};
    let rec;
    try {
      rec = new MediaRecorder(this.stream, options);
    } catch (err) {
      try {
        rec = new MediaRecorder(this.stream);
      } catch (err2) {
        this.cleanup(); // 别让麦克风一直开着
        throw new Error(`这台设备无法创建录音器：${err2.message || err2}`);
      }
    }
    this.mediaRecorder = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) this.chunks.push(ev.data);
    };
    rec.onerror = (ev) => this.emit('error', { message: describeMediaError(ev.error || ev) });
    rec.start(250);
    this.startedAt = performance.now();

    // 实时电平 / 音高
    const ctx = audioContext();
    this.sourceNode = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    this.sourceNode.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const v = this.buf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / this.buf.length);
      const p = detectPitch(this.buf, ctx.sampleRate, { minHz: 65, maxHz: 1250 });
      this.emit('meter', {
        rms,
        peak,
        db: rms > 1e-6 ? 20 * Math.log10(rms) : -100,
        hz: p.clarity > 0.6 ? p.hz : 0,
        clarity: p.clarity,
        note: p.clarity > 0.6 ? midiToName(hzToMidi(p.hz)) : '',
        cents: p.clarity > 0.6 ? Math.round((hzToMidi(p.hz) - Math.round(hzToMidi(p.hz))) * 100) : 0,
        elapsed: (performance.now() - this.startedAt) / 1000,
      });
      this.meterTimer = requestAnimationFrame(tick);
    };
    this.meterTimer = requestAnimationFrame(tick);
    this.emit('start', { kind });
  }

  /** @returns {Promise<{blob:Blob,mime:string,duration:number,kind:string}>} */
  stop() {
    return new Promise((resolve, reject) => {
      const rec = this.mediaRecorder;
      if (!rec) { reject(new Error('没有正在进行的录音')); return; }
      const duration = (performance.now() - this.startedAt) / 1000;
      const finish = () => {
        const mime = rec.mimeType || this.chunks[0]?.type || 'audio/mp4';
        const blob = new Blob(this.chunks, { type: mime });
        const kind = this.kind;
        this.cleanup();
        this.emit('stop', { kind, duration, size: blob.size });
        resolve({ blob, mime, duration, kind });
      };
      rec.onstop = finish;
      try {
        if (rec.state === 'recording') rec.stop();
        else finish();
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  cancel() {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      }
    } catch { /* ignore */ }
    this.cleanup();
    this.chunks = [];
  }

  cleanup() {
    cancelAnimationFrame(this.meterTimer);
    this.meterTimer = 0;
    this.analyser = null;
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* ignore */ }
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
      this.stream = null;
    }
    this.mediaRecorder = null;
    this.kind = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/* ------------------------- 预备拍 / 提示音 ------------------------- */

export async function beep(freq = 880, dur = 0.09, gain = 0.15) {
  const ctx = await resumeAudio();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + dur + 0.02);
}

/**
 * 预备拍：倒计时 beeps 次（3,2,1 音高不同）
 * @param {number} beats
 * @param {(n:number)=>void} onBeat
 */
export async function countIn(beats, onBeat) {
  for (let i = beats; i > 0; i--) {
    onBeat?.(i);
    await beep(i === 1 ? 1320 : 880, 0.08, 0.16);
    await new Promise((r) => setTimeout(r, 520));
  }
}
