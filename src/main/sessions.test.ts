/**
 * M3 验收 · 主进程扫描与读取（SPEC §14.3 E1–E5）。
 *
 * 全部跑在 node 环境，**不起 Electron**——被测的是 sessions.ts 里那几个
 * 不依赖 electron 的函数，ipc.ts 只是它们的 `ipcMain.handle` 包装（§14.7）。
 *
 * E6（`window.require` / `window.process` 为 undefined）与
 * E7（`window.unroll` 恰好 8 个方法）**没法在 node 里测**——它们断言的是
 * 渲染进程里 contextIsolation + sandbox 的实际效果，需要真实的 Electron 窗口。
 * 由 §14.6 的端到端冒烟覆盖：`npm start` 后在 DevTools 控制台执行
 *   `typeof window.require === 'undefined' && typeof window.process === 'undefined'`
 *   `Object.keys(window.unroll).length === 8`
 * 本文件用一个静态断言守住 preload 侧的方法名集合（见文件末尾）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { UNKNOWN_PROJECT } from '../shared/project';
import {
  FIRST_USER_MAX,
  type HeadSummary,
  type ProjectFields,
  SUMMARY_LIMIT,
  accumulateHeadLine,
  accumulateProjectLine,
  collectRolloutFiles,
  extractProjectFields,
  headSummaryComplete,
  readHead,
  readHeadSummary,
  readProjectRef,
  readSessionFile,
  resolveCodexHome,
  scanSessions,
  sessionsDirOf,
  streamHeadLines,
  summarizeHeadLines,
} from './sessions';

// ─────────────────────────────────────────────────────────────
// 临时目录辅助
// ─────────────────────────────────────────────────────────────

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unroll-sessions-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** 造一个 rollout 文件，可指定 mtime（秒） */
function writeRollout(file: string, content: string, mtimeSec?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

const metaLine = (over: Record<string, unknown> = {}) =>
  line({
    timestamp: '2026-08-04T03:13:09.979Z',
    type: 'session_meta',
    payload: {
      session_id: 'sid-1',
      cwd: '/Users/dev/workspace/codex',
      cli_version: '0.0.0',
      model_provider: 'custom',
      ...over,
    },
  });

const turnLine = (model = 'deepseek-v4-flash') =>
  line({
    timestamp: '2026-08-04T03:13:09.989Z',
    type: 'turn_context',
    payload: { model, approval_policy: 'never', sandbox_policy: { type: 'read-only' } },
  });

const userLine = (message: string) =>
  line({
    timestamp: '2026-08-04T03:13:10.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });

/** 一份最小但结构真实的 rollout */
function sampleRollout(message = '创建 hello.txt'): string {
  return metaLine() + turnLine() + userLine(message);
}

// ─────────────────────────────────────────────────────────────
// E3 · CODEX_HOME
// ─────────────────────────────────────────────────────────────

describe('E3 · $CODEX_HOME 解析', () => {
  it('默认是 ~/.codex', () => {
    expect(resolveCodexHome({ HOME: '/Users/dev' })).toBe('/Users/dev/.codex');
  });

  it('尊重 CODEX_HOME 环境变量覆盖', () => {
    expect(resolveCodexHome({ HOME: '/Users/dev', CODEX_HOME: '/tmp/xyz' })).toBe('/tmp/xyz');
  });

  it('展开 ~ 并规范化相对路径', () => {
    expect(resolveCodexHome({ HOME: '/Users/dev', CODEX_HOME: '~/custom' })).toBe(
      '/Users/dev/custom',
    );
    expect(resolveCodexHome({ HOME: '/Users/dev', CODEX_HOME: '  ' })).toBe('/Users/dev/.codex');
  });

  it('sessionsDirOf 拼的是 §3.1 的 sessions 子目录', () => {
    expect(sessionsDirOf('/Users/dev/.codex')).toBe('/Users/dev/.codex/sessions');
  });

  it('scanSessions() 不传参时读 process.env.CODEX_HOME', async () => {
    const home = mkTmp();
    writeRollout(path.join(home, 'sessions', '2026', '08', '04', 'rollout-a.jsonl'), sampleRollout());
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const res = await scanSessions();
      expect(res.codexHome).toBe(home);
      expect(res.sessionsDir).toBe(path.join(home, 'sessions'));
      expect(res.items).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// E1 · 排序 / 布局
// ─────────────────────────────────────────────────────────────

describe('E1 · listSessions 按 mtime 倒序', () => {
  it('YYYY/MM/DD 嵌套布局按 mtime 从新到旧', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    writeRollout(path.join(dir, '2026/08/02/rollout-old.jsonl'), sampleRollout(), 1_000_000);
    writeRollout(path.join(dir, '2026/08/03/rollout-mid.jsonl'), sampleRollout(), 2_000_000);
    writeRollout(path.join(dir, '2026/08/04/rollout-new.jsonl'), sampleRollout(), 3_000_000);

    const { items } = await scanSessions(home);
    expect(items.map((i) => path.basename(i.path))).toEqual([
      'rollout-new.jsonl',
      'rollout-mid.jsonl',
      'rollout-old.jsonl',
    ]);
    expect(items[0].mtime).toBeGreaterThan(items[1].mtime);
    expect(items[1].mtime).toBeGreaterThan(items[2].mtime);
  });

  it('容忍扁平布局（文件直接躺在 sessions/ 下），并与嵌套布局混排', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    writeRollout(path.join(dir, 'rollout-flat.jsonl'), sampleRollout(), 5_000_000);
    writeRollout(path.join(dir, '2026/08/04/rollout-nested.jsonl'), sampleRollout(), 4_000_000);

    const { items } = await scanSessions(home);
    expect(items.map((i) => path.basename(i.path))).toEqual([
      'rollout-flat.jsonl',
      'rollout-nested.jsonl',
    ]);
  });

  it('忽略非 .jsonl 文件', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    writeRollout(path.join(dir, 'rollout-a.jsonl'), sampleRollout());
    writeRollout(path.join(dir, 'notes.md'), '# hi');
    writeRollout(path.join(dir, 'rollout-b.json'), '{}');

    const { items } = await scanSessions(home);
    expect(items).toHaveLength(1);
    expect(path.basename(items[0].path)).toBe('rollout-a.jsonl');
  });

  it('size 是真实字节数', async () => {
    const home = mkTmp();
    const f = writeRollout(path.join(home, 'sessions', 'rollout-a.jsonl'), sampleRollout());
    const { items } = await scanSessions(home);
    expect(items[0].size).toBe(fs.statSync(f).size);
  });
});

// ─────────────────────────────────────────────────────────────
// E2 · 目录不存在
// ─────────────────────────────────────────────────────────────

describe('E2 · sessions 目录不存在时不抛异常', () => {
  it('$CODEX_HOME 存在但没有 sessions 子目录 → 空数组', async () => {
    const home = mkTmp();
    const res = await scanSessions(home);
    expect(res.items).toEqual([]);
    expect(res.sessionsDir).toBe(path.join(home, 'sessions'));
  });

  it('$CODEX_HOME 整个都不存在 → 空数组', async () => {
    const res = await scanSessions('/definitely/not/a/real/path/xyzzy');
    expect(res.items).toEqual([]);
  });

  it('sessions 是个空目录 → 空数组', async () => {
    const home = mkTmp();
    fs.mkdirSync(path.join(home, 'sessions'));
    await expect(scanSessions(home)).resolves.toMatchObject({ items: [] });
  });

  it('collectRolloutFiles 对不存在的目录返回空数组', async () => {
    await expect(collectRolloutFiles('/nope/nope/nope')).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 文件头摘要（§10.2）
// ─────────────────────────────────────────────────────────────

describe('文件头摘要', () => {
  it('提取 model / cwd / cliVersion / firstUser', async () => {
    const home = mkTmp();
    writeRollout(path.join(home, 'sessions', 'rollout-a.jsonl'), sampleRollout('创建 hello.txt'));
    const { items } = await scanSessions(home);
    expect(items[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      cwd: '/Users/dev/workspace/codex',
      cliVersion: '0.0.0',
      firstUser: '创建 hello.txt',
    });
  });

  it('firstUser 截断到 120 字符，取的是第一条 user_message', () => {
    const long = 'x'.repeat(500);
    const s = summarizeHeadLines([
      metaLine().trim(),
      turnLine().trim(),
      userLine(long).trim(),
      userLine('第二条').trim(),
    ]);
    expect(s.firstUser).toHaveLength(FIRST_USER_MAX);
    expect(s.firstUser).toBe('x'.repeat(FIRST_USER_MAX));
  });

  it('firstUser 里的密钥被脱敏，只留尾 4 位（§9.1）', () => {
    const s = summarizeHeadLines([
      userLine('用这个 key sk-FAKEinline0000000000000000ef56 调接口').trim(),
    ]);
    expect(s.firstUser).toContain('sk-••••ef56');
    expect(s.firstUser).not.toContain('FAKEinline');
  });

  it('普通文本不受脱敏影响', () => {
    const s = summarizeHeadLines([userLine('帮我用这个 key 调接口').trim()]);
    expect(s.firstUser).toBe('帮我用这个 key 调接口');
  });

  it('坏行 / 空 payload / 缺字段都不崩（§3.4 宽松解析）', () => {
    expect(() =>
      summarizeHeadLines(['{not json', '{}', '[]', 'null', line({ type: 'session_meta' }).trim()]),
    ).not.toThrow();
    const s = summarizeHeadLines(['{not json', line({ type: 'weird_new_type', payload: {} }).trim()]);
    expect(s).toEqual({});
  });

  it('坏行之后的记录照常解析', () => {
    const s = summarizeHeadLines(['{broken', metaLine().trim(), turnLine('gpt-x').trim()]);
    expect(s.model).toBe('gpt-x');
    expect(s.cliVersion).toBe('0.0.0');
  });

  it('巨型行挡在前面也能拿到 model / firstUser（§10.1 的真实形状）', async () => {
    const home = mkTmp();
    // 模拟 skills_instructions + AGENTS.md 注入：两条各 ~100KB 的巨行挡在前面，
    // turn_context 与 user_message 排在它们之后 —— 这正是夹具 01/02 的形状。
    const giant = (n: number) =>
      line({ type: 'response_item', payload: { type: 'message', text: 'y'.repeat(n) } });
    const f = path.join(home, 'sessions', 'rollout-big.jsonl');
    writeRollout(
      f,
      metaLine() + giant(100_000) + giant(100_000) + turnLine() + userLine('巨行之后的第一句'),
    );

    const { items } = await scanSessions(home);
    expect(items[0].model).toBe('deepseek-v4-flash');
    expect(items[0].firstUser).toBe('巨行之后的第一句');
    expect(items[0].cwd).toBe('/Users/dev/workspace/codex');
  });

  it('拿齐 model + firstUser 立刻停止，后面的行根本不读', async () => {
    const home = mkTmp();
    const f = path.join(home, 'sessions', 'rollout-stop.jsonl');
    writeRollout(
      f,
      metaLine() +
        turnLine() +
        userLine('第一句') +
        line({ type: 'event_msg', payload: { type: 'agent_message', message: '不该被读到' } }) +
        line({ type: 'turn_context', payload: { model: '不该覆盖' } }),
    );

    const visited: string[] = [];
    const out: HeadSummary = {};
    await streamHeadLines(f, (l) => {
      visited.push(l);
      return accumulateHeadLine(out, l);
    });

    expect(visited).toHaveLength(3); // session_meta / turn_context / user_message
    expect(out.model).toBe('deepseek-v4-flash');
    expect(out.firstUser).toBe('第一句');
    expect(headSummaryComplete(out)).toBe(true);
  });

  it('maxBytes 兜底：超过上限就停，且不吐半行', async () => {
    const home = mkTmp();
    const f = path.join(home, 'sessions', 'rollout-cap.jsonl');
    const content = metaLine() + turnLine() + userLine('超出上限，读不到');
    writeRollout(f, content);

    const firstLineBytes = Buffer.byteLength(metaLine(), 'utf8');
    // 上限恰好落在第二行中间：只应拿到完整的第一行
    const head = await readHead(f, firstLineBytes + 20);
    expect(head).toHaveLength(1);
    expect(JSON.parse(head[0]).type).toBe('session_meta');

    // 上限为 0 → 什么都不读
    await expect(readHead(f, 0)).resolves.toEqual([]);
  });

  it('末行没有换行符时也不会被丢掉', async () => {
    const home = mkTmp();
    const f = path.join(home, 'sessions', 'rollout-nonewline.jsonl');
    // 结尾故意不带换行
    writeRollout(f, (metaLine() + turnLine() + userLine('末行无换行')).trimEnd());
    const { items } = await scanSessions(home);
    expect(items[0].firstUser).toBe('末行无换行');
  });

  it(`只对最近 ${SUMMARY_LIMIT} 个会话生成摘要，其余只给 path/mtime/size`, async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    const total = SUMMARY_LIMIT + 2;
    for (let i = 0; i < total; i++) {
      // mtime 越大越新：i=0 最新
      writeRollout(path.join(dir, `rollout-${i}.jsonl`), sampleRollout(), 9_000_000 - i * 100);
    }
    const { items } = await scanSessions(home);
    expect(items).toHaveLength(total);
    expect(items[0].model).toBe('deepseek-v4-flash');
    expect(items[SUMMARY_LIMIT - 1].model).toBe('deepseek-v4-flash');
    for (let i = SUMMARY_LIMIT; i < total; i++) {
      expect(items[i].model).toBeUndefined();
      expect(items[i].firstUser).toBeUndefined();
      expect(items[i].size).toBeGreaterThan(0);
      expect(items[i].mtime).toBeGreaterThan(0);
      expect(items[i].path).toContain('rollout-');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 真实夹具回归 · 防止文件头窗口再次退化
// ─────────────────────────────────────────────────────────────

/**
 * 哨兵测试。
 *
 * 起因：文件头一度是「固定读 64KB」，而真实 rollout 的 `turn_context`（带 model）
 * 落在 98 376 字节处、首条 `user_message` 落在 99 5xx 字节处——两份真实夹具
 * 的 model / firstUser 全是空，F2 要求的会话列表摘要一个都显示不出来。
 *
 * 这两条断言就是防线：**任何让文件头窗口变小的改动都会在这里挂掉。**
 */
describe('真实夹具的列表摘要（F2 回归哨兵）', () => {
  const fixtures = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../test/fixtures',
  );

  it.each([
    ['01-apply-patch-rejected.jsonl', '创建一个 hello.txt'],
    ['02-exec-command.jsonl', '列出当前目录下的文件'],
  ])('%s：model 与 firstUser 都拿得到', async (name, firstUserPrefix) => {
    const s = await readHeadSummary(path.join(fixtures, name));
    expect(s.model).toBe('deepseek-v4-flash');
    expect(s.cwd).toBe('/Users/dev/workspace/codex/codex-rs');
    expect(s.firstUser).toBeTruthy();
    expect(s.firstUser!.startsWith(firstUserPrefix)).toBe(true);
  });

  it('经由 scanSessions 走完整链路（含符号链接的会话目录）', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    // §14.6 冒烟用的就是 test/sessions -> fixtures 这种符号链接布局
    fs.symlinkSync(path.join(fixtures, '01-apply-patch-rejected.jsonl'), path.join(dir, 'a.jsonl'));
    fs.symlinkSync(path.join(fixtures, '02-exec-command.jsonl'), path.join(dir, 'b.jsonl'));

    const { items } = await scanSessions(home);
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.model).toBe('deepseek-v4-flash');
      expect(it.firstUser).toBeTruthy();
      expect(it.size).toBeGreaterThan(100_000);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 项目身份（§12 Q3）· 左栏分组的地基
// ─────────────────────────────────────────────────────────────

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');

/** 带 git 的 session_meta */
const gitMetaLine = (repositoryUrl: string, cwd = '/Users/dev/workspace/codex/codex-rs') =>
  metaLine({
    cwd,
    git: { commit_hash: '64bb8094', branch: 'main', repository_url: repositoryUrl },
  });

describe('项目身份 · 字段提取', () => {
  it('从 session_meta 里取 payload.cwd 与 payload.git.repository_url', () => {
    const f = extractProjectFields(gitMetaLine('https://github.com/openai/codex.git').trim());
    expect(f).toEqual({
      cwd: '/Users/dev/workspace/codex/codex-rs',
      repositoryUrl: 'https://github.com/openai/codex.git',
    });
  });

  it('没有 git 时只有 cwd', () => {
    expect(extractProjectFields(metaLine().trim())).toEqual({
      cwd: '/Users/dev/workspace/codex',
      repositoryUrl: undefined,
    });
  });

  it('坏行 / 非对象 / 缺 payload / git 不是对象都不抛（§3.4）', () => {
    for (const bad of [
      '{not json',
      '[]',
      'null',
      '"str"',
      '{}',
      line({ type: 'session_meta' }).trim(),
      line({ type: 'session_meta', payload: null }).trim(),
      line({ type: 'session_meta', payload: { git: 'nope' } }).trim(),
      line({ type: 'session_meta', payload: { cwd: '', git: { repository_url: '' } } }).trim(),
    ]) {
      expect(() => extractProjectFields(bad)).not.toThrow();
      expect(extractProjectFields(bad)).toEqual({ cwd: undefined, repositoryUrl: undefined });
    }
  });

  /**
   * ★ 哨兵：`base_instructions` 里塞了一段**长得像字段的字符串**。
   *
   * 实测 session_meta 有 22KB，其中绝大部分是 `base_instructions`。曾经考虑过
   * 「不整行 JSON.parse，直接从原始文本里抠 cwd / repository_url」来省解析开销
   * （实测只能省 ~17ms/1000 个，不划算，见 extractProjectFields 的注释）。
   * 这条测试就是那条路线的护栏：**任何基于子串搜索的实现都会在这里读到 /decoy。**
   * 分组键读错是静默的——列表照常显示，只是分到了错误的组，不会有任何报错。
   */
  it('base_instructions 里的同名子串骗不到它', () => {
    const decoy =
      'You are Codex. 举例：{"cwd":"/decoy/not/the/real/one","git":{"repository_url":"https://evil.example.com/decoy.git"}} 以上仅为示例。';
    const l = metaLine({
      base_instructions: decoy + 'x'.repeat(20_000),
      cwd: '/Users/dev/workspace/codex/codex-rs',
      git: { repository_url: 'https://github.com/openai/codex.git' },
    }).trim();

    expect(extractProjectFields(l)).toEqual({
      cwd: '/Users/dev/workspace/codex/codex-rs',
      repositoryUrl: 'https://github.com/openai/codex.git',
    });
  });

  it('accumulateProjectLine：拿到 cwd 就停，坏行不致命', () => {
    const out: ProjectFields = {};
    expect(accumulateProjectLine(out, '{broken')).toBe(false);
    expect(accumulateProjectLine(out, line({ type: 'response_item', payload: {} }).trim())).toBe(
      false,
    );
    expect(accumulateProjectLine(out, gitMetaLine('git@github.com:openai/codex.git').trim())).toBe(
      true,
    );
    expect(out.repositoryUrl).toBe('git@github.com:openai/codex.git');
  });
});

describe('项目身份 · readProjectRef', () => {
  it.each([
    ['01-apply-patch-rejected.jsonl'],
    ['02-exec-command.jsonl'],
  ])('%s → git:github.com/openai/codex', async (name) => {
    const p = await readProjectRef(path.join(FIXTURES, name));
    // ⚠️ 只断言 key / kind。label 是展示串，归 shared/project.ts 管；
    //    这里要守的是「分组键算对了」，不是它长什么样。
    expect(p).toMatchObject({ key: 'git:github.com/openai/codex', kind: 'git' });
  });

  it('夹具 01 与 02 的 project.key 完全相等（cwd 相同也不能靠 cwd）', async () => {
    const a = await readProjectRef(path.join(FIXTURES, '01-apply-patch-rejected.jsonl'));
    const b = await readProjectRef(path.join(FIXTURES, '02-exec-command.jsonl'));
    expect(a.key).toBe(b.key);
    expect(a.key).toBe('git:github.com/openai/codex');
  });

  it('夹具 03 → git:example.com/x', async () => {
    const p = await readProjectRef(path.join(FIXTURES, '03-edge-cases.jsonl'));
    expect(p).toMatchObject({ key: 'git:example.com/x', kind: 'git' });
  });

  it('无 git 信息 → 退回 dir: 键', async () => {
    const home = mkTmp();
    const f = writeRollout(path.join(home, 'rollout-nogit.jsonl'), sampleRollout());
    expect(await readProjectRef(f)).toMatchObject({
      key: 'dir:/Users/dev/workspace/codex',
      kind: 'dir',
    });
  });

  it('cwd 与 git 都没有 → UNKNOWN_PROJECT，且不抛', async () => {
    const home = mkTmp();
    const f = writeRollout(
      path.join(home, 'rollout-bare.jsonl'),
      line({ type: 'session_meta', payload: { session_id: 'x' } }) + turnLine(),
    );
    expect(await readProjectRef(f)).toEqual(UNKNOWN_PROJECT);
  });

  it('文件不存在 / 空文件 → UNKNOWN_PROJECT', async () => {
    const home = mkTmp();
    expect(await readProjectRef(path.join(home, 'nope.jsonl'))).toEqual(UNKNOWN_PROJECT);
    const empty = writeRollout(path.join(home, 'empty.jsonl'), '');
    expect(await readProjectRef(empty)).toEqual(UNKNOWN_PROJECT);
  });

  /**
   * 同一仓库、不同子目录起的会话必须落进同一组——这正是「不用 cwd 当键」的理由
   * （实测 cwd=/Users/dev/workspace/codex/codex-rs，仓库却是 openai/codex）。
   */
  it('同仓库不同子目录 / 不同 URL 写法 → 同一个 key', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    writeRollout(
      path.join(dir, 'a.jsonl'),
      gitMetaLine('https://github.com/openai/codex.git', '/Users/dev/workspace/codex/codex-rs'),
    );
    writeRollout(
      path.join(dir, 'b.jsonl'),
      gitMetaLine('git@github.com:openai/codex.git', '/Users/dev/workspace/codex/codex-cli'),
    );
    writeRollout(
      path.join(dir, 'c.jsonl'),
      gitMetaLine('https://github.com/openai/codex', '/Users/dev/workspace/codex'),
    );

    const { items } = await scanSessions(home);
    const keys = new Set(items.map((i) => i.project?.key));
    expect(items).toHaveLength(3);
    expect([...keys]).toEqual(['git:github.com/openai/codex']);
  });
});

describe('项目身份 · scanSessions 全量填充', () => {
  it('每一项都有 project（含超出摘要上限的那些）', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    const total = SUMMARY_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      writeRollout(
        path.join(dir, `rollout-${String(i).padStart(3, '0')}.jsonl`),
        gitMetaLine('https://github.com/openai/codex.git') + turnLine() + userLine(`第 ${i} 句`),
        9_000_000 - i * 100, // i=0 最新
      );
    }

    const { items } = await scanSessions(home);
    expect(items).toHaveLength(total);

    // ★ 哨兵：project 与 model/firstUser **不同级别**。
    //   一旦有人图省事把 project 并进那一趟「只做最近 60 个」的摘要，
    //   第 61 个往后就会全部掉进「未知项目」组，左栏分组直接废掉。
    for (const it of items) {
      expect(it.project).toMatchObject({ key: 'git:github.com/openai/codex', kind: 'git' });
    }
    // 同时确认 model / firstUser 的范围**没有**被顺手放大
    expect(items[SUMMARY_LIMIT - 1].model).toBe('deepseek-v4-flash');
    expect(items[SUMMARY_LIMIT - 1].firstUser).toBeTruthy();
    for (let i = SUMMARY_LIMIT; i < total; i++) {
      expect(items[i].model).toBeUndefined();
      expect(items[i].firstUser).toBeUndefined();
      expect(items[i].project?.key).toBe('git:github.com/openai/codex');
    }
  });

  it('混合项目：每一项的 project 各归各的', async () => {
    const home = mkTmp();
    const dir = path.join(home, 'sessions');
    writeRollout(path.join(dir, 'a.jsonl'), gitMetaLine('https://github.com/openai/codex.git'), 300);
    writeRollout(path.join(dir, 'b.jsonl'), sampleRollout(), 200); // 无 git
    writeRollout(path.join(dir, 'c.jsonl'), line({ type: 'session_meta', payload: {} }), 100);

    const { items } = await scanSessions(home);
    expect(items.map((i) => i.project?.key)).toEqual([
      'git:github.com/openai/codex',
      'dir:/Users/dev/workspace/codex',
      '',
    ]);
    expect(items.map((i) => i.project?.kind)).toEqual(['git', 'dir', 'unknown']);
  });
});

/**
 * §10.2 性能预算：1000+ 个会话，启动 <1s。
 *
 * project 是**全量**的一趟（1000 个文件都要摸），是这里最贵的一环，所以拿它当哨兵。
 * 本机实测（M1、页缓存已热）：
 *   collectRolloutFiles ~5ms · 最近 60 个 head 摘要 ~11ms · 全量 project ~51ms
 *   → scanSessions 合计 **~70ms**（1000 个 104KB 会话）
 * 断言给到 1000ms，是本机数字的 14 倍——CI 抖动、冷缓存都还有余量，
 * 但任何**量级**上的退化（比如误改成每个文件整份读进内存）都会在这里挂掉。
 */
describe('§10.2 · 1000 个会话的扫描耗时', () => {
  it('scanSessions 在 1s 内返回，且 1000 项全都有 project', async () => {
    const home = mkTmp();
    const src = path.join(FIXTURES, '01-apply-patch-rejected.jsonl');
    const N = 1000;
    // 真实布局是 sessions/YYYY/MM/DD/；用符号链接指向 104KB 的真实夹具，
    // 既拿到真实的文件形状（22KB 的 session_meta），又不用写 100MB 到磁盘。
    for (let i = 0; i < N; i++) {
      const d = path.join(home, 'sessions', '2026', '08', String((i % 28) + 1).padStart(2, '0'));
      fs.mkdirSync(d, { recursive: true });
      fs.symlinkSync(src, path.join(d, `rollout-${String(i).padStart(4, '0')}.jsonl`));
    }

    const t0 = performance.now();
    const { items } = await scanSessions(home);
    const elapsed = performance.now() - t0;

    expect(items).toHaveLength(N);
    expect(items.every((i) => i.project?.key === 'git:github.com/openai/codex')).toBe(true);
    // 摘要仍然只做最近 60 个
    expect(items.filter((i) => i.model !== undefined)).toHaveLength(SUMMARY_LIMIT);
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────
// E4 / E5 · readSession
// ─────────────────────────────────────────────────────────────

describe('E4 · readSession 的 size 是文件字节数', () => {
  it('UTF-8 多字节内容下 size === fs.stat().size，且不等于字符数', async () => {
    const home = mkTmp();
    const content = userLine('中文内容——多字节，字符数少于字节数') + userLine('第二行');
    const f = writeRollout(path.join(home, 'rollout-utf8.jsonl'), content);

    const res = await readSessionFile(f);
    expect(res.size).toBe(fs.statSync(f).size);
    expect(res.size).toBe(Buffer.byteLength(content, 'utf8'));
    // 这正是「不能用字符串长度」的原因
    expect(res.size).toBeGreaterThan(content.length);
    expect(res.path).toBe(f);
  });

  it('size 可直接当跟随起点：从它开始读到的就是后续追加的内容', async () => {
    const home = mkTmp();
    const f = writeRollout(path.join(home, 'rollout-off.jsonl'), userLine('第一行中文'));
    const { size } = await readSessionFile(f);
    fs.appendFileSync(f, userLine('追加行'));

    const fd = fs.openSync(f, 'r');
    const st = fs.statSync(f);
    const buf = Buffer.allocUnsafe(st.size - size);
    fs.readSync(fd, buf, 0, buf.length, size);
    fs.closeSync(fd);
    expect(buf.toString('utf8')).toBe(userLine('追加行'));
  });

  it('空文件 → size 0，lines 为空', async () => {
    const home = mkTmp();
    const f = writeRollout(path.join(home, 'rollout-empty.jsonl'), '');
    await expect(readSessionFile(f)).resolves.toMatchObject({ size: 0, lines: [] });
  });
});

describe('E5 · readSession 的 lines 已过滤空行', () => {
  it('空行与纯空白行都不产生条目', async () => {
    const home = mkTmp();
    const content = `${metaLine()}\n${turnLine()}   \n\n${userLine('hi')}\n`;
    const f = writeRollout(path.join(home, 'rollout-blank.jsonl'), content);

    const res = await readSessionFile(f);
    expect(res.lines).toHaveLength(3);
    expect(res.lines.every((l) => l.trim() !== '')).toBe(true);
    expect(JSON.parse(res.lines[0]).type).toBe('session_meta');
    expect(JSON.parse(res.lines[2]).payload.type).toBe('user_message');
    // 过滤空行不影响 size —— size 仍是文件真实字节数
    expect(res.size).toBe(fs.statSync(f).size);
  });

  it('读真实夹具：行数与 §14.1 一致，且 size 等于文件字节数', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixture = path.resolve(here, '../../test/fixtures/01-apply-patch-rejected.jsonl');
    const res = await readSessionFile(fixture);
    expect(res.lines).toHaveLength(19);
    expect(res.size).toBe(fs.statSync(fixture).size);
  });
});

// ─────────────────────────────────────────────────────────────
// E7 的可测部分
// ─────────────────────────────────────────────────────────────

describe('E7 · IPC 通道集合', () => {
  it('§7.3 的 8 个方法各有一个通道名，无重复', async () => {
    const { IPC } = await import('../shared/types');
    const names = Object.values(IPC);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });

  // 真正的 E7（`Object.keys(window.unroll).length === 8`）与 E6
  // （window.require / window.process 为 undefined）需要真实渲染进程，
  // 见本文件头部说明，由 §14.6 端到端冒烟覆盖。
});
