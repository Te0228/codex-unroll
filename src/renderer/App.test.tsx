// @vitest-environment jsdom
/**
 * M4 验收（SPEC §14.4 F1–F24）+ M5 渲染侧（G1）。
 *
 * 数据一律来自 test/fixtures/ 的三份真实夹具，喂给 shared/rollout 的 toEntries，
 * 期望值是 §14 的实测确切数字，不接受「看起来对」。
 * window.unroll（主进程 IPC）在这里 mock 掉——它是另一条实现线。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnrollAPI } from '../shared/types';
import { App } from './App';
import { DETAIL_TRUNCATE, ROW_PREVIEW_MAX } from './format';
import { VIEW_KEY } from './hooks/useViewMode';

// jsdom 环境下 import.meta.url 的 base 不可靠，直接用 vitest 的 cwd（仓库根）
const fx = (name: string) => join(process.cwd(), 'test/fixtures', name);
const F01 = fx('01-apply-patch-rejected.jsonl');
const F02 = fx('02-exec-command.jsonl');
const F03 = fx('03-edge-cases.jsonl');

const SESSIONS_DIR = '/Users/dev/.codex/sessions';

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

let api: UnrollAPI;
let appendCb: ((p: { path: string; lines: string[] }) => void) | null = null;
let resetCb: ((p: { path: string }) => void) | null = null;

beforeEach(() => {
  appendCb = null;
  resetCb = null;
  /**
   * ★ 本文件的 F 组断言测的是**列表**视图——「19 条 = 19 行」这类等式只在列表下成立。
   * 主区默认视图已改为「图」（§6.8），图里 token_count 走块尾、task_complete 走 Turn 尾，
   * 都不是 .row，行数自然对不上。所以这里显式切回列表，不是为了让测试变绿，
   * 而是让每条断言测的仍然是它当初要测的那个东西。
   * 图视图另有一组断言，见 components/StepGraph.test.tsx。
   */
  localStorage.setItem(VIEW_KEY, 'list');
  // jsdom 不实现 scrollIntoView，F19 靠这个 spy 验证
  Element.prototype.scrollIntoView = vi.fn();
  api = {
    listSessions: vi.fn().mockResolvedValue({
      codexHome: '/Users/dev/.codex',
      sessionsDir: SESSIONS_DIR,
      items: [
        { path: F01, mtime: 1754277189000, size: 106496, model: 'deepseek-v4-flash', firstUser: '创建一个 hello.txt，内容写 hi' },
        { path: F02, mtime: 1754270000000, size: 114688, model: 'deepseek-v4-flash', firstUser: '看看 codex-rs 有几个 crate' },
        { path: F03, mtime: 1754260000000, size: 28672, model: 'test-model', firstUser: '边界用例' },
      ],
    }),
    readSession: vi.fn(async (path: string) => ({
      path,
      lines: readLines(path),
      size: readFileSync(path).byteLength,
    })),
    watchSession: vi.fn().mockResolvedValue({ ok: true }),
    unwatchSession: vi.fn().mockResolvedValue(undefined),
    onAppend: vi.fn((cb) => {
      appendCb = cb;
      return () => {};
    }),
    onReset: vi.fn((cb) => {
      resetCb = cb;
      return () => {};
    }),
    openFileDialog: vi.fn().mockResolvedValue(null),
    revealInFinder: vi.fn().mockResolvedValue(undefined),
  } as unknown as UnrollAPI;
  window.unroll = api;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** 渲染 App 并从左栏打开一份夹具 */
async function open(path = F01) {
  const view = render(<App />);
  const items = await screen.findAllByTestId('session-item');
  const item = items.find((el) => (el as HTMLElement).dataset.path === path);
  if (!item) throw new Error(`会话列表里没有 ${path}`);
  fireEvent.click(item);
  await screen.findAllByTestId('row');
  return view;
}

const rows = () => screen.getAllByTestId('row');
const rowAt = (index: number) => {
  const el = rows().find((r) => (r as HTMLElement).dataset.index === String(index));
  if (!el) throw new Error(`时间线上没有索引 ${index}`);
  return el;
};

// ═══════════════════════════════════════════════════════════════════
describe('时间线（§6.1 / §6.2）', () => {
  it('F1 · 打开 01 号夹具渲染 19 行', async () => {
    await open();
    expect(rows()).toHaveLength(19);
  });

  it('F1b · 02 号 17 行 / 03 号 13 行（03 的 14 行里有 1 个空行被过滤）', async () => {
    await open(F02);
    expect(rows()).toHaveLength(17);
    cleanup();
    await open(F03);
    expect(rows()).toHaveLength(13);
  });

  /**
   * ⚠️ F2 原文是「取所有 .row 的 offsetHeight，new Set(...).size === 1」。
   *    jsdom 不做布局，offsetHeight 恒为 0——那个断言在这里恒真、零价值。
   *    这里退一步断言「行结构完全一致 + 高度由 CSS 钉死」，
   *    真正的等高由 styles/global.css.test.ts 查规则，
   *    并在 §14.6 端到端冒烟时用 DevTools 目视复核一次。
   */
  it('F2 · 所有行结构一致，高度不由内容决定', async () => {
    await open();
    const all = rows();
    // 未选中时每一行的 class 完全相同（唯一变量是 .selected）
    expect(new Set(all.map((r) => r.className)).size).toBe(1);
    // 每行的列数固定：序号/时间/符号/类型/标题/摘要
    for (const r of all) expect(r.children).toHaveLength(6);
  });

  it('F3 · 巨型条目仍只占一行：行内文本压成单行且有长度上限', async () => {
    await open();
    const previews = rows().map((r) => r.querySelector('.row-preview')!.textContent ?? '');
    // 换行符会在 nowrap 下依然产生断行，必须在数据进 DOM 前就折掉
    for (const p of previews) {
      expect(p).not.toContain('\n');
      expect(p.length).toBeLessThanOrEqual(ROW_PREVIEW_MAX + 1);
    }
    // 且这确实是「巨型条目」的场景：至少有一条原始正文远超一行能显示的量
    const longest = Math.max(...previews.map((p) => p.length));
    expect(longest).toBe(ROW_PREVIEW_MAX + 1);
  });

  it('F2/F3 补充 · 每行都带符号 + 中文类型列（F21 灰度可辨识的载体）', async () => {
    await open();
    for (const r of rows()) {
      expect(r.querySelector('.row-symbol')!.textContent).toMatch(/[●○▶⚠·]/);
      expect(r.querySelector('.row-kind')!.textContent).toHaveLength(2);
    }
  });
});

