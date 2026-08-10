/**
 * rollout JSONL 的归一化纯函数（SPEC §3.4、§8）。
 *
 * 三条原则（§3.4），实现时不要打折：
 *   · 宽松解析：`payload.type` 是开放集合，未知值降级为 'other' 照常显示
 *   · 坏行不致命：单行 JSON 解析失败 → 一条 `_parse_error` 条目保留原文，继续解析后续行
 *   · 字段全部可选：所有读取都有默认值，缺字段不崩
 *
 * 统一信封（§3.2.1）：5 种记录字段一律在 `payload` 里，顶层只有
 * timestamp / type / payload。event_msg 与 response_item 的 payload 多一个
 * `type` 作为二级判别式，其余三种没有。
 */
import type { Entry, EntryKind, RolloutRecord, SessionSummary } from './types';
import type { MsgParams, Text } from './i18n';
import { ref } from './i18n';
import { redactDeep } from './redact';

/** 坏行的判别式，同时占据顶层 type 与 payload.type（验收 A4） */
export const PARSE_ERROR = '_parse_error';

// ─────────────────────────────────────────────────────────────
// 小工具：一切读取都有默认值
// ─────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

function joinParts(parts: (string | undefined)[], sep = ' · '): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

/** `content` 既可能是字符串，也可能是 `{type, text}[]`（§3.3） */
function textFromContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isPlainObject(item)) return str(item.text);
        return '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * `function_call.arguments` 是 **JSON 字符串**，展示前要二次解析成格式化对象，
 * 而不是原样展示带转义的字符串（验收 D6）。解析失败就退回原文。
 */
function prettyArgs(v: unknown): string {
  if (isPlainObject(v) || Array.isArray(v)) return JSON.stringify(v, null, 2);
  const s = str(v);
  if (!s) return '';
  try {
    const parsed: unknown = JSON.parse(s);
    if (isPlainObject(parsed) || Array.isArray(parsed)) return JSON.stringify(parsed, null, 2);
  } catch {
    /* 不是合法 JSON，按纯文本展示 */
  }
  return s;
}

/** 工具结果的 output 可能是字符串，也可能被包了一层 */
function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isPlainObject(v)) {
    const inner = str(v.output) || str(v.text) || textFromContent(v.content);
    if (inner) return inner;
    return JSON.stringify(v, null, 2);
  }
  if (Array.isArray(v)) return textFromContent(v);
  return '';
}

// ─────────────────────────────────────────────────────────────
// parseLine
// ─────────────────────────────────────────────────────────────

/**
 * 单行 → 统一信封。**坏行降级为 `_parse_error` 记录，不抛异常**（验收 A4）。
 * 原文保留在 `payload.text`，脱敏在 toEntry 里统一做。
 */
export function parseLine(line: string, lineno: number): RolloutRecord {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isPlainObject(parsed)) throw new Error('not a JSON object');
    // 展开而不是只取三个键：顶层若有额外字段，原始 JSON 面板里也要看得到
    const rec = { ...parsed } as RolloutRecord & Record<string, unknown>;
    rec.type = str(parsed.type);
    if (typeof parsed.timestamp !== 'string') delete rec.timestamp;
    rec.payload = isPlainObject(parsed.payload) ? parsed.payload : undefined;
    return rec;
  } catch {
    return {
      type: PARSE_ERROR,
      payload: { type: PARSE_ERROR, lineno, text: line },
    };
  }
}

// ─────────────────────────────────────────────────────────────
// classify
// ─────────────────────────────────────────────────────────────

/**
 * ★ `title` / `preview` 是 `Text` 而不是 `string`：**这一层不产出人话**。
 *   固定文案给出 `MsgRef`（key + 参数），纯数据（工具名、命令输出、模型名）
 *   保持字符串原样。理由见 shared/i18n.ts 的文件头。
 */
export interface Classification {
  kind: EntryKind;
  title: Text;
  preview: Text;
  callId?: string;
  turnId?: string;
}

