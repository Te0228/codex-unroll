/**
 * 显示层的小工具：时间/体积/时长格式化、kind 短标签、搜索匹配。
 *
 * 放在渲染进程而不是 shared/：这些是纯显示决策（标签措辞、截断长度），
 * 数据层不关心。全是纯函数，直接单测。
 *
 * ── 为什么这里收 `locale` 而不是收 `t` ──────────────────────────────
 * 本模块**不是组件**，拿不到 `useT()`。两条出路：函数收一个 `locale`，
 * 或者返回 key 让调用方自己翻。这里一律选**收 `locale`，且放在第一个参数**，
 * 理由有三：
 *   1. `matchesQuery` 没得选——它要拿翻译结果去做子串比对，只能自己翻，
 *      不可能把 key 甩给调用方。既然一个函数必须收 `locale`，
 *      整个模块统一收 `locale` 比「一半收 locale 一半返回 key」好读。
 *   2. 参数顺序跟 shared/i18n 的 `resolve(locale, text)` / `translate(locale, key)`
 *      对齐，全仓库一个口径：**要翻译的东西，locale 打头**。
 *   3. 调用方本来就要 `const { locale } = useT()`，传下来零成本；
 *      而返回 key 的方案会让 `t(kindLabel(kind))` 这种嵌套散落到各组件里。
 */
import type { Entry, EntryKind } from '../shared/types';
import type { Locale, MsgKey } from '../shared/i18n';
import { resolve, translate } from '../shared/i18n';

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
 * kind → 时间线的类型列短标签（§6.2 的 4ch 列）用的 key。
 *
 * 措辞由目录负责，这里只管「哪个 kind 对哪条 key」。列宽稳定的约束还在：
 * 中文一律两字、英文一律一个短词，别往目录里塞长词组，否则行会因文字长短而抖动。
 */
export const KIND_KEY: Record<EntryKind, MsgKey> = {
  session: 'kind.session',
  context: 'kind.context',
  user: 'kind.user',
  assistant: 'kind.assistant',
  reasoning: 'kind.reasoning',
  tool_call: 'kind.tool_call',
  tool_out: 'kind.tool_out',
  lifecycle: 'kind.lifecycle',
  usage: 'kind.usage',
  state: 'kind.state',
  error: 'kind.error',
  other: 'kind.other',
};

/**
 * 认不出的 kind 落到 `kind.other`——rollout 是外部数据，将来多出一个 kind
 * 是常态，绝不能因此显示空白（§6.0：摊开，不是隐藏）。
 */
export function kindLabel(locale: Locale, kind: string): string {
  return translate(locale, KIND_KEY[kind as EntryKind] ?? 'kind.other');
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

/**
 * ★ 仍然只收 `string`，不收 `Text`：这是纯排版（压行 + 截断），跟语言无关。
 *   `entry.preview` 现在是 `Text`，调用方先 `rt(entry.preview)` 再传进来——
 *   把 locale 塞进一个只做字符串裁剪的函数是白搭一层依赖。
 */
export function rowPreview(preview: string): string {
  const s = oneLine(preview);
  return s.length > ROW_PREVIEW_MAX ? `${s.slice(0, ROW_PREVIEW_MAX)}…` : s;
}

/** 详情面板正文的默认截断长度（§10.2：~2000 字符 + 「展开全部」） */
export const DETAIL_TRUNCATE = 2000;

/**
 * 全文搜索（F7）：标题 + 正文 + 原始 JSON，大小写不敏感。
 * 搜的是**脱敏后**的文本，所以搜尾 4 位（`ab12`）能命中（F17 / B10）。
 *
 * ★ 为什么必须先 `resolve` 再比对：
 *   `title` / `preview` 现在是 `Text`——固定文案只是一个 `MsgRef`，
 *   里面根本没有人话，`{ key: 'entry.user' }` 拿去 `toLowerCase()` 是类型错误，
 *   就算硬转成串也只会得到 `entry.user` 这种内部标识。
 *   **用户搜的是屏幕上那行字**：界面是中文就该搜到「用户」，
 *   是英文就该搜到「User」，同一条记录在两种语言下命中不同的词，这是对的。
 *   所以搜索必须在**当前 locale**下先把 `Text` 翻成人话，再做子串比对——
 *   搜索结果与眼睛看到的东西必须是同一份文本，否则「搜不到 = 没有」这个
 *   最基本的预期就崩了。locale 也因此不是可选项，必须由调用方传进来。
 */
export function matchesQuery(locale: Locale, entry: Entry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    resolve(locale, entry.title).toLowerCase().includes(q) ||
    resolve(locale, entry.preview).toLowerCase().includes(q) ||
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