describe('顶部状态条（§6.1 / F4 / F5 / F8）', () => {
  it('F4 · 只显示 model · approval · sandbox 三个值', async () => {
    await open();
    const meta = screen.getByTestId('statusbar-meta');
    expect(meta.textContent).toContain('deepseek-v4-flash');
    expect(meta.textContent).toContain('never');
    expect(meta.textContent).toContain('read-only');
  });

  it('F4b · 状态条里没有 provider / effort / 耗时 / token —— 它们属于详情面板（F8）', async () => {
    await open();
    const bar = screen.getByTestId('statusbar').textContent ?? '';
    expect(bar).not.toContain('custom'); // provider
    expect(bar).not.toContain('high'); // effort
    expect(bar).not.toContain('14058'); // durationMs
    expect(bar).not.toContain('34188'); // inputTokens
  });

  it('F5 · 不存在摘要卡片区（旧设计已废除）', async () => {
    const { container } = await open();
    expect(container.querySelector('.cards')).toBeNull();
    expect(container.querySelector('[class*="card"]')).toBeNull();
  });

  /**
   * §12 Q3：左栏组头能回答「这是哪个仓库」，但 ⌘1 一折叠就没了，
   * 所以状态条也要挂项目身份。
   */
  it('状态条显示当前会话的项目 label（git 远端优先于 cwd）', async () => {
    await open();
    const proj = screen.getByTestId('statusbar-project');
    // 01 号夹具：cwd=/Users/dev/workspace/codex/codex-rs，
    // repository_url=https://github.com/openai/codex.git → 认仓库而不是目录
    expect(proj.textContent).toContain('openai/codex');
    expect(screen.getByTestId('statusbar-branch').textContent).toContain('main');
  });

  it('状态条项目的 title 挂完整 cwd（用户要看实际目录）', async () => {
    await open();
    expect(screen.getByTestId('statusbar-project').getAttribute('title')).toContain(
      '/Users/dev/workspace/codex/codex-rs',
    );
  });

  it('⌘1 折掉左栏后，项目身份仍然看得到', async () => {
    await open();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(screen.queryByTestId('session-list')).toBeNull();
    expect(screen.getByTestId('statusbar-project').textContent).toContain('openai/codex');
  });

  it('未打开文件时不渲染项目段，也不出现 undefined', async () => {
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(screen.queryByTestId('statusbar-project')).toBeNull();
    expect(screen.getByTestId('statusbar').textContent).not.toContain('undefined');
  });

  it('summary 缺 cwd / repositoryUrl 时显示「未知项目」而不是 undefined', async () => {
    // 只有 session_meta 之外的行 → summary 里没有 cwd / git
    (api.readSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/tmp/bare.jsonl',
      lines: [JSON.stringify({ timestamp: '', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })],
      size: 10,
    });
    const view = render(<App />);
    const items = await screen.findAllByTestId('session-item');
    await act(async () => {
      fireEvent.click(items[0]);
    });
    const proj = await screen.findByTestId('statusbar-project');
    expect(proj.textContent).toContain('未知项目');
    expect(view.container.textContent).not.toContain('undefined');
  });

  it('F8 · provider/effort/耗时/token 在「选中会话头条目」时于详情面板展示', async () => {
    await open();
    fireEvent.click(rowAt(0));
    const body = screen.getByTestId('detail-body').textContent ?? '';
    expect(body).toContain('custom'); // provider
    expect(body).toContain('high'); // effort
    expect(body).toContain('14.06s'); // durationMs 14058
    expect(body).toContain('3.94s'); // ttftMs 3936
    expect(body).toContain('34188 in / 263 out');
  });
});

