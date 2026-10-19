/*
 * app.js — 业务编排：媒体、AB 循环、段落、录音、评分、导入导出
 */

import { Player } from './player.js';
import { UI, escapeHtml, fmtDur, REPEAT_OPTIONS, INTERVAL_OPTIONS } from './ui.js';
import { Waveform } from './waveform.js';
import { store, requestPersistence, storageEstimate, putMedia, getMedia, delMedia } from './db.js';
import * as S from './state.js';
import {
  decodeBlob, prepareForAnalysis, computePeaks, resumeAudio, fmtTime, fmtBytes,
  normalizeInPlace, parseTime, audioContext,
} from './audio.js';
import { extractFeatures, compareTakes, compareVocal, sliceFeatures } from './analyze.js';
import { Recorder, countIn, recorderSupported } from './recorder.js';
import { createZip, readZip } from './zip.js';

const MAX_ANALYSIS_SECONDS = 300;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

const app = {
  project: null,
  ui: null,
  player: null,
  wave: null,
  recorder: null,

  videoUrl: null,
  refUrl: null,
  peaks: null,
  duration: 0,

  ref: null,            // {samples, sampleRate, source, key}
  refFeaturesCache: new Map(),  // "key:a:b" → features
  takeSamplesCache: new Map(),  // recId → {samples, sampleRate}

  activeSegmentId: null,
  urlCache: new Map(),  // recId → objectURL
  recState: null,       // {kind, segId, t0, stopAt, stopping}
  lastHintSegId: null,
  analyzing: false,
  refSeq: 0,
  overlayChain: null,
  busy: false,
};

/* ==================================================================== *
 *  启动
 * ==================================================================== */

async function boot() {
  app.ui = new UI(app);
  app.player = new Player();
  app.player.attach({
    video: app.ui.el.video,
    pianoAudio: app.ui.el.audioPiano,
    voiceAudio: app.ui.el.audioVoice,
  });
  app.wave = new Waveform(app.ui.el.wave);
  app.recorder = new Recorder();

  bindPlayer();
  bindWaveform();
  bindRecorder();

  app.project = await S.loadProject();
  syncPlayerFromSettings();
  app.ui.renderProject(app.project);
  app.ui.renderMixer(app.project);
  app.ui.updateStorage();

  await restoreMedia();
  if (app.project.settings.webAudioMix) armWebAudioMix();
  updateWaveData();
  updateTimeUI();
  registerServiceWorker();
  requestPersistence().catch(() => {});

  if (!app.project.media.videoKey) {
    app.ui.showEmptyStage(true);
  } else {
    app.ui.showEmptyStage(false);
  }
  if (!recorderSupported()) {
    app.ui.toast('这个浏览器不支持录音：请用 Safari（iOS 14.3+）或 Chrome 打开。', 'warn');
  }
}

function bindPlayer() {
  const p = app.player;
  p.addEventListener('time', (ev) => {
    updateTimeUI(ev.detail.t);
    app.wave.setPlayhead(app.player.currentTime);
    maybeShowHint(app.player.currentTime);
  });
  p.addEventListener('play', () => app.ui.setPlaying(true));
  p.addEventListener('pause', () => {
    app.ui.setPlaying(false);
    app.ui.showSegmentHint(null);
    app.lastHintSegId = null;
    restoreSoloOriginal();
  });
  p.addEventListener('meta', () => {
    app.duration = p.duration || 0;
    app.project.media.videoDuration = app.duration;
    updateTimeUI();
    updateWaveData();
  });
  p.addEventListener('loopend', (ev) => {
    const { pass, repeats } = ev.detail;
    if (Number.isFinite(repeats)) app.ui.setStemInfo(`第 ${Math.min(pass, repeats)}/${repeats} 遍`);
    else app.ui.setStemInfo(`第 ${pass} 遍`);
  });
  p.addEventListener('complete', () => {
    app.ui.setStemInfo('');
    if (app.recState) finishRecording();
  });
  p.addEventListener('pass', (ev) => {
    const { pass, repeats } = ev.detail;
    if (Number.isFinite(repeats) && repeats > 1) app.ui.setStemInfo(`第 ${pass}/${repeats} 遍`);
    else if (pass > 1) app.ui.setStemInfo(`第 ${pass} 遍`);
  });
  p.addEventListener('overlaychange', () => { /* 占位：便于调试 */ });
  p.addEventListener('error', (ev) => app.ui.toast(`播放失败：${ev.detail.message}`, 'err'));
}

function bindWaveform() {
  const w = app.wave;
  w.addEventListener('seek', (ev) => {
    const t = ev.detail;
    const { a, b } = app.project.ab;
    const insideLoop = Number.isFinite(a) && Number.isFinite(b) && t >= a - 0.02 && t <= b + 0.02;
    // 点到循环区间之外时先暂停，否则播放头会被 A-B 循环立刻拉回去，没法在那里设 A/B
    if (!insideLoop && app.player.playing) app.player.pause();
    app.player.seek(t);
    if (app.player.playing) app.player.play();
    updateTimeUI(t);
  });
  w.addEventListener('abchange', (ev) => {
    let { time } = ev.detail;
    const which = ev.detail.which;
    const dur = app.duration || 0;
    time = Math.max(0, Math.min(dur || time, time));
    const ab = { ...app.project.ab };
    if (which === 'A') ab.a = Math.min(time, (Number.isFinite(ab.b) ? ab.b - 0.15 : time));
    else ab.b = Math.max(time, (Number.isFinite(ab.a) ? ab.a + 0.15 : time));
    setAB(ab, { manual: true, silent: true });
  });
  w.addEventListener('abend', () => {
    S.saveProject(app.project);
    toastAB();
    // 拖动 A/B 之后直接试听这段（对应「滑动音频区间即可自动播放」）
    const { a, b } = app.project.ab;
    if (app.project.settings.autoPlayOnTap && Number.isFinite(a) && Number.isFinite(b) && b - a > 0.15) {
      app.player.setLoop({ a, b });
      app.player.setRepeats(app.project.settings.repeats);
      app.player.setInterval(app.project.settings.interval);
      app.player.seek(a, { silent: true });
      app.player.play();
    }
  });
}

function bindRecorder() {
  app.recorder.addEventListener('meter', (ev) => {
    if (!app.recState) return;
    app.ui.updateRecHud(ev.detail);
  });
  app.recorder.addEventListener('error', (ev) => {
    app.ui.toast(ev.detail.message, 'err');
    finishRecording({ cancelled: true });
  });
}

/* ==================================================================== *
 *  设置 / 播放器同步
 * ==================================================================== */

