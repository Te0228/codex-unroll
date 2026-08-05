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

  it('F13 · 下钻恰好两层：时间线行没有展开控件，面板里只有「原始 JSON」一个', async () => {
    const { container } = await open();
    for (const r of rows()) expect(r.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(rowAt(11));
    // 只看「时间线 + 详情面板」这条下钻路径。左栏组头也是 aria-expanded，
    // 但它属于会话导航，不是条目的第三层。
    const drill = [...container.querySelectorAll('[aria-expanded]')].filter(
      (el) => !el.closest('.sessions'),
    );
    expect(drill).toHaveLength(1);
    expect((drill[0] as HTMLElement).dataset.testid).toBe('rawjson-toggle');
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
    localStorage.clear();
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
