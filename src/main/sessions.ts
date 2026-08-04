/**
 * 会话扫描与读取（SPEC §3.1、§7.2、§10.2；验收 E1–E5）。
 *
 * 本文件**不 import electron**——全部是可以在纯 node 环境跑单测的异步函数。
 * `src/main/ipc.ts` 只是把它们包一层 `ipcMain.handle`。
 *
 * 硬约束（§9）：全程只读。这里只有 open/read/stat/readdir，没有任何写操作，
 * 也没有任何网络调用。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type ProjectRef, projectRef } from '../shared/project';
import { redactText } from '../shared/redact';
import type { ListSessionsResult, SessionListItem } from '../shared/types';

/** Codex 源码 `codex-rs/rollout/src/lib.rs`：SESSIONS_SUBDIR = "sessions" */
export const SESSIONS_SUBDIR = 'sessions';

/**
 * 文件头扫描的**每次读取块大小**。
 *
 * 注意这不是上限。§8 原话是「只读文件头 64KB 生成摘要」，但那个数字对本项目的
 * 数据形状太小了：§10.1 实测单行 5 000–11 500 字符、AGENTS.md 注入 23 000 字符，
 * 真实 rollout 里 `turn_context`（带 model）落在 **98 KB** 处、
 * 第一条 `user_message` 落在 **99.5 KB** 处（夹具 01/02 实测）。
 * 读满 64KB 只能拿到 `session_meta`，model 与 firstUser 全空——
 * F2 要求的「时间、模型、首条用户消息」一个都显示不出来。
 *
 * 所以改成**流式按行读、拿齐就停**（见 streamHeadLines）。
 */
export const HEAD_CHUNK_BYTES = 64 * 1024;

/**
 * 文件头扫描的字节上限兜底。
 *
 * 典型 100KB 文件读到第 8 行就停（比原来读满 64KB 还省），
 * 这个上限只对「一直没出现 user_message 的超长会话」生效，
 * 防止个别文件把启动拖垮（§10.2：1000+ 会话启动 <1s，其中只有最近 60 个做摘要）。
 */
export const HEAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 只对最近这么多个会话预读文件头（§10.2：1000+ 会话时启动 <1s）。
 * 其余条目只带 path / mtime / size。
 */
export const SUMMARY_LIMIT = 60;

/** firstUser 截断长度（§8） */
export const FIRST_USER_MAX = 120;

/**
 * 项目扫描的字节上限。
 *
 * `session_meta` 永远是第 1 行，实测 22 150 字节（8 份真实 rollout 全一样，
 * 大头是 `base_instructions`）。正常文件第一次 64KB 读取就拿到了，这个上限只
 * 对「第一行异常巨大 / 前面全是没有 cwd 的记录」兜底。
 */
export const PROJECT_MAX_BYTES = 256 * 1024;

/**
 * project 这一趟的并发上限。见 mapLimit 的注释——1000 个文件同时 open 会 EMFILE。
 */
export const PROJECT_CONCURRENCY = 32;

/** 目录递归深度上限。真实布局是 sessions/YYYY/MM/DD/（3 层），留点余量。 */
const MAX_DEPTH = 6;

// ─────────────────────────────────────────────────────────────
// 路径
// ─────────────────────────────────────────────────────────────

/**
 * $CODEX_HOME，默认 ~/.codex。
 * **必须尊重环境变量覆盖**（验收 E3；§14.6 冒烟用 `CODEX_HOME=$(pwd)/test`）。
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_HOME?.trim();
  if (raw) return path.resolve(expandTilde(raw, env));
  return path.join(env.HOME || os.homedir(), '.codex');
}

function expandTilde(p: string, env: NodeJS.ProcessEnv): string {
  if (p === '~') return env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(env.HOME || os.homedir(), p.slice(2));
  return p;
}

export function sessionsDirOf(codexHome: string): string {
  return path.join(codexHome, SESSIONS_SUBDIR);
}

/**
 * 是否算一个 rollout 文件。
 *
 * 真实文件名是 `rollout-<ISO>-<session_id>.jsonl`，但 sessions 目录下的
 * `.jsonl` 一律当会话看——用户手工拷进去的副本（夹具就是这样）也能被列出来。
 */
export function isRolloutFile(name: string): boolean {
  return name.toLowerCase().endsWith('.jsonl');
}

// ─────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────

export interface RolloutFileStat {
  path: string;
  mtime: number;
  size: number;
}