/** 等第一次用户手势再接入 WebAudio，否则在挂起的 AudioContext 上接线会没声音 */
function armWebAudioMix() {
  const once = async () => {
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
    try {
      await resumeAudio();
      app.player.enableGraph(audioContext());
    } catch { /* ignore */ }
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
}

function syncPlayerFromSettings() {
  const s = app.project.settings;
  for (const kind of ['orig', 'piano', 'voice']) {
    const conf = s.mix[kind];
    app.player.setVolume(kind, conf.volume);
    app.player.setMuted(kind, conf.muted);
  }
  app.player.setRate(s.rate || 1);
  app.player.setRepeats(s.repeats);
  app.player.setInterval(s.interval);
}

function updateTimeUI(t = app.player.currentTime) {
  if (!app.project) return;
  const ab = app.project?.ab || { a: null, b: null };
  app.ui.updateTime({ t, duration: app.duration, ab, playing: app.player.playing });
}

function updateWaveData() {
  const ab = app.project?.ab || { a: null, b: null };
  app.wave.setData({
    peaks: app.peaks,
    duration: app.duration || 1,
    segments: sortedSegments().map((s, i) => ({ ...s, index: i + 1 })),
    ab,
    activeSegId: app.activeSegmentId,
  });
}

function sortedSegments() {
  return [...(app.project?.segments || [])].sort((x, y) => (x.a - y.a) || (x.b - y.b));
}

/* ==================================================================== *
 *  项目管理：新建 / 保存副本 / 打开 / 删除 / 导入导出
 * ==================================================================== */

const MEDIA_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a' };

function extFor(blob, fallback = 'bin') {
  if (blob && blob.type && MEDIA_EXT[blob.type]) return MEDIA_EXT[blob.type];
  const name = blob && blob.name ? blob.name : '';
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : fallback;
}

/** 收集一个项目引用的所有媒体键，用于删除时判断是否还被别的项目使用 */
function mediaKeysOf(project) {
  const keys = [];
  if (project.media?.videoKey) keys.push(project.media.videoKey, `peaks:${project.media.videoKey}`);
  if (project.media?.refKey) keys.push(project.media.refKey, `peaks:${project.media.refKey}`);
  for (const rec of project.recordings || []) if (rec.blobKey) keys.push(rec.blobKey);
  return keys;
}

async function keysUsedElsewhere(keys, exceptProjectId) {
  const list = await S.listProjects();
  const used = new Set();
  for (const entry of list) {
    if (entry.id === exceptProjectId) continue;
    const other = await S.getProject(entry.id);
    if (!other) continue;
    for (const k of mediaKeysOf(other)) used.add(k);
  }
  return keys.filter((k) => !used.has(k));
}

/** 把项目从界面上卸下来（切换 / 新建之前调用） */
function teardownProject() {
  try { app.player.pause(); } catch { /* ignore */ }
  app.player.clearOverlays();
  try { app.player.video.removeAttribute('src'); app.player.video.load(); } catch { /* ignore */ }
  for (const url of app.urlCache.values()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  app.urlCache.clear();
  if (app.videoUrl) { try { URL.revokeObjectURL(app.videoUrl); } catch { /* ignore */ } }
  app.videoUrl = null;
  app.ref = null;
  app.peaks = null;
  app.duration = 0;
  app.activeSegmentId = null;
  app.lastHintSegId = null;
  app.refFeaturesCache.clear();
  app.takeSamplesCache.clear();
  app.recState = null;
  app.recStarting = false;
  clearInterval(app.recWatch);
  app.ui.hideRecHud();
  app.ui.setRecordingUI(false);
  app.wave.setData({ peaks: null, duration: 1, segments: [], ab: { a: null, b: null }, activeSegId: null });
}

/** 把某个项目装进界面（boot 与切换项目共用） */
async function enterProject(project, { makeCurrent = true } = {}) {
  app.project = project;
  if (makeCurrent) await S.setCurrentProjectId(project.id);
  app.ui.el.title.value = project.title || '未命名练习';
  app.activeSegmentId = null;
  syncPlayerFromSettings();
  app.ui.setRateBadge(project.settings.rate || 1);
  app.ui.renderProject(project);
  app.ui.renderMixer(project);
  app.ui.showEmptyStage(!project.media.videoKey);
  await restoreMedia();
  updateWaveData();
  updateTimeUI();
  app.ui.updateStorage();
}

async function openProjectById(id) {
  if (!id || id === app.project?.id) { openProjectsSheet(); return; }
  if (app.recState || app.recStarting) { app.ui.toast('正在录音，先停止录音再切换项目。', 'warn'); return; }
  await S.saveProject(app.project, { immediate: true });
  const project = await S.getProject(id);
  if (!project) { app.ui.toast('这个项目读不出来了。', 'err'); return; }
  teardownProject();
  await enterProject(project);
  app.ui.closeSheet();
  app.ui.toast(`已打开「${project.title}」（${project.segments.length} 段）`);
}

async function createNewProject() {
  if (app.recState || app.recStarting) { app.ui.toast('正在录音，先停止录音。', 'warn'); return; }
  await S.saveProject(app.project, { immediate: true });
  const fresh = S.createProject();
  fresh.title = `新练习 ${new Date().toLocaleDateString('zh-CN')}`;
  fresh.settings = JSON.parse(JSON.stringify(app.project.settings));
  fresh.settings.lyricText = '';
  await S.registerProject(fresh, { makeCurrent: true });
  teardownProject();
  await enterProject(fresh);
  app.ui.closeSheet();
  app.ui.toast('新建项目：选一段视频，然后设置 A/B 加行。');
  document.getElementById('fileVideo')?.click();
}

/** 另存为副本（共享同一份媒体文件，不重复占用空间） */
async function duplicateCurrentProject() {
  await S.saveProject(app.project, { immediate: true });
  const copy = JSON.parse(JSON.stringify(app.project));
  copy.id = S.uid('proj');
  copy.title = `${app.project.title} 副本`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.segments = copy.segments.map((s) => ({ ...s, id: S.uid('seg') }));
  // 录音仍然指向原来的 blob，段落 id 重新映射
  const segMap = new Map(app.project.segments.map((s, i) => [s.id, copy.segments[i].id]));
  copy.recordings = copy.recordings.map((r) => ({ ...r, id: S.uid('rec'), segId: segMap.get(r.segId) || null }));
  copy.activeRecs = { piano: null, voice: null };
  await S.registerProject(copy);
  app.ui.toast('已保存为副本，可在「项目」里打开。');
  openProjectsSheet();
}

async function deleteProjectById(id) {
  const entry = (await S.listProjects()).find((e) => e.id === id);
  const project = await S.getProject(id);
  await S.deleteProjectFromLibrary(id);
  if (project) {
    const orphans = await keysUsedElsewhere(mediaKeysOf(project), id);
    for (const key of orphans) await delMedia(key);
  }
  if (app.project?.id === id) {
    const rest = await S.listProjects();
    if (rest.length) {
      teardownProject();
      app.project = await S.loadProject();
      await enterProject(app.project);
    } else {
      const fresh = S.createProject();
      await S.registerProject(fresh, { makeCurrent: true });
      teardownProject();
      await enterProject(fresh);
    }
  }
  app.ui.toast(`已删除「${entry?.title || '项目'}」`);
  openProjectsSheet();
}

/* ----------------------------- 单文件导出 / 导入 ----------------------------- */

async function exportProjectFile({ includeMedia = true, onProgress } = {}) {
  const project = app.project;
  await S.saveProject(project, { immediate: true });
  const payload = JSON.parse(JSON.stringify(project));
  const files = { recordings: {} };
  const entries = [];
  const mediaEntries = [];

  if (includeMedia) {
    if (project.media.videoKey) {
      const blob = await getMedia(project.media.videoKey);
      if (blob) {
        const path = `media/video.${extFor(blob, 'mp4')}`;
        mediaEntries.push({ path, blob });
        files.video = { path, type: blob.type || 'video/mp4', name: project.media.videoName || '' };
      }
    }
    if (project.media.refKey) {
      const blob = await getMedia(project.media.refKey);
      if (blob) {
        const path = `media/reference.${extFor(blob, 'm4a')}`;
        mediaEntries.push({ path, blob });
        files.ref = { path, type: blob.type || 'audio/mp4', name: project.media.refName || '' };
      }
    }
    for (const rec of project.recordings) {
      const blob = await getMedia(rec.blobKey);
      if (!blob) continue;
      const path = `media/${rec.kind}-${rec.id}.${extFor(blob, 'm4a')}`;
      mediaEntries.push({ path, blob });
      files.recordings[rec.id] = { path, type: blob.type || 'audio/mp4' };
    }
  }

  payload.files = files;
  payload.app = 'ScoreVoicePlay';
  payload.format = 'svp-project';
  payload.version = 1;

  entries.push({ name: 'project.json', data: JSON.stringify(payload, null, 1) });
  for (const m of mediaEntries) entries.push({ name: m.path, data: m.blob });

  const zip = await createZip(entries, onProgress);
  return zip;
}

async function downloadProjectFile() {
  const estimate = await projectExportSize();
  const includeMedia = await askIncludeMedia(estimate);
  if (includeMedia === null) return;
  app.ui.toast(includeMedia ? '正在打包（含视频与录音），请稍候…' : '正在打包分段与备注…');
  const zip = await exportProjectFile({ includeMedia });
  const name = `${(app.project.title || 'practice').replace(/[\\/:*?"<>|]/g, '_')}.svp.zip`;
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  app.ui.closeSheet();
  app.ui.toast(`已生成 ${name}（${fmtBytes(zip.size)}），可在「文件」App 里传给别人或用 AirDrop。`);
}

async function projectExportSize() {
  let total = 0;
  const keys = [];
  if (app.project.media.videoKey) keys.push(app.project.media.videoKey);
  if (app.project.media.refKey) keys.push(app.project.media.refKey);
  for (const rec of app.project.recordings) if (rec.blobKey) keys.push(rec.blobKey);
  for (const key of keys) {
    const blob = await getMedia(key);
    if (blob) total += blob.size;
  }
  return total;
}

function askIncludeMedia(size) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); app.ui.closeSheet(); };
    const body = document.createElement('div');
    body.innerHTML = `<div class="hint">
      导出的 <code>.svp.zip</code> 可以发给别人、放到 iCloud / 文件 App，再在别的设备上「导入项目」还原。
      ${size > 0 ? `<br/><br/>当前项目的视频与录音合计 <b>${fmtBytes(size)}</b>。` : ''}
      ${size > 260 * 1024 * 1024 ? '<br/><span style="color:#ffd489">文件较大，打包可能较慢（iPad 内存也吃紧），建议只导出分段与备注。</span>' : ''}
    </div>`;
    const foot = document.createElement('div');
    foot.className = 'row';
    const only = mkBtn('只导出分段与备注', 'btn', () => done(false));
    const all = mkBtn(size > 0 ? '连视频与录音一起导出' : '导出（无媒体文件）', 'btn primary', () => done(true));
    const cancel = mkBtn('取消', 'btn ghost', () => done(null));
    foot.append(cancel, only, all);
    app.ui.openSheet({ title: '导出项目', body, foot, onClose: () => done(null) });
  });
}

async function importProjectFile(file) {
  if (!file) return;
  const name = (file.name || '').toLowerCase();
  try {
    if (!name.endsWith('.zip') && !name.endsWith('.svp')) {
      // 纯文本 JSON（旧格式 / 只含分段）
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.app === 'ScoreVoicePlay' && Array.isArray(data.segments)) {
        applyImported(data);
        app.ui.toast('已把这份分段与备注导入当前项目。');
      } else {
        applyImported(data);
      }
      return;
    }

    app.ui.toast('正在读取项目文件…');
    const zip = await readZip(await file.arrayBuffer());
    if (!zip.has('project.json')) throw new Error('这个 zip 里没有 project.json');
    const payload = JSON.parse(await zip.text('project.json'));
    const project = S.normalizeProject(payload);
    project.id = S.uid('proj');
    project.title = payload.title ? `${payload.title}` : '导入的项目';
    project.createdAt = Date.now();
    project.updatedAt = Date.now();

    // 媒体落盘（重新分配键，避免覆盖本机已有文件）
    const files = payload.files || { recordings: {} };
    if (files.video && zip.has(files.video.path)) {
      const bytes = await zip.bytes(files.video.path);
      const key = `video_${Date.now().toString(36)}`;
      await putMedia(key, new Blob([bytes], { type: files.video.type || 'video/mp4' }));
      project.media.videoKey = key;
      project.media.videoName = files.video.name || 'video';
    } else {
      project.media.videoKey = null;
      project.media.videoName = '';
    }
    if (files.ref && zip.has(files.ref.path)) {
      const bytes = await zip.bytes(files.ref.path);
      const key = `ref_${Date.now().toString(36)}`;
      await putMedia(key, new Blob([bytes], { type: files.ref.type || 'audio/mp4' }));
      project.media.refKey = key;
      project.media.refName = files.ref.name || 'reference';
    } else {
      project.media.refKey = null;
      project.media.refName = '';
    }
    project.media.peaksKey = null;
    project.activeRecs = { piano: null, voice: null };
    let restoredRecs = 0;
    for (const rec of project.recordings) {
      const info = files.recordings?.[rec.id];
      if (!info || !zip.has(info.path)) { rec.blobKey = null; continue; }
      const bytes = await zip.bytes(info.path);
      const key = `rec_${S.uid('r')}`;
      await putMedia(key, new Blob([bytes], { type: info.type || 'audio/mp4' }));
      rec.blobKey = key;
      restoredRecs++;
    }
    project.recordings = project.recordings.filter((r) => r.blobKey);

    await S.registerProject(project, { makeCurrent: true });
    if (app.recState || app.recStarting) { app.ui.toast('正在录音，先停止录音。', 'warn'); return; }
    await S.saveProject(app.project, { immediate: true });
    teardownProject();
    await enterProject(project);
    app.ui.closeSheet();
    app.ui.toast(`已导入「${project.title}」：${project.segments.length} 段、${restoredRecs} 条录音`);
  } catch (err) {
    console.error(err);
    app.ui.toast(`导入失败：${err.message || err}`, 'err');
  }
}

/* ==================================================================== *
 *  媒体载入
 * ==================================================================== */

async function restoreMedia() {
  const m = app.project.media;
  if (!m.videoKey) return;
  try {
    const blob = await getMedia(m.videoKey);
    if (!blob) {
      app.ui.toast('上次的视频没有保存成功（可能超出存储配额），请重新选择。', 'warn');
      return;
    }
    app.videoUrl = URL.createObjectURL(blob);
    await app.player.loadSource(app.videoUrl, app.project.ab?.a || 0);
    app.duration = app.player.duration || m.videoDuration || 0;
    const cached = await store.get('media', `peaks:${m.videoKey}`);
    if (cached && cached.peaks) {
      app.peaks = cached.peaks;
      updateWaveData();
    }
    // 即使是缓存命中也必须解码一次，否则 app.ref 为空、录音无法评分
    prepareReference(blob, m.videoKey, { reusePeaks: !!(cached && cached.peaks) });
    if (m.refKey) {
      const refBlob = await getMedia(m.refKey);
      if (refBlob) loadReferenceAudio(refBlob, m.refKey);
    }
    await refreshOverlays();
  } catch (err) {
    console.warn(err);
    app.ui.toast('恢复上次的视频失败，请重新选择视频。', 'warn');
  }
}

