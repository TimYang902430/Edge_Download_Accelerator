import { createSink, supportsFileSystemAccess } from './sink.js';

/** 每次从网络读取的块大小；这也决定了单个 worker 的内存占用上限 */
const READ_CHUNK = 1024 * 1024;
const MIN_CHUNK = 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
/** 分块按此粒度对齐；块小于 1 MB 时仍要保持 Range 边界整齐 */
const CHUNK_ALIGN = 64 * 1024;
/** 分片已发出请求却一个字节都没收到超过此时长，判定为在排队等连接，而不是卡住 */
const CHUNK_QUEUE_WAIT_MS = 3000;

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 500;

const SAMPLE_INTERVAL_MS = 1000;
/** UI 更新节流间隔 */
export const PROGRESS_INTERVAL_MS = 200;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'download';
}

function fileNameFromResponse(headers, finalUrl) {
  const cd = headers.get('Content-Disposition');
  if (cd) {
    const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
    if (star) {
      const parts = star[1].trim().split("''");
      const encoded = (parts.length > 1 ? parts[1] : parts[0]).trim().replace(/^["']|["']$/g, '');
      try {
        return sanitizeFileName(decodeURIComponent(encoded));
      } catch {
        /* 编码异常则继续尝试其它来源 */
      }
    }
    const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(cd);
    if (plain) {
      const raw = (plain[2] ?? plain[3] ?? '').trim();
      if (raw) return sanitizeFileName(raw);
    }
  }
  try {
    const base = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || '');
    if (base) return sanitizeFileName(base);
  } catch {
    /* URL 解析失败，用默认名 */
  }
  return 'download';
}

/**
 * 浏览器在网络层失败时只会抛 "Failed to fetch" 这种无从下手的字符串，
 * 这里统一翻译成可操作的中文提示。AbortError（暂停/取消）原样抛出。
 */
function explainFetchError(err, url) {
  if (err?.name === 'AbortError') return err;
  const msg = err?.message || String(err);
  if (/failed to fetch|fetch failed|networkerror|load failed|network error/i.test(msg)) {
    const target = url ? ` (${url})` : '';
    return new Error(
      `Could not connect to${target}. Possible causes: the extension lacks site access ` +
        `(edge://extensions → this extension → allow access to all sites), the link is no longer valid, ` +
        `or the server rejects cross-origin requests with cookies (try turning off "Use login session").`,
    );
  }
  return err;
}

/**
 * 探测资源是否支持分片下载。
 * 用 Range GET 而不是 HEAD：相当多服务器未实现 HEAD，Range GET 更可靠。
 */
export async function probe(url, { credentials = 'include', signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      credentials,
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    throw explainFetchError(err, url);
  }

  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

  const finalUrl = res.url || url;
  const contentRange = res.headers.get('Content-Range');
  const contentLength = Number(res.headers.get('Content-Length')) || null;

  let acceptRanges = false;
  let size = null;

  if (res.status === 206 && contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) {
      acceptRanges = true;
      size = Number(m[1]);
    }
  }
  if (!acceptRanges) size = contentLength;

  // 探测响应体一律丢弃：若服务端忽略了 Range，此处 body 就是整个文件
  try {
    await res.body?.cancel();
  } catch {
    /* 已结束或不可取消 */
  }

  return {
    url,
    finalUrl,
    size,
    acceptRanges,
    fileName: fileNameFromResponse(res.headers, finalUrl),
    contentType: res.headers.get('Content-Type') || '',
  };
}

/**
 * 任务开始时的线程数：自动调节用并发上限，固定模式用用户指定值。
 * 必须集中在一处：buildPlan 和 restoreFrom 各算各的，会算出不一致的计划
 * （界面显示 16 线程、引擎却跑 32 线程）。
 */
function initialConcurrency(settings) {
  return Math.max(
    1,
    settings.autoTune && settings.concurrencyMax ? settings.concurrencyMax : settings.concurrency,
  );
}

/**
 * 依据探测结果制定下载计划。
 * 不支持分片、大小未知、或文件过小时走单连接，避免无谓的分片开销。
 */
