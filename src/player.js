/*
 * player.js — 播放引擎
 *  · 视频（原声）+ 两条叠加音轨（钢琴录音 / 人声录音）
 *  · A-B 循环、重复次数、重复间隔（自动/自定义）
 *  · 叠加音轨按录制起点与视频时间对齐，rAF 校正漂移
 */

const DRIFT_TOLERANCE = 0.14;

export class Player extends EventTarget {
  constructor() {
    super();
    this.video = null;
    this.audioEls = { piano: null, voice: null };
    this.loop = { a: 0, b: null };
    this.repeats = Infinity;
    this.interval = 'auto';
    this.completed = 0;
    this.state = 'idle'; // idle | playing | gap
    this.rate = 1;
    this.mix = {
      orig: { volume: 1, muted: false },
      piano: { volume: 1, muted: false },
      voice: { volume: 1, muted: false },
    };
    this.recs = { piano: null, voice: null };
    this._want = { piano: false, voice: false };
    this._blocked = { piano: 0, voice: 0 };
    this._gapTimer = 0;
    this._raf = 0;
    this._lastEmit = 0;
    this._active = true;
  }

  attach({ video, pianoAudio, voiceAudio }) {
    this.video = video;
    this.audioEls.piano = pianoAudio;
    this.audioEls.voice = voiceAudio;
    for (const el of [video, pianoAudio, voiceAudio]) {
      if (!el) continue;
      el.addEventListener('loadedmetadata', () => this.emit('meta'));
      el.addEventListener('play', () => this.emit('audioevent', { el }));
    }
    video.addEventListener('play', () => { this.state = 'playing'; this.emit('play'); });
    video.addEventListener('pause', () => {
      if (this.state !== 'gap') { this.state = 'idle'; this.emit('pause'); }
      this.pauseOverlays();
    });
    video.addEventListener('seeked', () => { this.syncOverlays(true); this.emit('time', { t: video.currentTime, force: true }); });
    video.addEventListener('ended', () => this.onEnded());
    this.applyVolumes();
    this.tick();
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._gapTimer);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get duration() {
    return this.video && Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get currentTime() {
    return this.video ? this.video.currentTime : 0;
  }

  get playing() {
    return this.state === 'playing' && this.video && !this.video.paused;
  }

  /* ------------------------- 源与设置 ------------------------- */

  async loadSource(url, startAt = 0) {
    if (!this.video) return;
    this.pause();
    this.video.src = url;
    this.video.load();
    await new Promise((resolve) => {
      const done = () => { this.video.removeEventListener('loadedmetadata', done); resolve(); };
      this.video.addEventListener('loadedmetadata', done);
      setTimeout(done, 4000);
    });
    try { this.video.currentTime = startAt; } catch { /* ignore */ }
    this.emit('meta');
  }

  setLoop({ a, b }) {
    const aa = Number.isFinite(a) ? Math.max(0, a) : 0;
    // B 必须明显大于 A，否则每帧都会判定“到边界”，陷入无限循环
    const bb = Number.isFinite(b) && b - aa > 0.05 ? b : null;
    this.loop = { a: aa, b: bb };
    this.emit('loopchange', this.loop);
  }

  setRepeats(n) {
    this.repeats = n === 'inf' || n === Infinity || n == null ? Infinity : Math.max(1, Number(n) || 1);
    this.emit('settings');
  }

  setInterval(sec) {
    this.interval = sec === 'auto' || sec == null ? 'auto' : Math.max(0, Number(sec) || 0);
    this.emit('settings');
  }

  setRate(r) {
    this.rate = Math.max(0.4, Math.min(2, Number(r) || 1));
    if (this.video) this.video.playbackRate = this.rate;
    for (const k of ['piano', 'voice']) {
      const el = this.audioEls[k];
      if (el) el.playbackRate = this.rate;
    }
    this.emit('settings');
  }

  setVolume(kind, v) {
    if (!this.mix[kind]) return;
    this.mix[kind].volume = Math.max(0, Math.min(1, v));
    this.applyVolumes();
    this.emit('settings');
  }

  setMuted(kind, muted) {
    if (!this.mix[kind]) return;
    this.mix[kind].muted = !!muted;
    this.applyVolumes();
    this.emit('settings');
  }

  applyVolumes() {
    if (this.video) {
      if (this.origGain) {
        // 走 WebAudio 混音：iOS 上元素 volume 可能被忽略，用增益节点才可靠
        this.origGain.gain.value = this.mix.orig.muted ? 0 : this.mix.orig.volume;
        this.video.volume = 1;
        this.video.muted = this.mix.orig.muted;
      } else {
        this.video.volume = this.mix.orig.muted ? 0 : this.mix.orig.volume;
        this.video.muted = this.mix.orig.muted;
      }
    }
    for (const k of ['piano', 'voice']) {
      const el = this.audioEls[k];
      if (!el) continue;
      el.volume = this.mix[k].muted ? 0 : this.mix[k].volume;
      el.muted = this.mix[k].muted;
    }
  }

  /**
   * 把视频音频接入 WebAudio（用于 iOS 上「原声音量」滑杆无效的情况）。
   * 注意：同一个 <video> 只能调用一次，且需要刷新页面才能恢复到普通模式。
   */
  enableGraph(ctx) {
    if (this.origGain) return true;
    if (this._graphFailed || !this.video) return false;
    try {
      this.mediaSource = ctx.createMediaElementSource(this.video);
      this.origGain = ctx.createGain();
      this.mediaSource.connect(this.origGain);
      this.origGain.connect(ctx.destination);
      this.applyVolumes();
      return true;
    } catch (err) {
      console.warn('[player] WebAudio 混音不可用', err);
      this._graphFailed = true;
      return false;
    }
  }

  get graphEnabled() {
    return !!this.origGain;
  }

  /* ------------------------- 叠加录音 ------------------------- */

  /**
   * @param {'piano'|'voice'} kind
   * @param {{url:string,start:number,duration:number}|null} rec start 为视频时间轴上的录制起点
   */
  setOverlay(kind, rec) {
    const el = this.audioEls[kind];
    if (!el) return;
    this._want[kind] = false;
    el.pause();
    this.recs[kind] = rec || null;
    if (rec && rec.url) {
      if (el.getAttribute('src') !== rec.url) {
        el.src = rec.url;
        el.load();
      }
      el.playbackRate = this.rate;
    } else {
      el.removeAttribute('src');
      try { el.load(); } catch { /* ignore */ }
    }
    this.emit('overlaychange', { kind, rec: this.recs[kind] });
  }

  clearOverlays() {
    this.setOverlay('piano', null);
    this.setOverlay('voice', null);
  }

  overlayTime(kind) {
    const rec = this.recs[kind];
    if (!rec) return null;
    return this.currentTime - rec.start;
  }

  syncOverlays(force = false) {
    const t = this.currentTime;
    for (const kind of ['piano', 'voice']) {
      const rec = this.recs[kind];
      const el = this.audioEls[kind];
      if (!el || !rec) continue;
      const local = t - rec.start;
      const inRange = this.playing && local >= -0.02 && local <= (rec.duration || (rec.end - rec.start) || 0) + 0.05;
      if (!inRange) {
        if (this._want[kind] || !el.paused) {
          this._want[kind] = false;
          el.pause();
        }
        if (local < -0.02) { try { el.currentTime = 0; } catch { /* ignore */ } }
        continue;
      }
      // 播放被系统拒绝后（iOS 未授权自动播放）退避重试，避免每秒 60 次的失败风暴
      const blockedUntil = this._blocked[kind] || 0;
      if (blockedUntil > performance.now()) continue;
      const want = Math.max(0, local);
      const startEl = () => {
        this._want[kind] = true;
        try { el.currentTime = want; } catch { /* ignore */ }
        el.playbackRate = this.rate;
        el.play().catch(() => {
          this._want[kind] = false;
          this._blocked[kind] = performance.now() + 1200;
        });
      };
      if (el.paused && !this._want[kind]) {
        startEl();
      } else if (force || Math.abs(el.currentTime - want) > DRIFT_TOLERANCE) {
        if (el.paused) startEl();
        else { try { el.currentTime = want; } catch { /* ignore */ } }
      }
    }
  }

  pauseOverlays() {
    for (const kind of ['piano', 'voice']) {
      const el = this.audioEls[kind];
      this._want[kind] = false;
      if (el && !el.paused) el.pause();
    }
  }

  /* ------------------------- 传输控制 ------------------------- */

  /** 等 seek 真正完成（WebKit 里 seek 未完成就 play() 容易抛 AbortError） */
  waitSeeked(timeout = 600) {
    if (!this.video || !this.video.seeking) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.video.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeout);
      this.video.addEventListener('seeked', done);
    });
  }

  /**
   * 播放后校验位置：WebKit 里「暂停 → seek → 立刻 play」偶尔会让媒体时钟
   * 从旧位置继续，这里补一次播放中的 seek 把它拉回来。
   */
  async ensurePosition(target, tol = 0.12, ms = 320) {
    if (!this.video || !Number.isFinite(target)) return true;
    const t0 = performance.now();
    let stable = 0;
    while (performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 25));
      if (Math.abs(this.video.currentTime - target) <= tol) {
        stable++;
        if (stable >= 2) return true; // 连续两次都在位，立刻放行
      } else {
        stable = 0;
        try { this.video.currentTime = target; } catch { /* ignore */ }
      }
    }
    return Math.abs(this.video.currentTime - target) <= tol;
  }

  /** 在用户手势里顺手解锁两条叠加音轨，iOS 才会允许后面 rAF 里的 play() */
  unlockOverlays() {
    for (const kind of ['piano', 'voice']) {
      const el = this.audioEls[kind];
      if (!el || !el.getAttribute('src')) continue;
      const wasMuted = el.muted;
      el.muted = true;
      const pr = el.play();
      if (pr && pr.then) {
        pr.then(() => { el.pause(); el.muted = wasMuted; }).catch(() => { el.muted = wasMuted; });
      } else {
        el.muted = wasMuted;
      }
    }
  }

  /**
   * 播放 + 重试：Safari/WebKit 在 seek 之后立刻 play() 偶尔会抛 AbortError，
   * 隔一点时间重试即可恢复，避免循环在第二遍卡住。
   */
  async tryPlay(attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.video.play();
        return true;
      } catch (err) {
        if (i === attempts - 1) {
          this.lastPlayError = err;
          return false;
        }
        await new Promise((r) => setTimeout(r, 60 * (i + 1)));
      }
    }
    return false;
  }

  async play() {
    if (!this.video || !this.video.src) return;
    this._blocked = { piano: 0, voice: 0 };
    clearTimeout(this._gapTimer);
    this.completed = 0;
    const { a, b } = this.loop;
    let seekedTo = null;
    if (Number.isFinite(b) && b - a > 0.05) {
      const t = this.currentTime;
      if (t < a - 0.05 || t >= b - 0.02) {
        this.seek(a, { silent: true });
        seekedTo = a;
        await this.waitSeeked();
      }
    }
    this.video.playbackRate = this.rate;
    this.state = 'playing';
    this._starting = true;
    const ok = await this.tryPlay();
    if (!ok) {
      this._starting = false;
      this.state = 'idle';
      this.emit('error', { message: String((this.lastPlayError && this.lastPlayError.message) || '播放被系统拒绝') });
      return;
    }
    // 有的 WebKit 后端在「暂停 → seek → play」时会从旧位置继续，这里兜一下
    const inRange = Number.isFinite(b) ? (this.currentTime >= a - 0.06 && this.currentTime <= b + 0.06) : true;
    if (!inRange) {
      this.seek(a, { silent: true });
      await this.waitSeeked();
      await this.ensurePosition(a);
    } else if (seekedTo != null) {
      await this.ensurePosition(seekedTo);
    }
    this._starting = false;
    this.emit('pass', { pass: 1, repeats: this.repeats });
    this.syncOverlays(true);
  }

  pause() {
    clearTimeout(this._gapTimer);
    if (this.video && !this.video.paused) this.video.pause();
    this.pauseOverlays();
    this.state = 'idle';
  }

  toggle() {
    if (this.playing) { this.pause(); return false; }
    // 若已停在 B 点，重新开始时回到 A
    const { a, b } = this.loop;
    if (Number.isFinite(b) && this.currentTime >= b - 0.03) this.seek(a, { silent: true });
    this.play();
    return true;
  }

  seek(t, { silent = false } = {}) {
    if (!this.video) return;
    const dur = this.duration || 0;
    const target = Math.max(0, Math.min(dur ? dur - 0.02 : t, t));
    try { this.video.currentTime = target; } catch { /* ignore */ }
    this.pauseOverlays();
    if (!silent) this.emit('time', { t: target, force: true });
    // 立刻让叠加音轨跟上
    setTimeout(() => this.syncOverlays(true), 30);
  }

  seekBy(dt) {
    const { a, b } = this.loop;
    let t = this.currentTime + dt;
    if (Number.isFinite(a) && Number.isFinite(b)) t = Math.max(a, Math.min(b, t));
    this.seek(t);
  }

  effectiveInterval() {
    if (this.interval !== 'auto') return this.interval;
    const { a, b } = this.loop;
    const len = Number.isFinite(b) ? Math.max(0, b - a) : 0;
    if (!len) return 0.6;
    return Math.max(0.35, Math.min(2.5, len * 0.09));
  }

  onEnded() {
    this.pauseOverlays();
    this.state = 'idle';
    this.emit('complete', { reason: 'ended' });
    this.emit('pause');
  }

  async onLoopBoundary() {
    const { a, b } = this.loop;
    this.completed += 1;
    this.video.pause();
    this.pauseOverlays();
    this.emit('loopend', { pass: this.completed, repeats: this.repeats });

    if (this.completed >= this.repeats) {
      this.state = 'idle';
      this.emit('complete', { reason: 'repeats', pass: this.completed });
      this.emit('pause');
      return;
    }
    const gap = this.effectiveInterval();
    this.state = 'gap';
    this.emit('gap', { ms: gap * 1000 });
    const resume = async () => {
      this._gapTimer = 0;
      this.seek(a, { silent: true });
      // 等 seek 真正落地再 play，能避开 WebKit 的 AbortError
      await this.waitSeeked();
      await new Promise((r) => setTimeout(r, 25));
      this.state = 'playing';
      this._starting = true;
      const ok = await this.tryPlay();
      if (ok) {
        await this.ensurePosition(a);
        this._starting = false;
        this.emit('pass', { pass: this.completed + 1, repeats: this.repeats });
        this.syncOverlays(true);
      } else {
        this._starting = false;
        this.state = 'idle';
        this.emit('pause');
        this.emit('error', { message: '自动续播被系统拦截了，点一下播放键继续。' });
      }
    };
    if (gap > 0.01) this._gapTimer = setTimeout(resume, gap * 1000);
    else resume();
  }

  tick = () => {
    this._raf = requestAnimationFrame(this.tick);
    if (!this.video) return;
    const t = this.video.currentTime;
    const now = performance.now();

    if (this.state === 'playing' && !this.video.paused) {
      const { b } = this.loop;
      const crossedEnd = !this._starting && Number.isFinite(b) && t >= b - 0.015 && !this.video.seeking
        && now - (this._lastBoundaryAt || 0) > 250;
      if (crossedEnd) {
        this._lastBoundaryAt = now;
        this.onLoopBoundary();
      } else {
        this.syncOverlays();
      }
    }

    if (now - this._lastEmit > 33) {
      this._lastEmit = now;
      this.emit('time', { t, playing: !this.video.paused, state: this.state });
    }
  };
}
