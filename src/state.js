/*
 * state.js — 项目数据模型与持久化
 */

import { store } from './db.js';

export const PROJECT_KEY = 'project';
export const SCHEMA_VERSION = 1;

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultSettings() {
  return {
    repeats: 3,            // 数字 | 'inf'
    interval: 'auto',      // 'auto' | 秒
    rate: 1,
    mix: {
      orig: { volume: 1, muted: false },
      piano: { volume: 0.95, muted: false },
      voice: { volume: 1, muted: false },
    },
    countIn: 0,            // 0 | 1 | 2 | 3 | 4
    processing: false,     // 录音时是否启用系统降噪/回声消除
    allowTranspose: false, // 人声评分是否允许任意移调（默认只对齐八度）
    autoPlayOnTap: true,   // 点击段落文字自动播放
    singleSegmentLoop: true, // 单句重复：点句子只循环该句
    showKaraoke: true,
    webAudioMix: false,    // 把原声接入 WebAudio 混音（iOS 上滑杆无效时打开）
    lyricText: '',
  };
}

export function createProject() {
  return {
    v: SCHEMA_VERSION,
    id: uid('proj'),
    title: '未命名练习',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    media: {
      videoKey: null, videoName: '', videoDuration: 0,
      refKey: null, refName: '',
      peaksKey: null,
    },
    ab: { a: null, b: null },
    segments: [],
    recordings: [],
    activeRecs: { piano: null, voice: null },
    settings: defaultSettings(),
  };
}

export function newSegment(a = 0, b = 0) {
  return {
    id: uid('seg'),
    a: Math.max(0, a),
    b: Math.max(0, b),
    tech: '',
    lyric: '',
    star: false,
    repeats: null,   // null = 跟随全局
    interval: null,  // null = 跟随全局
  };
}

/** 补齐缺失字段，避免旧数据 / 手改 JSON 崩溃 */
export function normalizeProject(raw) {
  const p = { ...createProject(), ...(raw || {}) };
  p.settings = { ...defaultSettings(), ...(p.settings || {}) };
  p.settings.mix = { ...defaultSettings().mix, ...(p.settings.mix || {}) };
  for (const k of ['orig', 'piano', 'voice']) {
    p.settings.mix[k] = { ...defaultSettings().mix[k], ...(p.settings.mix[k] || {}) };
  }
  p.media = { ...createProject().media, ...(p.media || {}) };
  p.ab = { a: p.ab?.a ?? null, b: p.ab?.b ?? null };
  p.activeRecs = { piano: null, voice: null, ...(p.activeRecs || {}) };
  p.segments = Array.isArray(p.segments) ? p.segments.map((s) => ({
    ...newSegment(0, 0), ...s,
    a: Number(s.a) || 0,
    b: Math.max(Number(s.a) || 0, Number(s.b) || 0) + ((Number(s.b) || 0) > (Number(s.a) || 0) ? 0 : 0.3),
    tech: s.tech || '',
    lyric: s.lyric || '',
    star: !!s.star,
    repeats: s.repeats ?? null,
    interval: s.interval ?? null,
  })) : [];
  p.recordings = Array.isArray(p.recordings) ? p.recordings.filter((r) => r && r.blobKey) : [];
  return p;
}

/* ------------------------------------------------------------------ *
 *  项目库：meta 里存索引 + 每个项目一条记录
 *    projects:index  → [{ id, title, updatedAt, createdAt, segmentCount, videoName, duration }]
 *    project:current → 当前项目 id
 *    project:<id>    → 完整项目 JSON
 * ------------------------------------------------------------------ */

export const LEGACY_KEY = 'project';
export const INDEX_KEY = 'projects:index';
export const CURRENT_KEY = 'project:current';
export const projectStorageKey = (id) => `project:${id}`;

function summarize(project) {
  return {
    id: project.id,
    title: project.title || '未命名练习',
    createdAt: project.createdAt || Date.now(),
    updatedAt: project.updatedAt || Date.now(),
    segmentCount: (project.segments || []).length,
    videoName: project.media?.videoName || '',
    duration: project.media?.videoDuration || 0,
  };
}

