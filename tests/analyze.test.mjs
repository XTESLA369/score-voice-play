import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPitch, extractFeatures, compareTakes, compareVocal, hzToMidi, midiToName, countOnsets, sliceFeatures,
  downsampleFeatures, limitFrames, MAX_DTW_FRAMES,
} from '../src/analyze.js';

const SR = 22050;

/** 合成一段“钢琴音”：带 3 次谐波、指数衰减包络 */
function synthNotes(notes, { sr = SR, detuneCents = 0, gain = 0.6 } = {}) {
  const total = notes.reduce((s, n) => s + n.dur, 0);
  const out = new Float32Array(Math.ceil(total * sr) + sr);
  let pos = 0;
  for (const n of notes) {
    const f0 = 440 * Math.pow(2, (n.midi - 69) / 12) * Math.pow(2, detuneCents / 1200);
    const len = Math.floor(n.dur * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const attack = Math.min(1, t / 0.008);
      const env = attack * Math.exp(-t * 3.2);
      let v = 0;
      for (let h = 1; h <= 3; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / (h * 1.7);
      out[pos + i] += v * env * gain * (n.vel ?? 1);
    }
    pos += len;
  }
  return out;
}

const MELODY = [
  { midi: 72, dur: 0.5 }, { midi: 74, dur: 0.5 }, { midi: 76, dur: 0.75 },
  { midi: 77, dur: 0.5 }, { midi: 76, dur: 0.5 }, { midi: 74, dur: 0.5 },
  { midi: 72, dur: 1.0 },
];

const OTHER = [
  { midi: 60, dur: 0.4 }, { midi: 63, dur: 0.4 }, { midi: 67, dur: 0.9 },
  { midi: 65, dur: 0.4 }, { midi: 62, dur: 0.7 },
];

function feats(samples) {
  return extractFeatures(samples, SR, { minHz: 65, maxHz: 1250 });
}

test('detectPitch 能识别 A4 = 440Hz', () => {
  const n = 2048;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  const p = detectPitch(f, SR);
  assert.ok(Math.abs(p.hz - 440) < 6, `检测到 ${p.hz}`);
  assert.ok(p.clarity > 0.7, `clarity=${p.clarity}`);
  assert.equal(midiToName(hzToMidi(p.hz)), 'A4');
});

test('detectPitch 能识别低音区 C3 ≈ 130.8Hz', () => {
  const n = 2048;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.sin((2 * Math.PI * 130.81 * i) / SR) * 0.6;
  const p = detectPitch(f, SR);
  assert.ok(Math.abs(p.hz - 130.81) < 3, `检测到 ${p.hz}`);
});

test('特征提取：帧时间单调、chroma 归一化', () => {
  const s = synthNotes(MELODY);
  const f = feats(s);
  assert.ok(f.frameCount > 20);
  for (let i = 1; i < f.frameCount; i++) assert.ok(f.times[i] > f.times[i - 1]);
  // 强能量帧的 chroma 应当 L2 归一化到 1
  let checked = 0;
  for (let i = 0; i < f.frameCount; i++) {
    if (f.rms[i] < 0.02) continue;
    let sq = 0;
    for (let k = 0; k < 12; k++) sq += f.chroma[i * 12 + k] ** 2;
    assert.ok(Math.abs(Math.sqrt(sq) - 1) < 0.02, `帧 ${i} 范数 ${Math.sqrt(sq)}`);
    checked++;
  }
  assert.ok(checked > 5);
});

test('同一段演奏自比：综合/音准/节奏接近满分', () => {
  const s = synthNotes(MELODY);
  const r = feats(s);
  const sc = compareTakes(r, feats(s), { mode: 'piano' });
  assert.equal(sc.ok, true);
  assert.ok(sc.overall >= 95, `overall=${sc.overall}`);
  assert.ok(sc.pitch >= 95, `pitch=${sc.pitch}`);
  assert.ok(sc.rhythm >= 90, `rhythm=${sc.rhythm}`);
});

test('钢琴模式：不同旋律分数明显更低', () => {
  const same = compareTakes(feats(synthNotes(MELODY)), feats(synthNotes(MELODY)), { mode: 'piano' });
  const diff = compareTakes(feats(synthNotes(MELODY)), feats(synthNotes(OTHER)), { mode: 'piano' });
  assert.ok(diff.overall < same.overall - 25, `same=${same.overall} diff=${diff.overall}`);
});

test('人声模式：八度差异不被惩罚，随机音高被判低', () => {
  const ref = feats(synthNotes(MELODY, { gain: 0.5 }));
  const octaveDown = synthNotes(MELODY.map((n) => ({ ...n, midi: n.midi - 12 })), { gain: 0.5 });
  const scOct = compareTakes(ref, feats(octaveDown), { mode: 'voice' });
  assert.ok(scOct.shift === -12 || scOct.shift === 0, `shift=${scOct.shift}`);
  assert.ok(scOct.pitch > 80, `八度演唱 pitch=${scOct.pitch}`);

  const wrong = feats(synthNotes(OTHER, { gain: 0.5 }));
  const scWrong = compareTakes(ref, wrong, { mode: 'voice' });
  assert.ok(scWrong.pitch < scOct.pitch - 15, `wrong=${scWrong.pitch} oct=${scOct.pitch}`);
});

test('轻微走音（+35 音分）仍有较高音准分但低于完美', () => {
  const ref = feats(synthNotes(MELODY));
  const detuned = feats(synthNotes(MELODY, { detuneCents: 35 }));
  const perfect = compareTakes(ref, feats(synthNotes(MELODY)), { mode: 'voice' });
  const sc = compareTakes(ref, detuned, { mode: 'voice' });
  assert.ok(sc.pitch < perfect.pitch, `走音 ${sc.pitch} 应低于完美 ${perfect.pitch}`);
  assert.ok(sc.pitch > 55, `走音仍应较高 ${sc.pitch}`);
});

test('噪声不应得到高分', () => {
  const s = synthNotes(MELODY);
  const noise = new Float32Array(s.length);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < noise.length; i++) noise[i] = rnd() * 0.5;
  const sc = compareTakes(feats(s), feats(noise), { mode: 'piano' });
  assert.ok(sc.overall < 45, `noise overall=${sc.overall}`);
});