export function buildPlan(meta, settings) {
  // 自动调节：任务开始就用满线程数，不再从低并发慢慢爬（开头几十秒只有几个线程在跑）
  const initial = initialConcurrency(settings);
  const { size, acceptRanges } = meta;
  if (!acceptRanges || !Number.isFinite(size) || size <= 0 || size < settings.minSplitBytes) {
    return { mode: 'single', initialConcurrency: 1, chunkSize: 0, totalChunks: 1 };
  }
  const target = Math.ceil(size / Math.max(1, initial * settings.chunksPerWorker));
  let chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, target));
  // 分片数必须不少于线程数，否则多出来的线程领不到活直接退出（小文件下很常见），
  // 徽标写着 16 线程、实际只有几个在跑。必要时把块切细到 size / initial。
  chunkSize = Math.min(chunkSize, Math.floor(size / initial));
  chunkSize = Math.max(CHUNK_ALIGN, Math.floor(chunkSize / CHUNK_ALIGN) * CHUNK_ALIGN);
  return {
    mode: 'ranged',
    initialConcurrency: initial,
    chunkSize,
    totalChunks: Math.ceil(size / chunkSize),
  };
}

export class AcceleratedDownload {
  constructor({ url, settings, credentials }) {
    this.url = url;
    this.settings = settings;
    this.credentials = credentials;

    this.state = 'idle';
    this.meta = null;
    this.plan = null;
    this.sink = null;
    this.degraded = false;
    this.downloadId = null;

    this.received = 0;
    this.speed = 0;
    this.concurrency = 1;
    this.retries = 0;
    this.error = null;

    this._controller = null;
    this._dirHandle = null;
    /** 从断点恢复且磁盘上已有部分数据，续写时需保留原文件内容 */
    this._restoredPartial = false;
    this._pending = [];
    this._completed = new Set();
    this._failed = new Set();
    this._surplus = new Map();
    /** 正在下载的分片 → 已写入字节数，仅用于界面展示进度 */
    this._chunkBytes = new Map();
    /** 正在下载的分片 → 开始等待第一个字节的时间戳，用于识别「请求已发出但收不到数据」 */
    this._chunkActiveSince = new Map();
    this._running = 0;
    this._target = 1;
    this._workers = null;
    this._sampleTimer = null;
    this._lastSampleAt = 0;
    this._lastSampleBytes = 0;
  }

  snapshot() {
    const total = this.meta?.size ?? null;
    return {
      state: this.state,
      fileName: this.meta?.fileName ?? '',
      url: this.url,
      total,
      received: this.received,
      speed: this.speed,
      concurrency: this.concurrency,
      mode: this.plan?.mode ?? 'unknown',
      acceptRanges: Boolean(this.meta?.acceptRanges),
      degraded: this.degraded,
      retries: this.retries,
      error: this.error,
      progress: this._progressRatio(),
    };
  }

  _progressRatio() {
    const total = this.meta?.size;
    if (Number.isFinite(total) && total > 0) {
      return Math.min(1, this.received / total);
    }
    return this.state === 'done' ? 1 : 0;
  }

  /** 逐个分片的进度快照，供界面画方块；非分片模式返回 null */
  chunkInfo() {
    const plan = this.plan;
    const total = this.meta?.size;
    if (!plan || plan.mode !== 'ranged' || !Number.isFinite(total) || total <= 0) return null;

    const items = [];
    for (let i = 0; i < plan.totalChunks; i++) {
      const start = i * plan.chunkSize;
      const end = Math.min(start + plan.chunkSize, total) - 1;
      const size = Math.max(0, end - start + 1);

      let state = 'pending';
      let bytes = 0;
      if (this._completed.has(i)) {
        state = 'done';
        bytes = size;
      } else if (this._failed.has(i)) {
        state = 'failed';
        bytes = this._surplus.get(i) || 0;
      } else if (this._chunkBytes.has(i)) {
        bytes = this._chunkBytes.get(i) || 0;
        // 请求已发出却迟迟收不到第一个字节：多半是在排队等连接（浏览器对同一站点
        // 最多开 6 条连接），而不是下载卡住了，单独标出来让用户看懂。
        const since = this._chunkActiveSince.get(i) || 0;
        const waiting = bytes === 0 && since > 0 && performance.now() - since > CHUNK_QUEUE_WAIT_MS;
        state = waiting ? 'queued' : 'active';
      }
      items.push({ index: i, size, bytes, state });
    }
    return { chunkSize: plan.chunkSize, total, totalChunks: plan.totalChunks, items };
  }

