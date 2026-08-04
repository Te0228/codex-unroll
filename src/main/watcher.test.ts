/**
 * M5 验收 · 实时跟随的主进程侧（SPEC §14.5 G1–G3、G6、G7）。
 *
 * 按 §14.5 的要求，用 `fs.appendFileSync` 往临时文件写来驱动，**不真的跑 codex**。
 *
 * G4 / G5（滚动位置）是渲染进程行为，不在本文件范围内，由 M5 的 UI 测试覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DEBOUNCE_MS,
  activeWatchPath,
  activeWatcher,
  createWatcher,
  startWatching,
  stopWatching,
  type WatcherHandle,
} from './watcher';

// ─────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];
const openHandles: WatcherHandle[] = [];

function mkTmpFile(content = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unroll-watch-'));
  tmpRoots.push(dir);
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

/** 记录回调的跟随器；测试结束统一 close */
function track(handle: WatcherHandle): WatcherHandle {
  openHandles.push(handle);
  return handle;
}

interface Sink {
  lines: string[];
  appendCalls: number;
  resets: number;
  errors: unknown[];
}

function makeSink(): Sink {
  return { lines: [], appendCalls: 0, resets: 0, errors: [] };
}

function watch(file: string, fromOffset: number, sink: Sink, debounceMs?: number): WatcherHandle {
  return track(
    createWatcher({
      path: file,
      fromOffset,
      debounceMs,
      onAppend: (lines) => {
        sink.appendCalls++;
        sink.lines.push(...lines);
      },
      onReset: () => {
        sink.resets++;
      },
      onError: (e) => sink.errors.push(e),
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeout = 4000, step = 15): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

afterEach(() => {
  stopWatching();
  while (openHandles.length) openHandles.pop()!.close();
});

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// G1 · 增量追加
// ─────────────────────────────────────────────────────────────

describe('G1 · 追加 3 行 → 推送 3 条', () => {
  it('只推新增的行，起点之前的内容不重复推送', async () => {
    const file = mkTmpFile('{"n":0}\n');
    const offset = fs.statSync(file).size;
    const sink = makeSink();
    watch(file, offset, sink);

    fs.appendFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    await waitFor(() => sink.lines.length >= 3);
    await sleep(DEFAULT_DEBOUNCE_MS * 2);

    expect(sink.lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(sink.resets).toBe(0);
    expect(sink.errors).toEqual([]);
  });

  it('分多批追加，全部按顺序送达', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    watch(file, 0, sink);

    fs.appendFileSync(file, 'a\n');
    await waitFor(() => sink.lines.length >= 1);
    fs.appendFileSync(file, 'b\nc\n');
    await waitFor(() => sink.lines.length >= 3);

    expect(sink.lines).toEqual(['a', 'b', 'c']);
  });

  it('空行不产生条目（与 readSession 的 E5 一致）', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    watch(file, 0, sink);

    fs.appendFileSync(file, '\n   \n{"n":1}\n');
    await waitFor(() => sink.lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 2);

    expect(sink.lines).toEqual(['{"n":1}']);
  });

  it('UTF-8 多字节字符横跨两次读取也不会乱码', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    const h = watch(file, 0, sink, 5);

    const payload = Buffer.from('{"msg":"中文测试"}\n', 'utf8');
    const cut = 12; // 落在某个汉字的字节中间
    fs.appendFileSync(file, payload.subarray(0, cut));
    await h.flush();
    expect(sink.lines).toEqual([]);

    fs.appendFileSync(file, payload.subarray(cut));
    await waitFor(() => sink.lines.length >= 1);
    expect(sink.lines).toEqual(['{"msg":"中文测试"}']);
  });
});

// ─────────────────────────────────────────────────────────────
// G2 · 半行
// ─────────────────────────────────────────────────────────────

describe('G2 · 只提交以 \\n 结尾的完整行', () => {
  it('半行不产生条目；补齐换行后才整行出现', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    const h = watch(file, 0, sink);

    fs.appendFileSync(file, '{"half":tr');
    // 半行确实被读进来缓存了（offset 前进了），只是没提交
    await waitFor(() => h.offset() === fs.statSync(file).size);
    await sleep(DEFAULT_DEBOUNCE_MS * 2);
    expect(sink.lines).toEqual([]);
    expect(sink.appendCalls).toBe(0);

    fs.appendFileSync(file, 'ue}\n');
    await waitFor(() => sink.lines.length >= 1);
    expect(sink.lines).toEqual(['{"half":true}']);
  });

  it('完整行 + 半行混在一次追加里：只提交完整的那条', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    watch(file, 0, sink);

    fs.appendFileSync(file, '{"a":1}\n{"b":');
    await waitFor(() => sink.lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 2);
    expect(sink.lines).toEqual(['{"a":1}']);

    fs.appendFileSync(file, '2}\n');
    await waitFor(() => sink.lines.length >= 2);
    expect(sink.lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

// ─────────────────────────────────────────────────────────────
// G3 · 120ms 去抖
// ─────────────────────────────────────────────────────────────

describe('G3 · 120ms 去抖', () => {
  it('连续快速追加 20 次，推送次数远小于 20，且一行不丢', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    watch(file, 0, sink);

    for (let i = 0; i < 20; i++) fs.appendFileSync(file, `{"n":${i}}\n`);

    await waitFor(() => sink.lines.length >= 20);
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(sink.lines).toHaveLength(20);
    expect(sink.lines[0]).toBe('{"n":0}');
    expect(sink.lines[19]).toBe('{"n":19}');
    // §14.5 G3：因为去抖，IPC 推送次数 < 20（实测通常是 1）
    expect(sink.appendCalls).toBeLessThan(20);
    expect(sink.appendCalls).toBeGreaterThan(0);
  });

  it('去抖窗口内的多次 change 不会各读一次', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    watch(file, 0, sink, 200);

    for (let i = 0; i < 10; i++) {
      fs.appendFileSync(file, `${i}\n`);
      await sleep(5);
    }
    await waitFor(() => sink.lines.length >= 10);
    expect(sink.appendCalls).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────
// G6 · 截断 / 重建
// ─────────────────────────────────────────────────────────────

describe('G6 · 文件被截断或重建 → reset', () => {
  it('size < offset 时发 reset，且不推半截内容', async () => {
    const file = mkTmpFile('{"a":1}\n{"a":2}\n{"a":3}\n');
    const sink = makeSink();
    const h = watch(file, fs.statSync(file).size, sink);

    fs.writeFileSync(file, '{"new":1}\n'); // 重建成更小的文件
    await waitFor(() => sink.resets >= 1);

    expect(sink.resets).toBeGreaterThanOrEqual(1);
    expect(sink.lines).toEqual([]);
    // reset 后 offset 对齐到新文件末尾，交给前端重读全量（§7.4-4）
    expect(h.offset()).toBe(fs.statSync(file).size);
  });

  it('reset 之后继续跟随新内容', async () => {
    const file = mkTmpFile('{"a":1}\n{"a":2}\n');
    const sink = makeSink();
    watch(file, fs.statSync(file).size, sink);

    fs.writeFileSync(file, '');
    await waitFor(() => sink.resets >= 1);

    fs.appendFileSync(file, '{"fresh":1}\n');
    await waitFor(() => sink.lines.length >= 1);
    expect(sink.lines).toEqual(['{"fresh":1}']);
  });

  it('size 没变时既不推也不 reset', async () => {
    const file = mkTmpFile('{"a":1}\n');
    const sink = makeSink();
    const h = watch(file, fs.statSync(file).size, sink);

    fs.utimesSync(file, new Date(), new Date()); // 只碰时间戳
    await h.flush();
    await sleep(DEFAULT_DEBOUNCE_MS * 2);

    expect(sink.lines).toEqual([]);
    expect(sink.resets).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// G7 · 同一时刻只跟一个文件，切换不泄漏
// ─────────────────────────────────────────────────────────────

describe('G7 · 切换会话时旧 watcher 被关闭', () => {
  it('startWatching 换文件会关掉上一个', async () => {
    const a = mkTmpFile('');
    const b = mkTmpFile('');
    const sinkA = makeSink();
    const sinkB = makeSink();

    expect(startWatching({ path: a, fromOffset: 0, onAppend: (l) => sinkA.lines.push(...l), onReset: () => sinkA.resets++ })).toEqual({ ok: true });
    const handleA = activeWatcher();
    expect(activeWatchPath()).toBe(a);
    expect(handleA?.closed()).toBe(false);

    expect(startWatching({ path: b, fromOffset: 0, onAppend: (l) => sinkB.lines.push(...l), onReset: () => sinkB.resets++ })).toEqual({ ok: true });
    expect(handleA?.closed()).toBe(true);
    expect(activeWatchPath()).toBe(b);

    // 旧文件继续被写，也不该再有任何回调
    fs.appendFileSync(a, '{"stale":1}\n');
    fs.appendFileSync(b, '{"live":1}\n');
    await waitFor(() => sinkB.lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(sinkA.lines).toEqual([]);
    expect(sinkB.lines).toEqual(['{"live":1}']);
  });

  it('unwatchSession 后没有跟随目标，也不再回调', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    startWatching({
      path: file,
      fromOffset: 0,
      onAppend: (l) => sink.lines.push(...l),
      onReset: () => sink.resets++,
    });
    const h = activeWatcher();

    stopWatching();
    expect(activeWatchPath()).toBeNull();
    expect(h?.closed()).toBe(true);

    fs.appendFileSync(file, '{"after":1}\n');
    await sleep(DEFAULT_DEBOUNCE_MS * 3);
    expect(sink.lines).toEqual([]);

    stopWatching(); // 重复调用是空操作
    expect(activeWatchPath()).toBeNull();
  });

  it('close() 之后的 flush 不再产生回调', async () => {
    const file = mkTmpFile('');
    const sink = makeSink();
    const h = watch(file, 0, sink);
    h.close();
    expect(h.closed()).toBe(true);

    fs.appendFileSync(file, '{"x":1}\n');
    await h.flush();
    expect(sink.lines).toEqual([]);
  });

  it('跟随不存在的文件 → { ok:false, error }，不抛异常', () => {
    const res = startWatching({
      path: path.join(os.tmpdir(), 'unroll-does-not-exist-xyzzy.jsonl'),
      fromOffset: 0,
      onAppend: () => undefined,
      onReset: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(activeWatchPath()).toBeNull();
  });
});
