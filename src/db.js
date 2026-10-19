/*
 * db.js — 极简 IndexedDB 封装
 *   meta   : 键值（项目 JSON、设置、波形缓存）
 *   media  : 二进制（视频、参考音频、录音）
 */

const DB_NAME = 'score-voice-play';
const DB_VERSION = 1;
const STORES = ['meta', 'media'];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用，请关闭其它页面后重试'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try {
      result = fn(os);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务被中止'));
  });
}

const wrap = (req) => ({ __req: req });

export const store = {
  async get(storeName, key) {
    return tx(storeName, 'readonly', (os) => wrap(os.get(key)));
  },
  async set(storeName, key, value) {
    await tx(storeName, 'readwrite', (os) => { os.put(value, key); });
    return value;
  },
  async del(storeName, key) {
    await tx(storeName, 'readwrite', (os) => { os.delete(key); });
  },
  async entries(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const os = t.objectStore(storeName);
      const keysReq = os.getAllKeys();
      const valsReq = os.getAll();
      t.oncomplete = () => {
        const out = {};
        keysReq.result.forEach((k, i) => { out[k] = valsReq.result[i]; });
        resolve(out);
      };
      t.onerror = () => reject(t.error);
    });
  },
  async keys(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async clear(storeName) {
    await tx(storeName, 'readwrite', (os) => { os.clear(); });
  },
};

/** 估算已用存储（字节） */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

/* ------------------------------------------------------------------ *
 *  媒体二进制读写
 *  某些 WebKit 构建（以及部分 Safari 版本）无法把 Blob/File 存进 IndexedDB，
 *  这里失败时自动退化成存 Uint8Array，读回时再还原成 Blob。
 * ------------------------------------------------------------------ */

const MEDIA_BYTES = '__svp_bytes';

export async function putMedia(key, blob) {
  try {
    await store.set('media', key, blob);
    return 'blob';
  } catch (err) {
    console.warn('[db] Blob 存储失败，改用字节数组', err);
  }
  const buf = await blob.arrayBuffer();
  await store.set('media', key, {
    [MEDIA_BYTES]: new Uint8Array(buf),
    type: blob.type || 'application/octet-stream',
    name: blob.name || '',
  });
  return 'bytes';
}

export async function getMedia(key) {
  const v = await store.get('media', key);
  if (!v) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  if (v && v[MEDIA_BYTES]) {
    return new Blob([v[MEDIA_BYTES]], { type: v.type || 'application/octet-stream' });
  }
  return null;
}

export async function delMedia(key) {
  try { await store.del('media', key); } catch { /* ignore */ }
}