test('sliceFeatures 按时间裁剪并重设时间轴', () => {
  const s = synthNotes(MELODY);
  const f = feats(s);
  const mid = sliceFeatures(f, 1.0, 2.0);
  assert.ok(mid.frameCount > 3);
  assert.ok(mid.times[0] >= 0 && mid.times[0] < 0.2);
  assert.ok(mid.times[mid.frameCount - 1] <= 1.0 + 0.1);
});

test('countOnsets 对合成旋律给出合理起音数', () => {
  const counts = [];
  for (const vel of [1, 0.7]) {
    const s = synthNotes(MELODY.map((n) => ({ ...n, vel })));
    counts.push(countOnsets(feats(s).onset));
  }
  for (const c of counts) assert.ok(c >= 4 && c <= 11, `onsets=${c}`);
});

/* ------------------- 人声 vs 参考（和声 + 节奏） ------------------- */

/** 合成“人声”：更接近正弦的单音，带轻微颤音 */
function synthVoice(notes, { sr = SR, gain = 0.5 } = {}) {
  const total = notes.reduce((s, n) => s + n.dur, 0);
  const out = new Float32Array(Math.ceil(total * sr) + sr);
  let pos = 0;
  for (const n of notes) {
    const f0 = 440 * Math.pow(2, (n.midi - 69) / 12);
    const len = Math.floor(n.dur * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.03) * Math.min(1, Math.max(0, (n.dur - t) / 0.06));
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t);
      out[pos + i] += (Math.sin(2 * Math.PI * f0 * vib * t) + 0.25 * Math.sin(4 * Math.PI * f0 * t)) * env * gain;
    }
    pos += len;
  }
  return out;
}

test('人声：跟着同一旋律唱，分数高；唱错音，分数低', () => {
  const ref = feats(synthNotes(MELODY));
  const good = compareVocal(ref, feats(synthVoice(MELODY)));
  const bad = compareVocal(ref, feats(synthVoice(OTHER)));
  assert.equal(good.ok, true);
  assert.ok(good.overall > 70, `跟唱 overall=${good.overall}`);
  assert.ok(bad.overall < good.overall - 15, `错唱 ${bad.overall} vs ${good.overall}`);
});

