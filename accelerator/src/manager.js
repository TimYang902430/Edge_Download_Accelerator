import { AcceleratedDownload, PROGRESS_INTERVAL_MS } from './lib/engine.js';
import { formatBytes, formatSpeed, formatDuration } from './lib/format.js';
import * as store from './lib/store.js';

const els = {
  pickDir: document.getElementById('pick-dir'),
  dirLabel: document.getElementById('dir-label'),
  tuneMode: document.getElementById('tune-mode'),
  concurrency: document.getElementById('concurrency'),
  maxTasks: document.getElementById('max-tasks'),
  credentials: document.getElementById('credentials'),
  settingsHint: document.getElementById('settings-hint'),
  urls: document.getElementById('urls'),
  add: document.getElementById('add'),
  clearDone: document.getElementById('clear-done'),
  tasks: document.getElementById('tasks'),
  empty: document.getElementById('empty'),
};

const STATE_TEXT = {
  idle: 'Queued',
  probing: 'Probing',
  saving: 'Preparing',
  running: 'Downloading',
  paused: 'Paused',
  error: 'Error',
  done: 'Done',
  canceled: 'Canceled',
};

const ACTIVE_STATES = ['probing', 'saving', 'running'];
const CANCELABLE_STATES = [...ACTIVE_STATES, 'idle', 'paused', 'error'];

const state = {
  settings: { ...store.DEFAULT_SETTINGS },
  dirHandle: null,
  dirState: 'none',
  tasks: [],
  lastPersistAt: 0,
};

let taskSeq = 0;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

function supportsFsa() {
  return typeof window.showDirectoryPicker === 'function';
}

function hint(text) {
  els.settingsHint.textContent = text;
}

/* ---------- URL 处理 ---------- */

