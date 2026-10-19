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

const param = (v) => ({ value: v });

function fakeCtx() {
  const made = [];
  return {
    destination: { name: 'dest' },
    createDynamicsCompressor: () => ({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25), connect: () => {}, name: 'comp' }),
    createGain: () => { const g = { gain: param(1), connect: () => {}, name: 'gain' }; made.push(g); return g; },
    createMediaElementSource: (el) => ({ el, connect: () => {}, name: `src:${el.name}` }),
    made,
  };
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

test('录音增益链：建链前先记录目标，建链后把增益写进节点', () => {
  const { p } = makePlayer();
  p.setOverlayGain('piano', 4.5);
  p.setOverlayGain('voice', 2);
  assert.equal(p.getOverlayGain('piano'), 4.5);
  assert.equal(p.overlayGraphEnabled, false, '还没建链');

  const ctx = fakeCtx();
  const okGraph = p.ensureOverlayGraph(ctx);
  assert.equal(okGraph, true);
  assert.equal(p.overlayGraphEnabled, true);
  assert.equal(p.overlayGains.piano.gain.value, 4.5, '建链时带上已有目标');
  assert.equal(p.overlayGains.voice.gain.value, 2);

  p.setOverlayGain('piano', 8);
  assert.equal(p.overlayGains.piano.gain.value, 8, '建链后实时更新');

  // 重复调用不会重复接线
  const before = p.overlayGains;
  p.ensureOverlayGraph(ctx);
  assert.equal(p.overlayGains, before);
});

test('增益链：上下文不可用时安全退回（不抛异常）', () => {
  const { p, piano } = makePlayer();
  const badCtx = { createDynamicsCompressor() { throw new Error('nope'); } };
  assert.equal(p.ensureOverlayGraph(badCtx), false);
  assert.equal(p.overlayGraphEnabled, false);
  // 退回后仍然按元素音量播放
  p.setVolume('piano', 0.8);
  assert.equal(piano.volume, 0.8);
});

test('叠加音轨：按录制起点对齐，起点之前保持暂停', () => {
  const { p, piano } = makePlayer();
  p.ensureOverlayGraph(fakeCtx());
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
