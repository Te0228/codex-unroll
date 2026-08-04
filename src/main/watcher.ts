/**
 * 实时跟随（SPEC §7.4；验收 G1–G3、G6、G7）。
 *
 * 与 sessions.ts 一样**不 import electron**，纯 node 可测。
 * ipc.ts 负责把回调接到 `webContents.send`。
 *
 * 四条要点（§7.4）：
 *   1. `readSession` 的字节数作为起点 offset
 *   2. fs.watch 触发时**不立即读**，120ms 去抖（一次 turn 会触发多次 change）
 *   3. 从 offset 增量读，**只提交以 \n 结尾的完整行**，半行留到下次（G2）
 *   4. `stat.size < offset` → 文件被截断/重建，发 reset 让前端重读全量（G6）
 *
 * 只读：这里只有 watch/open/read/stat。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/** §7.4：一次 turn 会触发多次 change，去抖窗口 */
export const DEFAULT_DEBOUNCE_MS = 120;

/**
 * fs.watch 的兜底轮询间隔。
 *
 * 为什么需要：macOS 上 fs.watch 走 FSEvents，**注册后有一段热身期**，
 * 这期间发生的写入根本不会产生 change 事件；网络盘 / 容器挂载上漏事件更常见。
 * 只靠 fs.watch 会出现「跟随勾上了但一直不动」。
 *
 * 代价极小：跟随期间每 500ms 一次 `stat`，size 没变就直接返回，不读文件。
 * 轮询同样走去抖，不会绕过 §7.4-2。设为 0 可关闭（单测里用得上）。
 */
export const DEFAULT_POLL_MS = 500;

export interface CreateWatcherOptions {
  /** 被跟随的文件绝对路径 */
  path: string;
  /** 起点字节偏移，一般是 readSession 返回的 size */
  fromOffset: number;
  /** 新增的完整行（已过滤空行）。只在 lines 非空时调用 */
  onAppend: (lines: string[]) => void;
  /** 文件被截断/重建，前端需要重读全量 */
  onReset: () => void;
  /** 读文件出错（文件被删等）。默认吞掉 */
  onError?: (err: unknown) => void;
  debounceMs?: number;
  /** fs.watch 漏事件时的兜底轮询间隔，0 关闭。默认 DEFAULT_POLL_MS */
  pollMs?: number;
}

export interface WatcherHandle {
  readonly path: string;
  /** 当前偏移，测试与调试用 */
  offset(): number;
  /** 是否已关闭 */
  closed(): boolean;
  /** 跳过去抖立刻拉一次（测试 / 手动刷新用） */
  flush(): Promise<void>;
  /** 关掉 fs.watch 并停止一切回调。可重复调用 */
  close(): void;
}

/**
 * 创建一个增量跟随器。**同一时刻只跟一个文件**由 `startWatching()` 保证，
 * 这个函数本身不做单例约束（方便单测多开）。
 */
export function createWatcher(opts: CreateWatcherOptions): WatcherHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let offset = Number.isFinite(opts.fromOffset) ? Math.max(0, Math.trunc(opts.fromOffset)) : 0;
  /** 半行缓存。存 Buffer 而不是 string：UTF-8 多字节字符可能横跨两次读取 */
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let isClosed = false;
  let timer: NodeJS.Timeout | null = null;
  /** 正在 pump 时又来了通知：置位，pump 结束后再跑一遍，避免并发读乱序 */
  let running = false;
  let rerun = false;

  // 文件不存在等启动期错误直接抛，由 startWatching() 转成 { ok:false, error }；
  // 运行期错误（文件中途被删等）走 onError，不打断跟随。
  let watcher: fs.FSWatcher | null = fs.watch(opts.path, { persistent: true }, () => schedule());
  watcher.on('error', (err) => opts.onError?.(err));

  // 兜底轮询（见 DEFAULT_POLL_MS）。unref 掉，免得它把进程/测试进程吊着不退。
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  let poller: NodeJS.Timeout | null = null;
  if (pollMs > 0) {
    poller = setInterval(() => schedule(), pollMs);
    poller.unref?.();
  }

  function schedule() {
    if (isClosed) return;
    // §7.4-2：不立即读，去抖。已有 timer 就复用（保证 N 次 change 最多 1 次读）
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, debounceMs);
  }

  async function pump(): Promise<void> {
    if (isClosed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        await pumpOnce();
      } while (rerun && !isClosed);
    } finally {
      running = false;
    }
  }

  async function pumpOnce(): Promise<void> {
    let size: number;
    try {
      const st = await fsp.stat(opts.path);
      size = st.size;
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    if (isClosed) return;

    // §7.4-4 / G6：文件被截断或重建
    if (size < offset) {
      offset = size;
      pending = Buffer.alloc(0);
      opts.onReset();
      return;
    }
    if (size === offset) return;

    let chunk: Buffer;
    try {
      chunk = await readRange(opts.path, offset, size);
    } catch (err) {
      opts.onError?.(err);
      return;
    }
    if (isClosed) return;

    offset += chunk.byteLength;

    const buf = pending.byteLength ? Buffer.concat([pending, chunk]) : chunk;
    const nl = buf.lastIndexOf(0x0a); // '\n'
    if (nl === -1) {
      // §7.4-3 / G2：一整段都还没换行，全部留作半行
      pending = buf;
      return;
    }
    pending = buf.subarray(nl + 1);
    const lines = buf
      .subarray(0, nl + 1)
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    if (lines.length > 0) opts.onAppend(lines);
  }

  return {
    path: opts.path,
    offset: () => offset,
    closed: () => isClosed,
    flush: () => pump(),
    close() {
      if (isClosed) return;
      isClosed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (poller) {
        clearInterval(poller);
        poller = null;
      }
      try {
        watcher?.close();
      } catch {
        /* 已经关了 */
      }
      watcher = null;
      pending = Buffer.alloc(0);
    },
  };
}

/** 从 [start, end) 读一段字节。只读，不改文件位置。 */
async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────
// 单例：同一时刻只跟随一个文件（验收 G7）
// ─────────────────────────────────────────────────────────────

let active: WatcherHandle | null = null;

/**
 * 开始跟随。**换文件或重复调用都会先关掉旧 watcher**，不留泄漏（G7）。
 * 失败不抛，按 §7.3 返回 `{ ok:false, error }`。
 */
export function startWatching(opts: CreateWatcherOptions): { ok: boolean; error?: string } {
  stopWatching();
  try {
    active = createWatcher(opts);
    return { ok: true };
  } catch (err) {
    active = null;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function stopWatching(): void {
  active?.close();
  active = null;
}

/** 当前正在跟随的文件；没有则 null。测试与调试用。 */
export function activeWatchPath(): string | null {
  return active?.path ?? null;
}

/** 当前 handle，仅供测试断言（生产代码不要依赖） */
export function activeWatcher(): WatcherHandle | null {
  return active;
}
