import test from 'node:test';
import assert from 'node:assert/strict';

/* 用最小的假 DOM / WebAudio 跑播放引擎，验证循环参数校验、增益链与音量逻辑 */

globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

class FakeEl extends EventTarget {
  constructor(name = 'el') {
    super();
    this.name = name;
    this.paused = true;
    this.muted = false;
    this.volume = 1;
    this.currentTime = 0;
    this.duration = 18;
    this.src = '';
    this.playbackRate = 1;
    this.seeking = false;
    this.attrs = {};
  }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {}
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = ''; }
}

const { Player } = await import('../src/player.js');

function makePlayer() {
  const video = new FakeEl('video');
  const piano = new FakeEl('piano');
  const voice = new FakeEl('voice');
  const p = new Player();
  p.attach({ video, pianoAudio: piano, voiceAudio: voice });
  return { p, video, piano, voice };
}

test('setLoop 拒绝退化的区间（B 不大于 A 时退化为不循环）', () => {
  const { p } = makePlayer();
  p.setLoop({ a: 2, b: 2 });
  assert.equal(p.loop.b, null, 'b == a 应当被忽略');
  p.setLoop({ a: 3, b: 2 });
  assert.equal(p.loop.b, null, 'b < a 应当被忽略');
  p.setLoop({ a: -5, b: 4 });
  assert.equal(p.loop.a, 0, 'A 不为负');
  assert.equal(p.loop.b, 4);
  p.setLoop({ a: 1, b: null });
  assert.equal(p.loop.b, null);
});

test('重复间隔：自动值随段落长度变化', () => {
  const { p } = makePlayer();
  p.setInterval('auto');
  p.setLoop({ a: 0, b: 1 });
  const short = p.effectiveInterval();
  p.setLoop({ a: 0, b: 12 });
  const long = p.effectiveInterval();
  assert.ok(short >= 0.35 && short <= 2.5, `short=${short}`);
  assert.ok(long >= short, `long=${long} short=${short}`);
  p.setInterval(1.5);
  assert.equal(p.effectiveInterval(), 1.5);
});

test('音量 / 静音：元素 volume 与 muted 同步', () => {
  const { p, video, piano } = makePlayer();
  p.setVolume('orig', 0.4);
  p.setVolume('piano', 0.7);
  assert.equal(video.volume, 0.4);
  assert.equal(piano.volume, 0.7);
  p.setMuted('piano', true);
  assert.equal(piano.muted, true);
  assert.equal(piano.volume, 0, '静音时音量归零');
  p.setMuted('piano', false);
  assert.equal(piano.volume, 0.7);
});

test('叠加音轨音量完全由元素 volume 控制（不经过 WebAudio，iOS 上不会掉采样）', () => {
  const { p, piano } = makePlayer();
  p.setVolume('piano', 0.35);
  assert.equal(piano.volume, 0.35);
  assert.equal(p.overlayGraphEnabled, undefined, '播放器不应再暴露 WebAudio 增益链');
  assert.equal(typeof p.ensureOverlayGraph, 'undefined');
  assert.equal(typeof p.setOverlayGain, 'undefined');
});

test('叠加音轨：按录制起点对齐，起点之前保持暂停', () => {
  const { p, piano } = makePlayer();
  p.setOverlay('piano', { url: 'blob:x', start: 5, duration: 4 });
  p.state = 'playing';
  p.video.paused = false;
  p.video.currentTime = 2;         // 还没到 5
  p.syncOverlays();
  assert.equal(piano.paused, true, '起点之前不该出声');

  p.video.currentTime = 6.2;       // 已进入该录音
  p.syncOverlays();
  assert.equal(piano.paused, false);
  assert.ok(Math.abs(piano.currentTime - 1.2) < 0.01, `currentTime=${piano.currentTime}`);
  assert.equal(piano.src, 'blob:x');
});

test('叠加音轨：清空后移除 src 并暂停', () => {
  const { p, piano } = makePlayer();
  p.setOverlay('piano', { url: 'blob:y', start: 0, duration: 3 });
  p.state = 'playing';
  p.video.paused = false;
  p.video.currentTime = 1;
  p.syncOverlays();
  p.setOverlay('piano', null);
  assert.equal(piano.src, '');
  assert.equal(piano.paused, true);
});

test('叠加音轨：小偏差用变速追赶，不写 currentTime（避免断音）', () => {
  const { p, piano } = makePlayer();
  p.setOverlay('piano', { url: 'blob:z', start: 0, duration: 10 });
  p.state = 'playing';
  p.video.paused = false;
  p.video.currentTime = 2;
  let seeks = 0;
  const desc = Object.getOwnPropertyDescriptor(FakeEl.prototype, 'currentTime') || null;
  Object.defineProperty(piano, 'currentTime', {
    get() { return this._ct || 0; },
    set(v) { seeks++; this._ct = v; },
  });
  piano._ct = 1.9;              // 落后 0.1 秒
  piano.paused = false;
  p._want.piano = true;
  p.syncOverlays();
  assert.equal(seeks, 0, '小偏差不应 seek');
  assert.ok(piano.playbackRate > p.rate, `应当加速追赶，rate=${piano.playbackRate}`);
  assert.ok(desc !== null || true);
});

test('叠加音轨：大偏差才硬对齐，并且有冷却', () => {
  const { p, piano } = makePlayer();
  p.setOverlay('piano', { url: 'blob:w', start: 0, duration: 10 });
  p.state = 'playing';
  p.video.paused = false;
  p.video.currentTime = 5;
  let seeks = 0;
  Object.defineProperty(piano, 'currentTime', {
    get() { return this._ct || 0; },
    set(v) { seeks++; this._ct = v; },
  });
  piano._ct = 1.0;              // 落后 4 秒
  piano.paused = false;
  p._want.piano = true;
  p.syncOverlays();
  assert.equal(seeks, 1, '大偏差应当硬对齐一次');
  assert.ok(Math.abs(piano._ct - 5) < 0.01);
  piano._ct = 1.0;
  p.syncOverlays();             // 冷却期内不再 seek
  assert.equal(seeks, 1, '900ms 冷却内不重复 seek');
});