  /** 中断（取消或暂停）导致的错误不应被当成下载失败 */
  _canceled() {
    return this.state === 'canceled' || this.state === 'paused';
  }

  /** 扩展未获得目标站点访问权限时，fetch 只会抛 "Failed to fetch"，这里提前给出明确原因 */
  async _missingHostPermission() {
    if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return null;
    let url;
    try {
      url = new URL(this.url);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    try {
      const granted = await chrome.permissions.contains({ origins: [`${url.origin}/*`] });
      if (granted) return null;
    } catch {
      return null;
    }
    return `The extension has no access to ${url.origin}: open edge://extensions, find this extension, enable "allow access to all sites", then retry.`;
  }

  async run({ dirHandle }) {
    if (!['idle', 'paused', 'error'].includes(this.state)) return;
    if (dirHandle) this._dirHandle = dirHandle;
    this.error = null;
    // 整轮下载（含探测）共用一个可取消信号，保证取消能立刻中断
    this._controller = new AbortController();

    if (!this.meta) {
      this.state = 'probing';
      const denied = await this._missingHostPermission();
      if (denied) {
        if (this._canceled()) return;
        this.state = 'error';
        this.error = denied;
        return;
      }
      try {
        this.meta = await probe(this.url, {
          credentials: this.credentials,
          signal: this._controller.signal,
        });
        this.plan = buildPlan(this.meta, this.settings);
      } catch (err) {
        if (this._canceled()) return;
        this.state = 'error';
        this.error = err.message || String(err);
        return;
      }
    }

    if (!this.sink) {
      this.state = 'saving';
      try {
        const created = await createSink({
          dirHandle: this._dirHandle,
          fileName: this.meta.fileName,
          size: this.meta.size,
          saveMode: this.settings.saveMode,
          keepExisting: this._restoredPartial,
        });
        this.sink = created.sink;
        this.degraded = created.degraded || !supportsFileSystemAccess();
        this._restoredPartial = false;
      } catch (err) {
        if (this._canceled()) return;
        this.state = 'error';
        this.error = err.message || String(err);
        return;
      }
    }

    if (this._failed.size) {
      this._failed.clear();
      this._pending = Array.from(new Set(this._pending));
    }

    if (this.plan.mode === 'single') {
      await this._runSingle();
    } else {
      this._prepareChunks();
      await this._runWorkers();
    }

    await this._finalize();
  }

  /** 首次下载时初始化待办分片；恢复下载时保留既有进度 */
  _prepareChunks() {
    if (this._pending.length || this._completed.size || this._failed.size) return;
    this._pending = Array.from({ length: this.plan.totalChunks }, (_, i) => i);
  }

  async _runSingle() {
    this.state = 'running';
    this._target = 1;
    this.concurrency = 1;
    // 服务端不支持 Range，无法从中间续传，重试一律从 0 重新写入
    this.received = 0;
    this._startSampling();

    try {
      let res;
      try {
        res = await fetch(this.meta.finalUrl, {
          method: 'GET',
          credentials: this.credentials,
          signal: this._controller.signal,
        });
      } catch (err) {
        throw explainFetchError(err, this.meta.finalUrl);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('Response has no data stream');

      const reader = res.body.getReader();
      let pos = this.received;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.sink.write(pos, value);
        pos += value.byteLength;
        this.received += value.byteLength;
      }
    } catch (err) {
      if (!this._controller.signal.aborted) {
        this.state = 'error';
        this.error = err.message || String(err);
      }
    } finally {
      this._stopSampling();
    }
  }

  _chunkRange(index) {
    const start = index * this.plan.chunkSize;
    const end = Math.min(start + this.plan.chunkSize, this.meta.size) - 1;
    return { start, end };
  }

  async _runWorkers() {
    this.state = 'running';
    this._target = this.plan.initialConcurrency;
    this.concurrency = this._target;
    this._workers = new Set();
    this._chunkBytes.clear();
    this._chunkActiveSince.clear();
    this._startSampling();
    this._ensureWorkers();

    try {
      // 自适应调优会在运行期间新增 worker，因此每轮都重新等待当前全部 worker
      while (this._workers.size) {
        await Promise.all([...this._workers]);
      }
    } finally {
      this._stopSampling();
    }

    if (this.state === 'paused' || this.state === 'canceled') return;

    if (this._failed.size) {
      this.state = 'error';
      this.error = `${this._failed.size} chunks failed to download; click Retry to finish them`;
    } else if (this._pending.length) {
      this.state = 'error';
      this.error = 'Download incomplete; click Retry to fetch the missing chunks';
    }
  }

  /** 把在跑的 worker 补齐到目标并发数 */
  _ensureWorkers() {
    const want = this._target - this._running;
    for (let i = 0; i < want; i++) {
      const p = this._worker().finally(() => this._workers.delete(p));
      this._workers.add(p);
    }
  }

  async _worker() {
    this._running++;
    try {
      while (!this._controller.signal.aborted) {
        if (this._running > this._target) break;
        const index = this._pending.shift();
        if (index === undefined) break;
        try {
          await this._fetchChunk(index);
          this._failed.delete(index);
          this._completed.add(index);
        } catch (err) {
          this._chunkBytes.delete(index);
          this._chunkActiveSince.delete(index);
          if (this._controller.signal.aborted) {
            this._pending.unshift(index);
            return;
          }
          this._failed.add(index);
          this._pending.push(index);
          this.error = err.message || String(err);
          return;
        }
      }
    } finally {
      this._running--;
    }
  }

  async _fetchChunk(index) {
    const { start, end } = this._chunkRange(index);
    let written = this._surplus.get(index) || 0;
    this._chunkBytes.set(index, written);
    this._chunkActiveSince.set(index, performance.now());
    let attempt = 0;

    for (;;) {
      try {
        await this._streamRange(start + written, end, (n) => {
          written += n;
          this.received += n;
          this._chunkBytes.set(index, written);
        });
        this._surplus.delete(index);
        this._chunkBytes.delete(index);
        this._chunkActiveSince.delete(index);
        return;
      } catch (err) {
        if (this._controller.signal.aborted) {
          this._surplus.set(index, written);
          throw err;
        }
        attempt++;
        if (attempt > MAX_RETRIES) {
          this._surplus.set(index, written);
          throw err;
        }
        this.retries++;
        // 只重取失败后剩余的字节区间，不重头再来
        await sleep(RETRY_BASE_DELAY * 2 ** (attempt - 1), this._controller.signal);
      }
    }
  }

  async _streamRange(from, to, onWrote) {
    if (from > to) return;

    let res;
    try {
      res = await fetch(this.meta.finalUrl, {
        method: 'GET',
        headers: { Range: `bytes=${from}-${to}` },
        credentials: this.credentials,
        signal: this._controller.signal,
      });
    } catch (err) {
      throw explainFetchError(err, this.meta.finalUrl);
    }

    if (res.status !== 206) {
      try {
        await res.body?.cancel();
      } catch {
        /* 忽略 */
      }
      throw new Error(`Server did not respond with chunked data (HTTP ${res.status})`);
    }

    const m = /bytes\s+(\d+)-/i.exec(res.headers.get('Content-Range') || '');
    const pos0 = m ? Number(m[1]) : null;
    if (pos0 !== from) {
      try {
        await res.body?.cancel();
      } catch {
        /* 忽略 */
      }
      throw new Error(`Chunk range mismatch (expected ${from}, got ${pos0})`);
    }

    const reader = res.body.getReader();
    let pos = from;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await this.sink.write(pos, value);
      pos += value.byteLength;
      onWrote(value.byteLength);
    }

    if (pos !== to + 1) throw new Error('Chunk data incomplete');
  }

