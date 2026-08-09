/**
 * 中栏外壳（SPEC §6.8）：一条 24px 的视图条 + 图/列表本体。
 *
 * 视图条只放切换器和一句结构摘要（N turn · M step）。
 * **不是摘要卡片区**——F5 禁的是顶部状态条下方那种多行卡片，
 * 这里是一行、只讲结构、不讲内容。
 */
import type { Entry } from '../../shared/types';
import type { SessionGraph } from '../../shared/steps';
import { countSteps } from '../../shared/steps';
import type { ViewMode } from '../hooks/useViewMode';
import { Timeline } from './Timeline';
import { StepGraph } from './StepGraph';

export interface MainPaneProps {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  /** 全量条目——图的结构从这里切，不受过滤影响 */
  graph: SessionGraph;
  total: number;
  /** 过滤/搜索后仍可见的条目 */
  visible: Entry[];
  visibleIndices: Set<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

export function MainPane({
  view,
  onViewChange,
  graph,
  total,
  visible,
  visibleIndices,
  selectedIndex,
  onSelect,
}: MainPaneProps) {
  return (
    <main className="main" data-testid="main">
      <div className="viewbar">
        <div className="viewswitch" role="group" aria-label="主区视图">
          <ViewBtn id="graph" view={view} onPick={onViewChange} label="图" />
          <ViewBtn id="list" view={view} onPick={onViewChange} label="列表" />
        </div>
        <span className="spacer" />
        <span className="viewbar-shape" data-testid="viewbar-shape">
          {graph.turns.length} turn · {countSteps(graph)} step
        </span>
      </div>

      {view === 'graph' ? (
        <StepGraph
          graph={graph}
          visible={visibleIndices}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          total={total}
        />
      ) : (
        <Timeline entries={visible} selectedIndex={selectedIndex} onSelect={onSelect} />
      )}
    </main>
  );
}

function ViewBtn({
  id,
  view,
  onPick,
  label,
}: {
  id: ViewMode;
  view: ViewMode;
  onPick: (v: ViewMode) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`viewswitch-btn${view === id ? ' on' : ''}`}
      // aria-pressed 而不是 aria-expanded：这是视图切换，不是下钻
      aria-pressed={view === id}
      data-testid={`view-${id}`}
      onClick={() => onPick(id)}
    >
      {label}
    </button>
  );
}
