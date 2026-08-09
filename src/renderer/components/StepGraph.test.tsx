// @vitest-environment jsdom
/**
 * 「图」视图（SPEC §6.8）的组件验收 —— G 组。
 *
 * ⚠️ 编号说明：这里的 G 是 **Graph**，和 §14.5「实时跟随」的 G 组是两个命名空间。
 *    跟随那组在 App.test.tsx 里，别混。
 *
 * 数据一律来自 test/fixtures/ 的真实夹具，经 shared/rollout 的 toEntries →
 * shared/steps 的 buildGraph，期望值是 §14.9 S 组实测出来的确切数字。
 *
 * ★ 这里**只测组件**：切分逻辑（几个 Turn、几个 Step、outcome 怎么算）已经被
 *   src/shared/steps.test.ts 的 27 条纯函数断言钉死了，重复测一遍没有价值。
 *   这个文件负责的是「切好的图渲染成什么样、点了会怎样」——
 *   尤其是 G7：**结构不随过滤变形**，那是图相对时间线唯一多出来的承诺。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEntries } from '../../shared/rollout';
import { buildGraph } from '../../shared/steps';
import type { Entry } from '../../shared/types';
import { StepGraph } from './StepGraph';
import { MainPane } from './MainPane';
import { useViewMode, VIEW_KEY } from '../hooks/useViewMode';

// jsdom 环境下 import.meta.url 的 base 不可靠，直接用 vitest 的 cwd（仓库根）——同 App.test.tsx
const fx = (name: string) => join(process.cwd(), 'test/fixtures', name);
const F01 = fx('01-apply-patch-rejected.jsonl');
const F03 = fx('03-edge-cases.jsonl');

function entriesOf(path: string): Entry[] {
  return toEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== ''),
  );
}

const allVisible = (es: Entry[]) => new Set(es.map((e) => e.index));

interface Opts {
  visible?: Set<number>;
  selectedIndex?: number | null;
  onSelect?: (index: number) => void;
}

/** 渲染图视图。默认全部可见、无选中——过滤与选中是各条断言自己的变量 */
function renderGraph(entries: Entry[], opts: Opts = {}) {
  return render(
    <StepGraph
      graph={buildGraph(entries)}
      visible={opts.visible ?? allVisible(entries)}
      selectedIndex={opts.selectedIndex ?? null}
      onSelect={opts.onSelect ?? (() => {})}
      total={entries.length}
    />,
  );
}

const turns = () => screen.getAllByTestId('turn');
const steps = () => screen.getAllByTestId('step');
const usages = () => screen.getAllByTestId('step-usage');
/** 图里的行仍然是时间线那一行（§6.0：块只承载结构） */
const rowsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="row"]')];
const rowIndices = (el: HTMLElement) => rowsIn(el).map((r) => Number(r.dataset.index));

