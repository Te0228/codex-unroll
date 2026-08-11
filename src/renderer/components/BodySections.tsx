/**
 * 大内容按 markdown 标题分段（SPEC §5 F20）。
 *
 * 起因是 Codex 往上下文里注入的 AGENTS.md：01 号夹具索引 3 是 **23 041 字符 /
 * 29 个标题**的一整块。默认截断到 2000 字符只能看见开头，点「展开全部」又是
 * 一面墙——两种都不是「浏览」。按标题切开之后，它变成一份可点开的目录。
 *
 * ── 三条边界，都不许自作主张 ──────────────────────────────────────
 *
 * 1. **没有标题就不切。** 硬切成等长块只会把句子拦腰截断，比截断更糟。
 *    退回原有的「截断 + 展开全部」（§10.2）。
 *
 * 2. **只有一段也不切。** 8 846 字符那条（03 号夹具索引 7）通篇只有开头一个
 *    `# AGENTS.md instructions for …`，切完就是「把全文塞进唯一一个折叠里」——
 *    没有任何导航价值，反而多一次点击才能看见正文。判据是**段数 ≥ 2**。
 *    这同时保住了验收 F12 对那一条的断言（截断到 2000 + 「展开全部」）。
 *
 * 3. **围栏代码块里的 `# xxx` 不是标题。** shell 注释、Python 注释长这样的太多，
 *    照切会把一段脚本劈成七八块。所以 ``` / ~~~ 之间的行一律跳过。
 *
 * ⚠️ 分段**不是新的一层下钻**（F13）：它是同一段正文的内部导航，
 *    性质等同于时间线可以滚动。所以这里的折叠开关**不打 `data-drill`**，
 *    面板里带 `data-drill` 的永远只有「原始 JSON」那一个（§14.8 已定的口径）。
 */
import { useState } from 'react';
import { useT } from '../i18n';
import { countHits, highlight } from './Highlight';

export interface BodySection {
  /** 标题行原文（含 `#`）。标题前的那一段（前言）没有标题，为 null */
  heading: string | null;
  /** 标题层级 1–6；前言段为 0 */
  level: number;
  /** 折叠时显示的标签：标题去掉 `#`；前言段取第一个非空行 */
  label: string;
  /** 这一段的完整文本（含标题行），展开后原样显示 */
  text: string;
  /**
   * 这一段在原文里的起始字符下标。
   * 有它才有**稳定且唯一**的 React key——标题在 AGENTS.md 里重名是常事
   * （`### Core Rules` 在两个不同的父标题下各来一遍），拿标签当 key 会撞。
   */
  offset: number;
}

const HEADING = /^(#{1,6})\s+(\S.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** 折叠标签的长度上限——标题偶尔会很长（AGENTS.md 里有整句话当标题的） */
const LABEL_MAX = 80;

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX)}…` : one;
}

/**
 * 按 markdown 标题切段。返回的段落**拼起来等于原文**（不丢一个字符），
 * 这条由单测钉死——分段是显示方式，不是内容加工。
 *
 * 没有任何标题时返回空数组，调用方据此退回截断视图。
 */
export function splitSections(text: string): BodySection[] {
  if (!text) return [];
  const lines = text.split('\n');
  const out: BodySection[] = [];
  let buf: string[] = [];
  let heading: string | null = null;
  let level = 0;
  let inFence = false;
  let sawHeading = false;
  /** 当前这一段在原文里的起始下标 */
  let start = 0;
  /** 扫描游标：当前行在原文里的起始下标（+1 是被 split 吃掉的那个 \n） */
  let cursor = 0;

  const flush = () => {
    // 前言全是空白就丢掉，别产生一个点开什么都没有的空段
    if (heading === null && buf.join('').trim() === '') {
      buf = [];
      return;
    }
    const body = buf.join('\n');
    out.push({
      heading,
      level,
      label: heading === null ? clip(firstLine(body)) : clip(heading.replace(/^#{1,6}\s+/, '')),
      text: body,
      offset: start,
    });
    buf = [];
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      flush();
      sawHeading = true;
      heading = line;
      level = m[1].length;
      buf = [line];
      start = cursor;
    } else {
      buf.push(line);
    }
    cursor += line.length + 1;
  }
  flush();

  return sawHeading ? out : [];
}

function firstLine(s: string): string {
  for (const l of s.split('\n')) if (l.trim() !== '') return l;
  return s;
}

export interface BodySectionsProps {
  sections: BodySection[];
  /** 面板内搜索词：命中数标在段头上，否则折叠起来的段等于「搜不到」 */
  query: string;
}

export function BodySections({ sections, query }: BodySectionsProps) {
  const { t } = useT();
  // 首段默认展开：一进来就有东西看，其余是目录
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));

  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="body-sections" data-testid="body-sections">
      {sections.map((s, i) => {
        const isOpen = open.has(i);
        const hits = countHits(s.text, query);
        return (
          <section className="body-section" key={s.offset}>
            <button
              type="button"
              className={`body-section-head lv${s.level}`}
              // aria-expanded 是无障碍的正确标注；它**不是** data-drill，
              // 不参与 F13 的下钻计数（见文件头第 3 条）
              aria-expanded={isOpen}
              data-testid="section-head"
              data-open={isOpen}
              onClick={() => toggle(i)}
            >
              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
              <span className="body-section-label">{s.label}</span>
              {hits > 0 && (
                <span className="body-section-hits" data-testid="section-hits">
                  {t('ui.hits', { n: hits })}
                </span>
              )}
              <span className="body-section-len" title={t('ui.bodyChars', { n: s.text.length })}>
                {s.text.length}
              </span>
            </button>
            {isOpen && (
              <pre className="detail-content mono" data-testid="section-body">
                {highlight(s.text, query)}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}