async function onVideoPicked(file) {
  if (!file) return;
  app.ui.toast('正在载入视频…');
  try {
    if (app.videoUrl) URL.revokeObjectURL(app.videoUrl);
    app.videoUrl = URL.createObjectURL(file);
    await app.player.loadSource(app.videoUrl, 0);
    app.duration = app.player.duration || 0;

    const key = `video_${Date.now().toString(36)}`;
    let stored = true;
    try {
      await putMedia(key, file);
    } catch (err) {
      stored = false;
      console.warn('[app] 视频保存失败', err);
    }
    const oldKey = app.project.media.videoKey;
    // 只有新视频确实存进去了，才删掉旧的，避免配额失败把旧视频也弄丢
    if (stored && oldKey && oldKey !== key) {
      await delMedia(oldKey);
      try { await store.del('media', `peaks:${oldKey}`); } catch { /* ignore */ }
    }
    app.project.media.videoKey = stored ? key : (oldKey || null);
    app.project.media.videoName = file.name || 'video';
    app.project.media.videoDuration = app.duration;
    app.project.media.peaksKey = null;
    app.project.ab = { a: null, b: null };
    app.activeSegmentId = null;
    app.peaks = null;
    app.ui.showEmptyStage(false);
    app.player.clearOverlays();

    S.saveProject(app.project, { immediate: true });
    app.ui.renderProject(app.project);
    updateWaveData();
    updateTimeUI();

    if (!stored) {
      app.ui.toast('视频太大，没能存到本机：本次可以正常使用，刷新后需要重新选择。', 'warn');
    }
    await prepareReference(file, key);
  } catch (err) {
    console.error(err);
    app.ui.toast(`载入视频失败：${err.message || err}`, 'err');
  }
}

async function onRefAudioPicked(file) {
  if (!file) return;
  const key = `ref_${Date.now().toString(36)}`;
  try {
    await putMedia(key, file).catch(() => {});
    app.project.media.refKey = key;
    app.project.media.refName = file.name || 'reference';
    await loadReferenceAudio(file, key);
    S.saveProject(app.project, { immediate: true });
    app.ui.toast('参考音频已载入：波形与评分将以它为准。');
    app.ui.updateStorage();
  } catch (err) {
    app.ui.toast(`参考音频载入失败：${err.message || err}`, 'err');
  }
}

/**
 * 解码视频/音频，得到一个可分析的参考信号；同时生成波形。
 */
async function prepareReference(blob, key, { reusePeaks = false } = {}) {
  const seq = ++app.refSeq;
  if (blob.size > 320 * 1024 * 1024) {
    app.ui.toast('视频文件太大（超过 320MB），浏览器无法解析它的音轨。请导入一个单独的参考音频用于波形与评分。', 'warn');
    return;
  }
  app.ui.setStemInfo('正在解析音频…');
  try {
    const buffer = await decodeBlob(blob);
    if (seq !== app.refSeq) return;
    if (!buffer) {
      app.ui.setStemInfo('');
      app.ui.toast('无法解析这段视频的音轨。可以点「参考音频」导入同一首曲子的音频文件，用于波形和自动评分。', 'warn');
      return;
    }
    const { samples, sampleRate } = prepareForAnalysis(buffer, 22050);
    app.ref = { samples, sampleRate, source: 'video', key };
    app.refFeaturesCache.clear();
    if (!reusePeaks || !app.peaks) {
      const peaks = computePeaks(samples, 4200);
      app.peaks = peaks;
      updateWaveData();
      if (key) {
        try { await store.set('media', `peaks:${key}`, { peaks, duration: samples.length / sampleRate }); } catch { /* ignore */ }
      }
    }
    app.ui.setStemInfo('');
    if (!reusePeaks) app.ui.toast('音频已解析，可以开始设置 A/B 段落了。');
  } catch (err) {
    console.warn('[app] 参考音频解析失败', err);
    app.ui.setStemInfo('');
  }
}

async function loadReferenceAudio(blob, key) {
  const buffer = await decodeBlob(blob);
  if (!buffer) {
    app.ui.toast('参考音频解码失败（格式不支持）。', 'err');
    return;
  }
  const { samples, sampleRate } = prepareForAnalysis(buffer, 22050);
  app.ref = { samples, sampleRate, source: 'audio', key };
  app.refFeaturesCache.clear();
  app.peaks = computePeaks(samples, 4200);
  updateWaveData();
  if (key) {
    try { await store.set('media', `peaks:${key}`, { peaks: app.peaks }); } catch { /* ignore */ }
  }
}

function refFeaturesFor(a, b) {
  if (!app.ref) return null;
  const key = `${app.ref.key}:${a.toFixed(1)}:${b.toFixed(1)}`;
  if (app.refFeaturesCache.has(key)) return app.refFeaturesCache.get(key);
  const feat = extractFeatures(app.ref.samples, app.ref.sampleRate, {
    from: Math.max(0, a - 0.3),
    to: b + 0.35,
    maxSeconds: MAX_ANALYSIS_SECONDS,
  });
  // 把时间轴平移回视频时间轴（从 a-0.3 开始）
  app.refFeaturesCache.set(key, feat);
  if (app.refFeaturesCache.size > 24) {
    const firstKey = app.refFeaturesCache.keys().next().value;
    app.refFeaturesCache.delete(firstKey);
  }
  return feat;
}

/* ==================================================================== *
 *  AB / 段落
 * ==================================================================== */

function setAB(ab, { manual = false, silent = false } = {}) {
  const a = Number.isFinite(ab.a) ? ab.a : null;
  const b = Number.isFinite(ab.b) ? ab.b : null;
  app.project.ab = { a, b };
  app.player.setLoop({ a: a ?? 0, b });
  if (manual) {
    app.activeSegmentId = null;
    app.ui.setActiveSegment(null);
    app.wave.setData({ activeSegId: null, ab: app.project.ab });
    refreshOverlays();
  } else {
    app.wave.setData({ ab: app.project.ab });
  }
  app.ui.updateABInputs(app.project.ab);
  if (!silent) toastAB();
  S.saveProject(app.project);
}

function toastAB() {
  const { a, b } = app.project.ab;
  const dur = app.duration || 0;
  const ratio = dur > 0 && a != null && b != null ? `（${((b - a) / dur * 100).toFixed(0)}% 全曲）` : '';
  app.ui.toast(`A = ${a != null ? fmtTime(a) : '--'} ，B = ${b != null ? fmtTime(b) : '--'} ${ratio}`);
}

function setAFromPlayhead() {
  if (!app.project) return;
  const t = app.player.currentTime;
  const ab = { ...app.project.ab, a: t };
  if (Number.isFinite(ab.b) && ab.b <= t + 0.1) ab.b = null;
  setAB(ab, { manual: true });
}

function setBFromPlayhead() {
  if (!app.project) return;
  const t = app.player.currentTime;
  const ab = { ...app.project.ab, b: t };
  if (Number.isFinite(ab.a) && ab.a >= t - 0.1) ab.a = null;
  setAB(ab, { manual: true });
}

function addRowAtPlayhead() {
  if (!app.project) return;
  const { a, b } = app.project.ab;
  const t = app.player.currentTime;
  const dur = app.duration || 0;
  let seg;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a + 0.15) {
    seg = S.newSegment(a, b);
  } else {
    const start = Math.max(0, t - 1);
    const end = Math.min(dur || t + 1, t + 1);
    seg = S.newSegment(Math.min(start, t), Math.max(end, t + 0.5));
  }
  app.project.segments.push(seg);
  app.activeSegmentId = seg.id;
  app.ui.renderSegments(app.project);
  app.ui.setActiveSegment(seg.id);
  updateWaveData();
  refreshOverlays();
  S.saveProject(app.project);
  app.ui.toast('已添加一行：双击时间可以改，点时间即播放。');
  focusSegmentInput(seg.id, 'tech');
}

function focusSegmentInput(segId, which = 'tech') {
  setTimeout(() => {
    const row = document.querySelector(`.seg[data-id="${segId}"]`);
    if (!row) return;
    const input = row.querySelector(which === 'tech' ? '.field.tech input' : '.field.lyric input');
    input?.focus();
    input?.select?.();
  }, 60);
}

function deleteActiveRow() {
  if (!app.project) return;
  const seg = activeOrAtPlayhead();
  if (!seg) {
    app.ui.toast('没有可删除的段落：先点一行让它高亮，或把播放头放到某段里。', 'warn');
    return;
  }
  app.ui.openSheet({
    title: '删除这一行？',
    body: `<div class="hint">${fmtTime(seg.a)} ~ ${fmtTime(seg.b)}<br/>${escapeHtml(seg.tech || '（无技巧备注）')}<br/>${escapeHtml(seg.lyric || '（无歌词备注）')}<br/><br/>只会删掉这一段的设置，不会删除视频和录音文件。</div>`,
    foot: (() => {
      const box = document.createElement('div');
      box.className = 'row';
      const cancel = mkBtn('取消', 'btn', () => app.ui.closeSheet());
      const ok = mkBtn('删除', 'btn danger', () => {
        const wasActive = app.activeSegmentId === seg.id;
        app.project.segments = app.project.segments.filter((s) => s.id !== seg.id);
        if (wasActive) {
          app.activeSegmentId = null;
          app.player.pause();
          app.project.ab = { a: null, b: null };
          app.player.setLoop({ a: app.player.currentTime, b: null });
          app.player.setRepeats(1);
        }
        app.ui.closeSheet();
        app.ui.renderSegments(app.project);
        updateWaveData();
        refreshOverlays();
        S.saveProject(app.project);
      });
      box.append(cancel, ok);
      return box;
    })(),
  });
}

function activeOrAtPlayhead() {
  const byId = app.project.segments.find((s) => s.id === app.activeSegmentId);
  if (byId) return byId;
  return S.findSegmentAtTime(app.project.segments, app.player.currentTime) || null;
}

function updateSegment(segId, patch, { soft = false } = {}) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  Object.assign(seg, patch);
  if (seg.b <= seg.a) seg.b = seg.a + 0.2;
  if (soft) {
    S.saveProject(app.project);
    if (app.activeSegmentId === seg.id) app.ui.showSegmentHint(seg);
    updateWaveData();
  } else {
    app.ui.renderSegments(app.project);
    app.ui.setActiveSegment(app.activeSegmentId);
    updateWaveData();
    S.saveProject(app.project);
  }
}

function toggleStar(segId) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  seg.star = !seg.star;
  app.ui.renderSegments(app.project);
  app.ui.setActiveSegment(app.activeSegmentId);
  S.saveProject(app.project);
}

function toggleSingleLoop() {
  app.project.settings.singleSegmentLoop = !app.project.settings.singleSegmentLoop;
  app.ui.$btnRepeatOne.classList.toggle('on', app.project.settings.singleSegmentLoop);
  S.saveProject(app.project);
  app.ui.toast(app.project.settings.singleSegmentLoop
    ? '单句重复：点句子 = 只循环这一句'
    : '连播模式：点句子 = 从该句开头一直播放到曲子结束');
}