export async function listProjects() {
  const index = await store.get('meta', INDEX_KEY);
  const list = Array.isArray(index) ? index : [];
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function writeIndexEntry(project) {
  const index = await store.get('meta', INDEX_KEY);
  const list = Array.isArray(index) ? index : [];
  const entry = summarize(project);
  const at = list.findIndex((e) => e.id === entry.id);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  await store.set('meta', INDEX_KEY, list);
}

async function dropIndexEntry(id) {
  const index = await store.get('meta', INDEX_KEY);
  const list = Array.isArray(index) ? index : [];
  await store.set('meta', INDEX_KEY, list.filter((e) => e.id !== id));
}

export async function getProject(id) {
  try {
    const raw = await store.get('meta', projectStorageKey(id));
    if (raw) return normalizeProject(raw);
  } catch (err) {
    console.warn('[state] 读取项目失败', err);
  }
  return null;
}

export async function setCurrentProjectId(id) {
  await store.set('meta', CURRENT_KEY, id);
}

export async function getCurrentProjectId() {
  try {
    return (await store.get('meta', CURRENT_KEY)) || null;
  } catch {
    return null;
  }
}

/** 启动时用：迁移旧的单项目数据，然后载入当前项目 */
export async function loadProject() {
  try {
    let id = await getCurrentProjectId();
    if (id) {
      const found = await getProject(id);
      if (found) {
        // 确保索引里有它（防止索引丢失）
        await writeIndexEntry(found);
        return found;
      }
    }
    // 当前项目丢了：退回库里最近改过的那个
    const list = await listProjects();
    if (list.length) {
      const first = await getProject(list[0].id);
      if (first) {
        await setCurrentProjectId(first.id);
        return first;
      }
    }
    // 迁移旧版：meta/project
    const legacy = await store.get('meta', LEGACY_KEY);
    if (legacy) {
      const project = normalizeProject(legacy);
      await store.set('meta', projectStorageKey(project.id), JSON.parse(JSON.stringify(project)));
      await writeIndexEntry(project);
      await setCurrentProjectId(project.id);
      try { await store.del('meta', LEGACY_KEY); } catch { /* ignore */ }
      return project;
    }
    // 全新：建一个空项目
    const fresh = createProject();
    await store.set('meta', projectStorageKey(fresh.id), JSON.parse(JSON.stringify(fresh)));
    await writeIndexEntry(fresh);
    await setCurrentProjectId(fresh.id);
    return fresh;
  } catch (err) {
    console.warn('[state] 读取项目失败', err);
    return createProject();
  }
}

let saveTimer = 0;
const pendingResolves = new Set();

export function saveProject(project, { immediate = false } = {}) {
  project.updatedAt = Date.now();
  const doSave = async () => {
    saveTimer = 0;
    try {
      await store.set('meta', projectStorageKey(project.id), JSON.parse(JSON.stringify(project)));
      await writeIndexEntry(project);
    } catch (err) {
      console.warn('[state] 保存失败', err);
    }
    for (const r of pendingResolves) r();
    pendingResolves.clear();
  };
  if (immediate) {
    clearTimeout(saveTimer);
    return doSave();
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 350);
  return new Promise((resolve) => { pendingResolves.add(resolve); });
}

/** 把项目登记进库（用于「另存为 / 导入」后立即出现在列表里） */
export async function registerProject(project, { makeCurrent = false } = {}) {
  project.updatedAt = Date.now();
  await store.set('meta', projectStorageKey(project.id), JSON.parse(JSON.stringify(project)));
  await writeIndexEntry(project);
  if (makeCurrent) await setCurrentProjectId(project.id);
  return project;
}

/** 从库里删掉（只处理元数据，媒体文件由调用方清理） */
export async function deleteProjectFromLibrary(id) {
  await dropIndexEntry(id);
  try { await store.del('meta', projectStorageKey(id)); } catch { /* ignore */ }
  const current = await getCurrentProjectId();
  if (current === id) {
    const rest = await listProjects();
    if (rest.length) await setCurrentProjectId(rest[0].id);
    else await store.del('meta', CURRENT_KEY);
  }
}

/* ------------------------- 段落工具 ------------------------- */

export function sortSegments(segments) {
  return [...segments].sort((x, y) => (x.a - y.a) || (x.b - y.b));
}

export function segmentsOverlapping(segments, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return segments.filter((s) => s.b > lo && s.a < hi);
}

export function findSegmentAtTime(segments, t) {
  return segments.find((s) => t >= s.a - 0.02 && t <= s.b + 0.02) || null;
}

export function recordingById(project, id) {
  return project.recordings.find((r) => r.id === id) || null;
}

export function recordingsFor(project, kind, segId = null) {
  return project.recordings.filter((r) => r.kind === kind && (segId == null || r.segId === segId));
}

export function bestRecording(project, kind, segId) {
  const list = recordingsFor(project, kind, segId).filter((r) => r.score && r.score.ok);
  if (!list.length) return null;
  return list.reduce((best, r) => (!best || r.score.overall > best.score.overall ? r : best), null);
}

/** 找出与某区间重叠、且该种类的“当前使用”录音 */
export function pickRecordingForRange(project, kind, a, b) {
  const activeId = project.activeRecs[kind];
  if (activeId) {
    const rec = recordingById(project, activeId);
    if (rec && rec.end > a && rec.start < b) return rec;
  }
  const candidates = project.recordings
    .filter((r) => r.kind === kind && r.end > a && r.start < b)
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  return candidates[0] || null;
}
