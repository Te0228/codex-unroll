// @vitest-environment jsdom
/**
 * 详情面板的 v0.2 验收 —— P 组（Pair）· K 组（Kopy 的 K，避免和 §14.2 的 C 组撞）·
 * N 组（seNctions… 好吧，Sections 的 N，因为 S 已经被 §14.9 的切分那组占了）。
 *
 * 三块功能：
 *   F14 工具调用配对互跳（shared/pairing.ts 提供配对，这里只测面板怎么用它）
 *   F18 复制（**已脱敏**的正文 / 原始 JSON，两条剪贴板路径都要活着）
 *   F20 大内容按 markdown 标题分段
 *
 * ★ 数据一律来自 test/fixtures/ 的真实夹具，期望值是跑出来的确切数字：
 *     01 索引 11/12 → call_00_VGd9…1663 的一对（custom_tool_call 路径）
 *     01 索引  3    → 23 041 字符 / 29 段（AGENTS.md 注入，F20 的正主）
 *     01 索引  2    → 10 467 字符 / 3 段（首段是标题之前的前言）
 *     01 索引  4    → 34 310 字符 / 0 个标题（长但切不动 → 退回截断）
 *     03 索引  7    →  8 846 字符 / 只有 1 个标题（切出来只有一段 → 退回截断）
 *     04           → 7 对 call_lf_0001…0007，两条工具路径都有
 *
 * ★ 配对逻辑本身（谁配谁、重复怎么办）由 shared 的纯函数负责，
 *   这个文件只负责「配上了 UI 长什么样、点了会怎样、配不上时**不画按钮**」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEntries } from '../../shared/rollout';
import { buildPairs, type CallPair } from '../../shared/pairing';
import { resolve } from '../../shared/i18n';
import type { Entry } from '../../shared/types';
import { DETAIL_TRUNCATE } from '../format';
import { DetailPanel } from './DetailPanel';
import { splitSections } from './BodySections';
import { copyText } from './CopyButtons';

// jsdom 下 import.meta.url 的 base 不可靠，直接用 vitest 的 cwd（仓库根）——同 StepGraph.test
const fx = (name: string) => join(process.cwd(), 'test/fixtures', name);
const F01 = fx('01-apply-patch-rejected.jsonl');
const F03 = fx('03-edge-cases.jsonl');
const F04 = fx('04-multi-turn.jsonl');

function entriesOf(path: string): Entry[] {
  return toEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== ''),
  );
}

const E01 = entriesOf(F01);
const E03 = entriesOf(F03);
const E04 = entriesOf(F04);

/** 测试环境的语言钉死在 zh-CN（§15.5），正文取值也必须显式指定语言 */
const bodyOf = (e: Entry) => resolve('zh-CN', e.preview ?? '');

interface Opts {
  entries?: Entry[];
  pairs?: Map<string, CallPair>;
  onJump?: (index: number) => void;
  /** 显式传 null 表示「App 还没接线」，不传则默认用整份文件建配对表 */
  noPairs?: boolean;
}

function renderPanel(entry: Entry, opts: Opts = {}) {
  const entries = opts.entries ?? E01;
  return render(
    <DetailPanel
      entry={entry}
      summary={null}
      onClose={() => {}}
      onResizeStart={() => {}}
      pairs={opts.noPairs ? undefined : (opts.pairs ?? buildPairs(entries))}
      onJump={opts.onJump ?? (() => {})}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 复制测试会往 navigator 上挂桩，清掉免得串到下一条
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as { execCommand?: unknown }).execCommand;
});

// ═══════════════════════════════════════════════════════════════════
// P 组 · F14 工具调用配对互跳
// ═══════════════════════════════════════════════════════════════════