/* ==================================================================== *
 *  播放控制
 * ==================================================================== */

function playSegment(segId, { record = false, fromStart = true } = {}) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  const s = app.project.settings;
  app.activeSegmentId = seg.id;
  app.ui.setActiveSegment(seg.id);
  app.wave.setData({ activeSegId: seg.id, ab: { a: seg.a, b: seg.b } });
  app.ui.updateABInputs({ a: seg.a, b: seg.b });
  app.project.ab = { a: seg.a, b: seg.b };

  if (s.singleSegmentLoop) {
    app.player.setLoop({ a: seg.a, b: seg.b });
    app.player.setRepeats(seg.repeats ?? s.repeats);
    app.player.setInterval(seg.interval ?? s.interval);
  } else {
    app.player.setLoop({ a: seg.a, b: null });
    app.player.setRepeats(1);
    app.player.setInterval(s.interval);
  }
  if (fromStart) app.player.seek(seg.a, { silent: true });
  refreshOverlays();
  if (!record) {
    app.player.unlockOverlays();
    app.player.play();
    updateTimeUI();
  }
  S.saveProject(app.project);
}

function playOriginalOnly(segId) {
  // 独奏原声：本次播放期间关掉两条叠加音轨，停止后自动恢复
  app.soloOrig = {
    piano: app.project.settings.mix.piano.muted,
    voice: app.project.settings.mix.voice.muted,
  };
  app.project.settings.mix.piano.muted = true;
  app.project.settings.mix.voice.muted = true;
  app.player.setMuted('piano', true);
  app.player.setMuted('voice', true);
  app.ui.renderMixer(app.project);
  playSegment(segId);
  app.ui.toast('本次只播原声（停止播放后自动恢复叠加）');
}

function restoreSoloOriginal() {
  if (!app.soloOrig || !app.project) return;
  const prev = app.soloOrig;
  app.soloOrig = null;
  app.project.settings.mix.piano.muted = prev.piano;
  app.project.settings.mix.voice.muted = prev.voice;
  app.player.setMuted('piano', prev.piano);
  app.player.setMuted('voice', prev.voice);
  app.ui.renderMixer(app.project);
  S.saveProject(app.project);
}

function togglePlay() {
  if (!app.project) return;
  resumeAudio().catch(() => {});
  if (app.recState) { finishRecording(); return; }
  if (app.player.playing) {
    app.player.pause();
    return;
  }
  const seg = app.project.segments.find((s) => s.id === app.activeSegmentId);
  if (seg) {
    // 暂停后继续播放：不强行跳回 A（若播放头已越界，player 会自己回到 A）
    playSegment(seg.id, { fromStart: false });
    return;
  }
  const ab = app.project.ab;
  const useLoop = app.project.settings.singleSegmentLoop && Number.isFinite(ab.b) && ab.b > (ab.a ?? 0);
  app.player.setLoop({
    a: Number.isFinite(ab.a) ? ab.a : app.player.currentTime,
    b: useLoop ? ab.b : null,
  });
  app.player.setRepeats(useLoop ? app.project.settings.repeats : 1);
  app.player.setInterval(app.project.settings.interval);
  refreshOverlays();
  app.player.unlockOverlays();
  app.player.play();
}

function seekBy(dt) {
  if (!app.project) return;
  resumeAudio().catch(() => {});
  const seg = activeOrAtPlayhead();
  if (seg) {
    const t = Math.max(seg.a, Math.min(seg.b, app.player.currentTime + dt));
    app.player.seek(t);
  } else {
    app.player.seekBy(dt);
  }
  updateTimeUI();
}

function cycleSpeed() {
  if (!app.project) return;
  const cur = Number(app.project.settings.rate || 1);
  const idx = SPEEDS.indexOf(cur);
  const next = SPEEDS[(idx + 1) % SPEEDS.length];
  app.project.settings.rate = next;
  app.player.setRate(next);
  app.ui.setRateBadge(next);
  S.saveProject(app.project);
}

function setRepeats(v) {
  if (!app.project) return;
  app.project.settings.repeats = v === 'inf' ? 'inf' : Number(v);
  app.player.setRepeats(v);
  app.ui.renderTransportControls(app.project);
  S.saveProject(app.project);
}

function setInterval(v) {
  if (!app.project) return;
  app.project.settings.interval = v === 'auto' ? 'auto' : Number(v);
  app.player.setInterval(v);
  app.ui.renderTransportControls(app.project);
  S.saveProject(app.project);
}

function setVolume(kind, v) {
  if (!app.project) return;
  app.project.settings.mix[kind].volume = v;
  app.player.setVolume(kind, v);
  S.saveProject(app.project);
}

function toggleMute(kind) {
  if (!app.project) return;
  const conf = app.project.settings.mix[kind];
  conf.muted = !conf.muted;
  app.player.setMuted(kind, conf.muted);
  app.ui.renderMixer(app.project);
  S.saveProject(app.project);
}

function maybeShowHint(t) {
  if (!app.project) return;
  const seg = S.findSegmentAtTime(app.project.segments, t);
  if (!seg) {
    if (app.lastHintSegId !== null) {
      app.lastHintSegId = null;
      app.ui.showSegmentHint(null);
      app.ui.setHighlightedSegment(null);
    }
    return;
  }
  if (seg.id === app.lastHintSegId) return;
  app.lastHintSegId = seg.id;
  // 只做「跟播高亮」，不改当前工作段落（否则点着的行会跟着播放头乱跳，
  // 刚录好的音轨也会因为段落切换而摘掉）
  app.ui.showSegmentHint(seg);
  app.ui.setHighlightedSegment(seg.id);
}

/* ==================================================================== *
 *  叠加音轨
 * ==================================================================== */

/**
 * 串行刷新叠加音轨：并发调用会互相打断，导致「钢琴挂上了、人声还是旧的」这种半更新状态。
 * 排队保证最后一次调用一定完整生效。
 */
function refreshOverlays() {
  app.overlayChain = (app.overlayChain || Promise.resolve())
    .then(() => doRefreshOverlays())
    .catch((err) => { console.warn('[app] 刷新叠加音轨失败', err); });
  return app.overlayChain;
}

async function doRefreshOverlays() {
  const { a, b } = currentRange();
  for (const kind of ['piano', 'voice']) {
    const rec = pickRecording(kind, a, b);
    if (!rec) { app.player.setOverlay(kind, null); continue; }
    let url = app.urlCache.get(rec.id);
    if (!url) {
      try {
        const blob = await getMedia(rec.blobKey);
        if (!blob) { app.player.setOverlay(kind, null); continue; }
        url = URL.createObjectURL(blob);
        // 控制 URL 缓存规模，避免把每一版录音都钉在内存里
        if (app.urlCache.size > 12) {
          const [oldId, oldUrl] = app.urlCache.entries().next().value;
          URL.revokeObjectURL(oldUrl);
          app.urlCache.delete(oldId);
        }
        app.urlCache.set(rec.id, url);
      } catch { app.player.setOverlay(kind, null); continue; }
    }
    app.player.setOverlay(kind, { url, start: rec.start, duration: rec.duration });
  }
  app.ui.updateMixerAvailability(app.project);
}

function currentRange() {
  const seg = app.project.segments.find((s) => s.id === app.activeSegmentId);
  if (seg) return { a: seg.a, b: seg.b };
  const { a, b } = app.project.ab;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : (app.duration || 0) };
}

function pickRecording(kind, a, b) {
  const seg = app.project.segments.find((s) => s.id === app.activeSegmentId);
  const all = app.project.recordings.filter((r) => r.kind === kind);
  const overlaps = (r) => r.end > a - 0.1 && r.start < b + 0.1;
  const newestFirst = (list) => list.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));

  const activeId = app.project.activeRecs[kind];
  const activeRec = all.find((r) => r.id === activeId);

  if (seg) {
    // 有选中段落时，只挂这一段自己的录音，避免上一段的尾巴串到下一段
    if (activeRec && activeRec.segId === seg.id && overlaps(activeRec)) return activeRec;
    const sameSeg = newestFirst(all.filter((r) => r.segId === seg.id && overlaps(r)));
    if (sameSeg.length) return sameSeg[0];
    return null;
  }
  // 手动 A/B：取与区间重叠、且中心落在区间里的最新一条
  if (activeRec && overlaps(activeRec)) return activeRec;
  const inRange = all.filter((r) => overlaps(r) && (r.start + r.end) / 2 >= a && (r.start + r.end) / 2 <= b);
  const cands = newestFirst(inRange.length ? inRange : all.filter(overlaps));
  return cands[0] || null;
}

/* ==================================================================== *
 *  录音
 * ==================================================================== */

async function recordSegment(segId, kind) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  if (app.recState) {
    await finishRecording();
    return;
  }
  if (!app.project.media.videoKey) {
    app.ui.toast('请先选择五线谱视频。', 'warn');
    return;
  }
  if (app.recStarting) return; // 连点两下的保护（getUserMedia 还没回来）
  app.recStarting = true;
  const s = app.project.settings;
  playSegment(seg.id, { record: true });
  app.player.pause();
  // iOS 关键：在用户手势内先把媒体元素「解锁」，否则 await 之后的 play() 会被拒绝
  unlockMedia(app.player.video);

  const label = kind === 'piano' ? '录制钢琴' : '录制人声';
  if (kind === 'piano') {
    app.ui.toast('提示：戴耳机可以把原声隔开，评分会更准（原声太大会被麦克风一起录进去）。');
  }

  try {
    await resumeAudio();
    if (s.countIn > 0) {
      app.ui.showRecHud(kind, `预备 ${s.countIn}`);
      await countIn(s.countIn, (n) => app.ui.showRecHud(kind, `预备 ${n}`));
    }
    app.player.seek(seg.a, { silent: true });
    await app.recorder.start({ kind, processing: s.processing });
    // 录制时把循环尾放宽 0.35s：既能录完最后一个音，也能让播放自然停在 B 之后
    app.player.applyVolumes();
    app.player.seek(seg.a, { silent: true });
    app.player.setLoop({ a: seg.a, b: seg.b + 0.35 });
    app.player.setRepeats(1);
    app.recState = {
      kind,
      segId: seg.id,
      t0: app.player.currentTime || seg.a,
      stopAt: seg.b + 0.3,
      seg: { a: seg.a, b: seg.b },
      wallStart: performance.now(),
    };
    app.recStarting = false;
    app.ui.showRecHud(kind, label);
    app.ui.setRecordingUI(true, kind);
    app.player.play();
    clearInterval(app.recWatch);
    app.recWatch = setInterval(() => {
      const st = app.recState;
      if (!st) { clearInterval(app.recWatch); return; }
      // 视频没动（加载失败 / 被暂停）时也要能收尾
      const wall = (performance.now() - st.wallStart) / 1000;
      if (app.player.currentTime >= st.stopAt || wall > (st.stopAt - st.seg.a) + 3) finishRecording();
    }, 60);
  } catch (err) {
    app.recState = null;
    app.recStarting = false;
    try { app.recorder.cancel(); } catch { /* 保证麦克风被释放 */ }
    app.ui.setRecordingUI(false);
    app.ui.hideRecHud();
    app.player.pause();
    app.ui.toast(String(err.message || err), 'err');
  }
}