function parseUrls(text) {
  const seen = new Set();
  return String(text)
    .replace(/^#.*$/gm, '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/\S+$/i.test(s))
    .filter((s) => (seen.has(s) ? false : seen.add(s)));
}

function appendUrls(urls) {
  const merged = parseUrls([els.urls.value, ...urls].filter(Boolean).join('\n'));
  els.urls.value = merged.join('\n');
}

/* ---------- 任务 ---------- */

function createEntry(url, { queued = true, id = null, createdAt = Date.now() } = {}) {
  const dl = new AcceleratedDownload({
    url,
    settings: state.settings,
    credentials: state.settings.sendCredentials ? 'include' : 'omit',
  });
  return {
    id: id || `t${createdAt}-${taskSeq++}`,
    createdAt,
    url,
    dl,
    queued,
    running: false,
    ui: null,
  };
}

/**
 * 真正把任务跑起来。
 * running 标记必须在 try/finally 里维护：resolveDirHandle() 会读保存的文件夹句柄，
 * 句柄失效时 queryPermission() 会抛异常，若它落在 try 之外，running 会永远为 true ——
 * 任务自己停在初始的 idle 状态（界面显示「排队中」），还占死一个并发位。
 */
async function startEntry(entry, { requestDir = false } = {}) {
  entry.queued = false;
  entry.running = true;
  try {
    const dirHandle = await resolveDirHandle({ request: requestDir });
    await entry.dl.run({ dirHandle });
  } catch (err) {
    entry.dl.state = 'error';
    entry.dl.error = err?.message || String(err);
  } finally {
    entry.running = false;
    persistNow();
    schedule();
  }
}

/** 还没跑起来过的任务（引擎 state 仍是 idle）也要能被重新派发，否则会永远卡在「排队中」 */
const startable = (t) => !t.running && (t.queued || t.dl.state === 'idle');

function schedule() {
  // 不 await 下载：这样才能让「同时下载」真正并行；每轮 running 都会同步 +1，故循环必然收敛
  for (;;) {
    const active = state.tasks.filter((t) => t.running).length;
    if (active >= state.settings.maxConcurrentTasks) return;
    const entry = state.tasks.find((t) => startable(t));
    if (!entry) return;
    startEntry(entry);
  }
}

async function onAction(entry, act) {
  const dl = entry.dl;

  if (act === 'pause') {
    dl.pause();
  } else if (act === 'resume' || act === 'retry') {
    // 授权请求必须发生在用户手势中，所以这里带 request=true
    startEntry(entry, { requestDir: true });
  } else if (act === 'cancel') {
    entry.queued = false;
    await dl.cancel();
    persistNow();
    schedule();
  } else if (act === 'reveal') {
    if (dl.downloadId != null) {
      try {
        chrome.downloads.showFile(dl.downloadId);
      } catch {
        /* 文件可能已被移动或删除 */
      }
    }
  } else if (act === 'remove') {
    if (CANCELABLE_STATES.includes(dl.state) && dl.state !== 'idle') await dl.cancel();
    state.tasks = state.tasks.filter((t) => t !== entry);
    entry.ui?.el.remove();
    persistNow();
  }

  renderAll();
}

/* ---------- 目标文件夹 ---------- */

async function dirPermissionState(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'none';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

async function refreshDirState() {
  state.dirState = state.dirHandle ? await dirPermissionState(state.dirHandle) : 'none';
  updateDirLabel();
}

function updateDirLabel() {
  const labels = {
    none: 'Not set: chunks will be assembled in memory, then handed to the browser to save',
    granted: `Granted: ${state.dirHandle?.name || ''} (chunks stream directly to disk)`,
    prompt: 'Permission needed: click the button on the left to grant access to the save folder',
    denied: 'Not granted: falling back to in-memory assembly, large files may fail',
  };
  els.dirLabel.textContent = labels[state.dirState] ?? labels.none;
}

async function resolveDirHandle({ request = false } = {}) {
  if (!state.dirHandle || !supportsFsa()) return null;
  const granted = await store.ensureDirectoryPermission(state.dirHandle, { request });
  state.dirState = granted ? 'granted' : await dirPermissionState(state.dirHandle);
  updateDirLabel();
  return granted ? state.dirHandle : null;
}

async function onPickDir() {
  if (!supportsFsa()) {
    hint('This browser does not support the File System Access API; only in-memory assembly is available.');
    return;
  }
  if (state.dirHandle) {
    const granted = await store.ensureDirectoryPermission(state.dirHandle, { request: true });
    if (granted) {
      state.dirState = 'granted';
      updateDirLabel();
      hint('');
      return;
    }
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dl-accelerator' });
    state.dirHandle = handle;
    await store.setDirectoryHandle(handle);
    state.dirState = 'granted';
    updateDirLabel();
    hint('');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      await refreshDirState();
      hint('Could not get folder access permission; falling back to in-memory assembly.');
    }
  }
}

/* ---------- 断点持久化 ---------- */

function persistNow() {
  state.lastPersistAt = performance.now();
  const records = state.tasks.map((t) => ({ id: t.id, createdAt: t.createdAt, ...t.dl.toRecord() }));
  store.saveTaskRecords(records).catch(() => {});
}

function persistThrottled() {
  if (performance.now() - state.lastPersistAt < 3000) return;
  persistNow();
}

async function restoreTasks() {
  const records = await store.loadTaskRecords();
  for (const rec of records) {
    if (!rec?.url) continue;
    const entry = createEntry(rec.url, { queued: false, id: rec.id, createdAt: rec.createdAt });
    entry.dl.restoreFrom(rec);
    state.tasks.push(entry);
  }
}

/* ---------- 渲染 ---------- */

function buildTaskEl(entry) {
  const el = document.createElement('div');
  el.className = 'task';
  el.dataset.id = entry.id;
  el.innerHTML = `
    <div class="task-head">
      <span class="name"></span>
      <span class="badge" hidden></span>
      <span class="state"></span>
    </div>
    <div class="bar"><div class="fill"></div></div>
    <div class="chunks" hidden>
      <div class="chunks-head"></div>
      <div class="chunks-grid"></div>
    </div>
    <div class="task-meta">
      <span class="pct"></span>
      <span class="bytes"></span>
      <span class="speed"></span>
      <span class="eta"></span>
    </div>
    <div class="task-actions">
      <button class="btn" data-act="pause">Pause</button>
      <button class="btn" data-act="resume">Resume</button>
      <button class="btn" data-act="retry">Retry</button>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn" data-act="reveal">Open folder</button>
      <button class="btn" data-act="remove">Remove</button>
    </div>
    <div class="note" hidden></div>`;

  const ui = { buttons: {} };
  for (const cls of ['name', 'badge', 'state', 'fill', 'pct', 'bytes', 'speed', 'eta', 'note']) {
    ui[cls] = el.querySelector(`.${cls}`);
  }
  ui.chunks = el.querySelector('.chunks');
  ui.chunksHead = el.querySelector('.chunks-head');
  ui.chunksGrid = el.querySelector('.chunks-grid');
  ui.chunkEls = [];
  ui.chunkCodes = new Uint8Array(0);
  ui.chunkPcts = new Uint8Array(0);
  for (const btn of el.querySelectorAll('button[data-act]')) {
    ui.buttons[btn.dataset.act] = btn;
  }
  // 悬停某个方块就浮出该分片当前的下载量；指针移出整片方块区就收起
  ui.chunksGrid.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.chunk');
    if (target) showChunkTip(target, entry);
  });
  ui.chunksGrid.addEventListener('mouseleave', hideChunkTip);

  el.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act) onAction(entry, act);
  });

  return { el, ui };
}