beforeEach(() => {
  // jsdom 不实现 scrollIntoView；useAutoScroll 会在选中时调它
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

// vitest 没开 globals，RTL 的自动 cleanup 不生效——不手动清会跨用例串 DOM
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
describe('图的骨架（§6.8）', () => {
  /**
   * G1 是这一组的地基：图渲染出来的块数必须等于 buildGraph 切出来的层级数。
   * 01 号夹具 19 行 = 1 Turn / 2 Step（§14.9 S1）。
   */
  it('G1 · 01 号夹具渲染 1 个 Turn、2 个 Step', () => {
    renderGraph(entriesOf(F01));
    expect(turns()).toHaveLength(1);
    expect(steps()).toHaveLength(2);
    // 会话前言（session_meta）在 Turn 之外单独成段，不该被塞进 Turn 里
    expect(rowIndices(screen.getByTestId('graph-preamble'))).toEqual([0]);
  });

  /**
   * G2 · outcome 是图相对时间线新增的**唯一语义**：这一步是「调工具、循环继续」
   * 还是「收工、出环」。它写在 data-outcome 上，块尾的符号 ▶/● 由它决定，
   * 灰度下也要能区分（同 F21 的原则）。
   */
  it('G2 · Step 的 data-outcome 依次是 act（调工具）/ answer（收工）', () => {
    renderGraph(entriesOf(F01));
    expect(steps().map((s) => s.dataset.outcome)).toEqual(['act', 'answer']);
    // 符号独立于颜色：块尾文字里要有可辨识的符号，不能只靠 class 上色
    expect(steps()[0].querySelector('.step-outcome')!.textContent).toContain('▶');
    expect(steps()[1].querySelector('.step-outcome')!.textContent).toContain('●');
  });

  /**
   * G3 · 连接线是「竖向链」形态的全部载体：N 个 Step 之间恰好 N-1 条。
   * 多一条会在最后一个 Step 后面拖出一根悬空的箭头（看起来像还没跑完），
   * 少一条则两个块糊在一起看不出先后。顺序也要对：step → link → step。
   */
  it('G3 · 两个 Step 之间有且仅有 1 条连接线，且夹在两块中间', () => {
    const { container } = renderGraph(entriesOf(F01));
    expect(screen.getAllByTestId('step-link')).toHaveLength(1);
    const kids = [...container.querySelector('.steps')!.children];
    expect(kids.map((k) => (k as HTMLElement).dataset.testid)).toEqual([
      'step',
      'step-link',
      'step',
    ]);
    // act 收场的那一步，连接线要说清「为什么还要再问一次模型」
    expect(screen.getByTestId('step-link').textContent).toContain('工具结果写回历史');
  });

  /**
   * G4 · token_count 不进块内正文（它在 usage 里），而是渲染成块尾。
   * 但它仍是一条真实条目，必须能点进详情面板——否则用量数据就成了死数字。
   * 期望值 = §14.9 S7 / S8：Step1 16986→187（usage 在索引 13），
   * Step2 34188→263（索引 17，也就是 §14.2 C11 的会话合计）。
   */
  it('G4 · 块尾显示 token 数，点击以 token_count 条目的索引下钻', () => {
    const onSelect = vi.fn();
    renderGraph(entriesOf(F01), { onSelect });
    expect(usages()).toHaveLength(2);
    expect(usages()[0].textContent).toBe('16986 → 187 tok');
    expect(usages()[1].textContent).toBe('34188 → 263 tok');

    fireEvent.click(usages()[0]);
    expect(onSelect).toHaveBeenLastCalledWith(13);
    fireEvent.click(usages()[1]);
    expect(onSelect).toHaveBeenLastCalledWith(17);

    // 块尾的 token_count 不能同时又出现在块内正文里（否则等于渲染了两遍）
    expect(rowIndices(steps()[0])).toEqual([8, 9, 10, 11, 12]);
    expect(rowIndices(steps()[1])).toEqual([14, 15, 16]);
  });

  /**
   * G5 · Turn 头显示的是这一轮**冻结的**配置（§14.9 S4，sandbox 读 .type
   * 而不是把 {"read-only":{}} 的键当值）。顶部状态条只有 model/approval/sandbox，
   * effort 在那里被显式排除（F4b）——图里带上 effort 才能看出「这一轮是高档位跑的」。
   */
  it('G5 · Turn 头显示 model · effort · approval · sandbox', () => {
    renderGraph(entriesOf(F01));
    const head = screen.getByTestId('turn');
    expect(head.querySelector('.turn-config')!.textContent).toBe(
      'deepseek-v4-flash · high · never · read-only',
    );
    expect(head.querySelector('.turn-no')!.textContent).toBe('Turn 1');
    expect(head.querySelector('.turn-steps')!.textContent).toBe('2 step');
    // 见到 task_complete → 状态 complete，块尾给出时长（§14.2 C9/C10）
    expect(head.dataset.status).toBe('complete');
    expect(screen.getByTestId('turn-end')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Turn 前言的折叠（§6.8）', () => {
  /**
   * G6 · 前言里 7 条有 6 条是上下文噪音（task_started / world_state /
   * turn_context / developer 指令）。默认全展开的话，每个 Turn 开头都要滚过
   * 一大坨才看得到模型产出——但「这一轮为什么开始」（user_message）
   * 和「哪里出问题了」（error）必须常显，否则折叠就成了信息丢失。
   */
  it('G6 · 默认只显示用户消息，turn_context / world_state 收在折叠里', () => {
    renderGraph(entriesOf(F01));
    const pre = screen.getByTestId('turn-preamble');
    expect(rowIndices(pre)).toEqual([7]); // 索引 7 = event_msg/user_message
    // 4 = world_state、5 = turn_context、1 = task_started，默认都不在 DOM 里
    expect(rowIndices(pre)).not.toContain(4);
    expect(rowIndices(pre)).not.toContain(5);

    const toggle = screen.getByTestId('turn-preamble-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 折叠不能是「悄悄藏起来」——要说清藏了几条
    expect(toggle.textContent).toContain('上下文 6 条');
  });

  it('G6b · 点开后前言 7 条全部可见，aria-expanded 从 false 变 true', () => {
    renderGraph(entriesOf(F01));
    fireEvent.click(screen.getByTestId('turn-preamble-toggle'));
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(screen.getByTestId('turn-preamble-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('turn-preamble-toggle').textContent).toContain('收起上下文');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('★ 结构不随过滤变形（StepGraph.tsx 文件头第 3 条）', () => {
  /**
   * G7 是这个文件里最重要的一条，也是图和时间线的分水岭。
   *
   * Step 边界正是靠 token_count（元信息组）切出来的。如果图跟着过滤器重切，
   * 用户一关「元信息」，Step 边界当场消失、整个图散架——而他只是想少看点噪音。
   * 所以图必须从**全量** entries 切，过滤只决定哪些行渲染出来。
   *
   * 这里把 visible 缩到只剩「行动组」（01 号夹具 = tool_call 11 + tool_out 12，
   * 即 F15 的那 2 条），断言 Turn / Step 的**数量一条不变**。
   */
  it('G7 · 只留「行动组」两条 → Turn / Step 数量不变，被滤掉的以计数说明', () => {
    const es = entriesOf(F01);
    renderGraph(es, { visible: new Set([11, 12]) });

    expect(turns()).toHaveLength(1);
    expect(steps()).toHaveLength(2);
    expect(steps().map((s) => s.dataset.outcome)).toEqual(['act', 'answer']);
    expect(screen.getAllByTestId('step-link')).toHaveLength(1);

    // 结构还在，内容按过滤器收敛：Step1 5 条留 2 条、Step2 3 条全滤掉
    expect(rowIndices(steps()[0])).toEqual([11, 12]);
    expect(rowIndices(steps()[1])).toEqual([]);
    // 「N 条被过滤」是空块的解释——没有它，空的 Step 2 看起来像数据丢了
    expect(steps().map((s) => s.querySelector('.step-filtered')!.textContent)).toEqual([
      '3 条被过滤',
      '3 条被过滤',
    ]);
    // 块尾的用量不受过滤影响：它是结构的一部分，不是一条普通行
    expect(usages().map((u) => u.textContent)).toEqual(['16986 → 187 tok', '34188 → 263 tok']);
  });

  it('G7b · 全部过滤掉也不塌成空白：Turn / Step 骨架照样在', () => {
    renderGraph(entriesOf(F01), { visible: new Set<number>() });
    expect(turns()).toHaveLength(1);
    expect(steps()).toHaveLength(2);
    expect(screen.queryAllByTestId('row')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('选中态（§6.1 两层下钻的第一跳）', () => {
  /**
   * G8 · 选中高亮走 class 而不是行内 style —— CSP `style-src 'self'` 禁止 inline style，
   * 这不是风格问题，写了在打包产物里会被浏览器直接拒掉。
   */
  it('G8 · selectedIndex 命中的那一行带 selected class，其余不带', () => {
    const { container } = renderGraph(entriesOf(F01), { selectedIndex: 11 });
    const hit = container.querySelector<HTMLElement>('[data-index="11"]')!;
    expect(hit.className).toContain('selected');
    expect(hit.getAttribute('aria-selected')).toBe('true');
    expect(
      [...container.querySelectorAll('.row.selected')].map(
        (r) => (r as HTMLElement).dataset.index,
      ),
    ).toEqual(['11']);
  });

  it('G8b · 选中块尾的 token_count 时高亮的是块尾，不是块内某一行', () => {
    const { container } = renderGraph(entriesOf(F01), { selectedIndex: 13 });
    expect(usages()[0].className).toContain('selected');
    expect(container.querySelectorAll('.row.selected')).toHaveLength(0);
  });

  it('G8c · 点块内的行，以该条目的索引下钻', () => {
    const onSelect = vi.fn();
    const { container } = renderGraph(entriesOf(F01), { onSelect });
    fireEvent.click(container.querySelector('[data-index="11"]')!);
    expect(onSelect).toHaveBeenCalledWith(11);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('MainPane 的视图切换（§6.8）', () => {
  /**
   * MainPane 自己不持有 view（它是受控的），所以这里用 useViewMode 包一层——
   * 「默认是图」这条承诺其实住在那个 hook 里，绕过它就测不到默认值。
   */
  function Harness({ entries }: { entries: Entry[] }) {
    const { view, setView } = useViewMode();
    return (
      <MainPane
        view={view}
        onViewChange={setView}
        graph={buildGraph(entries)}
        total={entries.length}
        visible={entries}
        visibleIndices={allVisible(entries)}
        selectedIndex={null}
        onSelect={() => {}}
      />
    );
  }

  /**
   * G9 · 默认必须是图：图承载 Codex 真实的执行层级（问了几次模型、
   * 每次是调工具还是收工），列表是平的，看不出这个。
   */
  it('G9 · 默认渲染图，没有时间线', () => {
    render(<Harness entries={entriesOf(F01)} />);
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.queryByTestId('timeline')).toBeNull();
    expect(screen.getByTestId('view-graph').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-list').getAttribute('aria-pressed')).toBe('false');
  });

  it('G9b · 点「列表」切到时间线，图消失，aria-pressed 跟着翻转', () => {
    render(<Harness entries={entriesOf(F01)} />);
    fireEvent.click(screen.getByTestId('view-list'));
    expect(screen.getByTestId('timeline')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    expect(screen.getByTestId('view-graph').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('view-list').getAttribute('aria-pressed')).toBe('true');
    // 列表视图渲染全部 19 行（F1），不受图的分块影响
    expect(screen.getAllByTestId('row')).toHaveLength(19);
  });

  it('G9c · 视图偏好是长期表态，写进 localStorage 后重新挂载仍是列表', () => {
    render(<Harness entries={entriesOf(F01)} />);
    fireEvent.click(screen.getByTestId('view-list'));
    expect(localStorage.getItem(VIEW_KEY)).toBe('list');
    cleanup();
    render(<Harness entries={entriesOf(F01)} />);
    expect(screen.getByTestId('timeline')).toBeTruthy();
  });

  /**
   * G10 · 视图条上那句结构摘要是**唯一**允许出现在主区顶部的汇总文字。
   * 它只讲结构（几 turn 几 step），不讲内容——F5 禁的是讲内容的摘要卡片区。
   */
  it('G10 · 视图条显示「1 turn · 2 step」', () => {
    render(<Harness entries={entriesOf(F01)} />);
    expect(screen.getByTestId('viewbar-shape').textContent).toBe('1 turn · 2 step');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('退化路径（§3.4：不认识也不崩）', () => {
  /**
   * G11 · 空图会在两种真实场景下出现：刚拖进来还没解析完、以及整份文件都是空行。
   * 白屏会被当成崩溃，必须给一句人话。
   */
  it('G11 · 空图不崩，给出空态文案', () => {
    render(
      <StepGraph
        graph={buildGraph([])}
        visible={new Set<number>()}
        selectedIndex={null}
        onSelect={() => {}}
        total={0}
      />,
    );
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.queryAllByTestId('turn')).toHaveLength(0);
    expect(screen.getByTestId('graph').textContent).toContain('没有可展示的条目');
  });

  /**
   * G12 · 03 号夹具没有 task_started（Turn 只能靠 turn_context 起，§14.9 S11），
   * 而且第 6 行是故意的坏 JSON。两件事叠在一起是最容易翻车的组合：
   * 坏行既不能让渲染崩，也**不能被折叠藏起来**——「哪里出问题了」是前言常显的理由之一。
   */
  it('G12 · 03 号夹具渲染 1 Turn / 1 Step，坏行默认就可见', () => {
    renderGraph(entriesOf(F03));
    expect(turns()).toHaveLength(1);
    expect(steps()).toHaveLength(1);
    expect(rowIndices(steps()[0])).toEqual([9, 10]); // function_call + function_call_output

    const pre = screen.getByTestId('turn-preamble');
    const shown = rowsIn(pre);
    // 默认可见的恰好是「用户消息 + 坏行」这两类
    expect(shown.map((r) => r.dataset.index)).toEqual(['2', '6']);
    expect(shown.map((r) => r.dataset.kind)).toEqual(['user', 'error']);
    // 未知顶层类型（brand_new_top_level_type，索引 5）不丢，只是收在折叠里
    fireEvent.click(screen.getByTestId('turn-preamble-toggle'));
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /**
   * G13 · **白屏回归**。骨架能兜住「搜不到」是因为 Turn/Step 框还在（G7b），
   * 但会话若一个 Turn 都没有（全是无 Turn 标记的条目，§14.9 S15 的形状），
   * 骨架自己就是空的——此时再把行全过滤掉，主区会整片空白。
   * 列表视图有 emptyHint 顶着（F17b），图视图不能例外。
   */
  it('G13 · 无 Turn 的会话 + 一条都没命中 → 给提示，不白屏', () => {
    const es = toEntries([
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: 'a' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
    ]);
    const graph = buildGraph(es);
    // 前提：这个形状确实没有任何 Turn 骨架可依靠
    expect(graph.turns).toHaveLength(0);
    expect(graph.preamble).toHaveLength(2);

    renderGraph(es, { visible: new Set<number>() });
    expect(screen.getByTestId('graph-empty').textContent).toContain('没有匹配的条目');
    // 「没有可展示的条目」是另一码事（图本身是空的），这里不该出现
    expect(screen.getByTestId('graph').textContent).not.toContain('没有可展示的条目');
  });

  /**
   * G14 · 前言常显的判据。同一句用户输入会落两份
   * （event_msg/user_message + response_item/message role=user），两份都显就是重复噪音；
   * 但只认前者的话，万一某份 rollout 只写了后者，「这一轮为什么开始」会被整个折叠掉。
   * 所以是「有事件那份就只认它，没有才退回 response_item」。
   *
   * ★ 顺带钉住一个反直觉的实测事实（见 §14.9 S25）：role=user **不等于**人打的字，
   *   Codex 注入的 AGENTS.md 也是 role=user。这正是不能反过来只认 response_item 的原因。
   */
  it('G14 · 只有 response_item 形式的用户输入时，前言仍然常显它', () => {
    const es = toEntries([
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1', model: 'm' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: '噪音' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: '帮我改个文件' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: 'a' } }),
    ]);
    renderGraph(es);
    const pre = screen.getByTestId('turn-preamble');
    // 只有 role=user 那条常显；developer 那条收在折叠里
    expect(rowIndices(pre)).toEqual([2]);
    expect(screen.getByTestId('turn-preamble-toggle').textContent).toContain('上下文 2 条');
  });
});
