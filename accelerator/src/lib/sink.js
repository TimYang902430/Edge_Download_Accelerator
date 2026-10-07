/** 内存降级模式允许的最大文件大小 */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 通过用户选定的文件夹句柄流式写盘。
 *
 * 关键点：
 * - open() 时用 truncate(size) 把文件零填充预分配到最终大小，之后各线程可按自身偏移
 *   直接随机写入，无需在内存里等待乱序分片重组。
 * - 所有 write() 通过内部 Promise 链串行执行：网络读取是并行的，磁盘写入是顺序的，
 *   磁盘几乎不可能是瓶颈，因此不会限制网络吞吐；同时每个 worker 最多只持有 1 个待写块，
 *   内存占用被钉死在（线程数 × 读取缓冲）级别。
 * - close() 才把临时文件原子替换为目标文件，中途失败不会留下残缺文件。
 */
export class FsaSink {
  constructor(dirHandle, fileName) {
    this.dirHandle = dirHandle;
    this.fileName = fileName;
    this.writable = null;
    this._tail = Promise.resolve();
    this._failed = null;
  }

  get kind() {
    return 'fsa';
  }

  async open(size, { keepExisting = false } = {}) {
    this.fileHandle = await this.dirHandle.getFileHandle(this.fileName, { create: true });
    // keepExisting 仅供续传使用：先把已有文件内容复制进临时文件，再接着写缺失区间。
    // 全新下载时不保留旧内容，避免同名残file被混入。
    this.writable = await this.fileHandle.createWritable(
      keepExisting ? { keepExistingData: true } : undefined,
    );
    if (Number.isFinite(size) && size > 0) {
      // 预分配，保证任意偏移写入都落在文件范围内
      await this.writable.truncate(size);
    }
  }

  write(position, chunk) {
    const run = this._tail.then(() => {
      if (this._failed) throw this._failed;
      return this.writable.write({ type: 'write', position, data: chunk });
    });
    // 链条本身不因单次失败而中断，避免后续写入永久挂起
    this._tail = run.catch((err) => {
      this._failed = this._failed || err;
    });
    return run;
  }

  async close() {
    await this._tail;
    if (this._failed) throw this._failed;
    await this.writable.close();
    this.writable = null;
  }

  async abort() {
    if (!this.writable) return;
    const w = this.writable;
    this.writable = null;
    try {
      await w.abort();
    } catch {
      /* 已经关闭或已失败 */
    }
  }
}

/**
 * 降级方案：把整个文件拼进内存，再交给 chrome.downloads 保存到默认下载目录。
 * 适用于浏览器不支持 File System Access API、用户拒绝授权、或 folder 句柄不可用的情况。
 */
export class BlobSink {
  constructor(fileName) {
    this.fileName = fileName;
    this.buffer = null;
    this.objectUrl = null;
    this.downloadId = null;
  }

  get kind() {
    return 'blob';
  }

  async open(size) {
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error('This resource does not report a file size, so in-memory assembly is unavailable; choose a save folder and retry');
    }
    if (size > MAX_BLOB_BYTES) {
      throw new Error('File exceeds 2 GB, which in-memory assembly cannot handle; choose a save folder and retry');
    }
    this.buffer = new Uint8Array(size);
  }

  async write(position, chunk) {
    this.buffer.set(chunk, position);
  }

  async close() {
    const blob = new Blob([this.buffer], { type: 'application/octet-stream' });
    this.buffer = null;
    this.objectUrl = URL.createObjectURL(blob);
    this.downloadId = await chrome.downloads.download({
      url: this.objectUrl,
      filename: this.fileName,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    this._releaseWhenDone(this.downloadId);
    return this.downloadId;
  }

  _releaseWhenDone(downloadId) {
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        this._revoke();
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // 页面被关闭等情况下的兜底释放
    window.addEventListener('pagehide', () => this._revoke(), { once: true });
  }

  _revoke() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async abort() {
    this.buffer = null;
    if (this.downloadId != null) {
      try {
        await chrome.downloads.cancel(this.downloadId);
      } catch {
        /* 尚未开始 */
      }
    }
    this._revoke();
  }
}

export function supportsFileSystemAccess() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * 按优先级创建落盘器：优先文件夹流式写入，不可用时自动降级为内存拼接。
 * @returns {Promise<{sink: FsaSink|BlobSink, degraded: boolean}>}
 */
export async function createSink({ dirHandle, fileName, size, saveMode, keepExisting = false }) {
  if (saveMode === 'fsa') {
    const sink = new FsaSink(dirHandle, fileName);
    await sink.open(size, { keepExisting });
    return { sink, degraded: false };
  }

  if (dirHandle && supportsFileSystemAccess()) {
    const sink = new FsaSink(dirHandle, fileName);
    try {
      await sink.open(size, { keepExisting });
      return { sink, degraded: false };
    } catch {
      await sink.abort();
      if (saveMode === 'auto') {
        const fallback = new BlobSink(fileName);
        await fallback.open(size);
        return { sink: fallback, degraded: true };
      }
      throw new Error('Could not write to the selected folder; please choose the save location again');
    }
  }

  const sink = new BlobSink(fileName);
  await sink.open(size);
  return { sink, degraded: true };
}