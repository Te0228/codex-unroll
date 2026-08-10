/**
 * Entry[] → Session ▸ Turn ▸ Step 的层级切分（SPEC §6.8）。
 *
 * ── 层级来自 Codex 源码，不是我们发明的 ──────────────────────────────
 * `codex-rs/core/src/tasks/mod.rs` 文件头写得很清楚：
 *
 *   Session
 *    └ Task  == Turn == 一个 turn_id == 一个冻结的 TurnContext
 *       └ run_turn   Turn 内的「一趟」（被插话就多一趟）
 *          └ Step    一次模型请求 + 处理它的回答
 *
 * ★ Task 和 Turn 是**同一层**，不是两层——源码原话「它们是同一个东西」。
 *   所以这里只有 Turn，没有 Task。
 *
 * ★「趟」（多次 run_turn）**故意不还原**：rollout 里没有任何标记，
 *   只能靠「Turn 中段冒出 user_message」去猜插话。宁可缺一层，不猜错一层。
 *
 * ── Step 边界怎么定：token_count ────────────────────────────────────
 * rollout 里没有显式的 Step 标记。但 `event_msg/token_count` 是**每次模型请求
 * 之后的用量上报**，天然就是 Step 的收尾。实测三份夹具 + 真实会话共 4 份样本
 * 全部吻合：
 *
 *   turn_context ─────────────────────────────── Turn 开始
 *     reasoning → message → tool_call → tool_out → token_count   ← Step 1
 *     reasoning → message → token_count                          ← Step 2
 *   task_complete ────────────────────────────── Turn 结束
 *
 * 这是**启发式，不是协议保证**。所以退化路径必须是良性的：
 * 一个 token_count 都没有的 Turn 会整体退化成一个 open 状态的 Step，
 * 内容一条不少，只是不分段。绝不因为切不动就丢条目——
 * `flattenGraph(buildGraph(es))` 恒等于 `es`，由单测钉死。
 *
 * ── SQ / EQ 为什么不画 ─────────────────────────────────────────────
 * `protocol/src/protocol.rs` 的 SQ(Submission Queue)/EQ(Event Queue) 里，
 * **SQ 完全不落盘**：rollout 只有 agent 发出来的 Event（= `event_msg`），
 * 没有上层发进去的 `Op`。画一条恒空的队列没有意义，因此只保留 EQ 这一半，
 * 融进 Step 内的条目里。
 */
import type { Entry, EntryKind } from './types';
import { isMsgRef } from './i18n';

// ─────────────────────────────────────────────────────────────
// 判别式：集中在这里，别散落到组件里
// ─────────────────────────────────────────────────────────────

const isEvent = (e: Entry, t: string) => e.topType === 'event_msg' && e.payloadType === t;

const isTaskStarted = (e: Entry) => isEvent(e, 'task_started');
const isTaskComplete = (e: Entry) => isEvent(e, 'task_complete');
const isTokenCount = (e: Entry) => isEvent(e, 'token_count');
const isTurnContext = (e: Entry) => e.topType === 'turn_context';

/**
 * 「模型这一步产出的东西」——Step 从第一条这样的条目开始。
 * 在它之前的（task_started / world_state / turn_context / 用户消息）都是 Turn 前言。
 */
const MODEL_OUTPUT: ReadonlySet<EntryKind> = new Set<EntryKind>([
  'reasoning',
  'assistant',
  'tool_call',
]);

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/**
 * Step 的收场，决定块尾画什么：
 *   · `act`    —— 有工具调用，结果回灌历史，循环继续 ▶
 *   · `answer` —— 只回了消息，模型认为活干完了，出环 ●
 *   · `open`   —— 还没等到 token_count（正在跟随 / 会话被中断）
 */
export type StepOutcome = 'act' | 'answer' | 'open';

export interface StepNode {
  /** Turn 内序号，1 起 */
  no: number;
  /** 正文条目，**不含**收尾的 token_count（它在 usage 里，块尾单独渲染） */
  entries: Entry[];
  /** 收尾的 token_count 条目；块尾点它能进详情面板 */
  usage?: Entry;
  inputTokens?: number;
  outputTokens?: number;
  outcome: StepOutcome;
  /**
   * 本 Step 调用的工具名，块头摘要用。
   * ★ 存**裸工具名**（`exec_command`），不带 `→` 前缀——箭头是排版，
   *   由渲染层加。此前这里直接拿 `entry.title`，等于把排版腌进了数据。
   */
  tools: string[];
  hasError: boolean;
}

export interface TurnNode {
  /** 会话内序号，1 起 */
  no: number;
  turnId?: string;
  /** 冻结配置，取自本 Turn 的 turn_context（§2 血泪教训：sandbox 读 .type） */
  model: string;
  effort: string;
  approval: string;
  sandbox: string;
  /** Turn 开头、第一个 Step 之前的条目 */
  preamble: Entry[];
  steps: StepNode[];
  /** task_complete 条目 */
  end?: Entry;
  durationMs?: number;
  ttftMs?: number;
  /** 没等到 task_complete 就是 open（正在跟随，或会话被中断） */
  status: 'complete' | 'open';
}