const CHUNK_CODE = { pending: 0, active: 1, done: 2, failed: 3, queued: 4 };

const CHUNK_STATE_TEXT = {
  pending: 'Not started',
  queued: 'Waiting for connection',
  active: 'Downloading',
  done: 'Done',
  failed: 'Failed',
};

/* ---------- 分片方块悬停信息卡 ---------- */

let chunkTipEl = null;

function chunkTip() {
  if (!chunkTipEl) {
    chunkTipEl = document.createElement('div');
    chunkTipEl.className = 'chunk-tip';
    chunkTipEl.hidden = true;
    document.body.appendChild(chunkTipEl);
  }
  return chunkTipEl;
}

function hideChunkTip() {
  if (chunkTipEl) chunkTipEl.hidden = true;
}

/** 鼠标停到某个方块上时，浮出该分片当前的下载量与状态 */
function showChunkTip(el, entry) {
  const info = entry.dl.chunkInfo();
  const it = info?.items[Number(el.dataset.i)];
  if (!it) return;
  const pct = it.size > 0 ? Math.round((it.bytes / it.size) * 100) : 0;

  const tip = chunkTip();
  tip.innerHTML =
    `<span class="tip-head">Chunk ${it.index + 1}/${info.totalChunks}</span>` +
    `<span>This chunk ${formatBytes(it.size)}</span>` +
    `<span>Downloaded ${formatBytes(it.bytes)} · ${pct}%</span>` +
    `<span class="tip-state">${CHUNK_STATE_TEXT[it.state] ?? it.state}</span>`;
  tip.hidden = false;

  // 默认浮在方块上方；顶部放不下就翻到下方，并夹在视口内
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const top = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  const left = Math.min(
    Math.max(8, r.left + r.width / 2 - t.width / 2),
    Math.max(8, window.innerWidth - t.width - 8),
  );
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/** 用一个个方块显示每个分片的进度与大小 */
function renderChunks(entry, s, info) {
  const { ui } = entry.ui;
  if (!info) {
    ui.chunks.hidden = true;
    hideChunkTip();
    return;
  }
  ui.chunks.hidden = false;

  // 分片数量变了才重建方块，避免每 200ms 重排 DOM
  if (ui.chunkEls.length !== info.totalChunks) {
    const frag = document.createDocumentFragment();
    ui.chunkEls = [];
    for (let i = 0; i < info.totalChunks; i++) {
      const el = document.createElement('div');
      el.className = 'chunk';
      el.dataset.i = String(i);
      frag.appendChild(el);
      ui.chunkEls.push(el);
    }
    ui.chunksGrid.replaceChildren(frag);
    ui.chunkCodes = new Uint8Array(info.totalChunks).fill(255);
    ui.chunkPcts = new Uint8Array(info.totalChunks).fill(255);
  }

  let done = 0;
  for (const it of info.items) {
    if (it.state === 'done') done++;
    const code = CHUNK_CODE[it.state];
    const pct = it.size > 0 ? Math.round((it.bytes / it.size) * 100) : 0;
    if (ui.chunkCodes[it.index] === code && ui.chunkPcts[it.index] === pct) continue;

    ui.chunkCodes[it.index] = code;
    ui.chunkPcts[it.index] = pct;
    const el = ui.chunkEls[it.index];
    el.className =
      code === CHUNK_CODE.failed
        ? 'chunk failed'
        : code === CHUNK_CODE.done
          ? 'chunk done'
          : code === CHUNK_CODE.queued
            ? 'chunk queued'
            : 'chunk';
    el.style.setProperty('--p', String(pct / 100));
  }

  ui.chunksHead.textContent =
    `${info.totalChunks} chunks · ${formatBytes(info.chunkSize)} each · ${done} done` +
    (s.state === 'running' && s.concurrency ? ` · ${s.concurrency} threads` : '');
}

function renderTask(entry) {
  const s = entry.dl.snapshot();
  const { ui } = entry.ui;

  ui.name.textContent = s.fileName || entry.url;
  ui.name.title = entry.url;

  const pct = s.total ? s.progress * 100 : 0;
  ui.fill.style.width = `${pct.toFixed(2)}%`;

  if (s.degraded && ['running', 'saving', 'paused'].includes(s.state)) {
    ui.badge.hidden = false;
    ui.badge.textContent = 'Memory buffer';
    ui.badge.classList.add('warn');
  } else if (s.state === 'running' && s.mode === 'ranged') {
    ui.badge.hidden = false;
    ui.badge.textContent = `${s.concurrency} threads`;
    ui.badge.classList.remove('warn');
  } else if (s.state === 'running') {
    ui.badge.hidden = false;
    ui.badge.textContent = 'Single thread';
    ui.badge.classList.remove('warn');
  } else {
    ui.badge.hidden = true;
  }

  ui.state.textContent = STATE_TEXT[s.state] ?? s.state;
  ui.state.className = `state${s.state === 'done' ? ' ok' : s.state === 'error' ? ' err' : ''}`;

  ui.pct.textContent = s.total ? `${pct.toFixed(1)}%` : '';
  ui.bytes.textContent = s.total
    ? `${formatBytes(s.received)} / ${formatBytes(s.total)}`
    : formatBytes(s.received);
  ui.speed.textContent = s.state === 'running' ? formatSpeed(s.speed) : '';
  ui.eta.textContent =
    s.state === 'running' && s.speed > 0 && s.total
      ? `${formatDuration((s.total - s.received) / s.speed)} left${s.retries ? ` (retried ${s.retries}×)` : ''}`
      : '';

  // 只显示真正的错误；其余解释性提示一律不显示
  ui.note.hidden = !s.error;
  ui.note.textContent = s.error || '';
  ui.note.className = 'note';

  renderChunks(entry, s, entry.dl.chunkInfo());

  const b = ui.buttons;
  b.pause.hidden = s.state !== 'running';
  b.resume.hidden = s.state !== 'paused';
  b.retry.hidden = s.state !== 'error';
  b.cancel.hidden = !CANCELABLE_STATES.includes(s.state);
  b.reveal.hidden = !(s.state === 'done' && entry.dl.downloadId != null);
  b.remove.hidden = !['done', 'canceled'].includes(s.state);
}

function renderAll() {
  const alive = new Set(state.tasks.map((t) => t.id));
  for (const el of [...els.tasks.children]) {
    if (!alive.has(el.dataset.id)) el.remove();
  }
  for (const entry of state.tasks) {
    if (!entry.ui) {
      entry.ui = buildTaskEl(entry);
      els.tasks.appendChild(entry.ui.el);
    }
    renderTask(entry);
  }
  els.empty.hidden = state.tasks.length > 0;
}

/* ---------- 设置 ---------- */

function syncSettingsUI() {
  const auto = state.settings.autoTune;
  els.tuneMode.value = auto ? 'auto' : 'fixed';
  // 自动调节是「任务开始即满线程」，所以这里显示实际上限，而不是固定模式用的 concurrency
  els.concurrency.value = String(auto ? state.settings.concurrencyMax : state.settings.concurrency);
  els.concurrency.disabled = auto;
  els.maxTasks.value = String(state.settings.maxConcurrentTasks);
  els.credentials.checked = Boolean(state.settings.sendCredentials);
}

function updateSettings(patch) {
  Object.assign(state.settings, patch);
  store.saveSettings({ ...state.settings }).catch(() => {});
}

/* ---------- 交互绑定 ---------- */

function wireEvents() {
  els.pickDir.addEventListener('click', onPickDir);

  els.add.addEventListener('click', () => {
    const urls = parseUrls(els.urls.value);
    if (!urls.length) {
      hint('No valid http(s) links found.');
      return;
    }
    for (const url of urls) state.tasks.push(createEntry(url));
    els.urls.value = '';
    hint('');
    persistNow();
    renderAll();
    schedule();
  });

  els.clearDone.addEventListener('click', () => {
    state.tasks = state.tasks.filter((t) => !['done', 'canceled'].includes(t.dl.state));
    persistNow();
    renderAll();
  });

  els.tuneMode.addEventListener('change', () => {
    updateSettings({ autoTune: els.tuneMode.value === 'auto' });
    syncSettingsUI();
  });

  els.concurrency.addEventListener('change', () => {
    const v = clamp(parseInt(els.concurrency.value, 10), 1, 32);
    els.concurrency.value = String(v);
    updateSettings({ concurrency: v });
  });

  els.maxTasks.addEventListener('change', () => {
    const v = clamp(parseInt(els.maxTasks.value, 10), 1, 5);
    els.maxTasks.value = String(v);
    updateSettings({ maxConcurrentTasks: v });
    schedule();
  });

  els.credentials.addEventListener('change', () => {
    updateSettings({ sendCredentials: els.credentials.checked });
  });

  const onDragOver = (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const text =
      e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    if (text) appendUrls(text.split('\n'));
  });

  // 右键菜单推入的链接
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.pendingUrls) return;
    const urls = await store.takePendingUrls();
    if (urls.length) {
      appendUrls(urls);
      hint('Link added from the context menu; click "Add & start" to confirm.');
    }
  });

  window.addEventListener('pagehide', () => persistNow());
}

/* ---------- 启动 ---------- */

async function init() {
  state.settings = await store.loadSettings();
  syncSettingsUI();

  state.dirHandle = await store.getDirectoryHandle();
  await refreshDirState();

  await restoreTasks();

  const pending = await store.takePendingUrls();
  if (pending.length) appendUrls(pending);

  wireEvents();
  renderAll();
  setInterval(() => {
    // 先派发再渲染：万一渲染抛错，也不会连带把任务派发一起吞掉
    schedule();
    renderAll();
    if (state.tasks.some((t) => t.running)) persistThrottled();
  }, PROGRESS_INTERVAL_MS);
  schedule();
}

init();