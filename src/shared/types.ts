/**
 * 主进程与渲染进程共用的类型契约（SPEC §7.3、§8）。
 *
 * ⚠️ 这个文件是三条实现线（shared 归一化 / main IPC / renderer UI）的唯一交汇点。
 *    改这里等于改契约，改之前先确认另外两侧。
 */
import type { ProjectRef } from './project';

export type { ProjectRef };

// ─────────────────────────────────────────────────────────────
// 数据源（§3.2.1 统一信封）
// ─────────────────────────────────────────────────────────────

/**
 * rollout 每行的统一信封。5 种记录都长这样，字段一律在 payload 里，
 * 顶层只有 timestamp / type / payload 三个键。
 *
 * 区别只在于 event_msg / response_item 的 payload 带 `type` 作为二级判别式，
 * session_meta / turn_context / world_state 不带。
 */
export interface RolloutRecord {
  timestamp?: string;
  /** 开放集合——未知值必须照常处理，不能丢弃（§3.4） */
  type: string;
  payload?: Record<string, unknown> & { type?: string };
}

// ─────────────────────────────────────────────────────────────
// 时间线条目（§8）
// ─────────────────────────────────────────────────────────────

/** 数据层分类，12 个，保持稳定；显示层再收敛到 6 组（§6.3） */
export type EntryKind =
  | 'session'
  | 'context'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_out'
  | 'lifecycle'
  | 'usage'
  | 'state'
  | 'error'
  | 'other';

/** 显示层分组，6 组（§6.3）。颜色与符号挂在这一层。 */
export type DisplayGroup = 'input' | 'think' | 'act' | 'output' | 'meta' | 'error';

/** 时间线上的一条。所有文本字段都已脱敏（§9.1）。 */
export interface Entry {
  /** 0 起，按过滤空行后的顺序 */
  index: number;
  /** 缺失时为空字符串，不是 undefined（验收 A9） */
  timestamp: string;
  /** session_meta / event_msg / response_item / … */
  topType: string;
  /** user_message / function_call / …；顶层记录无二级判别式时为 '' */
  payloadType: string;
  kind: EntryKind;
  /** 单行标题，如 '→ apply_patch'（验收 C12 / D5） */
  title: string;
  /** 正文。时间线截断显示，详情面板全量显示。已脱敏。 */
  preview: string;
  callId?: string;
  turnId?: string;
  /** 已脱敏的原始记录 */
  raw: unknown;
  /** JSON.stringify(已脱敏的 raw, null, 2)——验收 B7 查这个 */
  rawPretty: string;
}

/** 会话级摘要（§8）。渲染顶部状态条 + 会话头条目的详情面板。 */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  cliVersion: string;
  provider: string;
  /**
   * git 远端与分支，取自 session_meta.payload.git。
   * 用来推导「项目」身份——Codex 在磁盘上按 `sessions/YYYY/MM/DD/` 存，
   * 完全不按项目组织，项目归属只能从这里重建（§6.6）。
   */
  repositoryUrl?: string;
  branch?: string;
  model: string;
  effort: string;
  approval: string;
  sandbox: string;
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** 会话列表项。主进程只读文件头若干字节生成，不全量解析（§10.2）。 */
export interface SessionListItem {
  path: string;
  mtime: number;
  size: number;
  model?: string;
  cwd?: string;
  cliVersion?: string;
  /** 首条用户消息，截断 120 字符；已脱敏 */
  firstUser?: string;
  /**
   * 项目身份，左栏分组用（§12 Q3）。见 shared/project.ts。
   * ⚠️ 与 model/firstUser 不同：**每一项都要有**，不受「只摘要最近 N 个」的限制，
   *    否则超出上限的会话会全部掉进「未知项目」组。
   */
  project?: ProjectRef;
}

// ─────────────────────────────────────────────────────────────
// IPC 契约（§7.3）——preload 暴露的就是这 8 个，不多不少（验收 E7）
// ─────────────────────────────────────────────────────────────

export interface ListSessionsResult {
  codexHome: string;
  sessionsDir: string;
  items: SessionListItem[];
}

export interface ReadSessionResult {
  path: string;
  /** 已过滤空行（验收 E5） */
  lines: string[];
  /** 文件字节数，作为实时跟随的起点 offset（验收 E4） */
  size: number;
}

export interface AppendPayload {
  path: string;
  lines: string[];
}

export interface ResetPayload {
  path: string;
}

export interface UnrollAPI {
  /** 扫描 $CODEX_HOME/sessions，按 mtime 倒序。目录不存在返回空数组（E1/E2/E3） */
  listSessions(): Promise<ListSessionsResult>;
  /** 读整个文件，返回原始行 + 字节数 */
  readSession(file: string): Promise<ReadSessionResult>;
  /** 从 fromOffset 起跟随新增内容 */
  watchSession(file: string, fromOffset: number): Promise<{ ok: boolean; error?: string }>;
  unwatchSession(): Promise<void>;
  /** 新增行推送；返回取消订阅函数 */
  onAppend(cb: (p: AppendPayload) => void): () => void;
  /** 文件被截断/重建，需重读 */
  onReset(cb: (p: ResetPayload) => void): () => void;
  openFileDialog(): Promise<string | null>;
  revealInFinder(file: string): Promise<void>;
}

/** IPC 通道名，主进程与 preload 共用，避免写错字符串 */
export const IPC = {
  listSessions: 'unroll:listSessions',
  readSession: 'unroll:readSession',
  watchSession: 'unroll:watchSession',
  unwatchSession: 'unroll:unwatchSession',
  openFileDialog: 'unroll:openFileDialog',
  revealInFinder: 'unroll:revealInFinder',
  /** 主 → 渲染 */
  onAppend: 'unroll:append',
  onReset: 'unroll:reset',
} as const;

declare global {
  interface Window {
    unroll: UnrollAPI;
  }
}