  /* ---------- 采样 ---------- */

  _startSampling() {
    this._lastSampleAt = performance.now();
    this._lastSampleBytes = this.received;
    this._sampleTimer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
  }

  _stopSampling() {
    if (this._sampleTimer) clearInterval(this._sampleTimer);
    this._sampleTimer = null;
    this.speed = 0;
  }

  _sample() {
    const now = performance.now();
    const dt = (now - this._lastSampleAt) / 1000;
    if (dt <= 0) return;
    const delta = this.received - this._lastSampleBytes;
    this._lastSampleAt = now;
    this._lastSampleBytes = this.received;

    const instant = delta / dt;
    // EMA 平滑，避免瞬时抖动让速度显示乱跳
    this.speed = this.speed > 0 ? this.speed * 0.6 + instant * 0.4 : instant;
  }

  /* ---------- 对外控制 ---------- */

  pause() {
    if (this.state !== 'running' || !this._controller) return;
    this.state = 'paused';
    this._stopSampling();
    this._controller.abort();
    // 注意：不关闭 sink，保留已写入的数据以便续传
  }

  /** 续传：run() 内部会按需重新创建落盘器并只补缺失区间 */
  async resume(dirHandle) {
    if (this.state !== 'paused' && this.state !== 'error') return;
    await this.run({ dirHandle });
  }