/**
 * 递归收集 `dir` 下所有 rollout 文件。
 * 实际布局是 `sessions/YYYY/MM/DD/`，扁平布局（文件直接躺在 sessions/ 下）同样支持。
 *
 * 目录不存在 / 无权限 → 返回空数组，**不抛异常**（验收 E2）。
 */
export async function collectRolloutFiles(
  dir: string,
  depth = MAX_DEPTH,
): Promise<RolloutFileStat[]> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: RolloutFileStat[] = [];
  const subdirs: string[] = [];

  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (depth > 0) subdirs.push(full);
      continue;
    }
    if (!d.isFile() && !d.isSymbolicLink()) continue;
    if (!isRolloutFile(d.name)) continue;
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      out.push({ path: full, mtime: st.mtimeMs, size: st.size });
    } catch {
      // 扫描期间文件被删/无权限：跳过，不让一个坏文件毁掉整个列表
    }
  }

  const nested = await Promise.all(subdirs.map((s) => collectRolloutFiles(s, depth - 1)));
  for (const n of nested) out.push(...n);
  return out;
}

/**
 * 扫描 `$CODEX_HOME/sessions`，按 mtime 倒序（验收 E1）。
 * 只对最近 SUMMARY_LIMIT 个读文件头做摘要（§10.2）。
 */
export async function scanSessions(
  codexHome: string = resolveCodexHome(),
): Promise<ListSessionsResult> {
  const sessionsDir = sessionsDirOf(codexHome);
  const files = await collectRolloutFiles(sessionsDir);

  // mtime 倒序；同一毫秒时用路径兜底，保证顺序稳定可测
  files.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const items: SessionListItem[] = files.map((f) => ({
    path: f.path,
    mtime: f.mtime,
    size: f.size,
  }));

  const head = items.slice(0, SUMMARY_LIMIT);
  await Promise.all(
    head.map(async (item) => {
      const s = await readHeadSummary(item.path);
      Object.assign(item, s);
    }),
  );

  // project 是**全量**的（§12 Q3）：漏掉一个，它就掉进「未知项目」组，
  // 分组也就废了。所以这一趟不受 SUMMARY_LIMIT 限制，只受并发上限约束。
  await mapLimit(items, PROJECT_CONCURRENCY, async (item) => {
    item.project = await readProjectRef(item.path);
  });

  return { codexHome, sessionsDir, items };
}

/**
 * 有并发上限的 map。
 *
 * ★ 为什么不能直接 `Promise.all`
 *
 * head 摘要那一趟最多 60 个文件，随便并发；project 这一趟要摸**全部** 1000+ 个。
 * 实测：1000 个文件一次性 `fsp.open`，在 `ulimit -n 256`（macOS 的经典默认软上限）
 * 下有 **755 个直接 EMFILE 失败**。而 streamHeadLines 把 open 失败**静默吞掉**
 * （那是对的——一个坏文件不该毁掉整个列表），于是这 755 个会话会悄悄变成
 * 「未知项目」：不报错、不警告，只是分组莫名其妙地塌了一大半。
 *
 * 这种失败模式**在开发机上根本复现不了**（本机 ulimit -n 是 1048576，0 失败），
 * 所以必须在代码里就掐住，不能指望测出来。
 *
 * 32 也不牺牲速度——1000 个会话的 project 全量一趟实测：
 *   limit=8/16/32/64 都是 ~50ms，128 → ~55ms，**不设限（1000）反而 ~60ms**
 * （fd 一多，libuv 线程池排队 + 页缓存局部性变差）。限流是白拿的。
 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// ─────────────────────────────────────────────────────────────
// 文件头摘要
// ─────────────────────────────────────────────────────────────

export interface HeadSummary {
  model?: string;
  cwd?: string;
  cliVersion?: string;
  firstUser?: string;
}

/**
 * 流式按行读文件头：每次读 HEAD_CHUNK_BYTES，把**完整行**交给 `onLine`，
 * `onLine` 返回 true 即提前停止（拿齐了就不再读）。
 * 最多读到 `maxBytes` 为止；文件末尾没有换行时，最后那段也算一整行。
 *
 * 为什么必须流式：真实 rollout 的 model / 首条用户消息落在 ~100KB 处
 * （见 HEAD_CHUNK_BYTES 的注释），一刀切的固定窗口要么读不到、要么白读一堆巨行。
 *
 * 半行用 Buffer 缓存而不是 string 拼接——UTF-8 多字节字符会横跨两次读取。
 */
