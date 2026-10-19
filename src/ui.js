/*
 * ui.js — DOM 渲染与交互（不含业务逻辑）
 */

import { fmtTime } from './audio.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const REPEAT_OPTIONS = [
  { v: 'inf', label: '不限' },
  { v: 1, label: '1' },
  { v: 2, label: '2' },
  { v: 3, label: '3' },
  { v: 5, label: '5' },
  { v: 10, label: '10' },
  { v: 'custom', label: '自定义' },
];

export const INTERVAL_OPTIONS = [
  { v: 'auto', label: '自动' },
  { v: 0, label: '0.0' },
  { v: 0.5, label: '0.5' },
  { v: 1, label: '1.0' },
  { v: 2, label: '2.0' },
  { v: 3, label: '3.0' },
];

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="7" y="5.5" width="3.6" height="13" fill="currentColor"/><rect x="13.4" y="5.5" width="3.6" height="13" fill="currentColor"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor"/></svg>';

export class UI {
  /** @param {any} app 见 app.js */
  constructor(app) {
    this.app = app;
    this.$ = {};
    const ids = [
      'app', 'title', 'btnProjects', 'btnPickVideo', 'btnPickAudio', 'btnMenu', 'btnPickVideo2',
      'stage', 'video', 'emptyStage', 'timeBadge', 'loopBadge', 'ratioBadge',
      'recHud', 'recKind', 'recTime', 'recLevel', 'recNote', 'segHint',
      'panel', 'btnSetA', 'btnSetB', 'btnAddRow', 'btnDelRow', 'btnLyrics', 'btnIo', 'btnRepeatOne',
      'segList', 'segCount', 'storageInfo',
      'tCur', 'tAB', 'tDur', 'wave', 'btnBack', 'btnPlay', 'btnFwd', 'btnSpeed',
      'repeatChips', 'intervalChips', 'mixer',
      'sheetBackdrop', 'sheet', 'sheetTitle', 'sheetBody', 'sheetFoot', 'sheetClose',
      'toast', 'fileVideo', 'fileAudio', 'fileJson', 'audioPiano', 'audioVoice',
    ];
    for (const id of ids) {
      const node = document.getElementById(id);
      this.$[id] = node;
      if (node) this[`$${id}`] = node; // 便捷属性：this.$title / this.$btnPlay …
    }
    this.playing = false;
    this.toastTimer = 0;
    this.editingSegId = null;
    this.bindStatic();
  }

  get el() { return this.$; }

  /* ------------------------------ 静态绑定 ------------------------------ */