test('人声：低八度唱不被惩罚（chroma 天然忽略八度）', () => {
  const ref = feats(synthNotes(MELODY));
  const onPitch = compareVocal(ref, feats(synthVoice(MELODY)));
  const octDown = compareVocal(ref, feats(synthVoice(MELODY.map((n) => ({ ...n, midi: n.midi - 12 })))));
  assert.ok(Math.abs(octDown.pitch - onPitch.pitch) < 12, `低八度 ${octDown.pitch} vs 原调 ${onPitch.pitch}`);
});

test('人声：漏唱大部分音符会明显降分', () => {
  const ref = feats(synthNotes(MELODY));
  const full = compareVocal(ref, feats(synthVoice(MELODY)));
  // 只唱第一个音，其余留白
  const partial = MELODY.map((n, i) => ({ ...n, dur: i === 0 ? n.dur : n.dur, midi: n.midi, vel: 0 }));
  const sparse = synthVoice(MELODY.filter((_, i) => i === 0));
  const sc = compareVocal(ref, feats(sparse));
  assert.ok(sc.overall < full.overall, `漏唱 ${sc.overall} 应低于 ${full.overall}`);
  assert.equal(partial.length, MELODY.length);
});

/* ------------------- 帧数上限 / 降采样 ------------------- */

test('downsampleFeatures 保留音高与起音特征', () => {
  const f = feats(synthNotes(MELODY));
  const d = downsampleFeatures(f, 3);
  assert.ok(d.frameCount === Math.floor(f.frameCount / 3));
  let voiced = 0;
  for (let i = 0; i < d.frameCount; i++) if (d.voiced[i]) voiced++;
  assert.ok(voiced > d.frameCount * 0.4, `voiced=${voiced}/${d.frameCount}`);
  assert.ok(d.midi.find((v) => Number.isFinite(v)) > 60);
  for (let i = 1; i < d.frameCount; i++) assert.ok(d.times[i] > d.times[i - 1]);
  // 降采样后与自身比对仍然接近满分
  const sc = compareTakes(d, d, { mode: 'piano' });
  assert.ok(sc.overall >= 90, `overall=${sc.overall}`);
});

test('长段落自动限帧，DTW 不爆内存', () => {
  // 约 40 秒：帧数远超 MAX_DTW_FRAMES
  const long = [];
  for (let i = 0; i < 80; i++) long.push({ midi: 60 + (i % 12), dur: 0.5 });
  const f = feats(synthNotes(long));
  assert.ok(f.frameCount > MAX_DTW_FRAMES);
  const [a, b] = limitFrames(f, f);
  assert.ok(a.frameCount <= MAX_DTW_FRAMES + 2 && b.frameCount <= MAX_DTW_FRAMES + 2, `${a.frameCount}`);
  const sc = compareTakes(f, f, { mode: 'piano' });
  assert.ok(sc.overall >= 90, `overall=${sc.overall}`);
});

/* ------------------- 项目打包：zip 读写往返 ------------------- */

