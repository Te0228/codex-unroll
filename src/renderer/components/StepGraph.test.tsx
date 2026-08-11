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
/** 3 Turn / 9 Step，7 对 call_id，末轮故意没有 token_count 与 task_complete（§14.9 S27–S33） */
const F04 = fx('04-multi-turn.jsonl');

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
/** v0.2 的三块量化视图（F15/F16/F17）。用 query* 是因为它们**允许不存在**——
 *  没有工具调用/没有 token_count 时整块不画，「不画」本身就是被断言的行为 */
const toggles = () => screen.queryAllByTestId('turn-toggle');
const timings = () => screen.queryAllByTestId('step-timing');
const timingBars = () => screen.queryAllByTestId('timing-bar');
const timingNotes = () => screen.queryAllByTestId('timing-note');
const tokenRows = () => screen.queryAllByTestId('token-row');
const tokenBars = () => screen.queryAllByTestId('token-bar');
/** 条形图的长度写在 CSS 自定义属性里（CSP 不许行内 style，见 MetricBar.tsx） */
const widths = (els: HTMLElement[]) => els.map((e) => e.style.getPropertyValue('--w'));
const texts = (els: HTMLElement[]) => els.map((e) => e.textContent);
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
   * ★ G6 · **默认全展开**。这里一度默认收起，结果 19 条的会话在图里只显出 10 条，
   * 藏掉了近一半——查看器的职责是「摊开」不是「摘要」。
   * 折叠仍然留着，但要用户自己按。
   */
  it('G6 · 默认展开，前言 7 条全在，aria-expanded 是 true', () => {
    renderGraph(entriesOf(F01));
    const pre = screen.getByTestId('turn-preamble');
    expect(rowIndices(pre)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const toggle = screen.getByTestId('turn-preamble-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('收起上下文 6 条');
  });

  /**
   * ★ G6b · **一条都不能少**。这是「少了很多内容」那次的回归断言：
   * 19 条里，16 条是行、2 条 token_count 在 Step 块尾、1 条 task_complete 在 Turn 尾——
   * 加起来必须正好 19，不许有条目落在任何一个渲染出口之外。
   */
  it('G6b · 默认状态下 19 条全部有归宿：16 行 + 2 块尾 + 1 Turn 尾', () => {
    const es = entriesOf(F01);
    const { container } = renderGraph(es);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-testid="row"]')];
    expect(rows).toHaveLength(16);
    expect(usages()).toHaveLength(2);
    expect(screen.getAllByTestId('turn-end')).toHaveLength(1);
    expect(rows.length + usages().length + 1).toBe(es.length);
    // 且这 16 行的索引恰好是「全部条目 - 两条 token_count - 一条 task_complete」
    expect(rows.map((r) => Number(r.dataset.index))).toEqual(
      es.map((e) => e.index).filter((i) => ![13, 17, 18].includes(i)),
    );
  });

  it('G6c · 点折叠后只留真人输入，aria-expanded 从 true 变 false', () => {
    renderGraph(entriesOf(F01));
    fireEvent.click(screen.getByTestId('turn-preamble-toggle'));
    const toggle = screen.getByTestId('turn-preamble-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 索引 7 = event_msg/user_message，「这一轮为什么开始」折叠了也得看得见
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([7]);
    // 折叠不能是「悄悄藏起来」——要说清藏了几条
    expect(toggle.textContent).toContain('展开上下文 6 条');
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

    // 默认展开：坏行（索引 6）和未知顶层类型（brand_new_top_level_type，索引 5）都在
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // 折叠后仍必须留着坏行——「哪里出问题了」不能被折叠吞掉
    fireEvent.click(screen.getByTestId('turn-preamble-toggle'));
    const shown = rowsIn(screen.getByTestId('turn-preamble'));
    expect(shown.map((r) => r.dataset.index)).toEqual(['2', '6']);
    expect(shown.map((r) => r.dataset.kind)).toEqual(['user', 'error']);
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
    // 默认展开，三条都在
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([0, 1, 2]);
    // 折叠后只留 role=user 那条；developer 那条属于要折起来的噪音
    fireEvent.click(screen.getByTestId('turn-preamble-toggle'));
    expect(rowIndices(screen.getByTestId('turn-preamble'))).toEqual([2]);
    expect(screen.getByTestId('turn-preamble-toggle').textContent).toContain('展开上下文 2 条');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('F15 · 整轮折叠', () => {
  /**
   * G15 · **默认展开**。这条和 G6 同源：§6.8.8「一条都不能少」是回归约束，
   * 不是描述。折叠钮是给长会话准备的省地方手段，但默认值一旦翻过去，
   * 打开文件第一眼看到的就是三行摘要而不是内容——那正是这个项目不做的东西。
   */
  it('G15 · 折叠钮默认是展开态，正文一条不少', () => {
    const es = entriesOf(F01);
    renderGraph(es);
    expect(toggles()).toHaveLength(1);
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
    expect(toggles()[0].getAttribute('aria-label')).toBe('折叠这一轮');
    // G6b 的口径原样复核：16 行 + 2 块尾 + 1 Turn 尾 = 19
    expect(screen.getAllByTestId('row')).toHaveLength(16);
    expect(screen.queryAllByTestId('turn-collapsed')).toHaveLength(0);
  });

  /**
   * G15b · 折叠收的是**正文**，不是这一轮的身份。
   * 头（Turn N · 冻结配置 · N step）和尾（时长 · 首字 · task_complete）必须留着——
   * 否则折叠后的会话看起来像丢了一轮，用户没法判断该展开哪一个。
   */
  it('G15b · 折叠后正文全消失，Turn 头与尾照旧', () => {
    renderGraph(entriesOf(F01));
    fireEvent.click(toggles()[0]);

    // 正文（行 / Step 块 / 块尾用量 / Step 间连接线）全没了。
    // 只数这一轮里的行：会话前言那条 session_meta 在 Turn 之外，折谁都不该影响它
    expect(rowsIn(turns()[0])).toHaveLength(0);
    expect(rowIndices(screen.getByTestId('graph-preamble'))).toEqual([0]);
    expect(screen.queryAllByTestId('step')).toHaveLength(0);
    expect(screen.queryAllByTestId('step-usage')).toHaveLength(0);
    expect(screen.queryAllByTestId('step-link')).toHaveLength(0);
    expect(screen.queryAllByTestId('turn-preamble')).toHaveLength(0);

    // 身份还在：Turn 号、冻结配置、Step 数、以及 Turn 尾的 task_complete
    const turn = turns()[0];
    expect(turn.dataset.collapsed).toBe('1');
    expect(turn.querySelector('.turn-no')!.textContent).toBe('Turn 1');
    expect(turn.querySelector('.turn-config')!.textContent).toBe(
      'deepseek-v4-flash · high · never · read-only',
    );
    expect(turn.querySelector('.turn-steps')!.textContent).toBe('2 step');
    expect(screen.getAllByTestId('turn-end')).toHaveLength(1);
    expect(toggles()[0].getAttribute('aria-expanded')).toBe('false');
    expect(toggles()[0].getAttribute('aria-label')).toBe('展开这一轮');
  });

  /**
   * G15c · **藏了几条必须说出口**。悄悄消失和数据丢失在屏幕上长得一模一样，
   * 而这个查看器唯一的承诺就是「一条都不少」。
   * 实测：01 号夹具这一轮 = 前言 7 + Step1 正文 5 + 块尾 1 + Step2 正文 3 + 块尾 1 = 17，
   * 加上留在 Turn 尾的 task_complete 和会话前言的 session_meta 正好 19。
   */
  it('G15c · 折叠态显示「已折叠 17 条」，与 19 条对得上账', () => {
    const es = entriesOf(F01);
    renderGraph(es);
    fireEvent.click(toggles()[0]);
    expect(screen.getByTestId('turn-collapsed').textContent).toBe('已折叠 17 条');
    // 17（藏起来的）+ 1（Turn 尾的 task_complete）+ 1（会话前言的 session_meta）= 19
    expect(17 + 1 + rowIndices(screen.getByTestId('graph-preamble')).length).toBe(es.length);
  });

  /**
   * G15d · 折叠计数按**全量**算，不按当前可见的算（§6.8.5 第 3 条同一条纪律）。
   * 这个数字回答的是「这一轮有多少条记录」——那是结构属性；
   * 跟着过滤器变的话，同一轮在两个搜索词下会报出两个数，等于这个数字什么也不说明。
   */
  it('G15d · 全部过滤掉，折叠计数仍是 17 条', () => {
    renderGraph(entriesOf(F01), { visible: new Set<number>() });
    fireEvent.click(toggles()[0]);
    expect(screen.getByTestId('turn-collapsed').textContent).toBe('已折叠 17 条');
  });

  /**
   * G15e · 折叠是**每个 Turn 各自**的临时表态（组件内 state，不持久化）。
   * 做成全局开关的话，用户折起看过的第 1 轮，第 3 轮也跟着折——
   * 而他正在读的就是第 3 轮。
   * 04 号夹具三轮各 3/5/1 个 Step，折中间那轮，只该少 5 个。
   */
  it('G15e · 04 号夹具折叠第 2 轮，另外两轮不受影响', () => {
    renderGraph(entriesOf(F04));
    expect(turns()).toHaveLength(3);
    expect(steps()).toHaveLength(9);

    fireEvent.click(toggles()[1]);
    expect(turns()).toHaveLength(3); // Turn 骨架数不变，折的是正文
    expect(steps()).toHaveLength(4); // 9 − 5
    expect(toggles().map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'true']);
    // 实测：Turn 2 的前言 4 条 + 5 个 Step 的正文与块尾共 24 条 = 28
    expect(texts(screen.queryAllByTestId('turn-collapsed'))).toEqual(['已折叠 28 条']);
  });

  /**
   * G15f · 折叠必须是**可逆的**：再点一次，DOM 要和折叠前逐条相同。
   * 折叠若把状态写坏（比如按可见集重算了结构），展开回来就会少行或换序——
   * 这正是「折叠不改变骨架」的实际含义。
   */
  it('G15f · 折叠再展开，行索引与块尾用量逐条复原', () => {
    renderGraph(entriesOf(F01));
    const before = {
      rows: screen.getAllByTestId('row').map((r) => r.dataset.index),
      steps: steps().map((s) => s.dataset.outcome),
      usages: texts(usages()),
    };

    fireEvent.click(toggles()[0]);
    fireEvent.click(toggles()[0]);

    expect(screen.getAllByTestId('row').map((r) => r.dataset.index)).toEqual(before.rows);
    expect(steps().map((s) => s.dataset.outcome)).toEqual(before.steps);
    expect(texts(usages())).toEqual(before.usages);
    expect(screen.queryAllByTestId('turn-collapsed')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('F16 · 工具耗时条', () => {
  /**
   * G16 · 一条工具调用一条横条，长度按 `durationMs / 全会话最长`。
   * 01 号夹具只有一次 apply_patch，实测 161ms（索引 11 → 12 的时间戳差），
   * 它自己就是最长的那条，所以是满格。
   * 没有工具调用的 Step 不画这一块——空标题栏比没有更吵。
   */
  it('G16 · 01 号夹具：Step 1 一条满格的 161ms，Step 2 不画', () => {
    renderGraph(entriesOf(F01));
    expect(timings()).toHaveLength(1);
    expect(steps()[0].querySelector('[data-testid="step-timing"]')).toBeTruthy();
    expect(steps()[1].querySelector('[data-testid="step-timing"]')).toBeNull();

    expect(widths(timingBars())).toEqual(['100.00%']);
    const row = screen.getByTestId('timing-row');
    expect(row.querySelector('.timing-tool')!.textContent).toBe('apply_patch');
    expect(row.querySelector('.timing-value')!.textContent).toBe('161ms');
    // 条本身是 aria-hidden 的装饰，整行的意思由这句话承担
    expect(row.getAttribute('title')).toBe('apply_patch 耗时 161ms');
  });

  /**
   * ★ G16b · **刻度是全会话共用的一把尺子**，不是每个 Step 各自归一化。
   * 04 号夹具里 exec_command 一律 1800ms、apply_patch 一律 500ms。
   * 若各 Step 自己算 100%，那两个只调了 apply_patch 的 Step 会画出满格的条——
   * 比出来的结论正好是反的：0.5s 看着和 1.8s 一样久。
   * 27.78% = 500/1800，这个数字就是「尺子是共用的」的全部证据。
   */
  it('G16b · 04 号夹具 7 条工具调用共用刻度：1800ms 满格，500ms 只有 27.78%', () => {
    renderGraph(entriesOf(F04));
    expect(timings()).toHaveLength(7); // 9 个 Step 里有 7 个调了工具
    expect(widths(timingBars())).toEqual([
      '100.00%', // T1S1 exec_command 1800ms
      '100.00%', // T1S2 exec_command 1800ms
      '27.78%', // T2S1 apply_patch 500ms ← 各自归一化的话这里会是 100%
      '100.00%', // T2S2 exec_command 1800ms
      '27.78%', // T2S3 apply_patch 500ms
      '100.00%', // T2S4 exec_command 1800ms
      '100.00%', // T3S1 exec_command 1800ms（末轮 open，照样有耗时）
    ]);
  });

  /**
   * ★ G16c · **算不出耗时的，绝不画成 0 宽的条**。
   * 一条零宽的条会被读成「瞬间完成」，那是凭空捏造的结论。
   * 两种拿不到的情况文案还不一样，因为对用户意味着的事不一样：
   *   · 只有调用没有结果 → 还没有结果（被中断，或正在跟随）
   *   · 有结果但时间戳缺 → 算不出耗时（数据本身残缺，§14.2 A9：缺失时是空串）
   */
  it('G16c · 缺 durationMs 时给文案而不是零宽条', () => {
    const es = toEntries([
      JSON.stringify({ timestamp: '2026-08-10T09:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'm' } }),
      // 配得上、时间戳齐全：1000ms，撑起刻度
      JSON.stringify({ timestamp: '2026-08-10T09:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' } }),
      JSON.stringify({ timestamp: '2026-08-10T09:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }),
      // 只有调用没有结果
      JSON.stringify({ timestamp: '2026-08-10T09:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{}', call_id: 'c2' } }),
      // 配得上但两侧都没有时间戳
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: 'p', call_id: 'c3' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' } }),
    ]);
    renderGraph(es);

    // 三次调用，只有一条能画：另外两条**没有条**，不是宽度为 0 的条
    expect(screen.getAllByTestId('timing-row')).toHaveLength(3);
    expect(widths(timingBars())).toEqual(['100.00%']);
    expect(texts(timingNotes())).toEqual(['还没有结果', '算不出耗时']);
  });

  /**
   * G16d · 一条都算不出耗时时（没有尺子）**整块不画**，
   * 而不是画一排空槽——空槽同样会被读成「全都是 0」。
   * 但工具调用那一行本身照常在：不画的是度量，不是条目（§6.8.8）。
   */
  it('G16d · maxDuration 为 undefined 时不画任何耗时块', () => {
    const es = toEntries([
      JSON.stringify({ timestamp: '2026-08-10T09:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'm' } }),
      JSON.stringify({ timestamp: '2026-08-10T09:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' } }),
    ]);
    renderGraph(es);
    expect(timings()).toHaveLength(0);
    expect(screen.getAllByTestId('row')).toHaveLength(2); // 条目一条不少
  });

  /**
   * ★ G16e · **度量不随过滤变形**（§6.8.5 第 3 条的推论）。
   * 耗时是从全量 entries 上算的：用户关掉「行动」组只是不想看那两行，
   * 不是想让 161ms 变成「没有数据」。度量跟着过滤器变比不显示更糟——
   * 那是**错的数字**，不是缺的数字。
   */
  it('G16e · 把工具那两行全过滤掉，耗时条照样在', () => {
    renderGraph(entriesOf(F01), { visible: new Set<number>() });
    expect(widths(timingBars())).toEqual(['100.00%']);
    expect(screen.getByTestId('timing-row').querySelector('.timing-value')!.textContent).toBe(
      '161ms',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('F17 · Token 用量图', () => {
  /**
   * ★ G17 · **默认画单步增量，不是累计值**。
   * `total_token_usage` 是**会话累计**（04 号夹具实测 11840 → 24800 → … → 128620），
   * 直接画会得到一条永远向上的斜线，看着像每步都在暴涨，其实只是累计量在累计。
   * 第一个 Step 的增量等于它本身（前面没有基线），第二个才看得出差别：
   * 12960 而不是 24800——这两个数字就是「画的是增量」的全部证据。
   */
  it('G17 · 04 号夹具默认画增量：第 2 步是 12960，不是累计的 24800', () => {
    renderGraph(entriesOf(F04));
    const chart = screen.getByTestId('token-chart');
    expect(chart.dataset.mode).toBe('delta');
    // 9 个 Step 一根柱，末轮那步没等到 token_count（§14.9 S31），也占一行
    expect(tokenRows()).toHaveLength(9);

    const inputs = tokenRows().map((r) => r.querySelectorAll('.token-val')[0].textContent);
    expect(inputs).toEqual([
      '11840', // 首个点没有基线，增量 = 累计值本身
      '12960',
      '13920',
      '15300',
      '16740',
      '18020',
      '19480',
      '20360',
      '—', // 末轮被中断，没有 token_count：**不是 0**，是「不知道」
    ]);
    // 累计值一个都不该出现在增量模式里
    expect(chart.textContent).not.toContain('24800');
    expect(chart.textContent).not.toContain('128620');
  });

  /**
   * G17b · 切到累计仍然要能看——「这个会话总共烧了多少」是另一个合法问题。
   * 切换只换数字与刻度，行数（= Step 数）不变。
   */
  it('G17b · 点「累计」切到 total_token_usage 原值，aria-pressed 跟着翻转', () => {
    renderGraph(entriesOf(F04));
    fireEvent.click(screen.getByTestId('token-mode-total'));

    expect(screen.getByTestId('token-chart').dataset.mode).toBe('total');
    expect(screen.getByTestId('token-mode-total').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('token-mode-delta').getAttribute('aria-pressed')).toBe('false');
    expect(tokenRows()).toHaveLength(9);

    const inputs = tokenRows().map((r) => r.querySelectorAll('.token-val')[0].textContent);
    expect(inputs[1]).toBe('24800');
    expect(inputs[7]).toBe('128620');
    // 累计模式的刻度是最大的那个累计值，末点满格
    expect(widths(tokenBars())[14]).toBe('100.00%'); // 第 8 行的输入柱（每行 2 根）
  });

  /**
   * ★ G17c · 说明**常显**，不是 tooltip。
   * 用户迟早会把图上的数字和详情面板里那条 token_count 的原文对照，
   * 对不上的时候必须当场有解释，否则他只会以为哪一边算错了。
   */
  it('G17c · 「累计值 vs 做差」的说明一直显示在图旁边', () => {
    renderGraph(entriesOf(F04));
    expect(screen.getByTestId('token-note').textContent).toBe(
      'total_token_usage 是整个会话的累计值，单步数字是做差得到的',
    );
    // 切到累计模式也不撤——那正是最容易误读的模式
    fireEvent.click(screen.getByTestId('token-mode-total'));
    expect(screen.getByTestId('token-note')).toBeTruthy();
  });

  /**
   * ★ G17d · **负增量不许夹到 0**。
   * 会话被 compact 压缩后计数会回落，负值本身就是「这里发生过一次压缩」的信号，
   * 抹平成 0 等于把唯一的线索删掉。柱长按绝对值给（60% = 12000/20000），
   * 负号照实印出来，另有一个独立于颜色的 data-sign（灰度下也分得开，同 F21）。
   */
  it('G17d · 手搓一次压缩：−12000 照实显示，柱子按绝对值给长度', () => {
    const tokenCount = (input: number, output: number) =>
      JSON.stringify({
        timestamp: '2026-08-10T09:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: input, output_tokens: output } },
        },
      });
    const es = toEntries([
      JSON.stringify({ timestamp: '2026-08-10T09:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'm' } }),
      JSON.stringify({ timestamp: '2026-08-10T09:00:01.000Z', type: 'response_item', payload: { type: 'reasoning', content: 'a' } }),
      tokenCount(20000, 500),
      JSON.stringify({ timestamp: '2026-08-10T09:00:02.000Z', type: 'response_item', payload: { type: 'reasoning', content: 'b' } }),
      tokenCount(8000, 300), // ← 压缩后回落
    ]);
    renderGraph(es);

    const vals = tokenRows().map((r) => texts([...r.querySelectorAll<HTMLElement>('.token-val')]));
    expect(vals).toEqual([
      ['20000', '500'],
      ['-12000', '-200'], // 负号在，没有被 Math.max(0, …) 吃掉
    ]);
    // 刻度是绝对值里最大的 20000：−12000 占 60%，绝不是 0 宽
    expect(widths(tokenBars())).toEqual(['100.00%', '2.50%', '60.00%', '1.00%']);
    expect(tokenBars().map((b) => b.dataset.sign)).toEqual([
      undefined,
      undefined,
      'neg',
      'neg',
    ]);
  });

  /**
   * G17e · 一个 token_count 都没有的会话**整块不画**。
   * 画一排空槽会被读成「用量是 0」，那是彻头彻尾的假话——
   * 同 F16 的口径：0 和「不知道」必须分得开。
   */
  it('G17e · 没有任何用量数据时不画图', () => {
    const es = toEntries([
      JSON.stringify({ timestamp: '2026-08-10T09:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'm' } }),
      JSON.stringify({ timestamp: '2026-08-10T09:00:01.000Z', type: 'response_item', payload: { type: 'reasoning', content: 'a' } }),
    ]);
    renderGraph(es);
    expect(screen.queryByTestId('token-chart')).toBeNull();
    // 空图更不该画（G11 的空态文案不能被图表挤掉）
    cleanup();
    render(
      <StepGraph graph={buildGraph([])} visible={new Set<number>()} selectedIndex={null} onSelect={() => {}} total={0} />,
    );
    expect(screen.queryByTestId('token-chart')).toBeNull();
  });

  /**
   * ★ G17f · 图表统计的是**全量** Step，不是可见条目（§6.8.5 第 3 条）。
   * 顺带钉住 F15 与 F17 不打架：整轮折叠折的是正文，
   * 会话级的用量图不该跟着少几根柱——那会让「哪一步最贵」的答案随折叠而变。
   */
  it('G17f · 全部过滤掉、三轮全折起来，9 根柱一根不少', () => {
    renderGraph(entriesOf(F04), { visible: new Set<number>() });
    expect(tokenRows()).toHaveLength(9);
    for (const b of toggles()) fireEvent.click(b);
    expect(screen.queryAllByTestId('step')).toHaveLength(0);
    expect(tokenRows()).toHaveLength(9);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('metrics.css 的两条硬约束（§9 CSP / §6.8.4.1 连线）', () => {
  const metricsCss = readFileSync(
    join(process.cwd(), 'src/renderer/styles/metrics.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里提到这两个词，先摘掉免得误伤

  /**
   * 图的干线与接线画在元素框外面（负 left），**任何祖先加 overflow: hidden
   * 都会把它们裁没**。这个坑在 global.css 里踩过两次（.turn-head 裁掉菱形、
   * .step 裁掉接线），新加的容器同理。
   * 唯一允许的例外是叶子文本的省略号截断——所以要求它必须与 text-overflow 成对。
   */
  it('G18 · overflow: hidden 只出现在做省略号截断的叶子文本上', () => {
    const offenders = metricsCss
      .split('}')
      .filter((block) => block.includes('overflow: hidden'))
      .filter((block) => !block.includes('text-overflow: ellipsis'))
      .map((block) => block.trim().split('\n')[0]);
    expect(offenders).toEqual([]);
  });

  /** 条形图的长度只能来自 CSSOM 写进去的 --w，CSS 里不许写死宽度把它盖掉 */
  it('G18b · .metric-fill 的宽度读的是自定义属性 --w', () => {
    const i = metricsCss.indexOf('.metric-fill {');
    expect(i).toBeGreaterThan(-1);
    expect(metricsCss.slice(i, metricsCss.indexOf('}', i))).toContain('width: var(--w, 0%)');
  });
});