export async function streamHeadLines(
  file: string,
  onLine: (line: string) => boolean | void,
  maxBytes = HEAD_MAX_BYTES,
): Promise<void> {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    return; // 文件没了/没权限：摘要留空，不影响列表其余部分
  }
  try {
    const buf = Buffer.allocUnsafe(HEAD_CHUNK_BYTES);
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let pos = 0;

    /** 空行不算一行（与 readSession 的 E5 一致）；返回 true 表示该停了 */
    const emit = (line: string): boolean => (line.trim() === '' ? false : onLine(line) === true);

    while (pos < maxBytes) {
      const want = Math.min(HEAD_CHUNK_BYTES, maxBytes - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) {
        // EOF：末行没有换行符时，它也是一整行
        if (pending.byteLength > 0) emit(pending.toString('utf8'));
        return;
      }
      pos += bytesRead;

      let chunk: Buffer<ArrayBufferLike> = buf.subarray(0, bytesRead);
      if (pending.byteLength > 0) chunk = Buffer.concat([pending, chunk]);

      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start); // '\n'
        if (nl === -1) break;
        if (emit(chunk.subarray(start, nl).toString('utf8'))) return;
        start = nl + 1;
      }
      // 剩下的半行留到下一块。必须 copy：buf 会被下一次 read 覆写
      pending = Buffer.from(chunk.subarray(start));
    }
  } catch {
    // 读坏了就用已经拿到的部分，绝不让一个文件毁掉整个列表
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * 便于调试/测试：把文件头的完整行收集出来（受 maxBytes 限制）。
 * 生产路径走 readHeadSummary 的提前停止，不用这个。
 */
export async function readHead(file: string, maxBytes = HEAD_MAX_BYTES): Promise<string[]> {
  const lines: string[] = [];
  await streamHeadLines(file, (l) => void lines.push(l), maxBytes);
  return lines;
}

/**
 * 值得为它继续读下去吗？
 *
 * model 与 firstUser 是 F2 要显示的两个关键字段，也是最晚出现的两个
 * （session_meta 永远在第 1 行，cwd / cliVersion 跟着它一起到手）。
 * 这两个到齐就停——典型文件读到第 8 行、约 100KB。
 */
export function headSummaryComplete(s: HeadSummary): boolean {
  return s.model !== undefined && s.firstUser !== undefined;
}

/**
 * 把一行喂进摘要（**原地修改** out，返回是否已经可以停）。
 * 宽松解析（§3.4）：坏行跳过，字段缺失就留 undefined，绝不抛。
 */
export function accumulateHeadLine(out: HeadSummary, line: string): boolean {
  // 先做一次极便宜的子串预筛：AGENTS.md 注入那种 23 000 字符的巨行
  // 根本不含这些判别式，直接跳过，省掉整行 JSON.parse。
  // 误判（正文里恰好出现这些词）只是白解析一次，不影响正确性。
  if (
    !line.includes('session_meta') &&
    !line.includes('turn_context') &&
    !line.includes('user_message')
  ) {
    return false;
  }

  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return false; // 坏行不致命
  }
  if (!isRecord(rec)) return false;

  const topType = typeof rec.type === 'string' ? rec.type : '';
  const payload = isRecord(rec.payload) ? rec.payload : {};

  if (topType === 'session_meta') {
    out.cwd ??= str(payload.cwd);
    out.cliVersion ??= str(payload.cli_version);
  } else if (topType === 'turn_context') {
    out.model ??= str(payload.model);
    out.cwd ??= str(payload.cwd);
  } else if (topType === 'event_msg' && payload.type === 'user_message') {
    if (out.firstUser === undefined) {
      const msg = str(payload.message);
      // 脱敏用 shared/redact 的同一套规则（§9.1）——firstUser 不经过归一化层
      // 就直接进左栏，这里必须自己脱一次，但绝不能另写一套正则。
      if (msg !== undefined) out.firstUser = truncate(redactText(msg), FIRST_USER_MAX);
    }
  }

  return headSummaryComplete(out);
}

/** 从若干行里提取列表摘要（纯函数版，便于单测） */
export function summarizeHeadLines(lines: string[]): HeadSummary {
  const out: HeadSummary = {};
  for (const line of lines) {
    if (accumulateHeadLine(out, line)) break;
  }
  return out;
}

/** 流式读文件头生成摘要，拿齐 model + firstUser 立刻停止 */
export async function readHeadSummary(file: string): Promise<HeadSummary> {
  const out: HeadSummary = {};
  await streamHeadLines(file, (line) => accumulateHeadLine(out, line));
  return out;
}