async function finishRecording({ cancelled = false } = {}) {
  const st = app.recState;
  if (!st) return;
  app.recState = null;
  app.recStarting = false;
  clearInterval(app.recWatch);
  app.player.pause();
  // 恢复录制时被放宽的循环尾与重复次数
  const segNow = app.project.segments.find((sg) => sg.id === st.segId);
  const s0 = app.project.settings;
  app.player.seek(segNow ? segNow.b : st.seg.b, { silent: true });
  app.player.setLoop({ a: segNow ? segNow.a : st.seg.a, b: segNow ? segNow.b : st.seg.b });
  app.player.setRepeats(segNow?.repeats ?? s0.repeats);
  app.player.setInterval(segNow?.interval ?? s0.interval);
  if (cancelled) {
    app.recorder.cancel();
    app.ui.setRecordingUI(false);
    app.ui.hideRecHud();
    return;
  }
  const { kind, segId } = st;
  let result;
  try {
    result = await app.recorder.stop();
  } catch (err) {
    app.ui.setRecordingUI(false);
    app.ui.hideRecHud();
    app.ui.toast(`录音保存失败：${err.message || err}`, 'err');
    return;
  }
  app.ui.setRecordingUI(false);
  app.ui.hideRecHud();
  if (!result.blob.size) {
    app.ui.toast('没有录到声音，检查一下麦克风权限。', 'warn');
    return;
  }

  const id = S.uid('rec');
  const blobKey = `rec_${id}`;
  const duration = await blobDuration(result.blob).catch(() => result.duration);
  try {
    await putMedia(blobKey, result.blob);
  } catch (err) {
    app.ui.toast('录音写入本机存储失败（空间不足？）', 'err');
    return;
  }
  const seg = app.project.segments.find((s) => s.id === segId) || { a: st.seg.a, b: st.seg.b };
  const rec = {
    id,
    kind,
    segId,
    start: st.t0,
    end: st.t0 + (duration || result.duration),
    duration: duration || result.duration,
    trimStart: 0,
    blobKey,
    mime: result.mime,
    size: result.blob.size,
    createdAt: Date.now(),
    score: null,
  };
  app.project.recordings.push(rec);
  app.project.activeRecs[kind] = rec.id;
  S.saveProject(app.project, { immediate: true });
  app.ui.updateMixerAvailability(app.project);
  app.ui.updateSegmentScores(app.project, segId);
  await refreshOverlays();

  // 分析评分（异步，不阻塞）
  app.ui.toast('正在和原声对比…');
  scoreRecording(rec, seg).then(async () => {
    await refreshOverlays(); // 起点被对齐修正后要重新挂一次，播放才对得上
    app.ui.updateSegmentScores(app.project, segId);
    app.ui.updateMixerAvailability(app.project);
    S.saveProject(app.project, { immediate: true });
    const sc = rec.score;
    if (sc && sc.ok) {
      const kindLabel = kind === 'piano' ? '钢琴' : '人声';
      app.ui.toast(`${kindLabel}已保存：综合 ${sc.overall} 分（音准 ${sc.pitch} · 节奏 ${sc.rhythm}）`);
    } else {
      app.ui.toast('录音已保存（缺少参考音频，暂未评分）。', 'warn');
    }
    app.ui.updateStorage();
  }).catch((err) => {
    console.warn('[app] 评分失败', err);
    app.ui.toast(`录音已保存，评分失败：${err.message || err}`, 'warn');
  });
}

async function blobDuration(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.addEventListener('loadedmetadata', () => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) done(d);
      else {
        // Safari 某些格式 metadata 里 duration 为 Infinity
        a.currentTime = 1e6;
        a.addEventListener('timeupdate', function onTU() {
          a.removeEventListener('timeupdate', onTU);
          done(Number.isFinite(a.duration) ? a.duration : 0);
        });
      }
    });
    a.addEventListener('error', () => done(0));
    a.src = url;
    setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('超时')); }, 4000);
  });
}

/**
 * 录音评分：与参考音频（原声，或自己的钢琴录音）比较。
 */
async function scoreRecording(rec, seg) {
  const blob = await getMedia(rec.blobKey);
  if (!blob) throw new Error('录音文件丢失');
  const buffer = await decodeBlob(blob);
  if (!buffer) throw new Error('录音解码失败');

  const { samples, sampleRate } = prepareForAnalysis(buffer, 22050);
  normalizeInPlace(samples);
  const trimmed = trimSilence(samples, sampleRate);
  const takeSamples = trimmed.samples.length > sampleRate * 0.15 ? trimmed.samples : samples;

  const takeFeat = extractFeatures(takeSamples, sampleRate, { minHz: 65, maxHz: 1250 });
  if (takeFeat.frameCount < 5) throw new Error('录音太短');

  // 参考：人声优先用自己的钢琴录音（“歌词与自己弹奏的匹配度”）
  let refFeat = null;
  let refSource = '原声';
  if (rec.kind === 'voice') {
    const pianoRec = pickPianoForSegment(seg);
    if (pianoRec) {
      const pianoFeat = await takeFeaturesFor(pianoRec);
      if (pianoFeat) { refFeat = pianoFeat; refSource = '你的钢琴录音'; }
    }
  }
  if (!refFeat) {
    refFeat = refFeaturesFor(seg.a, seg.b);
    refSource = app.ref?.source === 'audio' ? '参考音频' : '原声';
  }
  if (!refFeat) {
    rec.score = { ok: false, reason: 'no-reference' };
    rec.refSource = refSource;
    return;
  }

  // 把参考特征裁到段落范围内（extractFeatures 的时间轴是绝对时间）
  const localRef = sliceFeaturesByTime(refFeat, seg.a, seg.b);

  const score = rec.kind === 'piano'
    ? compareTakes(localRef, takeFeat, { mode: 'piano' })
    : compareVocal(localRef, takeFeat);

  rec.score = { ...score, refSource, at: Date.now() };
  rec.trimStart = trimmed.offset;

  // 用起音对齐修正录音在视频时间轴上的起点，播放时才能对上
  const shift = estimateAlignment(localRef, takeFeat, 0.6);
  if (Number.isFinite(shift)) {
    // 录音开头可能有静音：blob 偏移 trimmed.offset 处才是真正开始弹的地方
    const blobOffset = trimmed.offset + shift;
    rec.start = clamp(seg.a - blobOffset, seg.a - 5, seg.a + 0.4);
    rec.end = rec.start + (rec.duration || 0);
  }
  app.takeSamplesCache.set(rec.id, { samples: takeSamples, sampleRate });
  if (app.takeSamplesCache.size > 6) {
    const k = app.takeSamplesCache.keys().next().value;
    app.takeSamplesCache.delete(k);
  }
}

function pickPianoForSegment(seg) {
  const list = app.project.recordings
    .filter((r) => r.kind === 'piano' && Math.abs(r.start - seg.a) < Math.max(1.5, (seg.b - seg.a) * 0.5))
    .sort((x, y) => (y.score?.overall || 0) - (x.score?.overall || 0));
  return list[0] || null;
}

async function takeFeaturesFor(rec) {
  const cached = app.takeSamplesCache.get(rec.id);
  let data = cached;
  if (!data) {
    const blob = await getMedia(rec.blobKey);
    if (!blob) return null;
    const buffer = await decodeBlob(blob);
    if (!buffer) return null;
    const prep = prepareForAnalysis(buffer, 22050);
    normalizeInPlace(prep.samples);
    const t = trimSilence(prep.samples, prep.sampleRate);
    data = { samples: t.samples.length > prep.sampleRate * 0.15 ? t.samples : prep.samples, sampleRate: prep.sampleRate };
    app.takeSamplesCache.set(rec.id, data);
  }
  return extractFeatures(data.samples, data.sampleRate, { minHz: 65, maxHz: 1250 });
}

/** 参考特征从 (a-0.3) 开始计时，这里裁到 [a,b]（sliceFeatures 用绝对时间轴，返回的时间从 0 开始） */
function sliceFeaturesByTime(feat, a, b) {
  return sliceFeatures(feat, a, b);
}

function trimSilence(samples, sampleRate, { floorDb = -52, padMs = 40 } = {}) {
  const win = Math.max(64, Math.floor(sampleRate * 0.02));
  const nWin = Math.floor(samples.length / win);
  let peak = 0;
  const rms = new Float32Array(nWin);
  for (let i = 0; i < nWin; i++) {
    let s = 0;
    for (let k = 0; k < win; k++) { const v = samples[i * win + k]; s += v * v; }
    rms[i] = Math.sqrt(s / win);
    peak = Math.max(peak, rms[i]);
  }
  const thr = Math.max(1e-5, peak * Math.pow(10, floorDb / 20));
  let first = -1;
  let last = -1;
  for (let i = 0; i < nWin; i++) {
    if (rms[i] > thr) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { samples: new Float32Array(0), offset: 0 };
  const pad = Math.floor((padMs / 1000) * sampleRate);
  const start = Math.max(0, first * win - pad);
  const end = Math.min(samples.length, (last + 1) * win + pad);
  return { samples: samples.subarray(start, end), offset: start / sampleRate };
}

/**
 * 用起音包络互相关估计“录音里视频时间 seg.a 对应的时间偏移（秒）”。
 * 返回正的 shift 表示录音内容相对段落开头有延迟。
 */
function estimateAlignment(refFeat, takeFeat, maxShift = 0.9) {
  if (!refFeat || !takeFeat || refFeat.frameCount < 3 || takeFeat.frameCount < 3) return NaN;
  const refOn = refFeat.onset;
  const refT = refFeat.times;
  const sampleRef = (t) => {
    if (t <= refT[0]) return refOn[0] || 0;
    if (t >= refT[refT.length - 1]) return refOn[refOn.length - 1] || 0;
    let lo = 0;
    let hi = refT.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (refT[mid] <= t) lo = mid; else hi = mid;
    }
    const span = refT[hi] - refT[lo] || 1;
    const f = (t - refT[lo]) / span;
    return refOn[lo] * (1 - f) + refOn[hi] * f;
  };
  const step = takeFeat.times.length > 1 ? (takeFeat.times[1] - takeFeat.times[0]) : 0.012;
  const shiftStep = Math.max(1, Math.round(0.01 / step));
  let best = { shift: 0, score: -1 };
  for (let k = -Math.round(maxShift / (step * shiftStep)); k <= Math.round(maxShift / (step * shiftStep)); k++) {
    const shift = k * shiftStep * step;
    let sum = 0;
    let cnt = 0;
    for (let f = 0; f < takeFeat.frameCount; f++) {
      const rt = takeFeat.times[f] - shift;
      if (rt < refT[0] || rt > refT[refT.length - 1]) continue;
      sum += takeFeat.onset[f] * sampleRef(rt);
      cnt++;
    }
    const norm = cnt ? sum / Math.pow(cnt, 0.35) : -1;
    if (norm > best.score) best = { shift, score: norm };
  }
  return best.score > 0 ? best.shift : 0;
}