  bindStatic() {
    const a = () => this.app;

    $('#btnPickVideo').addEventListener('click', () => $('#fileVideo').click());
    $('#btnPickVideo2').addEventListener('click', () => $('#fileVideo').click());
    $('#btnPickAudio').addEventListener('click', () => $('#fileAudio').click());
    $('#btnMenu').addEventListener('click', () => a().openSettingsSheet());
    $('#btnProjects').addEventListener('click', () => a().openProjectsSheet());

    $('#fileVideo').addEventListener('change', (ev) => a().onVideoPicked(ev.target.files?.[0]));
    $('#fileAudio').addEventListener('change', (ev) => a().onRefAudioPicked(ev.target.files?.[0]));
    $('#fileJson').addEventListener('change', (ev) => {
      a().importProjectFile(ev.target.files?.[0]);
      ev.target.value = '';
    });

    $('#title').addEventListener('input', (ev) => a().onTitleChange(ev.target.value));
    $('#title').addEventListener('blur', () => a().persist());

    $('#btnSetA').addEventListener('click', () => a().setAFromPlayhead());
    $('#btnSetB').addEventListener('click', () => a().setBFromPlayhead());
    $('#btnAddRow').addEventListener('click', () => a().addRowAtPlayhead());
    $('#btnDelRow').addEventListener('click', () => a().deleteActiveRow());
    $('#btnLyrics').addEventListener('click', () => a().openLyricsSheet());
    $('#btnIo').addEventListener('click', () => a().openIoSheet());
    $('#btnRepeatOne').addEventListener('click', () => a().toggleSingleLoop());

    $('#btnPlay').addEventListener('click', () => a().togglePlay());
    $('#btnBack').addEventListener('click', () => a().seekBy(-5));
    $('#btnFwd').addEventListener('click', () => a().seekBy(5));
    $('#btnSpeed').addEventListener('click', () => a().cycleSpeed());

    for (const s of $$('.slider', $('#mixer'))) {
      s.addEventListener('input', (ev) => a().setVolume(ev.target.dataset.kind, Number(ev.target.value) / 100));
    }
    for (const b of $$('.muteBtn', $('#mixer'))) {
      b.addEventListener('click', () => a().toggleMute(b.dataset.kind));
    }

    $('#sheetClose').addEventListener('click', () => this.closeSheet());
    $('#sheetBackdrop').addEventListener('click', () => this.closeSheet());

    document.addEventListener('keydown', (ev) => {
      if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
      const k = ev.key.toLowerCase();
      if (k === ' ') { ev.preventDefault(); a().togglePlay(); }
      else if (k === 'arrowleft') { ev.preventDefault(); a().seekBy(-1); }
      else if (k === 'arrowright') { ev.preventDefault(); a().seekBy(1); }
      else if (k === '[') a().setAFromPlayhead();
      else if (k === ']') a().setBFromPlayhead();
      else if (k === 'escape') this.closeSheet();
    });

    window.addEventListener('beforeunload', (ev) => {
      a().persist({ immediate: true });
      // 正在录音时提醒一下，避免随手刷新把这一条录音弄丢
      if (a().recState || a().recStarting) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  /* ------------------------------ 顶栏 / 面板 ------------------------------ */

  renderProject(project) {
    this.$title.value = project.title || '未命名练习';
    this.renderSegments(project);
    this.renderTransportControls(project);
    this.renderMixer(project);
  }

  renderTransportControls(project) {
    const s = project.settings;
    const repBox = this.$repeatChips;
    repBox.innerHTML = '<span class="chipLabel">重复</span>';
    for (const opt of REPEAT_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = opt.label;
      const isMatch = String(s.repeats) === String(opt.v);
      if (isMatch) btn.classList.add('on');
      btn.addEventListener('click', () => this.app.setRepeats(opt.v));
      repBox.appendChild(btn);
    }
    // 自定义次数
    if (s.repeats !== 'inf' && ![1, 2, 3, 5, 10].includes(Number(s.repeats))) {
      const inp = document.createElement('input');
      inp.className = 'chip input on';
      inp.value = String(s.repeats);
      inp.inputMode = 'numeric';
      inp.addEventListener('change', () => this.app.setRepeats(Number(inp.value) || 1));
      repBox.appendChild(inp);
    }

    const intBox = this.$intervalChips;
    intBox.innerHTML = '<span class="chipLabel">间隔</span>';
    for (const opt of INTERVAL_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = opt.label;
      if (String(s.interval) === String(opt.v)) btn.classList.add('on');
      btn.addEventListener('click', () => this.app.setInterval(opt.v));
      intBox.appendChild(btn);
    }

    this.$btnSpeed.textContent = `${Number(s.rate || 1).toFixed(1)}×`;
    this.$btnSpeed.classList.toggle('on', Number(s.rate) !== 1);
    this.$btnRepeatOne.classList.toggle('on', !!s.singleSegmentLoop);
    this.renderMixer(project);
  }

  renderMixer(project) {
    const mix = project.settings.mix;
    for (const kind of ['orig', 'piano', 'voice']) {
      const track = $(`.track[data-kind="${kind}"]`, this.$mixer);
      if (!track) continue;
      const conf = mix[kind] || { volume: 1, muted: false };
      const slider = $('.slider', track);
      const btn = $('.muteBtn', track);
      if (slider) slider.value = String(Math.round((conf.volume ?? 1) * 100));
      if (btn) {
        btn.classList.toggle('on', !conf.muted);
        btn.classList.toggle('off', !!conf.muted);
      }
    }
    this.updateMixerAvailability(project);
  }

  updateMixerAvailability(project) {
    for (const kind of ['piano', 'voice']) {
      const track = $(`.track[data-kind="${kind}"]`, this.$mixer);
      if (!track) continue;
      const has = project.recordings.some((r) => r.kind === kind);
      track.style.opacity = has ? '1' : '.45';
      track.title = has ? '' : '还没有该音轨的录音';
    }
  }

  /* ------------------------------ 段落列表 ------------------------------ */

  renderSegments(project) {
    const list = this.$segList;
    const segs = [...project.segments].sort((x, y) => (x.a - y.a) || (x.b - y.b));
    const activeId = this.app.activeSegmentId;
    list.innerHTML = '';
    if (!segs.length) {
      const div = document.createElement('div');
      div.className = 'emptyList';
      div.innerHTML = '还没有段落。<br/>把播放头停在句子开头点 <b>设置A</b>，停在结尾点 <b>设置B</b>，<br/>再点 <b>添加行</b> 即可记住这一句。';
      list.appendChild(div);
    }
    segs.forEach((seg, i) => {
      list.appendChild(this.buildSegmentRow(project, seg, i + 1, activeId));
    });
    this.$segCount.textContent = `${segs.length} 段`;
    this.activeSegId = this.app.activeSegmentId || null;
    this.applySegmentHighlight();
  }

  buildSegmentRow(project, seg, index, activeId) {
    const row = document.createElement('div');
    row.className = 'seg';
    row.dataset.id = seg.id;
    if (seg.star) row.classList.add('star');
    if (seg.id === activeId) row.classList.add('active');

    const head = document.createElement('div');
    head.className = 'segHead';

    const idx = document.createElement('button');
    idx.type = 'button';
    idx.className = 'segIdx';
    idx.textContent = seg.star ? '★' : String(index);
    idx.addEventListener('click', () => this.app.playSegment(seg.id));

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'segTime';
    time.textContent = `${fmtTime(seg.a)} ~ ${fmtTime(seg.b)}`;
    time.addEventListener('click', () => this.app.playSegment(seg.id));

    const len = document.createElement('span');
    len.className = 'segLen';
    len.textContent = `${Math.max(0, seg.b - seg.a).toFixed(2)}s`;

    const star = document.createElement('button');
    star.type = 'button';
    star.className = `iconBtn${seg.star ? ' on' : ''}`;
    star.textContent = seg.star ? '★' : '☆';
    star.title = '收藏这一段';
    star.addEventListener('click', () => this.app.toggleStar(seg.id));

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'iconBtn';
    more.textContent = '⋯';
    more.addEventListener('click', () => this.app.openSegmentMenu(seg.id));

    head.append(idx, time, len, star, more);

    const tech = document.createElement('label');
    tech.className = 'field tech';
    const techS = document.createElement('span');
    techS.textContent = '技巧';
    const techI = document.createElement('input');
    techI.type = 'text';
    techI.placeholder = '弹奏技巧：右手断奏 / 踏板每小节换…';
    techI.value = seg.tech || '';
    techI.addEventListener('input', () => this.app.updateSegment(seg.id, { tech: techI.value }, { soft: true }));
    techI.addEventListener('focus', () => { this.editingSegId = seg.id; });
    tech.append(techS, techI);

    const lyric = document.createElement('label');
    lyric.className = 'field lyric';
    const lyricS = document.createElement('span');
    lyricS.textContent = '歌词';
    const lyricI = document.createElement('input');
    lyricI.type = 'text';
    lyricI.placeholder = '歌词 / 段落：A段 · 第一句';
    lyricI.value = seg.lyric || '';
    lyricI.addEventListener('input', () => this.app.updateSegment(seg.id, { lyric: lyricI.value }, { soft: true }));
    lyricI.addEventListener('focus', () => { this.editingSegId = seg.id; });
    lyric.append(lyricS, lyricI);

    const actions = document.createElement('div');
    actions.className = 'segActions';
    actions.append(
      this.actBtn('▶ 播放', () => this.app.playSegment(seg.id)),
      this.actBtn(this.recLabel(project, seg, 'piano'), () => this.app.recordSegment(seg.id, 'piano'), 'piano', this.hasRec(project, seg, 'piano')),
      this.actBtn(this.recLabel(project, seg, 'voice'), () => this.app.recordSegment(seg.id, 'voice'), 'voice', this.hasRec(project, seg, 'voice')),
      this.actBtn('VS 对比', () => this.app.compareSegment(seg.id), 'vs'),
      this.actBtn('♪ 原声', () => this.app.playOriginalOnly(seg.id)),
    );

    const chips = document.createElement('div');
    chips.className = 'scoreChips';
    chips.dataset.role = 'scores';
    chips.innerHTML = this.scoreChipsHTML(project, seg);

    row.append(head, tech, lyric, actions, chips);
    return row;
  }

  actBtn(label, onClick, cls = '', have = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `act ${cls}${have ? ' have' : ''}`;
    b.textContent = label;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }

  recLabel(project, seg, kind) {
    const rec = this.bestRec(project, seg, kind);
    if (!rec) return kind === 'piano' ? '🎹 录钢琴' : '🎤 录人声';
    const icon = kind === 'piano' ? '🎹' : '🎤';
    return `${icon} 重录${rec.score?.ok ? ` ${rec.score.overall}` : ''}`;
  }

  hasRec(project, seg, kind) {
    return !!this.bestRec(project, seg, kind);
  }

  bestRec(project, seg, kind) {
    const list = project.recordings.filter((r) => r.kind === kind && r.segId === seg.id);
    if (!list.length) return null;
    return list.reduce((b, r) => (!b || (r.score?.overall || 0) > (b.score?.overall || 0) ? r : b), null);
  }

  scoreChipsHTML(project, seg) {
    const parts = [];
    for (const kind of ['piano', 'voice']) {
      const rec = this.bestRec(project, seg, kind);
      if (!rec || !rec.score || !rec.score.ok) continue;
      const v = rec.score.overall;
      const cls = v >= 85 ? 'good' : v >= 65 ? 'mid' : 'bad';
      const label = kind === 'piano' ? '钢琴' : '人声';
      parts.push(`<span class="scoreChip ${cls}">${label} <b>${v}</b></span>`);
    }
    if (!parts.length) return '';
    return parts.join('');
  }

  updateSegmentScores(project, segId) {
    const row = $(`.seg[data-id="${segId}"]`, this.$segList);
    if (!row) return;
    const seg = project.segments.find((s) => s.id === segId);
    if (!seg) return;
    const chips = $('[data-role="scores"]', row);
    if (chips) chips.innerHTML = this.scoreChipsHTML(project, seg);
    const acts = $$('.act.piano, .act.voice', row);
    if (acts[0]) acts[0].textContent = this.recLabel(project, seg, 'piano');
    if (acts[1]) acts[1].textContent = this.recLabel(project, seg, 'voice');
    for (const [i, kind] of [[0, 'piano'], [1, 'voice']]) {
      if (acts[i]) acts[i].classList.toggle('have', this.hasRec(project, seg, kind));
    }
  }

  setActiveSegment(segId) {
    this.activeSegId = segId;
    this.applySegmentHighlight();
  }

  /** 跟播高亮：只影响视觉，不影响当前工作段落 */
  setHighlightedSegment(segId) {
    if (this.highlightSegId === segId) return;
    this.highlightSegId = segId;
    this.applySegmentHighlight();
    const row = segId ? $(`.seg[data-id="${segId}"]`, this.$segList) : null;
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  applySegmentHighlight() {
    for (const row of $$('.seg', this.$segList)) {
      const on = row.dataset.id === this.activeSegId || row.dataset.id === this.highlightSegId;
      row.classList.toggle('active', on);
      row.classList.toggle('playing-seg', row.dataset.id === this.highlightSegId);
    }
  }

  /* ------------------------------ 时间 / 传输 ------------------------------ */

  updateTime({ t, duration, ab, playing }) {
    const $ = this.$;
    const dur = duration || 0;
    $.tCur.textContent = fmtTime(t);
    $.tDur.textContent = fmtTime(dur);
    $.timeBadge.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
    const aOk = Number.isFinite(ab?.a);
    const bOk = Number.isFinite(ab?.b);
    $.tAB.textContent = `A ${aOk ? fmtTime(ab.a) : '--'} · B ${bOk ? fmtTime(ab.b) : '--'}`;
    if (aOk && bOk && ab.b > ab.a) {
      $.loopBadge.hidden = false;
      $.loopBadge.textContent = `A→B ${(ab.b - ab.a).toFixed(2)}s`;
    } else {
      $.loopBadge.hidden = true;
    }
    this.setPlaying(playing);
  }

  setPlaying(playing) {
    if (this.playing === playing) return;
    this.playing = playing;
    this.$btnPlay.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  }

  /** 录音时把主按钮变成醒目的「停止」 */
  setRecordingUI(active, kind = 'piano') {
    const btn = this.$btnPlay;
    btn.classList.toggle('rec', !!active);
    btn.classList.toggle('stop', !!active);
    btn.innerHTML = active ? ICON_STOP : (this.playing ? ICON_PAUSE : ICON_PLAY);
    btn.setAttribute('aria-label', active ? '停止录音' : '播放/暂停');
    if (active) btn.title = kind === 'piano' ? '正在录制钢琴 —— 点这里停止' : '正在录制人声 —— 点这里停止';
    else btn.removeAttribute('title');
  }

  setRateBadge(rate) {
    this.$btnSpeed.textContent = `${Number(rate).toFixed(1)}×`;
    this.$btnSpeed.classList.toggle('on', Number(rate) !== 1);
  }

  setStemInfo(text) {
    this.$ratioBadge.hidden = !text;
    this.$ratioBadge.textContent = text || '';
  }

  updateABInputs(ab) {
    const $ = this.$;
    $.tAB.textContent = `A ${Number.isFinite(ab.a) ? fmtTime(ab.a) : '--'} · B ${Number.isFinite(ab.b) ? fmtTime(ab.b) : '--'}`;
  }

  showSegmentHint(seg) {
    const el = this.$segHint;
    if (!seg) { el.hidden = true; return; }
    const bits = [];
    if (seg.tech) bits.push(`<div><span class="k">技巧</span> ${escapeHtml(seg.tech)}</div>`);
    if (seg.lyric) bits.push(`<div><span class="k">歌词</span> ${escapeHtml(seg.lyric)}</div>`);
    if (!bits.length) { el.hidden = true; return; }
    el.innerHTML = bits.join('');
    el.hidden = false;
  }

  /* ------------------------------ 录音 HUD ------------------------------ */

  showRecHud(kind, label) {
    this.$recHud.hidden = false;
    this.$recKind.textContent = label || (kind === 'piano' ? '录制钢琴' : '录制人声');
    this.$recTime.textContent = '0.0s';
    this.$recNote.textContent = '—';
    this.$recLevel.style.width = '0%';
  }

  updateRecHud({ elapsed, rms, note, cents, db }) {
    const $ = this.$;
    $.recTime.textContent = `${elapsed.toFixed(1)}s`;
    const pct = Math.max(2, Math.min(100, ((db + 60) / 60) * 100));
    $.recLevel.style.width = `${pct}%`;
    if (note) {
      const c = Math.round(cents || 0);
      $.recNote.textContent = `${note}  ${c > 0 ? '+' : ''}${c}¢`;
    } else {
      $.recNote.textContent = '—';
    }
  }

  hideRecHud() {
    this.$recHud.hidden = true;
  }

  showEmptyStage(show) {
    this.$emptyStage.style.display = show ? 'flex' : 'none';
  }

  /* ------------------------------ 弹层 / 提示 ------------------------------ */

  openSheet({ title, body, foot, onClose }) {
    const $ = this.$;
    $.sheetTitle.textContent = title;
    $.sheetBody.innerHTML = '';
    if (typeof body === 'string') $.sheetBody.innerHTML = body;
    else if (body) $.sheetBody.appendChild(body);
    $.sheetFoot.innerHTML = '';
    if (foot) {
      if (typeof foot === 'string') $.sheetFoot.innerHTML = foot;
      else $.sheetFoot.appendChild(foot);
    }
    $.sheet.hidden = false;
    $.sheetBackdrop.hidden = false;
    this._onSheetClose = onClose || null;
    return $.sheetBody;
  }

  closeSheet() {
    const $ = this.$;
    $.sheet.hidden = true;
    $.sheetBackdrop.hidden = true;
    $.sheetBody.innerHTML = '';
    const cb = this._onSheetClose;
    this._onSheetClose = null;
    cb?.();
  }

  toast(msg, type = '') {
    const el = this.$toast;
    el.textContent = msg;
    el.className = `toast${type ? ' ' + type : ''}`;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, type === 'err' ? 5200 : 3200);
  }

  async updateStorage() {
    try {
      const { storageEstimate } = await import('./db.js');
      const est = await storageEstimate();
      if (!est) { this.$storageInfo.textContent = ''; return; }
      const { fmtBytes } = await import('./audio.js');
      this.$storageInfo.textContent = `本机已用 ${fmtBytes(est.usage)}`;
    } catch { /* ignore */ }
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDur(t) {
  if (!Number.isFinite(t)) return '--';
  if (t >= 60) return fmtTime(t, { decimals: 1 });
  return `${t.toFixed(1)}s`;
}
