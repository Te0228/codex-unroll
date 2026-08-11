/**
 * 面板内搜索（⌘F）的高亮与计数。
 *
 * 从 DetailPanel 里挪出来，理由只有一个：**分段视图（F20）也要用它**，
 * 而 BodySections 反过来 import DetailPanel 会形成循环依赖。
 * 这两个函数本来就是纯的，没有任何面板状态，独立成文件最干净。
 *
 * ★ 高亮**不改变文本本身**——`<mark>` 只是包在外面，
 *   `textContent` 与复制出去的内容仍然是原文（F18 依赖这一点）。
 */
import type { ReactNode } from 'react';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 大小写不敏感的出现次数。空查询恒为 0（不是「全部命中」） */
export function countHits(text: string, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  return text.toLowerCase().split(q.toLowerCase()).length - 1;
}

/** 命中处包 `<mark>`，其余原样返回 */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part,
  );
}
