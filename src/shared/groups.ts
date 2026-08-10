/**
 * 显示层分组（SPEC §6.3）：12 个数据层 kind → 6 个显示组。
 *
 * 原则：颜色只承载语义，不做装饰。符号 ●○▶⚠· 独立于颜色，
 * 灰度下也要能区分（验收 F21）。
 *
 * 色值走 CSS 变量（--g-input 等，定义在 styles/global.css），
 * 这里只放语义与符号，避免颜色在两处各写一份。
 */
import type { DisplayGroup, EntryKind } from './types';
import type { MsgKey } from './i18n';

export function kindToGroup(kind: EntryKind): DisplayGroup {
  switch (kind) {
    case 'user':
    case 'context':
    case 'session':
      return 'input';
    case 'reasoning':
      return 'think';
    case 'tool_call':
    case 'tool_out':
      return 'act';
    case 'assistant':
      return 'output';
    case 'error':
      return 'error';
    case 'usage':
    case 'state':
    case 'lifecycle':
    case 'other':
    default:
      return 'meta';
  }
}

export interface GroupMeta {
  id: DisplayGroup;
  /**
   * 底部状态栏显示的名字，**是翻译 key 不是人话**。
   * 这个模块被 main 与 renderer 共用，而语言是渲染时才知道的（见 shared/i18n.ts）。
   */
  labelKey: MsgKey;
  /** 不依赖颜色的标记符号（§6.2） */
  symbol: string;
  /** CSS 变量名，供 style 用 */
  cssVar: string;
}

/** 顺序即底部状态栏的显示顺序（验收 F14） */
export const GROUPS: GroupMeta[] = [
  { id: 'input', labelKey: 'group.input', symbol: '●', cssVar: '--g-input' },
  { id: 'think', labelKey: 'group.think', symbol: '○', cssVar: '--g-think' },
  { id: 'act', labelKey: 'group.act', symbol: '▶', cssVar: '--g-act' },
  { id: 'output', labelKey: 'group.output', symbol: '●', cssVar: '--g-output' },
  { id: 'meta', labelKey: 'group.meta', symbol: '·', cssVar: '--g-meta' },
  { id: 'error', labelKey: 'group.error', symbol: '⚠', cssVar: '--g-error' },
];

export const GROUP_BY_ID: Record<DisplayGroup, GroupMeta> = Object.fromEntries(
  GROUPS.map((g) => [g.id, g]),
) as Record<DisplayGroup, GroupMeta>;