/**
 * 在用户手势内静音开播一下，让 iOS 记住这个媒体元素已被用户激活。
 * 刻意不 pause()：pause 的时机可能与后面的正式 play() 抢跑，直接用 mute 兜住声音，
 * 正式播放前会 seek 回 A 并 applyVolumes() 恢复音量。
 */
function unlockMedia(el) {
  if (!el) return;
  try {
    el.muted = true;
    const pr = el.play();
    if (pr && pr.catch) pr.catch(() => {});
  } catch { /* ignore */ }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ==================================================================== *
 *  对比 / 录音管理
 * ==================================================================== */

function compareSegment(segId) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  const body = document.createElement('div');
  body.className = 'sheetBodyInner';
  const recs = app.project.recordings.filter((r) => r.segId === segId);
  if (!recs.length) {
    body.innerHTML = `<div class="hint">这一段还没有录音。<br/>点该行的 <b>🎹 录钢琴</b> 或 <b>🎤 录人声</b>，会跟着视频一起录，录完自动和原声比对。</div>`;
  } else {
    for (const kind of ['piano', 'voice']) {
      const list = recs.filter((r) => r.kind === kind);
      if (!list.length) continue;
      const best = list.reduce((b, r) => (!b || (r.score?.overall || 0) > (b.score?.overall || 0) ? r : b), null);
      body.insertAdjacentHTML('beforeend', scoreBlockHTML(kind === 'piano' ? '🎹 我的钢琴' : '🎤 我的人声', best, list.length));
    }
    body.insertAdjacentHTML('beforeend', `<div class="hint">综合 = 音准 × 0.64 + 节奏 × 0.36。钢琴音准看和声（音高类别与演奏的重合度），人声音准看是否唱在此刻的和声上；节奏看起音是否落在原声的拍点上。分数是相对参考——麦克风太远、没戴耳机、房间混响都会影响。</div>`);
  }
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(
    mkBtn('关闭', 'btn ghost', () => app.ui.closeSheet()),
    mkBtn('重听对比', 'btn primary', () => { app.ui.closeSheet(); playSegment(segId); }),
    mkBtn('录音管理', 'btn', () => openRecordingsSheet(segId)),
  );
  app.ui.openSheet({ title: `对比 · ${fmtTime(seg.a)} ~ ${fmtTime(seg.b)}`, body, foot });
}

function scoreBlockHTML(title, rec, count) {
  if (!rec) {
    return `<div class="listItem"><div class="grow"><div class="t">${title}</div><div class="s">无录音</div></div></div>`;
  }
  const sc = rec.score;
  if (!sc || !sc.ok) {
    return `<div class="listItem"><div class="grow"><div class="t">${title}</div><div class="s">已录音 ${count} 次 · 未评分${sc?.reason === 'no-reference' ? '（缺少可解析的参考音频）' : ''}</div></div></div>`;
  }
  const rows = [
    ['综合', sc.overall],
    ['音准', sc.pitch],
    ['节奏', sc.rhythm],
  ];
  if (Number.isFinite(sc.coverage)) rows.push(['覆盖', sc.coverage]);
  const metrics = rows.map(([k, v]) => `
    <div class="metricRow"><span>${k}</span><span class="bar"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span><b>${v}</b></div>`).join('');
  return `<div class="listItem" style="display:block">
    <div class="row between" style="margin-bottom:8px">
      <div class="t">${title} · ${count} 次录音</div>
      <div class="s">参考：${escapeHtml(sc.refSource || '原声')}</div>
    </div>
    <div class="metric">${metrics}</div>
    <div class="s" style="margin-top:8px">差的成分 ${100 - sc.overall} · 起音对齐 ${Math.round((sc.onsetRecall || 0) * 100)}%${sc.meanAbsCents ? ` · 平均偏差 ${Math.round(sc.meanAbsCents)}¢` : ''}</div>
  </div>`;
}

function openRecordingsSheet(segId = null) {
  const body = document.createElement('div');
  const list = document.createElement('div');
  list.className = 'list';
  const recs = app.project.recordings
    .filter((r) => (segId ? r.segId === segId : true))
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  if (!recs.length) {
    list.innerHTML = '<div class="hint">还没有任何录音。</div>';
  }
  for (const rec of recs) {
    const item = document.createElement('div');
    item.className = 'listItem';
    const kindLabel = rec.kind === 'piano' ? '🎹 钢琴' : '🎤 人声';
    const dur = Math.max(0, (rec.end || 0) - (rec.start || 0));
    const seg = app.project.segments.find((s) => s.id === rec.segId);
    const active = app.project.activeRecs[rec.kind] === rec.id;
    item.innerHTML = `<div class="grow">
      <div class="t">${kindLabel} · ${rec.score?.ok ? `综合 <b>${rec.score.overall}</b>` : '未评分'}</div>
      <div class="s">${seg ? `${fmtTime(seg.a)} ~ ${fmtTime(seg.b)}` : '无段落'} · ${dur.toFixed(1)}s · ${fmtBytes(rec.size || 0)} · ${new Date(rec.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
    </div>`;
    const play = mkBtn('试听', 'btn ghost', async () => {
      const blob = await getMedia(rec.blobKey);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      const cleanup = () => URL.revokeObjectURL(url);
      a.addEventListener('ended', cleanup);
      a.addEventListener('error', cleanup);
      a.play().catch(cleanup);
    });
    const use = mkBtn(active ? '使用中' : '使用', 'btn ghost', async () => {
      app.project.activeRecs[rec.kind] = rec.id;
      app.project.settings.mix[rec.kind].muted = false;
      app.player.setMuted(rec.kind, false);
      app.ui.renderMixer(app.project);
      await refreshOverlays();
      S.saveProject(app.project, { immediate: true });
      app.ui.toast('已切换该录音为当前音轨');
      app.ui.closeSheet();
    });
    const del = mkBtn('删除', 'btn ghost danger', async () => {
      app.project.recordings = app.project.recordings.filter((r) => r.id !== rec.id);
      if (app.project.activeRecs[rec.kind] === rec.id) app.project.activeRecs[rec.kind] = null;
      await delMedia(rec.blobKey);
      const url = app.urlCache.get(rec.id);
      if (url) { URL.revokeObjectURL(url); app.urlCache.delete(rec.id); }
      await refreshOverlays();
      S.saveProject(app.project, { immediate: true });
      app.ui.updateSegmentScores(app.project, rec.segId);
      app.ui.updateStorage();
      app.ui.closeSheet();
      openRecordingsSheet(segId);
    });
    item.append(play, use, del);
    list.appendChild(item);
  }
  body.appendChild(list);
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(
    mkBtn('清空全部录音', 'btn danger', async () => {
      for (const rec of app.project.recordings) {
        await delMedia(rec.blobKey);
        const url = app.urlCache.get(rec.id);
        if (url) URL.revokeObjectURL(url);
      }
      for (const url of app.urlCache.values()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
      app.urlCache.clear();
      app.project.recordings = [];
      app.project.activeRecs = { piano: null, voice: null };
      await refreshOverlays();
      S.saveProject(app.project, { immediate: true });
      app.ui.renderSegments(app.project);
      app.ui.updateMixerAvailability(app.project);
      app.ui.closeSheet();
      app.ui.updateStorage();
      app.ui.toast('已清空全部录音。');
    }),
  );
  app.ui.openSheet({ title: segId ? '本段录音' : '全部录音', body, foot });
}

/* ==================================================================== *
 *  项目管理面板
 * ==================================================================== */

function relTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

async function openProjectsSheet() {
  const entries = await S.listProjects();
  const currentId = app.project?.id;
  const body = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'row';
  head.append(
    mkBtn('＋ 新建项目', 'btn primary', () => createNewProject()),
    mkBtn('保存副本', 'btn', () => duplicateCurrentProject()),
    mkBtn('导入项目文件', 'btn', () => app.ui.el.fileJson.click()),
    mkBtn('导出当前项目', 'btn', () => downloadProjectFile()),
  );

  const note = document.createElement('div');
  note.className = 'hint';
  note.innerHTML = `每次编辑都会自动存到本机。项目里包含：视频引用、所有 A/B 分段与两条备注、混音/循环设置、以及录音文件。
    想搬到别的设备（或备份到 iCloud）就「导出当前项目」得到一个 <code>.svp.zip</code>（可选是否包含视频与录音），
    在另一台设备点「导入项目文件」即可完整还原。`;

  const list = document.createElement('div');
  list.className = 'list';
  if (!entries.length) {
    list.innerHTML = '<div class="hint">还没有已保存的项目。</div>';
  }
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'listItem';
    const isCurrent = entry.id === currentId;
    item.innerHTML = `
      <div class="grow">
        <div class="t">${escapeHtml(entry.title)}${isCurrent ? ' <span class="pill" style="margin-left:6px">当前</span>' : ''}</div>
        <div class="s">${entry.segmentCount} 段${entry.videoName ? ` · ${escapeHtml(entry.videoName)}` : ' · 无视频'}${entry.duration ? ` · ${fmtTime(entry.duration)}` : ''} · ${relTime(entry.updatedAt)}</div>
      </div>`;

    const rename = mkBtn('改名', 'btn ghost', async () => {
      const next = await promptSheet('重命名项目', entry.title);
      if (!next) return;
      const proj = await S.getProject(entry.id);
      if (!proj) return;
      proj.title = next.slice(0, 60);
      await S.registerProject(proj);
      if (app.project?.id === entry.id) {
        app.project.title = proj.title;
        app.ui.el.title.value = proj.title;
        await S.saveProject(app.project, { immediate: true });
      }
      openProjectsSheet();
    });
    const openBtn = mkBtn(isCurrent ? '当前打开' : '打开', isCurrent ? 'btn ghost' : 'btn primary', () => {
      if (isCurrent) { app.ui.closeSheet(); return; }
      openProjectById(entry.id);
    });
    const del = mkBtn('删除', 'btn ghost danger', async () => {
      const sure = await confirmSheet('删除项目？', `「${escapeHtml(entry.title)}」的分段、备注和它的录音都会被删除，无法恢复。`);
      if (sure) deleteProjectById(entry.id);
    });
    item.append(openBtn, rename, del);
    list.appendChild(item);
  }

  body.append(head, note, list);

  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(
    mkBtn('关闭', 'btn ghost', () => { app.ui.closeSheet(); }),
    mkBtn('导出当前项目', 'btn primary', () => downloadProjectFile()),
  );
  app.ui.openSheet({ title: '项目', body, foot });
}

