const DB_NAME = 'dl-accelerator';
const DB_VERSION = 1;
const STORE = 'kv';

const KEY_DIR_HANDLE = 'dirHandle';
const KEY_TASKS = 'tasks';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- 目标文件夹句柄 ---------- */

export function getDirectoryHandle() {
  return idbGet(KEY_DIR_HANDLE).then((v) => v || null);
}

export function setDirectoryHandle(handle) {
  return idbSet(KEY_DIR_HANDLE, handle);
}

export function clearDirectoryHandle() {
  return idbDelete(KEY_DIR_HANDLE);
}

/**
 * 查询/申请文件夹读写授权。request=true 时必须在用户手势中调用。
 * 句柄失效（文件夹被移动/删除、浏览器重启后条目丢失）时 queryPermission 会抛异常，
 * 这里一律当作「未授权」返回，交给调用方降级处理，而不是让异常冒到调度逻辑里。
 */
export async function ensureDirectoryPermission(handle, { request = false } = {}) {
  const opts = { mode: 'readwrite' };
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  let current;
  try {
    current = await handle.queryPermission(opts);
  } catch {
    return false;
  }
  if (current === 'granted') return true;
  if (!request || typeof handle.requestPermission !== 'function') return false;
  try {
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

/* ---------- 任务断点 ---------- */

export function loadTaskRecords() {
  return idbGet(KEY_TASKS).then((v) => (Array.isArray(v) ? v : []));
}

export function saveTaskRecords(records) {
  return idbSet(KEY_TASKS, records);
}

/* ---------- 设置（chrome.storage.local） ---------- */

export const DEFAULT_SETTINGS = {
  /** 自动调节线程数；关闭后固定使用 concurrency */
  autoTune: true,
  /** 初始/固定线程数 */
  concurrency: 4,
  concurrencyMax: 16,
  /** 同时进行的下载任务数；多任务抢带宽同样会互相拖慢 */
  maxConcurrentTasks: 1,
  /** 每线程分配的分块数量，用于推导分块大小 */
  chunksPerWorker: 8,
  /** 小于该值不分片 */
  minSplitBytes: 2 * 1024 * 1024,
  /** 是否携带站点登录态（Cookie） */
  sendCredentials: true,
  /** 'auto' = 优先文件夹流式写盘，失败降级内存拼接；'blob' = 始终内存拼接 */
  saveMode: 'auto',
};

export async function loadSettings() {
  const got = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

/* ---------- 管理页待接收的 URL（由右键菜单写入） ---------- */

export async function pushPendingUrls(urls) {
  const got = await chrome.storage.local.get('pendingUrls');
  const merged = [...(got.pendingUrls || []), ...urls];
  await chrome.storage.local.set({ pendingUrls: merged });
}

export async function takePendingUrls() {
  const got = await chrome.storage.local.get('pendingUrls');
  const urls = got.pendingUrls || [];
  if (urls.length) await chrome.storage.local.set({ pendingUrls: [] });
  return urls;
}