describe('详情面板（§6.1 / F6–F13）', () => {
  it('F6 · 初始不渲染详情面板，时间线占满宽度', async () => {
    await open();
    expect(screen.queryByTestId('detail-panel')).toBeNull();
    expect(screen.getByTestId('shell-body').className).not.toContain('has-panel');
  });

  it('F7 · 点索引 11 → 面板出现，标题是 apply_patch', async () => {
    await open();
    fireEvent.click(rowAt(11));
    expect(screen.getByTestId('detail-panel')).toBeTruthy();
    expect(screen.getByTestId('detail-title').textContent).toContain('apply_patch');
    expect(screen.getByTestId('shell-body').className).toContain('has-panel');
  });

  it('F8 · 面板正文以 *** Begin Patch 开头', async () => {
    await open();
    fireEvent.click(rowAt(11));
    expect(screen.getByTestId('detail-content').textContent!.trim()).toMatch(/^\*\*\* Begin Patch/);
  });

  it('F8b · 另一条工具路径（02 的 function_call）正文是二次解析后的对象，不是转义字符串', async () => {
    await open(F02);
    fireEvent.click(rowAt(9));
    const text = screen.getByTestId('detail-content').textContent ?? '';
    expect(screen.getByTestId('detail-title').textContent).toContain('exec_command');
    expect(text).not.toContain('\\"'); // 没有残留的转义引号
    expect(text).toContain('\n'); // 已格式化成多行
  });

  it('F9 · 「原始 JSON」段默认折叠', async () => {
    await open();
    fireEvent.click(rowAt(11));
    const toggle = screen.getByTestId('rawjson-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('rawjson-body')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('rawjson-body').textContent).toContain('call_00_VGd9DAeHsvuuvIgL2BSM1663');
  });

  it('F9b · 换一条时原始 JSON 重新折叠（每次下钻都从摘要开始）', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    fireEvent.click(rowAt(12));
    expect(screen.getByTestId('rawjson-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('F10 · Esc 关闭面板', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });

  it('F10b · 再点同一条也关闭', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.click(rowAt(11));
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });

  it('F10c · 关闭按钮也关闭', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.click(screen.getByLabelText('关闭详情面板'));
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });

  it('F11 · 面板有拖拽把手（钳制逻辑见 hooks.test）', async () => {
    await open();
    fireEvent.click(rowAt(11));
    const handle = screen.getByTestId('panel-resizer');
    expect(handle.getAttribute('role')).toBe('separator');
    fireEvent.pointerDown(handle, { clientX: 900 });
    // 宽度写在 :root 的自定义属性上，不是行内 style（CSP）
    expect(document.documentElement.style.getPropertyValue('--panel-w')).toMatch(/^\d+px$/);
  });

  it('F12 · 超大内容默认截断 ~2000 字符 + 「展开全部」（§10.2）', async () => {
    await open(F03);
    const big = rows().find(
      (r) => Number((r as HTMLElement).dataset.index) === 7,
    )!;
    fireEvent.click(big);
    const content = screen.getByTestId('detail-content');
    expect(content.textContent!.length).toBe(DETAIL_TRUNCATE);
    const expand = screen.getByTestId('expand-all');
    fireEvent.click(expand);
    expect(screen.getByTestId('detail-content').textContent!.length).toBeGreaterThan(8000);
  });

  it('F12b · 小条目不出现「展开全部」——它只是截断阈值开关，不是常驻的第三层', async () => {
    await open();
    fireEvent.click(rowAt(11)); // 正文 58 字符
    expect(screen.queryByTestId('expand-all')).toBeNull();
  });

  /**
   * F13 的原始断言是「面板里 aria-expanded 的元素恰好 1 个」。
   * JSON 树视图会引入大量 aria-expanded 节点，所以断言改成
   * 「详情面板里**顶层的**可折叠区段恰好 1 个」（打了 data-drill 标记的那个）。
   *
   * ⚠️ 这不是放水。下钻层级数的是「时间线选中 → 详情面板 + 原始 JSON」这两跳；
   *    树内部的展开是「原始 JSON」这一层内部的导航，性质等同于时间线内部可以滚动。
   *    下面显式断言：所有非顶层的 aria-expanded 节点都在 rawjson-body 里面，
   *    也就是说面板里确实没有第三个独立的下钻区段。
   */
  it('F13 · 下钻恰好两层：详情面板里顶层可折叠区段只有「原始 JSON」一个', async () => {
    const { container } = await open();
    for (const r of rows()) expect(r.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(rowAt(11));

    const drills = () => [...container.querySelectorAll('.detail [data-drill]')];
    expect(drills()).toHaveLength(1);
    expect((drills()[0] as HTMLElement).dataset.testid).toBe('rawjson-toggle');

    // 展开原始 JSON：顶层区段数**不变**，新增的 aria-expanded 全在树内部
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    expect(drills()).toHaveLength(1);
    const inner = [...container.querySelectorAll('.detail [aria-expanded]')].filter(
      (el) => (el as HTMLElement).dataset.drill == null,
    );
    expect(inner.length).toBeGreaterThan(0);
    for (const el of inner) {
      expect(el.closest('[data-testid="rawjson-body"]')).not.toBeNull();
    }
  });
});

describe('过滤 / 搜索 / 导航（§6.3 / §6.5）', () => {
  it('F14 · 底部状态栏按 6 组显示，01 号夹具计数 = 输入6 思考2 行动2 输出4 元信息5 异常0', async () => {
    await open();
    const count = (g: string) => Number(screen.getByTestId(`group-${g}`).dataset.count);
    expect(count('input')).toBe(6);
    expect(count('think')).toBe(2);
    expect(count('act')).toBe(2);
    expect(count('output')).toBe(4);
    expect(count('meta')).toBe(5);
    expect(count('error')).toBe(0);
    // 合计必须等于条目总数
    expect(['input', 'think', 'act', 'output', 'meta', 'error'].reduce((s, g) => s + count(g), 0)).toBe(19);
    expect(screen.getByTestId('entry-count').textContent).toBe('19 条');
  });

  it('F14b · 分组顺序即 GROUPS 的顺序', async () => {
    await open();
    const labels = Array.from(screen.getByTestId('filterbar').querySelectorAll('.fb-group')).map(
      (b) => b.textContent,
    );
    expect(labels.map((l) => l!.replace(/[●○▶⚠·\d]/g, ''))).toEqual([
      '输入', '思考', '行动', '输出', '元信息', '异常',
    ]);
  });

  it('F15 · 只勾「行动」后剩 2 条（tool_call 1 + tool_out 1）', async () => {
    await open();
    for (const g of ['input', 'think', 'output', 'meta', 'error']) {
      fireEvent.click(screen.getByTestId(`group-${g}`));
    }
    const left = rows();
    expect(left).toHaveLength(2);
    expect(left.map((r) => (r as HTMLElement).dataset.kind)).toEqual(['tool_call', 'tool_out']);
    // 计数不随过滤变化——否则关掉一组后就没法判断该不该再打开它
    expect(screen.getByTestId('group-input').dataset.count).toBe('6');
    expect(screen.getByTestId('entry-count').textContent).toBe('2 / 19 条');
  });

  it('F15b · 过滤掉的组可以再点回来', async () => {
    await open();
    fireEvent.click(screen.getByTestId('group-input'));
    expect(rows()).toHaveLength(13);
    fireEvent.click(screen.getByTestId('group-input'));
    expect(rows()).toHaveLength(19);
  });

  /**
   * ⚠️ SPEC F16 写的是「搜 rejected 命中 1 条（索引 12）」，**实测是 2 条**。
   *    01 号夹具第 3 行（developer 的 <permissions instructions>）里有一句
   *    "commands will be rejected."，它在 preview 和 rawPretty 里都在。
   *    而 F7 要求搜索范围含原始 JSON、F17/B10 又要求搜尾 4 位能命中
   *    只存在于 rawPretty 的 key——两条合起来决定了 rejected 必然命中 2 条。
   *    这里断言实测值，并额外断言 F16 真正关心的那条（索引 12）在结果里。
   */
  it('F16 · 搜 rejected 命中工具结果那条', async () => {
    await open();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'rejected' } });
    const hit = rows().map((r) => Number((r as HTMLElement).dataset.index));
    expect(hit).toContain(12);
    expect(hit).toEqual([2, 12]); // ← 实测；SPEC 写的 1 条与夹具不符，见上方注释
  });

  it('F16b · 搜 call_id 能把 function_call 与 function_call_output 一起捞出来（S4 场景）', async () => {
    await open();
    fireEvent.change(screen.getByTestId('search'), {
      target: { value: 'call_00_VGd9DAeHsvuuvIgL2BSM1663' },
    });
    expect(rows().map((r) => Number((r as HTMLElement).dataset.index))).toEqual([11, 12]);
  });

  it('F17 · 搜 ab12（03 号夹具）命中脱敏后的 key，且命中的是 session_meta 那条', async () => {
    await open(F03);
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'ab12' } });
    const hits = rows();
    expect(hits).toHaveLength(1);
    expect((hits[0] as HTMLElement).dataset.kind).toBe('session');
    fireEvent.click(hits[0]);
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    expect(screen.getByTestId('rawjson-body').textContent).toContain('••••ab12');
  });

  it('F17b · 搜不到时给空态提示，不是白屏', async () => {
    await open();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'zzz-no-such-thing' } });
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
    expect(screen.getByTestId('timeline').textContent).toContain('没有匹配的条目');
  });

  it('F18 · j / k 切换选中，详情面板同步更新', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('detail-panel')).toBeTruthy();
    expect(rowAt(0).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('detail-title').textContent).toContain('会话开始');

    fireEvent.keyDown(window, { key: 'j' });
    expect(rowAt(1).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('detail-title').textContent).toContain('任务开始');

    fireEvent.keyDown(window, { key: 'k' });
    expect(rowAt(0).getAttribute('aria-selected')).toBe('true');
  });

  it('F18b · ↑ / ↓ 与 j / k 等价', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(rowAt(1).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(rowAt(0).getAttribute('aria-selected')).toBe('true');
  });

  it('F18c · 在搜索框里打字时 j / k 不劫持按键', async () => {
    await open();
    const search = screen.getByTestId('search') as HTMLInputElement;
    fireEvent.keyDown(search, { key: 'j' });
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });

  it('F18d · 过滤后 j / k 只在可见条目间移动', async () => {
    await open();
    for (const g of ['input', 'think', 'output', 'meta', 'error']) {
      fireEvent.click(screen.getByTestId(`group-${g}`));
    }
    fireEvent.keyDown(window, { key: 'j' });
    expect(rowAt(11).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(window, { key: 'j' });
    expect(rowAt(12).getAttribute('aria-selected')).toBe('true');
  });

  it('F19 · 选中项滚入视口', async () => {
    await open();
    fireEvent.click(rowAt(11));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  /**
   * ★ F14 互跳的接线回归（§6.9.1）。
   *
   * 这一条不是「功能能用吗」，而是**一个具体的坑**：
   * `useSelection.selected` 是从 `visible` 里 find 出来的，而面板的显示条件是
   * `selected != null`。所以「跳到一个当前被搜索过滤掉的对家」如果直接
   * `selection.select(index)`，结果是 selectedIndex 设上了、selected 却是 null
   * → **面板当场关掉**，用户看到「点了跳转，面板没了」。
   *
   * 触发路径很短：夹具 01 搜 `rejected` 命中索引 12（工具结果），
   * 而它的调用方索引 11 不含这个词。
   */
  describe('F14b · 跳到被过滤掉的对家时，面板必须还在', () => {
    it('搜索把调用方过滤掉了，点「跳到调用」仍能打开它', async () => {
      await open();
      // 先搜 rejected：命中索引 12，索引 11 被滤掉
      fireEvent.change(screen.getByTestId('search'), { target: { value: 'rejected' } });
      await waitFor(() => expect(rows().some((r) => r.dataset.index === '12')).toBe(true));
      expect(rows().some((r) => r.dataset.index === '11')).toBe(false);

      fireEvent.click(rowAt(12));
      const jump = await screen.findByTestId('jump-counterpart');
      fireEvent.click(jump);

      // 面板还在，且展示的是索引 11 那条（不是空、不是原来那条）
      const panel = await screen.findByTestId('detail-panel');
      expect(panel).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByTestId('detail-title').textContent).toContain('apply_patch'),
      );
      // 副作用是**可见的**：搜索框被清空，用户能理解为什么列表变了
      expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('');
    });

    /**
     * jumpTo 里除了清搜索词，还会把目标所属的组重新打开。**这条路径今天从 UI 走不到**，
     * 我试着写用例才发现：调用与结果同属「行动」组，关掉这一组会把两条一起藏起来，
     * 于是面板自己先关了，根本点不到跳转按钮。
     *
     * 那段 `setActive` 因此是防御性的，不是死代码——它保的是
     * 「选中之前先让目标可见」这个不变量。真正该钉住的是**它为什么走不到**：
     * 一旦有人把 tool_out 挪到别的组，这条断言会红，提醒回来补用例。
     */
    it('（记录不变量）调用与结果同属一组，所以组过滤永远藏不掉「只有对家」', async () => {
      await open();
      const call = rowAt(11);
      const out = rowAt(12);
      expect(call.dataset.kind).toBe('tool_call');
      expect(out.dataset.kind).toBe('tool_out');
      expect(call.dataset.group).toBe('act');
      expect(out.dataset.group).toBe('act');
    });
  });
});