/** 简单文本输入弹层 */
function promptSheet(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); app.ui.closeSheet(); };
    const body = document.createElement('div');
    body.innerHTML = `<input id="ps_input" style="width:100%;min-height:44px;font-size:16px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.32);border:1px solid var(--line2);color:var(--txt);outline:none" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />`;
    const foot = document.createElement('div');
    foot.className = 'row';
    foot.append(
      mkBtn('取消', 'btn ghost', () => done(null)),
      mkBtn('确定', 'btn primary', () => done(document.getElementById('ps_input')?.value?.trim() || null)),
    );
    app.ui.openSheet({ title, body, foot, onClose: () => done(null) });
    setTimeout(() => {
      const input = document.getElementById('ps_input');
      input?.focus();
      input?.select();
      input?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(input.value.trim() || null); });
    }, 60);
  });
}

function confirmSheet(title, html) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); app.ui.closeSheet(); };
    const body = document.createElement('div');
    body.innerHTML = `<div class="hint">${html}</div>`;
    const foot = document.createElement('div');
    foot.className = 'row';
    foot.append(
      mkBtn('取消', 'btn ghost', () => done(false)),
      mkBtn('确定', 'btn danger', () => done(true)),
    );
    app.ui.openSheet({ title, body, foot, onClose: () => done(false) });
  });
}

/* ==================================================================== *
 *  段落菜单 / 设置 / 歌词 / 导入导出
 * ==================================================================== */

function openSegmentMenu(segId) {
  const seg = app.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  const body = document.createElement('div');

  body.insertAdjacentHTML('beforeend', `
    <div class="row">
      <label class="hint" style="flex:1">起点 A<br/><input id="m_a" class="chip input" style="width:100%" value="${fmtTime(seg.a)}"/></label>
      <label class="hint" style="flex:1">终点 B<br/><input id="m_b" class="chip input" style="width:100%" value="${fmtTime(seg.b)}"/></label>
    </div>
    <div class="row">
      <span class="hint">本段重复</span>
      <select id="m_rep" class="chip" style="min-height:36px">
        <option value="">跟随全局（${app.project.settings.repeats === 'inf' ? '不限' : app.project.settings.repeats}）</option>
        ${REPEAT_OPTIONS.filter((o) => o.v !== 'custom').map((o) => `<option value="${o.v}" ${String(seg.repeats) === String(o.v) ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
      <span class="hint">间隔</span>
      <select id="m_int" class="chip" style="min-height:36px">
        <option value="">跟随全局（${app.project.settings.interval === 'auto' ? '自动' : app.project.settings.interval}）</option>
        ${INTERVAL_OPTIONS.map((o) => `<option value="${o.v}" ${String(seg.interval) === String(o.v) ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>
    <div class="row">
      <button class="btn" id="m_pasteAt">把播放头设为 A</button>
      <button class="btn" id="m_pasteBt">把播放头设为 B</button>
    </div>
    <div class="row">
      <span class="hint">A</span>
      <button class="btn ghost" data-nudge="a:-0.1">−0.1</button>
      <button class="btn ghost" data-nudge="a:-0.01">−0.01</button>
      <button class="btn ghost" data-nudge="a:0.01">+0.01</button>
      <button class="btn ghost" data-nudge="a:0.1">+0.1</button>
    </div>
    <div class="row">
      <span class="hint">B</span>
      <button class="btn ghost" data-nudge="b:-0.1">−0.1</button>
      <button class="btn ghost" data-nudge="b:-0.01">−0.01</button>
      <button class="btn ghost" data-nudge="b:0.01">+0.01</button>
      <button class="btn ghost" data-nudge="b:0.1">+0.1</button>
    </div>
    <div class="hint">A/B 也可以直接在底部波形上拖动两个小旗标。</div>
  `);

  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(
    mkBtn('复制一行', 'btn ghost', () => {
      const copy = { ...seg, id: S.uid('seg'), star: false };
      app.project.segments.push(copy);
      app.ui.renderSegments(app.project);
      updateWaveData();
      S.saveProject(app.project);
      app.ui.closeSheet();
    }),
    mkBtn('删除', 'btn danger', () => { app.activeSegmentId = seg.id; app.ui.closeSheet(); deleteActiveRow(); }),
    mkBtn('保存', 'btn primary', () => {
      const a = parseTime(document.getElementById('m_a').value);
      const b = parseTime(document.getElementById('m_b').value);
      const rep = document.getElementById('m_rep').value;
      const int = document.getElementById('m_int').value;
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) { app.ui.toast('时间格式不对：用 0:12.34 这种写法，且 B 要大于 A', 'err'); return; }
      seg.a = a; seg.b = b;
      seg.repeats = rep === '' ? null : (rep === 'inf' ? 'inf' : Number(rep));
      seg.interval = int === '' ? null : (int === 'auto' ? 'auto' : Number(int));
      app.ui.renderSegments(app.project);
      updateWaveData();
      S.saveProject(app.project);
      app.ui.closeSheet();
    }),
  );

  app.ui.openSheet({ title: '段落设置', body, foot });

  document.getElementById('m_pasteAt').addEventListener('click', () => {
    document.getElementById('m_a').value = fmtTime(app.player.currentTime);
  });
  document.getElementById('m_pasteBt').addEventListener('click', () => {
    document.getElementById('m_b').value = fmtTime(app.player.currentTime);
  });
  for (const btn of body.querySelectorAll('[data-nudge]')) {
    btn.addEventListener('click', () => {
      const [which, delta] = btn.dataset.nudge.split(':');
      const input = document.getElementById(which === 'a' ? 'm_a' : 'm_b');
      const cur = parseTime(input.value);
      if (!Number.isFinite(cur)) return;
      input.value = fmtTime(Math.max(0, cur + Number(delta)));
    });
  }
}

async function openSettingsSheet() {
  const s = app.project.settings;
  const body = document.createElement('div');
  const est = await storageEstimate();
  body.innerHTML = `
    <div class="row"><span class="hint" style="flex:1">点击句子自动播放</span>
      <button class="btn ${s.autoPlayOnTap ? 'on' : 'ghost'}" id="set_auto">${s.autoPlayOnTap ? '开' : '关'}</button></div>
    <div class="row"><span class="hint" style="flex:1">单句重复（关闭 = 从该句连播到结尾）</span>
      <button class="btn ${s.singleSegmentLoop ? 'on' : 'ghost'}" id="set_single">${s.singleSegmentLoop ? '开' : '关'}</button></div>
    <div class="row"><span class="hint" style="flex:1">录音前预备拍</span>
      <select id="set_countin" class="chip" style="min-height:36px">
        ${[0, 1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(s.countIn) === n ? 'selected' : ''}>${n === 0 ? '不倒数' : n + ' 拍'}</option>`).join('')}
      </select></div>
    <div class="row"><span class="hint" style="flex:1">录音时开启系统降噪/回声消除<br/><small>开启后钢琴音色会被处理，评分更宽松（人声建议开，钢琴建议关）</small></span>
      <button class="btn ${s.processing ? 'on' : 'ghost'}" id="set_proc">${s.processing ? '开' : '关'}</button></div>
    <div class="row"><span class="hint" style="flex:1">原声走 WebAudio 混音<br/><small>iPad 上如果「原声」滑杆拖动没反应，打开这个（改完需要刷新页面）</small></span>
      <button class="btn ${app.player.graphEnabled ? 'on' : 'ghost'}" id="set_graph">${app.player.graphEnabled ? '已启用' : '关'}</button></div>
    <div class="row">
      <button class="btn" id="set_clearAB">清除 A/B（整曲连播）</button>
      <button class="btn" id="set_micTest">测试麦克风</button>
    </div>
    <div class="row">
      <button class="btn" id="set_clearRec">管理录音</button>
      <button class="btn danger" id="set_reset">删除当前项目</button>
    </div>
    <div class="hint">
      <b>iPad 使用建议</b><br/>
      · 用 Safari 打开后点「分享 → 添加到主屏幕」，之后从桌面图标进入，全屏且支持离线。<br/>
      · 麦克风必须运行在 https 页面；本机 http 局域网页面上 Safari 会拒绝录音。<br/>
      · 录音评分最怕「原声漏进麦克风」：戴耳机或用耳返，房间安静一些会更准。<br/>
      · 视频与录音都存在这台设备的浏览器里，不会上传；换设备请用「导入/导出」搬运段落文本。
    </div>
    <div class="hint">本机存储：${est ? `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}` : '未知'} · 视频 ${app.project.media.videoName || '无'}${app.project.media.refName ? ` · 参考音频 ${escapeHtml(app.project.media.refName)}` : ''}</div>
  `;
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(mkBtn('完成', 'btn primary', () => { app.ui.closeSheet(); S.saveProject(app.project, { immediate: true }); }));
  app.ui.openSheet({ title: '设置 / 帮助', body, foot });

  const rebind = () => { app.ui.closeSheet(); openSettingsSheet(); };
  body.querySelector('#set_auto').addEventListener('click', () => { s.autoPlayOnTap = !s.autoPlayOnTap; S.saveProject(app.project); rebind(); });
  body.querySelector('#set_single').addEventListener('click', () => { s.singleSegmentLoop = !s.singleSegmentLoop; app.ui.$btnRepeatOne.classList.toggle('on', s.singleSegmentLoop); S.saveProject(app.project); rebind(); });
  body.querySelector('#set_proc').addEventListener('click', () => { s.processing = !s.processing; S.saveProject(app.project); rebind(); });
  body.querySelector('#set_countin').addEventListener('change', (ev) => { s.countIn = Number(ev.target.value); S.saveProject(app.project); });
  body.querySelector('#set_graph').addEventListener('click', async () => {
    await resumeAudio().catch(() => {});
    const okGraph = app.player.enableGraph(audioContext());
    s.webAudioMix = okGraph;
    S.saveProject(app.project, { immediate: true });
    app.ui.toast(okGraph ? '已启用 WebAudio 混音：现在「原声」滑杆一定生效（建议刷新一次页面）' : '启用失败，这台设备可能不支持把视频音频接入 WebAudio。', okGraph ? '' : 'warn');
    rebind();
  });
  body.querySelector('#set_clearAB').addEventListener('click', () => {
    app.activeSegmentId = null;
    app.ui.setActiveSegment(null);
    setAB({ a: null, b: null }, { manual: true, silent: true });
    app.player.setRepeats(1);
    app.ui.toast('已清除 A/B：现在点播放会从当前位置直接连播到结尾。');
    app.ui.closeSheet();
  });
  body.querySelector('#set_micTest').addEventListener('click', micTest);
  body.querySelector('#set_clearRec').addEventListener('click', () => openRecordingsSheet());
  body.querySelector('#set_reset').addEventListener('click', resetAll);
}

async function micTest() {
  if (!recorderSupported()) { app.ui.toast('这个浏览器不支持录音。', 'err'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = await resumeAudio();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const t0 = performance.now();
    app.ui.toast('对着麦克风说话或弹几个音…（2 秒）');
    await new Promise((resolve) => {
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });
    for (const t of stream.getTracks()) t.stop();
    app.ui.toast(peak > 0.02
      ? `麦克风正常（峰值 ${peak.toFixed(2)}）`
      : `几乎没收到声音（峰值 ${peak.toFixed(3)}）：检查 iPad 是否被壳挡住麦克风、是否静音模式/输入选择错误。`, peak > 0.02 ? '' : 'warn');
  } catch (err) {
    app.ui.toast(err.message || String(err), 'err');
  }
}

async function resetAll() {
  const sure = await confirmSheet('删除当前项目？', '只删除当前这个项目的分段、备注与它的视频/录音；其它项目不受影响。删除后无法恢复。');
  if (!sure) return;
  const old = app.project;
  const oldId = old?.id;
  // 清掉这个项目独占的媒体（被别处引用的留着）
  const orphans = await keysUsedElsewhere(mediaKeysOf(old), oldId);
  for (const key of orphans) await delMedia(key);
  await S.deleteProjectFromLibrary(oldId);
  teardownProject();
  let next = await S.loadProject();
  if (!next || next.id === oldId) {
    next = S.createProject();
    await S.registerProject(next, { makeCurrent: true });
  }
  await enterProject(next);
  app.ui.closeSheet();
  app.ui.toast('已删除当前项目。');
  app.ui.updateStorage();
}

function openLyricsSheet() {
  const s = app.project.settings;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="hint">把整段歌词粘进来，按标点/换行切成句子，再按顺序填进下面各行的「歌词」备注里（不会覆盖已经写过的内容，除非勾选强制覆盖）。</div>
    <textarea id="lyr" placeholder="长亭外，古道边，芳草碧连天。&#10;晚风拂，柳笛声残，夕阳山外山。">${escapeHtml(s.lyricText || '')}</textarea>
    <div class="row">
      <label class="hint"><input type="checkbox" id="lyr_overwrite" /> 强制覆盖已有歌词</label>
    </div>
    <div class="row">
      <button class="btn" id="lyr_split">预览分句</button>
      <button class="btn primary" id="lyr_fill">按时间顺序填入</button>
      <button class="btn" id="lyr_rec">语音识别（实验）</button>
    </div>
    <div class="hint" id="lyr_preview"></div>
  `;
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(mkBtn('关闭', 'btn ghost', () => { s.lyricText = document.getElementById('lyr')?.value || s.lyricText; app.ui.closeSheet(); S.saveProject(app.project); }));
  app.ui.openSheet({ title: '歌词分句 / 填入', body, foot });

  const split = (text) => text
    .replace(/[，,、;；]/g, '，')
    .split(/[\n\r。！？!?]+|，/)
    .map((t) => t.trim())
    .filter(Boolean);

  body.querySelector('#lyr_split').addEventListener('click', () => {
    const lines = split(body.querySelector('#lyr').value);
    body.querySelector('#lyr_preview').innerHTML = lines.length
      ? `共 ${lines.length} 句：<br/>${lines.map((l, i) => `${i + 1}. ${escapeHtml(l)}`).join('<br/>')}`
      : '没有识别到句子。';
  });

  body.querySelector('#lyr_fill').addEventListener('click', () => {
    const lines = split(body.querySelector('#lyr').value);
    const overwrite = body.querySelector('#lyr_overwrite').checked;
    if (!lines.length) { app.ui.toast('先粘贴歌词。', 'warn'); return; }
    const segs = sortedSegments();
    if (!segs.length) { app.ui.toast('还没有段落，先设置 A/B 并添加行。', 'warn'); return; }
    segs.forEach((seg, i) => {
      const line = lines[i % lines.length];
      if (overwrite || !seg.lyric) seg.lyric = line;
    });
    s.lyricText = body.querySelector('#lyr').value;
    app.ui.renderSegments(app.project);
    S.saveProject(app.project, { immediate: true });
    app.ui.toast(`已把 ${Math.min(lines.length, segs.length)} 句歌词填进 ${segs.length} 行。`);
    app.ui.closeSheet();
  });

  body.querySelector('#lyr_rec').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { app.ui.toast('这个浏览器没有语音识别接口（Safari 通常不支持），建议「听写」后用键盘粘贴。', 'warn'); return; }
    try {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.continuous = true;
      rec.onresult = (ev) => {
        const text = Array.from(ev.results).map((r) => r[0].transcript).join('，');
        const ta = body.querySelector('#lyr');
        ta.value = `${ta.value}${text}，`;
      };
      rec.onerror = (ev) => app.ui.toast(`识别出错：${ev.error}`, 'warn');
      rec.onend = () => app.ui.toast('识别结束。');
      rec.start();
      app.ui.toast('开始识别…读完一句后点「关闭」停止。');
    } catch (err) {
      app.ui.toast(`识别启动失败：${err.message || err}`, 'err');
    }
  });
}