test('zip：写入 store 后能原样读回（含二进制与 UTF-8 文件名）', async () => {
  const { createZip, readZip } = await import('../src/zip.js');
  const bin = new Uint8Array(5000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 31) & 255;
  const blob = await createZip([
    { name: 'project.json', data: JSON.stringify({ title: '练习 · A段', segments: [{ a: 0, b: 1 }] }) },
    { name: 'media/video.mp4', data: bin },
    { name: 'media/piano-abc.m4a', data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  assert.ok(blob.size > 5000);
  const zip = await readZip(await blob.arrayBuffer());
  assert.deepEqual(zip.names.sort(), ['media/piano-abc.m4a', 'media/video.mp4', 'project.json'].sort());
  const json = JSON.parse(await zip.text('project.json'));
  assert.equal(json.title, '练习 · A段');
  assert.equal(json.segments.length, 1);
  const back = await zip.bytes('media/video.mp4');
  assert.equal(back.length, bin.length);
  for (let i = 0; i < bin.length; i += 97) assert.equal(back[i], bin[i]);
  assert.equal((await zip.bytes('media/piano-abc.m4a')).length, 4);
  assert.equal(await zip.bytes('nope'), null);
});

/* ------------------- 录音响度 / 回放增益 ------------------- */

test('loudnessReport 报告峰值与 RMS', async () => {
  const { loudnessReport } = await import('../src/audio.js');
  const sr = 8000;
  const s = new Float32Array(sr * 2);
  for (let i = 0; i < s.length; i++) s[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5;
  const r = loudnessReport(s, sr);
  assert.ok(Math.abs(r.peak - 0.5) < 0.01, `peak=${r.peak}`);
  assert.ok(Math.abs(r.rmsDb - (-9.03)) < 0.6, `rmsDb=${r.rmsDb}`);
  const half = loudnessReport(s, sr, { from: 0, to: 1 });
  assert.ok(half.samples <= sr + 1);
});

test('gainForLoudness：小声音被放大，够响的不动，爆音被限', async () => {
  const { gainForLoudness } = await import('../src/audio.js');
  const target = 0.1;                                  // 约 -20 dBFS
  const quiet = gainForLoudness({ peak: 0.02, rms: 0.01 }, target);
  assert.ok(quiet >= 9.5 && quiet <= 10.5, `quiet gain=${quiet}`); // 10 倍
  const loud = gainForLoudness({ peak: 0.6, rms: 0.2 }, target);
  assert.equal(loud, 1);                               // 已经比目标响，不衰减
  const loudPeak = gainForLoudness({ peak: 0.9, rms: 0.02 }, target);
  assert.ok(loudPeak <= 1.6, `peak cap=${loudPeak}`);   // 峰值大的不让无限放大
  assert.equal(gainForLoudness({ peak: 0, rms: 0 }, target), 1); // 静音不放大
});

/* ------------------- 录音标准化（WAV 编码 / 软限幅 / 增益） ------------------- */

test('encodeWav → decodeWav 往返保持电平与时长', async () => {
  const { encodeWav, decodeWav, softLimitInPlace } = await import('../src/wav.js');
  const sr = 16000;
  const n = sr; // 1 秒
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.3;
  const blob = encodeWav(s, sr);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + n * 2);
  const back = decodeWav(await blob.arrayBuffer());
  assert.equal(back.sampleRate, sr);
  assert.equal(back.samples.length, n);
  let maxErr = 0;
  for (let i = 0; i < n; i += 37) maxErr = Math.max(maxErr, Math.abs(back.samples[i] - s[i]));
  assert.ok(maxErr < 0.001, `最大误差 ${maxErr}`);
});

test('标准化：小音量录音放大后接近目标响度，且不削爆', async () => {
  const { encodeWav, softLimitInPlace } = await import('../src/wav.js');
  const { loudnessReport, gainForLoudness } = await import('../src/audio.js');
  const sr = 16000;
  const n = sr;
  const quiet = new Float32Array(n);
  for (let i = 0; i < n; i++) quiet[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.02; // 很小声
  const loud = loudnessReport(quiet, sr);
  assert.ok(loud.rmsDb < -35, `原始 rms=${loud.rmsDb}`);

  const target = 0.1;                    // 目标 RMS ≈ -20 dBFS
  const boost = gainForLoudness(loud, target);
  const out = Float32Array.from(quiet, (v) => v * boost);
  softLimitInPlace(out, 0.72);
  const after = loudnessReport(out, sr);
  assert.ok(after.rmsDb > loud.rmsDb + 12, `放大后应明显更响: ${loud.rmsDb} → ${after.rmsDb}`);
  assert.ok(after.peak <= 1.0, `不能超过 0 dBFS: ${after.peak}`);
  // 编码后的文件能正常读回
  const back = (await import('../src/wav.js')).decodeWav(await encodeWav(out, sr).arrayBuffer());
  assert.equal(back.samples.length, n);
});

test('softLimitInPlace 只压缩峰值，不改变小信号', async () => {
  const { softLimitInPlace } = await import('../src/wav.js');
  const s = new Float32Array([0, 0.1, -0.1, 0.5, -0.5, 0.99, -0.99]);
  const copy = Float32Array.from(s);
  softLimitInPlace(copy, 0.7);
  assert.equal(copy[0], 0);
  assert.ok(Math.abs(copy[1] - 0.1) < 1e-6, `小信号不变: ${copy[1]}`);
  assert.ok(Math.abs(copy[3] - 0.5) < 1e-6, '0.5 < knee(0.7) 应保持不变');
  assert.ok(copy[5] < 0.99 && copy[5] > 0.7, `0.99 被压到 ${copy[5]}`);
  assert.ok(Math.abs(copy[6] + copy[5]) < 1e-6, '负峰值对称');
});