describe('P · F14 工具调用配对互跳', () => {
  const call01 = E01[11];
  const out01 = E01[12];

  /**
   * 这条钉的是**方向**：站在「调用」上，按钮该说「跳到结果」。
   * 说反了比没有更糟——用户会以为自己没跳动。
   */
  it('P1 · 站在 tool_call 上，按钮是「跳到结果」，目标是配对的 output', () => {
    renderPanel(call01);
    const btn = screen.getByTestId('jump-counterpart');
    expect(btn.textContent).toBe('跳到结果');
    expect(btn.dataset.target).toBe('12');
  });

  /** 反方向同理，且两条走的是同一个 call_id（01 号夹具只有这一对） */
  it('P2 · 站在 tool_out 上，按钮是「跳到调用」，目标是配对的 call', () => {
    renderPanel(out01);
    const btn = screen.getByTestId('jump-counterpart');
    expect(btn.textContent).toBe('跳到调用');
    expect(btn.dataset.target).toBe('11');
    expect(out01.callId).toBe(call01.callId);
  });

  /** 按钮真的会调 onJump，且传的是 Entry.index（App 拿它去选中，不是数组下标） */
  it('P3 · 点击调用 onJump(对家的 index)，一次点击只跳一次', () => {
    const onJump = vi.fn();
    renderPanel(call01, { onJump });
    fireEvent.click(screen.getByTestId('jump-counterpart'));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(12);
  });

  /**
   * 04 号夹具的 7 对里，两条工具路径都在（function_call 与 custom_tool_call）。
   * 只支持一条会导致另一条完全跳不动，这是本仓库栽过的坑（CLAUDE.md §2）。
   */
  it('P4 · 04 号夹具 7 对全部能互跳，两条工具路径都覆盖到', () => {
    const pairs = buildPairs(E04);
    expect(pairs.size).toBe(7);
    const types = new Set<string>();
    for (const [callId, p] of pairs) {
      expect(callId).toMatch(/^call_lf_000[1-7]$/);
      types.add(p.call!.payloadType);

      // 调用 → 结果
      const onJump = vi.fn();
      renderPanel(p.call!, { entries: E04, onJump });
      fireEvent.click(screen.getByTestId('jump-counterpart'));
      expect(onJump).toHaveBeenCalledWith(p.output!.index);
      cleanup();

      // 结果 → 调用
      const back = vi.fn();
      renderPanel(p.output!, { entries: E04, onJump: back });
      fireEvent.click(screen.getByTestId('jump-counterpart'));
      expect(back).toHaveBeenCalledWith(p.call!.index);
      cleanup();
    }
    expect([...types].toSorted()).toEqual(['custom_tool_call', 'function_call']);
  });

  /**
   * ★ 最关键的一条：配不上对家时**不许有按钮**。
   * 一个点了没反应的按钮会让人以为程序坏了；一句说明则告诉他
   * 「这份文件里就是没有」——被中断的会话、从中间截断的文件都会到这里（pairing.ts 文件头）。
   */
  it('P5 · 只有调用没有结果时，跳转按钮不渲染，只留一句说明', () => {
    const halfPairs = buildPairs(E01.filter((e) => e.index !== 12));
    renderPanel(call01, { pairs: halfPairs });
    expect(screen.queryByTestId('jump-counterpart')).toBeNull();
    expect(screen.getByTestId('no-counterpart').textContent).toBe('这份文件里没有配对的记录');
  });

  /** 反向的半截：只有结果没有调用（从中间截断的文件） */
  it('P6 · 只有结果没有调用时同样不渲染按钮', () => {
    const halfPairs = buildPairs(E01.filter((e) => e.index !== 11));
    renderPanel(out01, { pairs: halfPairs });
    expect(screen.queryByTestId('jump-counterpart')).toBeNull();
    expect(screen.queryByTestId('no-counterpart')).not.toBeNull();
  });

  /** 非工具记录压根没有「对家」这回事，整个互跳区都不该出现 */
  it('P7 · 用户消息这类非工具记录不出现互跳区', () => {
    renderPanel(E01[3]);
    expect(screen.queryByTestId('detail-pair')).toBeNull();
  });

  /**
   * App 还没接线（不传 pairs）时也不能画按钮——
   * 宁可少一个功能，也不要一个点了没反应的控件。
   */
  it('P8 · 没传 pairs 时不渲染互跳区', () => {
    renderPanel(call01, { noPairs: true });
    expect(screen.queryByTestId('detail-pair')).toBeNull();
  });

  /** 同理：配得上但上层没给 onJump，按钮也点不动，那就不画 */
  it('P9 · 配得上但没有 onJump 时退化成说明，不画死按钮', () => {
    render(
      <DetailPanel
        entry={call01}
        summary={null}
        onClose={() => {}}
        onResizeStart={() => {}}
        pairs={buildPairs(E01)}
      />,
    );
    expect(screen.queryByTestId('jump-counterpart')).toBeNull();
    expect(screen.queryByTestId('no-counterpart')).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// K 组 · F18 复制
// ═══════════════════════════════════════════════════════════════════

/** 装一个能记录写入内容的剪贴板桩 */
function stubClipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/** 装一个 execCommand 桩，返回它复制到的文本（从 .copy-sink 里读，和真实浏览器同源） */
function stubExecCommand(ok: boolean) {
  const seen: string[] = [];
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = vi.fn(() => {
    const sink = document.querySelector<HTMLTextAreaElement>('.copy-sink');
    if (sink) seen.push(sink.value);
    return ok;
  });
  return seen;
}

/** 点按钮 + 等异步复制落地（copyText 是 Promise） */
async function clickCopy(testId: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

describe('K · F18 复制', () => {
  const patch = E01[11]; // 正文 58 字符的 apply_patch，短、好断言

  /**
   * 主路径：`navigator.clipboard.writeText`。
   * 实测（Electron 43）`file://` 是 secure context，这条路在生产里确实可用。
   */
  it('K1 · 复制正文走 navigator.clipboard，内容是完整正文', async () => {
    const writeText = stubClipboard(async () => {});
    renderPanel(patch);
    await clickCopy('copy-body');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(bodyOf(patch));
    expect(screen.getByTestId('copy-state').textContent).toBe('已复制');
  });

  /** 复制的是 rawPretty 那一份，不是 preview——两个按钮各管各的 */
  it('K2 · 复制原始 JSON 拿到的是 rawPretty', async () => {
    const writeText = stubClipboard(async () => {});
    renderPanel(patch);
    await clickCopy('copy-json');
    expect(writeText.mock.calls[0][0]).toBe(patch.rawPretty);
  });

  /**
   * ★ 回退路径必须真的能跑。
   * 实测：窗口失焦时 async 路径抛 `NotAllowedError: Document is not focused`，
   * 而 execCommand 在同样情况下（有用户手势）返回 true。这条模拟的就是那一刻。
   */
  it('K3 · async 路径抛 NotAllowedError 时回退到 execCommand，仍然算成功', async () => {
    const err = new Error('Document is not focused');
    err.name = 'NotAllowedError';
    const writeText = stubClipboard(async () => {
      throw err;
    });
    const seen = stubExecCommand(true);
    renderPanel(patch);
    await clickCopy('copy-body');
    expect(writeText).toHaveBeenCalledTimes(1);
    // 回退路径复制到的内容与主路径完全一致
    expect(seen).toEqual([bodyOf(patch)]);
    expect(screen.getByTestId('copy-state').textContent).toBe('已复制');
  });

  /**
   * 连 clipboard 对象都没有（非 secure context 的假设场景）时，
   * **不能假报成功**——`await undefined` 也会 resolve，这是很容易写出的 bug。
   */
  it('K4 · navigator.clipboard 不存在时直接走 execCommand，不假报成功', async () => {
    const seen = stubExecCommand(true);
    renderPanel(patch);
    await clickCopy('copy-body');
    expect(seen).toEqual([bodyOf(patch)]);
    expect(screen.getByTestId('copy-state').textContent).toBe('已复制');
  });

  /** 两条路都跪了要说出来。静默失败最坏：用户粘出去的是上一次的剪贴板内容 */
  it('K5 · 两条路都失败时显示「复制失败」，不静默', async () => {
    stubClipboard(async () => {
      throw new Error('nope');
    });
    stubExecCommand(false);
    renderPanel(patch);
    await clickCopy('copy-body');
    const state = screen.getByTestId('copy-state');
    expect(state.textContent).toBe('复制失败');
    expect(state.className).toContain('bad');
  });

  /** 纯函数层面再钉一遍：copyText 的返回值就是「到底复制成没成」 */
  it('K6 · copyText 在两条路都不可用时返回 false，空串直接 false', async () => {
    await expect(copyText('')).resolves.toBe(false);
    await expect(copyText('x')).resolves.toBe(false); // jsdom 里两条路都没有
    stubClipboard(async () => {});
    await expect(copyText('x')).resolves.toBe(true);
  });

  /**
   * ★ §9.1 的硬约束：复制出去的必须是脱敏后的。
   * 03 号夹具索引 0 的 session_meta 里有一把 fake key，
   * 归一化层已经把它遮成尾 4 位；这里验证复制通道没有绕过那一步。
   */
  it('K7 · 复制出去的原始 JSON 是脱敏后的：搜不到 FAKEkeyDoNotUse，只剩尾 4 位', async () => {
    const writeText = stubClipboard(async () => {});
    renderPanel(E03[0], { entries: E03 });
    await clickCopy('copy-json');
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).not.toContain('FAKEkeyDoNotUse');
    expect(copied).toContain('ab12'); // 尾 4 位仍在，排障要靠它区分是哪把 key
    expect(copied).toContain('••••');
  });

  /** 整份夹具逐条扫一遍，任何一条的两个复制通道都不许漏出明文 */
  it('K8 · 03 号夹具每一条的正文与原始 JSON 都不含明文 key', () => {
    for (const e of E03) {
      expect(bodyOf(e)).not.toContain('FAKEkeyDoNotUse');
      expect(e.rawPretty).not.toContain('FAKEkeyDoNotUse');
    }
  });

  /** §9.1 要求让用户**知道**自己粘出去的是遮蔽过的，所以这句是常显不是 toast */
  it('K9 · 脱敏说明常显，不依赖任何交互', () => {
    renderPanel(patch);
    expect(screen.getByTestId('copy-note').textContent).toBe(
      '复制出去的是脱敏后的文本，密钥仍是遮蔽的',
    );
  });

  /**
   * 没有正文的记录不该给一个复制出空串的按钮（原始 JSON 永远有，所以那个留着）。
   * 四份夹具里恰好没有正文为空的记录（实测），所以这条用现成条目改出来——
   * 但它不是假想场景：`ui.noBody` 那条分支本来就是为这种记录准备的。
   */
  it('K10 · 正文为空时不出现「复制正文」，「复制原始 JSON」照常在', () => {
    const empty: Entry = { ...E01[11], preview: '' };
    renderPanel(empty);
    expect(screen.queryByTestId('copy-body')).toBeNull();
    expect(screen.queryByTestId('copy-json')).not.toBeNull();
  });

  /**
   * 回退路径靠 `.copy-sink` 这个 class 把 textarea 挪出视口。
   * `display:none` / `visibility:hidden` 的元素**选不中**，execCommand 会复制到空——
   * 这不是理论问题，是这条路的标准踩法。CSS 里必须是「挪走」而不是「隐藏」。
   */
  it('K11 · .copy-sink 用离屏定位而不是 display:none（隐藏元素选不中）', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/styles/detail.css'), 'utf8');
    const i = css.indexOf('.copy-sink {');
    expect(i).toBeGreaterThan(-1);
    const body = css.slice(i, css.indexOf('}', i));
    expect(body).toContain('position: fixed');
    expect(body).not.toContain('display: none');
    expect(body).not.toContain('visibility: hidden');
  });
});

// ═══════════════════════════════════════════════════════════════════
// N 组 · F20 大内容按 markdown 标题分段
// ═══════════════════════════════════════════════════════════════════

describe('N · F20 分段（纯函数）', () => {
  /** 分段是显示方式不是内容加工：拼回去必须一字不差，否则复制/搜索都会失真 */
  it('N1 · 各段拼起来等于原文，一个字符都不丢', () => {
    const text = bodyOf(E01[3]);
    const parts = splitSections(text);
    expect(parts.map((s) => s.text).join('\n')).toBe(text);
  });

  /** offset 是 React key 的依据，指错了会让相邻段共用状态（点 A 展开 B） */
  it('N1b · 每段的 offset 指向它在原文里的真实位置，且各不相同', () => {
    const text = bodyOf(E01[3]);
    const parts = splitSections(text);
    for (const s of parts) expect(text.slice(s.offset, s.offset + s.text.length)).toBe(s.text);
    expect(new Set(parts.map((s) => s.offset)).size).toBe(parts.length);
  });

  /** 01 索引 3 是 AGENTS.md 注入：23 041 字符、29 个标题、无前言 → 29 段 */
  it('N2 · 01 索引 3（23 041 字符）切成 29 段', () => {
    const text = bodyOf(E01[3]);
    expect(text.length).toBe(23041);
    expect(splitSections(text)).toHaveLength(29);
  });

  /** 01 索引 2 的第一行不是标题，那一段前言必须自成一段，不能被吞掉 */
  it('N3 · 01 索引 2（10 467 字符）= 前言 1 段 + 2 个标题 = 3 段，首段标签取前言首行', () => {
    const parts = splitSections(bodyOf(E01[2]));
    expect(parts).toHaveLength(3);
    expect(parts[0].heading).toBeNull();
    expect(parts[0].label).toBe('<skills_instructions>');
    expect(parts[1].heading).toBe('## Skills');
    expect(parts[1].level).toBe(2);
  });

  /** 没有标题就不切——硬切等长块会把句子拦腰截断，比截断更糟 */
  it('N4 · 01 索引 4（34 310 字符、0 个标题）切不出段，返回空数组', () => {
    const text = bodyOf(E01[4]);
    expect(text.length).toBe(34310);
    expect(splitSections(text)).toEqual([]);
  });

  /** 围栏里的 shell/Python 注释长得就像标题，照切会把脚本劈碎 */
  it('N5 · ``` 围栏内的 `# 注释` 不当标题', () => {
    const text = ['# 真标题', '', '```bash', '# 这是注释', 'echo hi', '```', '', '## 第二个真标题', 'x'].join('\n');
    const parts = splitSections(text);
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toContain('# 这是注释');
  });

  /** `#hashtag`（井号后没空格）不是 markdown 标题 */
  it('N6 · `#` 后面没空格不算标题', () => {
    expect(splitSections('#hashtag\nbody\n')).toEqual([]);
  });
});

describe('N · F20 分段（面板）', () => {
  /** 大内容默认就是分段视图——这才是 F20 的意义，不是藏在开关后面 */
  it('N7 · 01 索引 3 默认渲染分段视图，29 个段头，段数标注为「29 段」', () => {
    renderPanel(E01[3]);
    expect(screen.getByTestId('body-sections')).toBeTruthy();
    expect(screen.getAllByTestId('section-head')).toHaveLength(29);
    expect(screen.getByTestId('section-count').textContent).toBe('29 段');
    // 分段视图下不该再有整段的截断提示
    expect(screen.queryByTestId('expand-all')).toBeNull();
  });

  /** 首段展开（一进来就有东西看），其余折叠（其余是目录） */
  it('N8 · 首段默认展开、其余默认折叠，点第二段能展开出正文', () => {
    renderPanel(E01[3]);
    const heads = () => screen.getAllByTestId('section-head');
    expect(heads()[0].getAttribute('aria-expanded')).toBe('true');
    expect(heads()[1].getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByTestId('section-body')).toHaveLength(1);

    fireEvent.click(heads()[1]);
    expect(heads()[1].getAttribute('aria-expanded')).toBe('true');
    const bodies = screen.getAllByTestId('section-body');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].textContent).toContain('# Rust/codex-rs');
  });

  /** 「整段」切回原来的截断视图，两个视图共存但**不是**两层下钻 */
  it('N9 · 切到「整段」回到截断 2000 + 「展开全部」', () => {
    renderPanel(E01[3]);
    fireEvent.click(screen.getByTestId('view-whole'));
    expect(screen.queryByTestId('body-sections')).toBeNull();
    expect(screen.getByTestId('detail-content').textContent).toHaveLength(DETAIL_TRUNCATE);
    fireEvent.click(screen.getByTestId('expand-all'));
    expect(screen.getByTestId('detail-content').textContent).toHaveLength(23041);
  });

  /**
   * ★ 8 846 字符那条通篇只有开头一个标题，切出来只有一段——
   * 把全文塞进唯一一个折叠没有任何导航价值，反而多一次点击。判据是**段数 ≥ 2**。
   * 这同时保住了验收 F12 对这一条的断言（截断 2000 + 「展开全部」）。
   */
  it('N10 · 03 索引 7（8 846 字符、只切出 1 段）退回截断视图，不出现分段开关', () => {
    const text = bodyOf(E03[7]);
    expect(text.length).toBe(8846);
    expect(splitSections(text)).toHaveLength(1);

    renderPanel(E03[7], { entries: E03 });
    expect(screen.queryByTestId('body-sections')).toBeNull();
    expect(screen.queryByTestId('view-sections')).toBeNull();
    expect(screen.getByTestId('detail-content').textContent).toHaveLength(DETAIL_TRUNCATE);
    expect(screen.queryByTestId('expand-all')).not.toBeNull();
  });

  /** 长但没有标题的（34 310 字符的 world_state）同样退回截断 */
  it('N11 · 没有标题的超长正文退回截断视图', () => {
    renderPanel(E01[4]);
    expect(screen.queryByTestId('body-sections')).toBeNull();
    expect(screen.getByTestId('detail-content').textContent).toHaveLength(DETAIL_TRUNCATE);
  });

  /** 短正文根本不进这条路——分段开关不该在 58 字符的条目上出现 */
  it('N12 · 小条目不出现分段开关', () => {
    renderPanel(E01[11]);
    expect(screen.queryByTestId('view-sections')).toBeNull();
    expect(screen.queryByTestId('body-sections')).toBeNull();
  });

  /**
   * 折叠起来的段等于「搜不到」，用户会以为没有。段头挂命中数就是那条去路
   * （和 RawJson 给树视图挂搜索提示是同一个理由）。
   */
  it('N13 · 面板内搜索时，命中的段在段头标出命中数', () => {
    renderPanel(E01[3]);
    fireEvent.change(screen.getByTestId('detail-search'), { target: { value: 'ratatui' } });
    const badges = screen.getAllByTestId('section-hits');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].textContent).toMatch(/^\d+ 处$/);
    // 只有真正含这个词的段才挂角标，不是每段都挂
    expect(badges.length).toBeLessThan(screen.getAllByTestId('section-head').length);
  });

  /**
   * ★ F13 · 下钻恰好两层。分段折叠是**本层内部导航**（§14.8 的口径），
   *   所以它不许打 data-drill——面板里带 data-drill 的永远只有「原始 JSON」。
   */
  it('N14 · 分段视图下 data-drill 仍然恰好 1 个（原始 JSON）', () => {
    const { container } = renderPanel(E01[3]);
    const drills = [...container.querySelectorAll('[data-drill]')];
    expect(drills).toHaveLength(1);
    expect((drills[0] as HTMLElement).dataset.testid).toBe('rawjson-toggle');
  });

  /** 视图切换用 aria-pressed 而不是 aria-expanded：它不是下钻，是换个看法 */
  it('N15 · 分段/整段开关用 aria-pressed 标注', () => {
    renderPanel(E01[3]);
    expect(screen.getByTestId('view-sections').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-whole').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('view-whole'));
    expect(screen.getByTestId('view-sections').getAttribute('aria-pressed')).toBe('false');
  });
});