export interface SessionGraph {
  /** 第一个 Turn 之前的条目，通常是 session_meta */
  preamble: Entry[];
  turns: TurnNode[];
}

// ─────────────────────────────────────────────────────────────
// 从 raw 读配置（rollout.ts 的小工具没导出，这里按需重写最小版）
// ─────────────────────────────────────────────────────────────

function payloadOf(e: Entry): Record<string, unknown> {
  const raw = e.raw as { payload?: unknown } | undefined;
  const p = raw?.payload;
  return p !== null && typeof p === 'object' && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 工具名。归一化层把它放进标题的参数里（`entry.toolCall` 的 `tool`），
 * 名字缺失时走的是 `entry.toolCallUnnamed`，没有参数——那种情况直接读 payload 兜底。
 */
function toolNameOf(e: Entry): string {
  const title = e.title;
  if (isMsgRef(title) && typeof title.params?.tool === 'string') return title.params.tool;
  return str(payloadOf(e).name);
}

// ─────────────────────────────────────────────────────────────
// 切分
// ─────────────────────────────────────────────────────────────

interface TurnDraft {
  no: number;
  turnId?: string;
  preamble: Entry[];
  steps: StepNode[];
  cur: Entry[] | null;
  end?: Entry;
  sawContext: boolean;
  model: string;
  effort: string;
  approval: string;
  sandbox: string;
  durationMs?: number;
  ttftMs?: number;
}

function newTurn(no: number, turnId?: string): TurnDraft {
  return {
    no,
    ...(turnId ? { turnId } : {}),
    preamble: [],
    steps: [],
    cur: null,
    sawContext: false,
    model: '',
    effort: '',
    approval: '',
    sandbox: '',
  };
}

/**
 * 一个 Turn 是否从这条开始。
 *
 * `task_started` 一定是开头。`turn_context` 要小心：夹具 01 里它出现在
 * task_started **之后**、属于同一个 Turn，不能因为看见它就再切一刀。
 * 只有「还没有 Turn」「已经见过一个 turn_context」「turn_id 变了」这三种
 * 情况才算新 Turn——最后一条是为了兜住没有 task_started 的会话（夹具 03）。
 */
function startsTurn(e: Entry, cur: TurnDraft | null): boolean {
  if (isTaskStarted(e)) return true;
  if (!isTurnContext(e)) return false;
  if (!cur) return true;
  if (cur.sawContext) return true;
  return Boolean(e.turnId && cur.turnId && e.turnId !== cur.turnId);
}

function closeStep(t: TurnDraft, usage?: Entry): void {
  const entries = t.cur ?? [];
  t.cur = null;
  if (entries.length === 0) {
    if (!usage) return;
    // 一条正文都没有的 token_count（两次用量上报连着发时会出现）。
    // ★ 还没有任何 Step 时才能并回前言——前言排在 steps 之前，
    //   已经有 Step 了还往前言塞就会把顺序搞乱，flattenGraph 的恒等性会挂。
    //   所以后一种情况老老实实生成一个只有块尾的退化 Step。
    if (t.steps.length === 0) {
      t.preamble.push(usage);
      return;
    }
  }

  const tools = entries.filter((e) => e.kind === 'tool_call').map(toolNameOf);
  const total = usage ? totalUsage(usage) : undefined;

  t.steps.push({
    no: t.steps.length + 1,
    entries,
    ...(usage ? { usage } : {}),
    ...(total
      ? { inputTokens: num(total.input_tokens), outputTokens: num(total.output_tokens) }
      : {}),
    outcome: outcomeOf(entries, tools.length, usage),
    tools,
    hasError: entries.some((e) => e.kind === 'error'),
  });
}

function outcomeOf(entries: Entry[], toolCount: number, usage?: Entry): StepOutcome {
  // 还没等到用量上报 = 这一步还没收尾（正在跟随，或会话被中断）
  if (!usage) return 'open';
  // 有工具调用 → 结果回灌历史，循环继续。哪怕同一步里模型也说了话，也是 act。
  if (toolCount > 0) return 'act';
  if (entries.some((e) => e.kind === 'assistant')) return 'answer';
  // 既没工具也没回答：循环还在走，只是这一步没有可见产出
  return 'act';
}

function totalUsage(usage: Entry): Record<string, unknown> | undefined {
  const info = payloadOf(usage).info;
  if (info === null || typeof info !== 'object') return undefined;
  const total = (info as Record<string, unknown>).total_token_usage;
  if (total === null || typeof total !== 'object') return undefined;
  return total as Record<string, unknown>;
}

function finish(t: TurnDraft): TurnNode {
  closeStep(t);
  return {
    no: t.no,
    ...(t.turnId ? { turnId: t.turnId } : {}),
    model: t.model,
    effort: t.effort,
    approval: t.approval,
    sandbox: t.sandbox,
    preamble: t.preamble,
    steps: t.steps,
    ...(t.end ? { end: t.end } : {}),
    ...(t.durationMs === undefined ? {} : { durationMs: t.durationMs }),
    ...(t.ttftMs === undefined ? {} : { ttftMs: t.ttftMs }),
    status: t.end ? 'complete' : 'open',
  };
}

/** 入口。`entries` 必须是**未过滤**的全量条目，否则结构会被过滤器打散。 */
export function buildGraph(entries: Entry[]): SessionGraph {
  const preamble: Entry[] = [];
  const turns: TurnNode[] = [];
  let cur: TurnDraft | null = null;

  for (const e of entries) {
    if (startsTurn(e, cur)) {
      if (cur) turns.push(finish(cur));
      cur = newTurn(turns.length + 1, e.turnId);
    }

    if (!cur) {
      preamble.push(e);
      continue;
    }

    if (isTurnContext(e)) {
      cur.sawContext = true;
      const p = payloadOf(e);
      cur.model = str(p.model) || cur.model;
      cur.effort = str(p.effort) || cur.effort;
      cur.approval = str(p.approval_policy) || cur.approval;
      // sandbox_policy 是 internally-tagged：{"type":"read-only"}，读 .type
      const sp = p.sandbox_policy;
      if (sp !== null && typeof sp === 'object') {
        cur.sandbox = str((sp as Record<string, unknown>).type) || cur.sandbox;
      }
      if (!cur.turnId && e.turnId) cur.turnId = e.turnId;
    }

    if (isTaskComplete(e)) {
      closeStep(cur);
      const p = payloadOf(e);
      cur.end = e;
      cur.durationMs = num(p.duration_ms);
      cur.ttftMs = num(p.time_to_first_token_ms);
      turns.push(finish(cur));
      cur = null;
      continue;
    }

    if (isTokenCount(e)) {
      closeStep(cur, e);
      continue;
    }

    if (cur.cur === null && !MODEL_OUTPUT.has(e.kind)) {
      cur.preamble.push(e);
      continue;
    }
    if (cur.cur === null) cur.cur = [];
    cur.cur.push(e);
  }

  if (cur) turns.push(finish(cur));
  return { preamble, turns };
}

/**
 * 把图重新摊平回条目序列。**存在的唯一目的是被单测钉住**：
 * 它必须恒等于 buildGraph 的输入（同样的对象、同样的顺序、一条不少）。
 * 切分是启发式，而「不丢条目」不能是启发式。
 */
export function flattenGraph(g: SessionGraph): Entry[] {
  const out: Entry[] = [...g.preamble];
  for (const t of g.turns) {
    out.push(...t.preamble);
    for (const s of t.steps) {
      out.push(...s.entries);
      if (s.usage) out.push(s.usage);
    }
    if (t.end) out.push(t.end);
  }
  return out;
}

/** 图里的全部 Step 数，底部状态栏显示用 */
export function countSteps(g: SessionGraph): number {
  return g.turns.reduce((n, t) => n + t.steps.length, 0);
}

/**
 * 「这一轮为什么开始」——真人打的字。Turn 前言里只有这一类默认常显。
 *
 * ★ 同一句话有**两种落盘形式**，都要认：
 *     event_msg/user_message                      —— 事件流里的那份
 *     response_item/message + payload.role=user   —— 写进模型历史的那份
 *   只认前者的话，一旦某份 rollout 只写了后者，整个 Turn 前言就一条 lead 都没有，
 *   「为什么开始」会被完全折叠掉。
 *
 * ⚠️ 不能简化成 `kind === 'user'`：归一化把 developer / system 消息也归进
 *   kind='user'（rollout.ts 的 §6.3 输入组口径），而那两类正是要折叠的噪音。
 *
 * ★★ 反直觉的实测事实：**`role === 'user'` 不等于「人打的字」**。
 *   夹具 01 的索引 3 是 Codex 注入的 AGENTS.md 内容，落盘也是 role=user
 *   （`# AGENTS.md instructions for …`）。真正唯一可靠的「人打的字」信号是
 *   `event_msg/user_message`。所以调用方应当**优先只认事件那一份**，
 *   把 response_item 这条当作「一份 event 都没有时」的退路（见 StepGraph 的用法）。
 */
export function isUserInput(e: Entry): boolean {
  if (e.payloadType === 'user_message') return true;
  if (e.topType !== 'response_item' || e.payloadType !== 'message') return false;
  return str(payloadOf(e).role) === 'user';
}
