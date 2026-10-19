/*
 * waveform.js — 可交互的波形区：A/B 手柄拖拽、点击定位、段落色带
 */

const PAD = 10;

export class Waveform extends EventTarget {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaks = null;
    this.duration = 1;
    this.segments = [];
    this.ab = { a: null, b: null };
    this.playhead = 0;
    this.activeSegId = null;
    this.hover = null;
    this.drag = null;
    this.raf = 0;
    this.dirty = true;
    this.pad = PAD;

    this._onPointerDown = this.onPointerDown.bind(this);
    this._onPointerMove = this.onPointerMove.bind(this);
    this._onPointerUp = this.onPointerUp.bind(this);

    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.requestRender(); } });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.loop();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(80, Math.round(rect.width));
    const h = Math.max(48, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestRender();
  }

  setData({ peaks, duration, segments, ab, activeSegId }) {
    if (peaks !== undefined) this.peaks = peaks;
    if (duration !== undefined) this.duration = Math.max(0.001, duration || 0.001);
    if (segments !== undefined) this.segments = segments;
    if (ab !== undefined) this.ab = ab;
    if (activeSegId !== undefined) this.activeSegId = activeSegId;
    this.requestRender();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.requestRender();
  }

  get innerW() { return this.w - this.pad * 2; }

  timeToX(t) {
    return this.pad + (Math.max(0, Math.min(this.duration, t)) / this.duration) * this.innerW;
  }

  xToTime(x) {
    return Math.max(0, Math.min(this.duration, ((x - this.pad) / this.innerW) * this.duration));
  }

  requestRender() {
    this.dirty = true;
  }

  loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
  };

  draw() {
    const { ctx, w, h, pad } = this;
    const innerW = this.innerW;
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    roundRect(ctx, pad, 6, innerW, h - 12, 8);
    ctx.fill();

    // 段落色带
    for (const seg of this.segments) {
      const x0 = this.timeToX(seg.a);
      const x1 = this.timeToX(seg.b);
      if (x1 - x0 < 1) continue;
      const isActive = seg.id === this.activeSegId;
      ctx.fillStyle = isActive ? 'rgba(255,176,32,0.22)' : 'rgba(120,170,255,0.10)';
      ctx.fillRect(x0, 6, Math.max(1, x1 - x0), h - 12);
      if (isActive) {
        ctx.strokeStyle = 'rgba(255,176,32,0.75)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, 6.5, Math.max(1, x1 - x0 - 1), h - 13);
      }
      if (x1 - x0 > 34) {
        ctx.fillStyle = isActive ? 'rgba(255,196,80,0.95)' : 'rgba(160,190,255,0.55)';
        ctx.font = '10px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(String(seg.index), x0 + 4, 17);
      }
    }

    // AB 区间
    const { a, b } = this.ab;
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      const xa = this.timeToX(a);
      const xb = this.timeToX(b);
      ctx.fillStyle = 'rgba(255,110,110,0.16)';
      ctx.fillRect(xa, 6, xb - xa, h - 12);
    }

    // 波形
    const peaks = this.peaks;
    const midY = h / 2;
    const ampH = (h - 20) / 2;
    if (peaks && peaks.length >= 4) {
      const buckets = peaks.length / 2;
      for (let x = 0; x < innerW; x++) {
        const i0 = Math.floor((x / innerW) * buckets);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / innerW) * buckets));
        let lo = 1;
        let hi = -1;
        for (let i = i0; i < i1 && i < buckets; i++) {
          lo = Math.min(lo, peaks[i * 2]);
          hi = Math.max(hi, peaks[i * 2 + 1]);
        }
        if (lo > hi) continue;
        const t = ((x + 0.5) / innerW) * this.duration;
        const inRegion = Number.isFinite(a) && Number.isFinite(b) && t >= a && t <= b;
        ctx.strokeStyle = inRegion ? 'rgba(255,214,120,0.95)' : 'rgba(150,200,255,0.5)';
        ctx.beginPath();
        ctx.moveTo(pad + x + 0.5, midY - hi * ampH);
        ctx.lineTo(pad + x + 0.5, midY - lo * ampH);
        ctx.stroke();
      }
      // 中线
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(pad, midY + 0.5);
      ctx.lineTo(pad + innerW, midY + 0.5);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.font = '12px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无波形数据（视频音轨无法解析时可导入参考音频）', w / 2, midY + 4);
    }

    // 播放头
    if (Number.isFinite(this.playhead)) {
      const x = this.timeToX(this.playhead);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, h - 4);
      ctx.stroke();
    }

    // A / B 手柄
    this.drawHandle(a, 'A', '#4cc9a0');
    this.drawHandle(b, 'B', '#ff7a7a');
  }

  drawHandle(t, label, color) {
    if (!Number.isFinite(t)) return;
    const { ctx, h } = this;
    const x = this.timeToX(t);
    const active = this.drag === label || this.hover === label;
    ctx.fillStyle = color;
    ctx.globalAlpha = active ? 1 : 0.85;
    roundRect(ctx, x - 7, 2, 14, 16, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0b0f16';
    ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, 10.5);
    ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = color;
    ctx.lineWidth = active ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 18);
    ctx.lineTo(x, h - 2);
    ctx.stroke();
  }

  hitTest(x, y) {
    const { a, b } = this.ab;
    const near = 16;
    if (y < 26) {
      if (Number.isFinite(a) && Math.abs(this.timeToX(a) - x) < near) return 'A';
      if (Number.isFinite(b) && Math.abs(this.timeToX(b) - x) < near) return 'B';
    }
    if (Number.isFinite(a) && Math.abs(this.timeToX(a) - x) < 10) return 'A';
    if (Number.isFinite(b) && Math.abs(this.timeToX(b) - x) < 10) return 'B';
    return null;
  }

  localPoint(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  onPointerDown(ev) {
    ev.preventDefault();
    const { x, y } = this.localPoint(ev);
    const handle = this.hitTest(x, y);
    if (handle) {
      this.drag = handle;
      this.canvas.setPointerCapture?.(ev.pointerId);
      this.emit('abstart', { which: handle });
      return;
    }
    this.drag = 'seek';
    this.canvas.setPointerCapture?.(ev.pointerId);
    this.emit('seek', this.xToTime(x));
  }

  onPointerMove(ev) {
    const { x, y } = this.localPoint(ev);
    if (!this.drag) {
      const handle = this.hitTest(x, y);
      if (handle !== this.hover) {
        this.hover = handle;
        this.canvas.style.cursor = handle ? 'ew-resize' : 'pointer';
        this.requestRender();
      }
      return;
    }
    ev.preventDefault();
    const t = this.xToTime(x);
    if (this.drag === 'seek') {
      this.emit('seek', t);
    } else {
      this.emit('abchange', { which: this.drag, time: t, live: true });
    }
  }

  onPointerUp(ev) {
    if (!this.drag) return;
    const which = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture?.(ev.pointerId);
    if (which !== 'seek') this.emit('abend', { which });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