function openIoSheet() {
  const payload = exportPayload();
  const text = JSON.stringify(payload, null, 2);
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="hint">导出的内容只包含段落、备注、A/B 与设置（不含视频与录音文件），可以复制到别的设备再导入。</div>
    <textarea id="io" spellcheck="false" style="min-height:180px">${escapeHtml(text)}</textarea>
    <div class="row">
      <button class="btn" id="io_copy">复制 JSON</button>
      <button class="btn" id="io_download">下载 .json</button>
      <button class="btn" id="io_pick">从文件导入</button>
      <button class="btn primary" id="io_apply">应用这段 JSON</button>
    </div>
    <div class="row">
      <button class="btn" id="io_tsv">复制为纯文本（时间 + 备注）</button>
    </div>
    <div class="row">
      <button class="btn primary" id="io_proj_export">导出整个项目（含视频/录音）</button>
      <button class="btn" id="io_proj_import">导入项目文件</button>
    </div>
    <div class="hint">「导出整个项目」会生成一个 <code>.svp.zip</code>：分段、备注、设置，可选连视频和录音一起打包，换设备后「导入项目文件」即可完整还原。</div>
  `;
  const foot = document.createElement('div');
  foot.className = 'row';
  foot.append(mkBtn('关闭', 'btn ghost', () => app.ui.closeSheet()));
  app.ui.openSheet({ title: '导入 / 导出', body, foot });

  body.querySelector('#io_copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(body.querySelector('#io').value); app.ui.toast('已复制'); }
    catch { app.ui.toast('复制失败，请长按文本手动复制。', 'warn'); }
  });
  body.querySelector('#io_download').addEventListener('click', () => {
    const blob = new Blob([body.querySelector('#io').value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(app.project.title || 'practice').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  body.querySelector('#io_pick').addEventListener('click', () => app.ui.el.fileJson.click());
  body.querySelector('#io_proj_export').addEventListener('click', () => downloadProjectFile());
  body.querySelector('#io_proj_import').addEventListener('click', () => app.ui.el.fileJson.click());
  body.querySelector('#io_apply').addEventListener('click', () => {
    try {
      const data = JSON.parse(body.querySelector('#io').value);
      applyImported(data);
    } catch (err) {
      app.ui.toast(`JSON 解析失败：${err.message}`, 'err');
    }
  });
  body.querySelector('#io_tsv').addEventListener('click', async () => {
    const lines = sortedSegments().map((seg, i) => `${i + 1}\t${fmtTime(seg.a)} ~ ${fmtTime(seg.b)}\t${seg.tech || '-'}\t${seg.lyric || '-'}`);
    try { await navigator.clipboard.writeText(lines.join('\n')); app.ui.toast('已复制为纯文本'); }
    catch { app.ui.toast('复制失败', 'warn'); }
  });
}

function exportPayload() {
  return {
    app: 'ScoreVoicePlay',
    v: 1,
    title: app.project.title,
    duration: app.duration,
    exportedAt: new Date().toISOString(),
    segments: sortedSegments().map((s) => ({ a: +s.a.toFixed(3), b: +s.b.toFixed(3), tech: s.tech, lyric: s.lyric, star: s.star, repeats: s.repeats, interval: s.interval })),
    ab: app.project.ab,
    settings: app.project.settings,
  };
}

function applyImported(data) {
  if (!data || !Array.isArray(data.segments)) {
    app.ui.toast('这份数据里没有 segments。', 'err');
    return;
  }
  app.project.segments = data.segments.map((s) => ({
    ...S.newSegment(Number(s.a) || 0, Number(s.b) || 0),
    tech: s.tech || '',
    lyric: s.lyric || '',
    star: !!s.star,
    repeats: s.repeats ?? null,
    interval: s.interval ?? null,
  }));
  // 重新按时间把已有录音挂回段落，避免行内评分标签丢失
  for (const rec of app.project.recordings) {
    const hit = app.project.segments.find((sg) => rec.end > sg.a && rec.start < sg.b);
    rec.segId = hit ? hit.id : null;
  }
  app.activeSegmentId = null;
  if (data.title) {
    app.project.title = data.title;
    app.ui.el.title.value = data.title;
  }
  if (data.settings) {
    app.project.settings = { ...app.project.settings, ...data.settings, mix: app.project.settings.mix };
  }
  if (data.ab && Number.isFinite(data.ab.a) && Number.isFinite(data.ab.b)) {
    app.project.ab = { a: data.ab.a, b: data.ab.b };
    app.player.setLoop(app.project.ab);
  }
  syncPlayerFromSettings();
  app.ui.renderProject(app.project);
  updateWaveData();
  S.saveProject(app.project, { immediate: true });
  app.ui.closeSheet();
  app.ui.toast(`已导入 ${app.project.segments.length} 个段落。`);
}


/* ==================================================================== *
 *  杂项
 * ==================================================================== */

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function onTitleChange(v) {
  if (!app.project) return;
  app.project.title = v.slice(0, 60);
  S.saveProject(app.project);
}

function persist(opts) {
  if (app.project) S.saveProject(app.project, opts);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          app.ui.toast('有新版本：下次打开或刷新后生效。');
        }
      });
    });
  } catch (err) {
    console.warn('[app] SW 注册失败', err);
  }
}

// 暴露动作给 UI
Object.assign(app, {
  persist,
  onTitleChange,
  onVideoPicked,
  onRefAudioPicked,
  setAFromPlayhead,
  setBFromPlayhead,
  addRowAtPlayhead,
  deleteActiveRow,
  updateSegment,
  toggleStar,
  toggleSingleLoop,
  playSegment,
  playOriginalOnly,
  compareSegment,
  recordSegment,
  togglePlay,
  seekBy,
  cycleSpeed,
  setRepeats,
  setInterval,
  setVolume,
  toggleMute,
  openSegmentMenu,
  openSettingsSheet,
  openLyricsSheet,
  openIoSheet,
  openProjectsSheet,
  openProjectById,
  createNewProject,
  duplicateCurrentProject,
  deleteProjectById,
  exportProjectFile,
  importProjectFile,
  downloadProjectFile,
  applyImported,
});

// 调试用句柄（在 Safari 控制台里可以直接调 window.SVP）
window.SVP = app;

boot().catch((err) => {
  console.error(err);
  const t = document.getElementById('toast');
  if (t) {
    t.hidden = false;
    t.className = 'toast err';
    t.textContent = `启动失败：${err.message || err}`;
  }
});