// ─────────────────────────────────────────────────────────────
// 项目身份（§12 Q3）
// ─────────────────────────────────────────────────────────────

export interface ProjectFields {
  cwd?: string;
  repositoryUrl?: string;
}

/**
 * 从一行里取出 `payload.cwd` 与 `payload.git.repository_url`。
 *
 * ★ 为什么就是老老实实 JSON.parse（别再"优化"了）
 *
 * 顾虑是合理的：`session_meta` 实测 **22 150 字节**（8 份真实 rollout 一字节不差，
 * 大头是 `base_instructions`），1000 个会话 = 22 MB 的解析量，听起来很吓人。
 * 所以先测了，数字如下（M1 Mac，1000 个会话，见 §10.2 的 <1s 预算）：
 *
 * | 环节                        | 耗时   |
 * |-----------------------------|-------:|
 * | collectRolloutFiles（目录） |  ~5 ms |
 * | 最近 60 个的 head 摘要      | ~11 ms |
 * | **全部 1000 个的 project**  | **~51 ms** |
 * | **scanSessions 合计**       | **~70 ms** |
 *
 * 其中纯 CPU 的 JSON.parse 只占 **~17 ms / 1000 行**——V8 的 JSON.parse 是原生的，
 * 22 MB 对它不算什么，剩下 ~34 ms 全是 open/read 的 I/O，换任何解析方式都省不掉。
 *
 * 也就是说「从原始文本里定向抠 cwd / repository_url」最多省 17 ms（占预算 1.7%），
 * 代价却是要自己处理 JSON 字符串转义、还要提防 `base_instructions` 里出现同名子串。
 * **收益 1.7%、风险是静默读错分组键，不换。**
 * 哪天数据形状变了（比如 base_instructions 涨到 MB 级），先重跑这个基准再说。
 */
export function extractProjectFields(line: string): ProjectFields {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return {}; // 坏行不致命（§3.4）
  }
  if (!isRecord(rec)) return {};
  const payload = isRecord(rec.payload) ? rec.payload : {};
  const git = isRecord(payload.git) ? payload.git : {};
  return { cwd: str(payload.cwd), repositoryUrl: str(git.repository_url) };
}

/** 把一行喂进项目字段（**原地修改** out），返回是否已经可以停 */
export function accumulateProjectLine(out: ProjectFields, line: string): boolean {
  // 极便宜的子串预筛，同 accumulateHeadLine：真正贵的是万一第 1 行不是
  // session_meta，后面那些 ~100KB 的巨行会被白白 JSON.parse 一遍。
  if (!line.includes('cwd') && !line.includes('repository_url')) return false;

  const f = extractProjectFields(line);
  out.cwd ??= f.cwd;
  out.repositoryUrl ??= f.repositoryUrl;
  // cwd 到手就够了：cwd 和 git 在 session_meta 里是同一条记录，
  // 有 cwd 却没 git，说明这个会话本来就不在 git 仓库里，再往下读也不会有。
  return out.cwd !== undefined || out.repositoryUrl !== undefined;
}

/**
 * 读文件头推导项目身份（§12 Q3）。
 *
 * ⚠️ 与 readHeadSummary 不同，这个函数对**每一个**会话都要跑（不受 SUMMARY_LIMIT
 * 限制），所以它必须廉价：只读到第一条带 cwd 的记录（正常就是第 1 行）就停。
 */
export async function readProjectRef(file: string): Promise<ProjectRef> {
  const out: ProjectFields = {};
  await streamHeadLines(file, (line) => accumulateProjectLine(out, line), PROJECT_MAX_BYTES);
  return projectRef(out.cwd, out.repositoryUrl);
}

// ─────────────────────────────────────────────────────────────
// 读整个文件（验收 E4 / E5）
// ─────────────────────────────────────────────────────────────

export interface ReadSessionFileResult {
  path: string;
  lines: string[];
  size: number;
}

/**
 * 读整个文件，返回**已过滤空行**的原始行 + 字节数（验收 E4 / E5）。
 *
 * `size` 用的是实际读到的**字节数**，不是字符串长度——UTF-8 多字节会算错，
 * 而这个值是实时跟随的起点 offset，错一个字节后面全歪。
 * 用 buffer 长度而不是事后再 stat，是为了保证「返回的内容」与「offset」严格对应：
 * 读完之后文件又被追加了的话，stat 会比实际读到的多。
 */
export async function readSessionFile(file: string): Promise<ReadSessionFileResult> {
  const buf = await fsp.readFile(file);
  const lines = buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return { path: file, lines, size: buf.byteLength };
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}