  /** 序列化为可持久化的断点记录 */
  toRecord() {
    return {
      url: this.url,
      fileName: this.meta?.fileName ?? '',
      size: this.meta?.size ?? null,
      acceptRanges: Boolean(this.meta?.acceptRanges),
      mode: this.plan?.mode ?? 'single',
      chunkSize: this.plan?.chunkSize ?? 0,
      totalChunks: this.plan?.totalChunks ?? 1,
      completedChunks: [...this._completed],
      received: this.received,
      status: this.state,
      degraded: this.degraded,
      downloadId: this.downloadId ?? null,
    };
  }

  /** 从断点记录恢复任务（不自动开始，等用户点击「继续」） */
  restoreFrom(record) {
    this.meta = {
      url: record.url,
      finalUrl: record.url,
      size: record.size,
      acceptRanges: Boolean(record.acceptRanges),
      fileName: record.fileName,
      contentType: '',
    };
    this.plan = {
      mode: record.mode,
      // 分片尺寸沿用记录（改了会让已完成的块区间对不上），但线程数必须按当前设置重算：
      // 旧记录里 autoTune 下的 concurrency 是个被界面隐藏的陈旧值（可能 32），
      // 直接拿来用就会出现「界面 16 线程、实际跑 32 线程」的错位。
      initialConcurrency: initialConcurrency(this.settings),
      chunkSize: record.chunkSize,
      totalChunks: record.totalChunks,
    };
    this.degraded = Boolean(record.degraded);
    this.downloadId = record.downloadId ?? null;

    // 内存拼接模式下已收到的分片并不在磁盘上，无法续传，只能重头来
    const canResume = !this.degraded && record.mode === 'ranged' && record.size > 0;
    this._completed = new Set(canResume ? record.completedChunks || [] : []);
    this.received = canResume ? record.received || 0 : 0;
    this._restoredPartial = canResume && this.received > 0;

    this._pending = [];
    for (let i = 0; i < this.plan.totalChunks; i++) {
      if (!this._completed.has(i)) this._pending.push(i);
    }

    this.error = null;
    this.state = record.status === 'done' ? 'done' : 'paused';
  }

  async cancel() {
    this.state = 'canceled';
    this._stopSampling();
    this._controller?.abort();
    if (this.sink) {
      await this.sink.abort();
      this.sink = null;
    }
  }

  async _finalize() {
    if (this.state === 'canceled' || this.state === 'paused' || this.state === 'error') return;
    if (!this.sink) return;
    try {
      const result = await this.sink.close();
      if (result != null) this.downloadId = result;
      this.state = 'done';
      this.speed = 0;
      if (Number.isFinite(this.meta?.size)) this.received = this.meta.size;
    } catch (err) {
      this.state = 'error';
      this.error = err.message || String(err);
    }
  }
}