/** 只把有值的键塞进参数表——`MsgParams` 不接受 undefined，目录函数自己判缺省。 */
function params(entries: Record<string, string | number | undefined>): MsgParams {
  const out: MsgParams = {};
  for (const [k, v] of Object.entries(entries)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** 返回 null 表示「不认识这个 payload.type」，交给上层降级为 'other' */
function classifyEventMsg(p: Record<string, unknown>, payloadType: string): Classification | null {
  switch (payloadType) {
    case 'user_message':
      return { kind: 'user', title: ref('entry.user'), preview: str(p.message) };
    case 'agent_message':
      return { kind: 'assistant', title: ref('entry.assistant'), preview: str(p.message) };
    case 'task_started':
      return {
        kind: 'lifecycle',
        title: ref('entry.taskStarted'),
        preview: joinParts([str(p.turn_id), str(p.collaboration_mode_kind)]),
      };
    case 'task_complete':
      return {
        kind: 'lifecycle',
        title: ref('entry.taskComplete'),
        // 「首字 Nms」那半句是文案，拼接交给目录；数字与模型原话是数据，走参数
        preview: ref(
          'preview.taskComplete',
          params({
            duration: num(p.duration_ms),
            ttft: num(p.time_to_first_token_ms),
            message: str(p.last_agent_message),
          }),
        ),
      };
    case 'token_count': {
      const total = obj(obj(p.info).total_token_usage);
      return {
        kind: 'usage',
        title: ref('entry.usage'),
        preview: ref(
          'preview.tokenCount',
          params({ input: num(total.input_tokens), output: num(total.output_tokens) }),
        ),
      };
    }
    case 'error':
    case 'stream_error':
      return { kind: 'error', title: ref('entry.error'), preview: str(p.message) || JSON.stringify(p) };
    default:
      return null;
  }
}

/**
 * 工具调用的标题。工具名是**数据**（走参数），箭头是排版（在目录里）。
 * 名字缺失时换一条完整文案，而不是给参数塞兜底词——目录函数没法再翻译一次。
 */
function toolTitle(name: unknown): Text {
  const tool = str(name);
  return tool ? ref('entry.toolCall', { tool }) : ref('entry.toolCallUnnamed');
}

/** 同上，null → 降级 'other' */
function classifyResponseItem(p: Record<string, unknown>, payloadType: string): Classification | null {
  switch (payloadType) {
    case 'message': {
      const role = str(p.role);
      const isAssistant = role === 'assistant';
      // ★ 标题分四种角色，而 kind 只有两种——developer / system 在 kind 上被
      //   并进 'user'（§6.3 输入组），所以标题不能从 kind 反推，必须自己判。
      const title = isAssistant
        ? ref('entry.assistant')
        : role === 'developer'
          ? ref('entry.developer')
          : role === 'system'
            ? ref('entry.system')
            : ref('entry.user');
      return {
        kind: isAssistant ? 'assistant' : 'user',
        title,
        preview: textFromContent(p.content),
      };
    }
    case 'reasoning':
      return {
        kind: 'reasoning',
        title: ref('entry.reasoning'),
        preview: textFromContent(p.content) || textFromContent(p.summary),
      };
    // 两条工具路径：function_call 参数在 arguments（JSON 字符串），
    // custom_tool_call 参数在 input（纯文本）。都要支持。
    case 'function_call':
      return { kind: 'tool_call', title: toolTitle(p.name), preview: prettyArgs(p.arguments) };
    case 'custom_tool_call':
      return { kind: 'tool_call', title: toolTitle(p.name), preview: str(p.input) };
    case 'function_call_output':
    case 'custom_tool_call_output':
      return { kind: 'tool_out', title: ref('entry.toolOut'), preview: outputText(p.output) };
    default:
      return null;
  }
}

/** 归类 + 提取展示文本。未知类型一律降级 'other'，绝不丢弃（§3.4）。 */
export function classify(rec: RolloutRecord): Classification {
  const p = obj(rec?.payload);
  const topType = str(rec?.type);
  const payloadType = str(p.type);

  const callId = str(p.call_id) || undefined;
  const turnId =
    str(p.turn_id) || str(obj(p.internal_chat_message_metadata_passthrough).turn_id) || undefined;

  const withIds = (c: Classification): Classification => ({
    ...c,
    ...(callId ? { callId } : {}),
    ...(turnId ? { turnId } : {}),
  });

  if (topType === PARSE_ERROR || payloadType === PARSE_ERROR) {
    const lineno = num(p.lineno);
    return {
      kind: 'error',
      title: lineno === undefined ? ref('entry.parseError') : ref('entry.parseErrorAt', { lineno }),
      preview: str(p.text),
    };
  }

  switch (topType) {
    case 'session_meta':
      return withIds({
        kind: 'session',
        title: ref('entry.sessionStart'),
        preview: joinParts([str(p.cwd), str(p.cli_version), str(p.model_provider)]),
      });
    case 'turn_context':
      return withIds({
        kind: 'context',
        title: ref('entry.turnContext'),
        preview: joinParts([
          str(p.model),
          str(p.effort),
          str(p.approval_policy),
          str(obj(p.sandbox_policy).type),
        ]),
      });
    case 'world_state':
      return withIds({
        kind: 'state',
        title: ref('entry.worldState'),
        preview: JSON.stringify(p, null, 2),
      });
    case 'event_msg': {
      const c = classifyEventMsg(p, payloadType);
      if (c) return withIds(c);
      break;
    }
    case 'response_item': {
      const c = classifyResponseItem(p, payloadType);
      if (c) return withIds(c);
      break;
    }
    default:
      break;
  }

  // 未知顶层 type / 未知 payload.type：降级为「其它」，payloadType 原样保留在 Entry 上。
  // ★ 标题优先回显**原始类型名**——它是数据不是文案，任何语言下都该原样显示，
  //   看的人要靠它认出「Codex 又加了个新记录类型」。两个都没有才退到文案。
  return withIds({
    kind: 'other',
    title: payloadType || topType || ref('entry.unknown'),
    preview: JSON.stringify(p, null, 2),
  });
}

// ─────────────────────────────────────────────────────────────
// toEntry / toEntries
// ─────────────────────────────────────────────────────────────

/**
 * 记录 → 时间线条目。
 * **先脱敏再派生**：title / preview / raw / rawPretty 全部来自脱敏后的记录（验收 B7/B8）。
 */
export function toEntry(rec: RolloutRecord, index: number): Entry {
  const safe = redactDeep(rec);
  const c = classify(safe);
  return {
    index,
    // 缺 timestamp 时是空字符串，不是 undefined（验收 A9）
    timestamp: str(safe?.timestamp),
    topType: str(safe?.type),
    payloadType: str(obj(safe?.payload).type),
    kind: c.kind,
    title: c.title,
    preview: c.preview,
    ...(c.callId ? { callId: c.callId } : {}),
    ...(c.turnId ? { turnId: c.turnId } : {}),
    raw: safe,
    rawPretty: JSON.stringify(safe, null, 2),
  };
}

/** 入口：整份文件的行 → Entry[]。空行不产生条目（验收 A2）。 */
export function toEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.trim() === '') continue;
    entries.push(toEntry(parseLine(line, i + 1), entries.length));
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────
// summarize
// ─────────────────────────────────────────────────────────────

/**
 * 会话级摘要（§8）。所有字段缺失都有兜底，不崩。
 * token 用量取**最后一条** `token_count`；turn_context 取最后一次配置。
 */
export function summarize(entries: Entry[]): SessionSummary {
  const s: SessionSummary = {
    sessionId: '',
    cwd: '',
    cliVersion: '',
    provider: '',
    model: '',
    effort: '',
    approval: '',
    sandbox: '',
  };

  for (const e of entries) {
    const rec = e?.raw as RolloutRecord | undefined;
    const p = obj(rec?.payload);

    switch (e?.topType) {
      case 'session_meta':
        s.sessionId = str(p.session_id) || s.sessionId;
        s.cwd = str(p.cwd) || s.cwd;
        s.cliVersion = str(p.cli_version) || s.cliVersion;
        s.provider = str(p.model_provider) || s.provider;
        // git 远端用来推导「项目」身份（§6.6）。Codex 在磁盘上按日期存，
        // 不按项目——项目归属只能从这里重建。
        s.repositoryUrl = str(obj(p.git).repository_url) || s.repositoryUrl;
        s.branch = str(obj(p.git).branch) || s.branch;
        break;
      case 'turn_context':
        s.model = str(p.model) || s.model;
        s.effort = str(p.effort) || s.effort;
        s.approval = str(p.approval_policy) || s.approval;
        // sandbox_policy 是 internally-tagged：{"type":"read-only"}，读 .type
        s.sandbox = str(obj(p.sandbox_policy).type) || s.sandbox;
        if (!s.cwd) s.cwd = str(p.cwd);
        break;
      case 'event_msg':
        if (e.payloadType === 'task_complete') {
          s.durationMs = num(p.duration_ms) ?? s.durationMs;
          s.ttftMs = num(p.time_to_first_token_ms) ?? s.ttftMs;
        } else if (e.payloadType === 'token_count') {
          const total = obj(obj(p.info).total_token_usage);
          const input = num(total.input_tokens);
          const output = num(total.output_tokens);
          // 覆盖式赋值 → 天然取到最后一条
          if (input !== undefined) s.inputTokens = input;
          if (output !== undefined) s.outputTokens = output;
        }
        break;
      default:
        break;
    }
  }

  return s;
}
