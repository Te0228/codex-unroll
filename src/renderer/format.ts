/**
 * 显示层的小工具：时间/体积/时长格式化、kind 短标签、搜索匹配。
 *
 * 放在渲染进程而不是 shared/：这些是纯显示决策（中文标签、截断长度），
 * 数据层不关心。全是纯函数，直接单测。
 */
import type { Entry, EntryKind } from '../shared/types';

/** ISO 时间戳 → HH:MM:SS（§6.2 的 8ch 时间列）。缺失时给等宽占位。 */
export function formatClock(ts: string): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 会话列表用的日期：MM-DD HH:MM */
export function formatStamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * kind → 时间线的类型列短标签（§6.2 的 4ch 列）。
 * 一律两个汉字，保证列宽稳定、行不会因文字长短而抖动。
 */
export const KIND_LABEL: Record<EntryKind, string> = {
  session: '会话',
  context: '轮次',
  user: '用户',
  assistant: '模型',
  reasoning: '推理',
  tool_call: '工具',
  tool_out: '结果',
  lifecycle: '周期',
  usage: '用量',
  state: '状态',
  error: '异常',
  other: '其它',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as EntryKind] ?? '其它';
}

/**
 * 压成单行：换行/制表/连续空白全部折成一个空格。
 * ★ 这一步必须做——preview 里带 \n 的话，即使 white-space: nowrap
 *   也会被浏览器当作换行符渲染成一行内的断点，破坏 F2 的等高约束。
 */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 时间线行里塞进 DOM 的摘要长度上限。视觉截断靠 CSS 省略号，这里只是别把 11 000 字符塞进 DOM。 */
export const ROW_PREVIEW_MAX = 240;

export function rowPreview(preview: string): string {
  const s = oneLine(preview);
  return s.length > ROW_PREVIEW_MAX ? `${s.slice(0, ROW_PREVIEW_MAX)}…` : s;
}

/** 详情面板正文的默认截断长度（§10.2：~2000 字符 + 「展开全部」） */
export const DETAIL_TRUNCATE = 2000;

/**
 * 全文搜索（F7）：标题 + 正文 + 原始 JSON，大小写不敏感。
 * 搜的是**脱敏后**的文本，所以搜尾 4 位（`ab12`）能命中（F17 / B10）。
 */
export function matchesQuery(entry: Entry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.preview.toLowerCase().includes(q) ||
    entry.rawPretty.toLowerCase().includes(q) ||
    entry.payloadType.toLowerCase().includes(q) ||
    entry.topType.toLowerCase().includes(q)
  );
}

/** 从路径取文件名（渲染进程拿不到 path 模块，手写） */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}