describe('快捷键（§6.5）', () => {
  it('⌘O 打开文件选择器', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    expect(api.openFileDialog).toHaveBeenCalled();
  });

  it('/ 聚焦搜索框', async () => {
    await open();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(screen.getByTestId('search'));
  });

  it('Esc 先退出搜索框，再按才关面板', async () => {
    await open();
    fireEvent.click(rowAt(11));
    const search = screen.getByTestId('search') as HTMLInputElement;
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(document.activeElement).not.toBe(search);
    expect(screen.getByTestId('detail-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('detail-panel')).toBeNull();
  });

  it('⌘F 聚焦详情面板内的搜索框，命中处高亮', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    const box = screen.getByTestId('detail-search') as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Patch' } });
    const marks = screen.getByTestId('detail-content').querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe('Patch');
  });

  it('r 刷新会话列表', async () => {
    await open();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r' });
    });
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it('⌘1 折叠/展开左栏', async () => {
    await open();
    expect(screen.getByTestId('session-list')).toBeTruthy();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(screen.queryByTestId('session-list')).toBeNull();
    expect(screen.getByTestId('shell-body').className).toContain('no-left');
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(screen.getByTestId('session-list')).toBeTruthy();
  });

  it('⌘2 折叠/展开右栏，展开后回到原来那条', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    expect(screen.queryByTestId('detail-panel')).toBeNull();
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    expect(screen.getByTestId('detail-title').textContent).toContain('apply_patch');
  });
});

