/**
 * 详情面板内的「原始 JSON」段（§6.1）——下钻的第二层，也是最后一层。
 *
 * 默认折叠（F9：aria-expanded === 'false'）。展开后有两个视图：
 *   · **树**（默认，react-json-view-lite 渲染）：可折叠、按类型着色、
 *     JSON 字符串已二次解析（F19）
 *   · **原文**：就是 rawPretty 那一坨 <pre>，整段复制时要用
 *
 * 内容是 rollout.ts 脱敏后的 raw / rawPretty——用户复制粘贴的就是这份，
 * 所以 §9.1 的脱敏必须覆盖到它（验收 B7）。这里不再做任何密钥处理。
 *
 * F13 的下钻层数只数「时间线 → 详情面板 → 原始 JSON」，
 * 树内部的展开属于本层内部导航，不计入。本段的总开关带 data-drill 标记，
 * 测试据此断言「顶层可折叠区段恰好 1 个」。
 */
import { useState } from 'react';
import { JsonTree, type ExpandMode } from './JsonTree';

export interface RawJsonProps {
  pretty: string;
  /** 已脱敏的原始记录对象；不是对象/数组时只提供原文视图 */
  value?: unknown;
  /** 详情面板的搜索词。搜索够不到树里折叠的节点，有词时要给出去处 */
  query?: string;
}

type View = 'tree' | 'text';

export function RawJson({ pretty, value, query = '' }: RawJsonProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('tree');
  const [mode, setMode] = useState<ExpandMode>('auto');

  const canTree = typeof value === 'object' && value !== null;
  const showTree = canTree && view === 'tree';

  return (
    <section className="rawjson" data-testid="rawjson">
      <button
        className="rawjson-toggle"
        aria-expanded={open}
        aria-controls="rawjson-body"
        data-testid="rawjson-toggle"
        data-drill="rawjson"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>原始 JSON</span>
      </button>

      {/*
       * 面板搜索（⌘F）只覆盖正文，够不到原始 JSON；树视图还会把值藏进折叠节点，
       * 用户很容易以为「搜不到 = 没有」。有搜索词时直接给一条去路。
       */}
      {query.trim() !== '' && showTree && (
        <p className="rawjson-hint" data-testid="rawjson-search-hint">
          <span>搜索不覆盖原始 JSON，树里折叠的值也看不到</span>
          <button
            type="button"
            className="link-btn"
            data-testid="rawjson-goto-text"
            onClick={() => {
              setOpen(true);
              setView('text');
            }}
          >
            在原文视图中查看
          </button>
        </p>
      )}

      {open && (
        <>
          <div className="rawjson-bar">
            {canTree && (
              <div className="rawjson-views" role="group" aria-label="原始 JSON 视图">
                <ViewBtn id="tree" view={view} onPick={setView} label="树" />
                <ViewBtn id="text" view={view} onPick={setView} label="原文" />
              </div>
            )}
            {showTree && (
              <>
                <span className="spacer" />
                <button
                  type="button"
                  className="link-btn"
                  data-testid="rawjson-expand-all"
                  onClick={() => setMode('all')}
                >
                  全部展开
                </button>
                <button
                  type="button"
                  className="link-btn"
                  data-testid="rawjson-collapse-all"
                  onClick={() => setMode('none')}
                >
                  全部折叠
                </button>
              </>
            )}
          </div>

          {showTree ? (
            <div className="rawjson-tree" id="rawjson-body" data-testid="rawjson-body">
              <JsonTree value={value} mode={mode} />
            </div>
          ) : (
            <pre className="rawjson-pre" id="rawjson-body" data-testid="rawjson-body">
              {pretty}
            </pre>
          )}
        </>
      )}
    </section>
  );
}

function ViewBtn({
  id,
  view,
  onPick,
  label,
}: {
  id: View;
  view: View;
  onPick: (v: View) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`rawjson-view${view === id ? ' on' : ''}`}
      // aria-pressed 而不是 aria-expanded：这是视图切换，不是又一层下钻
      aria-pressed={view === id}
      data-testid={`rawjson-view-${id}`}
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  );
}
