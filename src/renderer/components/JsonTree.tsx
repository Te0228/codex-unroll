/**
 * 原始 JSON 的树视图（§6.1 第二层 / F19）。渲染交给 `react-json-view-lite`。
 *
 * ★ 为什么这个库在 CSP 下是安全的（实测，不是推测）：
 *   dist/index.js 与 index.modern.js 里**行内 style 属性 0 处、insertRule 0 处、
 *   cssText 0 处**，纯 CSS Modules（哈希类名 + 自带 dist/index.css），零运行时依赖。
 *   样式来自打包进来的 CSS 文件，不是运行时注入，所以 `style-src 'self'` 拦不到它。
 *
 * ★ 配色怎么接到我们的六组语义色：
 *   库的 `style` prop 收的是**类名对象**（`Partial<StyleProps>`），
 *   所以直接把 global.css 里我们自己的 class 传进去，比在 CSS 里反向覆盖
 *   `._2T6PJ` 这种哈希类名稳得多——哈希会随库的每次构建变。
 *   这样也顺手解决了深浅色：我们的 class 用 CSS 变量，
 *   `prefers-color-scheme` 一变颜色就跟着变，**不需要运行时在
 *   defaultStyles / darkStyles 之间切**（少一次 matchMedia，也没有首帧闪烁）。
 *
 * ★ 树内部的展开**不算新增下钻层级**（F13）。
 *   它是「原始 JSON」这一层内部的导航，性质等同于时间线内部可以滚动。
 */
import { useMemo } from 'react';
import { JsonView, allExpanded, collapseAllNested, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import { EXPAND_LEVELS, expandNestedJson } from '../jsonTree';

/** 展开策略。「全部展开 / 全部折叠」靠换 key 重挂载生效（预设只在挂载时求值）。 */
export type ExpandMode = 'auto' | 'all' | 'none';

export interface JsonTreeProps {
  value: unknown;
  mode: ExpandMode;
}

/**
 * 只保留库的结构类（缩进、子项容器），颜色与图标全换成我们自己的 class。
 * 图标 class 被替换掉了，所以 ▸ / ▾ 的字形要在 global.css 里自己给（.jt-icon-*::after）。
 */
const STYLE = {
  ...defaultStyles,
  container: 'jt',
  label: 'jt-key',
  clickableLabel: 'jt-key jt-key-click',
  nullValue: 'jt-null',
  undefinedValue: 'jt-null',
  stringValue: 'jt-string',
  numberValue: 'jt-number',
  booleanValue: 'jt-boolean',
  otherValue: 'jt-other',
  punctuation: 'jt-punct',
  expandIcon: 'jt-icon jt-icon-expand',
  collapseIcon: 'jt-icon jt-icon-collapse',
  collapsedContent: 'jt-collapsed',
  // 字符串保持带引号、**不** JSON.stringify——
  // stringify 会把 apply_patch 的换行压成 \n 字面量，正是要避免的
  noQuotesForStringValues: false,
  stringifyStringValues: false,
  quotesForFieldNames: false,
  // 注意库里这个键就是拼错的 ariaLables，别「顺手修正」
  ariaLables: { collapseJson: '折叠', expandJson: '展开' },
};

export function JsonTree({ value, mode }: JsonTreeProps) {
  // 预处理：把 JSON 字符串换成解析后的子树（F19）。库不管这件事。
  const { data, nested } = useMemo(() => {
    const marks = new WeakSet<object>();
    return { data: expandNestedJson(value, marks), nested: marks };
  }, [value]);

  /**
   * ⚠️ 必须 memo：库内部有 `useEffect(..., [shouldExpandNode])`，这个函数一变引用
   *    就**重置所有节点的展开状态**——不 memo 的话，每次重渲染都会把用户
   *    手动折起来的节点弹回去。
   */
  const shouldExpandNode = useMemo(() => {
    if (mode === 'all') return allExpanded;
    if (mode === 'none') return collapseAllNested;
    // 层级内的照常展开；二次解析出来的子树无论多深都展开
    return (level: number, v: unknown) =>
      level < EXPAND_LEVELS || (typeof v === 'object' && v !== null && nested.has(v));
  }, [mode, nested]);

  return (
    <JsonView
      key={mode}
      data={data as object}
      style={STYLE}
      shouldExpandNode={shouldExpandNode}
      aria-label="原始 JSON 树"
    />
  );
}