describe('空状态与拖放（§6.4 / F23 / F24）', () => {
  it('F23 · 未选中会话时主区是拖放区，并显示扫描目录', async () => {
    render(<App />);
    const zone = await screen.findByTestId('dropzone');
    expect(zone.textContent).toContain('把 rollout .jsonl 拖到这里');
    await waitFor(() =>
      expect(screen.getByTestId('scan-dir').textContent).toContain(SESSIONS_DIR),
    );
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
  });

  it('F23b · 扫描目录拿不到时给出默认路径，而不是空白', async () => {
    (api.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
      codexHome: '',
      sessionsDir: '',
      items: [],
    });
    render(<App />);
    expect((await screen.findByTestId('scan-dir')).textContent).toContain('~/.codex/sessions');
  });

  it('F24 · 拖 .jsonl 到窗口任意位置即打开', async () => {
    const { container } = render(<App />);
    await screen.findAllByTestId('session-item');
    const file = new File([readFileSync(F01, 'utf8')], '01-apply-patch-rejected.jsonl');
    const shell = container.querySelector('.shell')!;
    fireEvent.dragOver(shell);
    await act(async () => {
      fireEvent.drop(shell, { dataTransfer: { files: [file] } });
    });
    await waitFor(() => expect(screen.getAllByTestId('row')).toHaveLength(19));
    // 拖放的 File 在 sandbox 下拿不到磁盘路径 → 跟随置灰并说明原因
    expect((screen.getByTestId('follow-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('F24b · 拖放不经过主进程 IPC（渲染进程本来就负责解析）', async () => {
    const { container } = render(<App />);
    await screen.findAllByTestId('session-item');
    const file = new File([readFileSync(F03, 'utf8')], '03-edge-cases.jsonl');
    await act(async () => {
      fireEvent.drop(container.querySelector('.shell')!, { dataTransfer: { files: [file] } });
    });
    await waitFor(() => expect(screen.getAllByTestId('row')).toHaveLength(13));
    expect(api.readSession).not.toHaveBeenCalled();
  });
});

describe('会话列表（F1 / F2 of §5）', () => {
  it('列出 3 个会话，显示时间 / 体积 / 模型 / 首条用户消息', async () => {
    render(<App />);
    const items = await screen.findAllByTestId('session-item');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('创建一个 hello.txt');
    expect(items[0].textContent).toContain('104K');
    expect(items[0].textContent).toContain('deepseek-v4-flash');
    expect(screen.getByTestId('filterbar').textContent).toContain('3 个会话');
  });

  it('左栏过滤框按路径/模型/首条消息筛选', async () => {
    render(<App />);
    await screen.findAllByTestId('session-item');
    fireEvent.change(screen.getByLabelText('过滤会话'), { target: { value: '边界' } });
    expect(screen.getAllByTestId('session-item')).toHaveLength(1);
  });

  it('切换会话会重置选中与搜索，不把上一份的状态带过去', async () => {
    await open();
    fireEvent.click(rowAt(11));
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'rejected' } });
    const items = screen.getAllByTestId('session-item');
    await act(async () => {
      fireEvent.click(items.find((el) => (el as HTMLElement).dataset.path === F02)!);
    });
    expect(screen.queryByTestId('detail-panel')).toBeNull();
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('');
    expect(screen.getAllByTestId('row')).toHaveLength(17);
  });

  it('listSessions 失败不白屏（目录不存在等）', async () => {
    (api.listSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
    render(<App />);
    expect(await screen.findByTestId('dropzone')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('会话列表按项目分组（§12 Q3）', () => {
  const CODEX = { key: 'git:github.com/openai/codex', label: 'openai/codex', kind: 'git' as const };
  const DEMO = { key: 'git:example.com/x/demo', label: 'x/demo', kind: 'git' as const };

  /** F03 最新 → x/demo 组应排在 openai/codex 之前 */
  function withProjects(items: Array<Record<string, unknown>>) {
    (api.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue({
      codexHome: '/Users/dev/.codex',
      sessionsDir: SESSIONS_DIR,
      items,
    });
  }

  const F01_CODEX = { path: F01, mtime: 1754277189000, size: 106496, model: 'deepseek-v4-flash', firstUser: '创建一个 hello.txt，内容写 hi', project: CODEX };
  const F02_CODEX = { path: F02, mtime: 1754270000000, size: 114688, model: 'deepseek-v4-flash', firstUser: '看看 codex-rs 有几个 crate', project: CODEX };
  const F03_DEMO = { path: F03, mtime: 1754280000000, size: 28672, model: 'test-model', firstUser: '边界用例', project: DEMO };

  const heads = () => screen.getAllByTestId('session-group-head');
  const headText = () => heads().map((h) => h.querySelector('.session-group-label')!.textContent);
  const itemPaths = () =>
    screen.getAllByTestId('session-item').map((el) => (el as HTMLElement).dataset.path);

  beforeEach(() => {
    // 这一组测的是分组折叠的持久化，要从干净的 localStorage 起步。
    // 但外层 beforeEach 设的视图偏好不能一起清掉——清了这里就变成图视图，
    // 而「点开会话渲染 19 行」是列表视图的断言。
    localStorage.clear();
    localStorage.setItem(VIEW_KEY, 'list');
  });

  it('多项目 → 渲染组头，组序按「组内最新 mtime」倒序', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(headText()).toEqual(['x/demo', 'openai/codex']);
    // 第一组的第一条 = 全局最新（分组设计的核心性质）
    expect(itemPaths()[0]).toBe(F03);
  });

  it('组内按 mtime 倒序，组头右侧显示会话数', async () => {
    withProjects([F02_CODEX, F03_DEMO, F01_CODEX]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(itemPaths()).toEqual([F03, F01, F02]);
    expect(heads().map((h) => h.querySelector('.session-group-count')!.textContent)).toEqual(['1', '2']);
  });

  /**
   * 哨兵：曾经反过来做过（单组时抑制组头），被实测推翻——
   * 所有会话都在一个仓库的用户反而**完全看不到自己在看哪个仓库**。
   * 组头是项目身份，不是分组装饰，恒定值也要显示。
   */
  it('单项目 → 照样渲染组头（项目身份不因「只有一个值」而隐藏）', async () => {
    withProjects([F01_CODEX, F02_CODEX]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(headText()).toEqual(['openai/codex']);
    expect(screen.getAllByTestId('session-group')).toHaveLength(1);
    expect(itemPaths()).toEqual([F01, F02]);
  });

  it('全部缺 project 时显示单个「未知项目」组头', async () => {
    render(<App />); // 默认 mock 的三项都没有 project
    await screen.findAllByTestId('session-item');
    expect(headText()).toEqual(['未知项目']);
    expect(screen.getAllByTestId('session-item')).toHaveLength(3);
  });

  it('「未知项目」组永远排最后，哪怕它的会话最新', async () => {
    withProjects([
      { path: F03, mtime: 9999999999999, size: 28672, firstUser: '边界用例' }, // 无 project，且最新
      F01_CODEX,
      F02_CODEX,
    ]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(headText()).toEqual(['openai/codex', '未知项目']);
    expect(itemPaths()[itemPaths().length - 1]).toBe(F03);
  });

  it('过滤框匹配项目名 —— 会话自身字段里没有这个词也能命中', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    // 'x/demo' 只出现在 project.label 里，F03 的路径/首条消息都没有
    fireEvent.change(screen.getByLabelText('过滤会话'), { target: { value: 'x/demo' } });
    expect(itemPaths()).toEqual([F03]);
    // 组头留着，正好解释「凭什么选中这条」——它自己的文字里没有搜索词
    expect(headText()).toEqual(['x/demo']);
  });

  it('组头 title 给出完整项目身份（组名被省略号截断时的兜底）', async () => {
    withProjects([F01_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(heads().map((h) => h.getAttribute('title'))).toEqual([DEMO.key, CODEX.key]);
  });

  it('过滤后为空的组不渲染组头', async () => {
    withProjects([
      F01_CODEX,
      F02_CODEX,
      F03_DEMO,
      { path: '/z/other.jsonl', mtime: 1754000000000, size: 10, firstUser: '边界用例' },
    ]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(headText()).toEqual(['x/demo', 'openai/codex', '未知项目']);
    fireEvent.change(screen.getByLabelText('过滤会话'), { target: { value: '边界' } });
    // 命中 F03（x/demo）与无 project 的那条 → openai/codex 组整组消失
    expect(headText()).toEqual(['x/demo', '未知项目']);
  });

  it('点击组头折叠该组，其它组不受影响', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    const codexHead = heads()[1];
    expect(codexHead.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(codexHead);
    expect(heads()[1].getAttribute('aria-expanded')).toBe('false');
    expect(itemPaths()).toEqual([F03]);
    // 再点一次展开
    fireEvent.click(heads()[1]);
    expect(itemPaths()).toEqual([F03, F01, F02]);
  });

  it('折叠状态存 localStorage（键用 project.key），重新挂载后仍然折叠', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    fireEvent.click(heads()[1]); // 折 openai/codex
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('unroll:collapsedProjects')!)).toContain(CODEX.key),
    );

    cleanup();
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(itemPaths()).toEqual([F03]);
  });

  it('localStorage 里是垃圾数据也不崩', async () => {
    localStorage.setItem('unroll:collapsedProjects', '{oops');
    withProjects([F01_CODEX, F03_DEMO]);
    render(<App />);
    expect(await screen.findAllByTestId('session-item')).toHaveLength(2);
  });

  it('点击组内的会话仍能正常打开（原有交互不变）', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    const items = await screen.findAllByTestId('session-item');
    const target = items.find((el) => (el as HTMLElement).dataset.path === F01)!;
    await act(async () => {
      fireEvent.click(target);
    });
    await waitFor(() => expect(screen.getAllByTestId('row')).toHaveLength(19));
    expect(target.className).toContain('active');
  });

  it('打开折叠组里的会话 → 自动展开该组，且展开写进持久化状态', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    fireEvent.click(heads()[1]); // 折 openai/codex
    expect(itemPaths()).toEqual([F03]);

    // 组折着，从别处（⌘O）打开组里的会话
    (api.openFileDialog as ReturnType<typeof vi.fn>).mockResolvedValue(F01);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'o', metaKey: true });
    });
    await waitFor(() => expect(itemPaths()).toEqual([F03, F01, F02]));
    expect(heads()[1].getAttribute('aria-expanded')).toBe('true');

    // 关键：写进 localStorage，而不是渲染时临时覆盖——
    // 否则用户下次打开会看到「它又自己折回去了」
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('unroll:collapsedProjects')!)).not.toContain(CODEX.key),
    );
    cleanup();
    render(<App />);
    await screen.findAllByTestId('session-item');
    expect(heads()[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('打开会话后仍可手动折叠该组 —— 自动展开只在切换会话时生效一次', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    const items = await screen.findAllByTestId('session-item');
    await act(async () => {
      fireEvent.click(items.find((el) => (el as HTMLElement).dataset.path === F01)!);
    });
    fireEvent.click(heads()[1]);
    expect(heads()[1].getAttribute('aria-expanded')).toBe('false');
    expect(itemPaths()).toEqual([F03]);
  });

  it('折叠组里藏着当前会话时，组头显示 --g-input 色的圆点', async () => {
    withProjects([F01_CODEX, F02_CODEX, F03_DEMO]);
    render(<App />);
    const items = await screen.findAllByTestId('session-item');
    expect(screen.queryAllByTestId('session-group-dot')).toHaveLength(0);

    await act(async () => {
      fireEvent.click(items.find((el) => (el as HTMLElement).dataset.path === F01)!);
    });
    fireEvent.click(heads()[1]); // 打开之后再手动折叠
    const dots = screen.getAllByTestId('session-group-dot');
    expect(dots).toHaveLength(1);
    // 颜色靠 class（CSP 下不能用行内 style），符号本身独立于颜色（F21 同理）
    expect(dots[0].className).toContain('g-input');
    expect(dots[0].textContent).toBe('●');
    // 圆点只挂在藏着当前会话的那个组头上
    expect(heads()[1].contains(dots[0])).toBe(true);
    expect(heads()[0].querySelector('[data-testid="session-group-dot"]')).toBeNull();

    // 展开后不再需要提示
    fireEvent.click(heads()[1]);
    expect(screen.queryAllByTestId('session-group-dot')).toHaveLength(0);
  });

  it('⌘1 仍然折叠整个左栏，不被组头折叠抢走', async () => {
    withProjects([F01_CODEX, F03_DEMO]);
    render(<App />);
    await screen.findAllByTestId('session-item');
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(screen.queryByTestId('session-list')).toBeNull();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(await screen.findByTestId('session-list')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('原始 JSON 的树视图（§6.1 第二层 / F19）', () => {
  /**
   * 树由 react-json-view-lite 渲染，所以断言打在它的输出上：
   * 每个可展开节点是 role="treeitem"，里面第一个 .jt-key 是本节点的键，
   * role="button" 的那个 span 是展开/折叠开关。
   */
  async function openRaw(file: string, index: number) {
    await open(file);
    fireEvent.click(rowAt(index));
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    return screen.getByTestId('rawjson-body');
  }

  const items = () => [...screen.getByTestId('rawjson-body').querySelectorAll('[role="treeitem"]')];

  function nodeByKey(key: string): HTMLElement {
    const el = items().find((i) => i.querySelector('.jt-key')?.textContent === `${key}:`);
    if (!el) throw new Error(`树里没有键 ${key}`);
    return el as HTMLElement;
  }

  const toggleOf = (node: HTMLElement) => node.querySelector('[role="button"]') as HTMLElement;

  it('展开后默认是树视图，不是原文', async () => {
    await openRaw(F01, 11);
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(screen.getByTestId('rawjson-view-tree').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('rawjson-view-text').getAttribute('aria-pressed')).toBe('false');
  });

  it('默认展开 2 层：payload 的直接子项可见，更深的默认折叠', async () => {
    const body = await openRaw(F01, 0); // session_meta，最大的一条
    // 深度 1 的 payload 展开 → 深度 2 的键看得见
    expect(body.textContent).toContain('cli_version');
    // 深度 2 的容器（payload.git）折叠
    expect(nodeByKey('git').getAttribute('aria-expanded')).toBe('false');
    expect(body.textContent).not.toContain('commit_hash');
  });

  it('点击节点可折叠 / 展开', async () => {
    const body = await openRaw(F01, 0);
    fireEvent.click(toggleOf(nodeByKey('git')));
    expect(nodeByKey('git').getAttribute('aria-expanded')).toBe('true');
    expect(body.textContent).toContain('commit_hash');

    fireEvent.click(toggleOf(nodeByKey('git')));
    expect(nodeByKey('git').getAttribute('aria-expanded')).toBe('false');
    expect(body.textContent).not.toContain('commit_hash');
  });

  it('「全部展开」把深层节点也打开，「全部折叠」收回去', async () => {
    const body = await openRaw(F01, 0);
    expect(body.textContent).not.toContain('commit_hash');

    fireEvent.click(screen.getByTestId('rawjson-expand-all'));
    expect(screen.getByTestId('rawjson-body').textContent).toContain('commit_hash');

    fireEvent.click(screen.getByTestId('rawjson-collapse-all'));
    const after = screen.getByTestId('rawjson-body').textContent ?? '';
    expect(after).not.toContain('commit_hash');
    expect(after).not.toContain('cli_version'); // 连第二层都收了
  });

  /**
   * ★ 二次解析（F19）。02 号夹具索引 9 是 function_call，
   *   arguments = `{"cmd": "ls -la"}` —— 一个 **JSON 字符串**。
   *   库不管这件事，是我们在喂数据前做的预处理。
   */
  it('function_call.arguments 被二次解析成子树', async () => {
    const body = await openRaw(F02, 9);
    expect(body.textContent).toContain('cmd');
    expect(body.textContent).toContain('ls -la');
    // 转义后的原样字符串不该出现在树里
    expect(body.textContent).not.toContain('\\"cmd\\"');
    // arguments 现在是个可展开节点，而不是一行字符串
    expect(nodeByKey('arguments').getAttribute('aria-expanded')).toBeTruthy();
  });

  /**
   * ⚠️ 另一条工具调用路径：01 号索引 11 的 custom_tool_call.input 是**纯文本 patch**，
   *   不能当 JSON 解析，且换行要原样保留。
   */
  it('custom_tool_call.input 不被误解析，换行原样保留', async () => {
    const body = await openRaw(F01, 11);
    const input = nodeByKey('input');
    // 它是叶子（字符串），不是可展开节点
    expect(input.getAttribute('aria-expanded')).toBeNull();
    const val = input.querySelector('.jt-string')!.textContent ?? '';
    expect(val).toContain('*** Begin Patch');
    expect(val).toContain('*** End Patch');
    expect(val).toContain('\n'); // 换行没被压成一行，也没变成 \n 字面量
    expect(body.textContent).not.toContain('\\n');
  });

  /**
   * 超长字符串**不在 JS 里截断**（截断了就没法完整复制），
   * 靠 CSS 给值节点限高 + 内部滚动。这里钉死「DOM 里是全文」。
   */
  it('超长字符串完整进 DOM，不做 JS 截断', async () => {
    await openRaw(F02, 13); // agent_message，payload.message 长 351 字符
    const val = nodeByKey('message').querySelector('.jt-string')!.textContent ?? '';
    expect(val.length).toBe(351 + 2); // 库给字符串加了一对引号
    expect(val).not.toContain('…');
  });

  it('两视图可切换，原文视图内容仍等于 rawPretty', async () => {
    await openRaw(F01, 11);
    fireEvent.click(screen.getByTestId('rawjson-view-text'));
    const pre = screen.getByTestId('rawjson-body');
    expect(pre.tagName).toBe('PRE');
    expect(screen.queryByRole('tree')).toBeNull();

    // 原文 = shared/rollout 生成的 rawPretty（脱敏后的 JSON.stringify(raw, null, 2)）
    const expected = JSON.stringify(JSON.parse(pre.textContent!), null, 2);
    expect(pre.textContent).toBe(expected);
    expect(pre.textContent).toContain('*** Begin Patch');

    fireEvent.click(screen.getByTestId('rawjson-view-tree'));
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  /**
   * 面板搜索不覆盖原始 JSON，树还会把值藏进折叠节点——
   * 相对原来那堵 <pre> 是能力倒退，所以有搜索词时必须给出去路。
   */
  it('面板里有搜索词时，树视图给出「去原文视图」的提示', async () => {
    await openRaw(F01, 11);
    expect(screen.queryByTestId('rawjson-search-hint')).toBeNull();

    fireEvent.change(screen.getByTestId('detail-search'), { target: { value: 'Patch' } });
    expect(screen.getByTestId('rawjson-search-hint')).toBeTruthy();

    fireEvent.click(screen.getByTestId('rawjson-goto-text'));
    expect(screen.getByTestId('rawjson-body').tagName).toBe('PRE');
    // 切过去之后提示自己消失（问题已经解决了）
    expect(screen.queryByTestId('rawjson-search-hint')).toBeNull();
  });

  it('B7 · 两个视图里都搜不到完整 fake key（脱敏覆盖 raw 与 rawPretty）', async () => {
    const body = await openRaw(F03, 0); // session_meta，两个假 key 都在这条
    expect(body.textContent).toContain('••••ab12');
    expect(body.textContent).not.toContain('FAKEkeyDoNotUse');
    expect(body.textContent).not.toContain('FAKEsecond');

    fireEvent.click(screen.getByTestId('rawjson-view-text'));
    const pre = screen.getByTestId('rawjson-body');
    expect(pre.textContent).toContain('••••ab12');
    expect(pre.textContent).not.toContain('FAKEkeyDoNotUse');
    expect(pre.textContent).not.toContain('FAKEsecond');
    expect(document.body.textContent).not.toContain('FAKEkeyDoNotUse');
  });

  it('坏行（_parse_error）也能进树，不白屏', async () => {
    // 03 号夹具第 6 行是故意的坏 JSON，归一化成 _parse_error 条目
    await open(F03);
    const bad = rows().find((r) => (r as HTMLElement).dataset.kind === 'error');
    expect(bad).toBeTruthy();
    fireEvent.click(bad!);
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    expect(screen.getByTestId('rawjson-body').textContent).toBeTruthy();
  });
});

describe('安全（§9.1 / F22）', () => {
  it('F22 · 界面任何位置都搜不到完整 fake key —— 逐条选中并展开原始 JSON', async () => {
    await open(F03);
    const total = rows().length;
    for (let i = 0; i < total; i += 1) {
      fireEvent.click(rows()[i]);
      const toggle = screen.queryByTestId('rawjson-toggle');
      if (toggle) fireEvent.click(toggle);
      expect(document.body.textContent).not.toContain('FAKEkeyDoNotUse');
      expect(document.body.textContent).not.toContain('FAKEsecond');
      expect(document.body.textContent).not.toContain('FAKEinline');
      expect(document.body.textContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
    // 但脱敏标记本身要看得见，让用户知道这不是数据缺失
    fireEvent.click(rows()[0]);
    fireEvent.click(screen.getByTestId('rawjson-toggle'));
    expect(screen.getByTestId('rawjson-body').textContent).toContain('••••');
  });
});

describe('实时跟随 · 渲染侧（§14.5 G1 / G7）', () => {
  it('跟随开关会从 readSession 返回的字节数起 watch', async () => {
    await open();
    fireEvent.click(screen.getByTestId('follow-toggle'));
    expect(api.watchSession).toHaveBeenCalledWith(F01, readFileSync(F01).byteLength);
  });

  it('G1 · 追加 3 行 → 时间线增加 3 条，已有行的 DOM 节点原地保留（不重建整表）', async () => {
    await open();
    fireEvent.click(screen.getByTestId('follow-toggle'));
    const before = rows();
    const firstNode = before[0];
    const lastNode = before[before.length - 1];

    const extra = [0, 1, 2].map((i) =>
      JSON.stringify({
        timestamp: '2026-08-04T03:14:0' + i + '.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: `追加消息 ${i}` },
      }),
    );
    await act(async () => {
      appendCb?.({ path: F01, lines: extra });
    });

    const after = rows();
    expect(after).toHaveLength(22);
    expect(after[0]).toBe(firstNode); // 同一个 DOM 节点，没被重建
    expect(after[18]).toBe(lastNode);
    // 新条目的序号接着排
    expect((after[21] as HTMLElement).dataset.index).toBe('21');
    expect(after[21].textContent).toContain('追加消息 2');
  });

  it('G1b · 追加后六组计数与总数同步更新', async () => {
    await open();
    fireEvent.click(screen.getByTestId('follow-toggle'));
    await act(async () => {
      appendCb?.({
        path: F01,
        lines: [JSON.stringify({ timestamp: '', type: 'event_msg', payload: { type: 'agent_message', message: 'x' } })],
      });
    });
    expect(screen.getByTestId('entry-count').textContent).toBe('20 条');
    expect(screen.getByTestId('group-output').dataset.count).toBe('5');
  });

  it('G6 · reset 推送触发重读全量，条目数回到 19 而不是翻倍', async () => {
    await open();
    fireEvent.click(screen.getByTestId('follow-toggle'));
    await act(async () => {
      appendCb?.({
        path: F01,
        lines: [JSON.stringify({ timestamp: '', type: 'event_msg', payload: { type: 'agent_message', message: 'x' } })],
      });
    });
    expect(rows()).toHaveLength(20);
    await act(async () => {
      resetCb?.({ path: F01 });
    });
    await waitFor(() => expect(rows()).toHaveLength(19));
  });

  it('G7 · 切到另一个会话时旧 watcher 被关闭', async () => {
    await open();
    fireEvent.click(screen.getByTestId('follow-toggle'));
    const items = screen.getAllByTestId('session-item');
    await act(async () => {
      fireEvent.click(items.find((el) => (el as HTMLElement).dataset.path === F02)!);
    });
    expect(api.unwatchSession).toHaveBeenCalled();
  });
});
