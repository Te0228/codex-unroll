// @vitest-environment jsdom
/**
 * 三个 hook 的单元测试：
 *   useSelection  → F13 / F18 的导航语义、F10 的「再点一次关闭」
 *   useResizable  → F11 的最小宽度钳制
 *   useFollow     → G4 / G5 的滚动判据、G7 的 watcher 回收
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { Entry, UnrollAPI } from '../../shared/types';
import { useSelection } from './useSelection';
import { PANEL_DEFAULT, PANEL_MIN, clampPanelWidth, useResizable } from './useResizable';
import { NEAR_BOTTOM_PX, isNearBottom, useFollow } from './useFollow';

afterEach(() => cleanup());

function e(index: number): Entry {
  return {
    index,
    timestamp: '',
    topType: 'event_msg',
    payloadType: 'agent_message',
    kind: 'assistant',
    title: `t${index}`,
    preview: '',
    raw: {},
    rawPretty: '{}',
  };
}

// ─────────────────────────────────────────────────────────────
describe('useSelection', () => {
  const list = [e(0), e(1), e(2)];

  it('初始未选中——详情面板因此不渲染（F6）', () => {
    const { result } = renderHook(() => useSelection(list));
    expect(result.current.selectedIndex).toBeNull();
    expect(result.current.selected).toBeNull();
  });

  it('j（move +1）在未选中时选第一条，k 在未选中时选最后一条', () => {
    const { result } = renderHook(() => useSelection(list));
    act(() => result.current.move(1));
    expect(result.current.selectedIndex).toBe(0);

    const second = renderHook(() => useSelection(list));
    act(() => second.result.current.move(-1));
    expect(second.result.current.selectedIndex).toBe(2);
  });

  it('到头到尾都夹住，不回卷（列表短，回卷比停住更容易迷路）', () => {
    const { result } = renderHook(() => useSelection(list));
    act(() => result.current.select(2));
    act(() => result.current.move(1));
    expect(result.current.selectedIndex).toBe(2);
    act(() => result.current.select(0));
    act(() => result.current.move(-1));
    expect(result.current.selectedIndex).toBe(0);
  });

  it('F10 · 再选同一条即取消选中（点击行的关闭路径）', () => {
    const { result } = renderHook(() => useSelection(list));
    act(() => result.current.toggle(1));
    expect(result.current.selectedIndex).toBe(1);
    act(() => result.current.toggle(1));
    expect(result.current.selectedIndex).toBeNull();
  });

  it('选中值是 Entry.index 而非可见下标：过滤后仍指向同一条', () => {
    const { result, rerender } = renderHook(({ v }: { v: Entry[] }) => useSelection(v), {
      initialProps: { v: list },
    });
    act(() => result.current.select(2));
    rerender({ v: [e(2)] });
    expect(result.current.selected?.index).toBe(2);
  });

  it('选中项被过滤掉时 selected 变 null（面板自动关闭），move 从头开始', () => {
    const { result, rerender } = renderHook(({ v }: { v: Entry[] }) => useSelection(v), {
      initialProps: { v: list },
    });
    act(() => result.current.select(2));
    rerender({ v: [e(0), e(1)] });
    expect(result.current.selected).toBeNull();
    act(() => result.current.move(1));
    expect(result.current.selectedIndex).toBe(0);
  });

  it('空列表时导航不崩', () => {
    const { result } = renderHook(() => useSelection([]));
    act(() => result.current.move(1));
    expect(result.current.selectedIndex).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe('useResizable · F11 面板宽度', () => {
  it('默认 420px（§6.1）', () => {
    expect(PANEL_DEFAULT).toBe(420);
    const { result } = renderHook(() => useResizable('--test-w'));
    expect(result.current.width).toBe(420);
  });

  it('★ 拖到 200px 被钳制为 320px（最小宽度）', () => {
    expect(clampPanelWidth(200)).toBe(PANEL_MIN);
    expect(PANEL_MIN).toBe(320);
    const { result } = renderHook(() => useResizable('--test-w'));
    act(() => result.current.setWidth(200));
    expect(result.current.width).toBe(320);
  });

  it('上限不超过视口的 70%，别把时间线挤没', () => {
    expect(clampPanelWidth(99999, 1000)).toBe(700);
  });

  it('非法值降级为最小宽度，不产生 NaN 宽度', () => {
    expect(clampPanelWidth(Number.NaN)).toBe(PANEL_MIN);
  });

  it('宽度写到 :root 的自定义属性上（CSSOM，绕开 style-src 限制）', () => {
    const { result } = renderHook(() => useResizable('--test-w'));
    expect(document.documentElement.style.getPropertyValue('--test-w')).toBe('420px');
    act(() => result.current.setWidth(500));
    expect(document.documentElement.style.getPropertyValue('--test-w')).toBe('500px');
  });

  it('pointerdown → move 改变宽度（面板贴右边：宽度 = 视口宽 - 鼠标 x）', () => {
    window.innerWidth = 1200;
    const { result } = renderHook(() => useResizable('--test-w'));
    act(() => result.current.onPointerDown({ clientX: 800 }));
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700 }));
    });
    expect(result.current.width).toBe(500);
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    // 松手后再动鼠标不再改宽度
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }));
    });
    expect(result.current.width).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────
describe('isNearBottom · G4 / G5 的判据（§7.4 第 5 条）', () => {
  it('阈值是 60px', () => {
    expect(NEAR_BOTTOM_PX).toBe(60);
  });

  it('G5 · 用户在底部 → 追加时自动滚', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 845, clientHeight: 100 })).toBe(true);
  });

  it('G4 · 用户在中部 → 不打断阅读', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 100 })).toBe(false);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 839, clientHeight: 100 })).toBe(false);
  });

  it('内容不足一屏时视为在底部', () => {
    expect(isNearBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('useFollow · 订阅与 watcher 生命周期', () => {
  let api: UnrollAPI & Record<string, ReturnType<typeof vi.fn>>;
  let appendCb: ((p: { path: string; lines: string[] }) => void) | null;
  let resetCb: ((p: { path: string }) => void) | null;
  const offAppend = vi.fn();
  const offReset = vi.fn();

  beforeEach(() => {
    appendCb = null;
    resetCb = null;
    offAppend.mockClear();
    offReset.mockClear();
    api = {
      listSessions: vi.fn(),
      readSession: vi.fn(),
      watchSession: vi.fn().mockResolvedValue({ ok: true }),
      unwatchSession: vi.fn().mockResolvedValue(undefined),
      onAppend: vi.fn((cb) => {
        appendCb = cb;
        return offAppend;
      }),
      onReset: vi.fn((cb) => {
        resetCb = cb;
        return offReset;
      }),
      openFileDialog: vi.fn(),
      revealInFinder: vi.fn(),
    } as never;
    window.unroll = api;
  });

  function Harness(props: { enabled: boolean; path: string | null; onAppend: (l: string[]) => void; onReset: () => void }) {
    useFollow({ ...props, offset: 128 });
    return null;
  }

  it('未勾选跟随时不 watch', () => {
    render(<Harness enabled={false} path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />);
    expect(api.watchSession).not.toHaveBeenCalled();
  });

  it('勾选后从 readSession 返回的字节数起跟随（§7.4 第 1 条）', () => {
    render(<Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />);
    expect(api.watchSession).toHaveBeenCalledWith('/a.jsonl', 128);
  });

  it('G7 · 切换会话时旧 watcher 被关掉，再对新文件开一个', () => {
    const { rerender } = render(
      <Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />,
    );
    rerender(<Harness enabled path="/b.jsonl" onAppend={() => {}} onReset={() => {}} />);
    expect(api.unwatchSession).toHaveBeenCalledTimes(1);
    expect(api.watchSession).toHaveBeenLastCalledWith('/b.jsonl', 128);
  });

  it('G7 · 卸载时退订并停止 watch，不泄漏', () => {
    const { unmount } = render(
      <Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />,
    );
    unmount();
    expect(api.unwatchSession).toHaveBeenCalled();
    expect(offAppend).toHaveBeenCalled();
    expect(offReset).toHaveBeenCalled();
  });

  it('onAppend 只处理当前文件的推送（别的文件的残余推送要丢掉）', () => {
    const spy = vi.fn();
    render(<Harness enabled path="/a.jsonl" onAppend={spy} onReset={() => {}} />);
    act(() => appendCb?.({ path: '/other.jsonl', lines: ['x'] }));
    expect(spy).not.toHaveBeenCalled();
    act(() => appendCb?.({ path: '/a.jsonl', lines: ['x'] }));
    expect(spy).toHaveBeenCalledWith(['x']);
  });

  it('G2 · 空推送（半行还没补齐）不触发回调', () => {
    const spy = vi.fn();
    render(<Harness enabled path="/a.jsonl" onAppend={spy} onReset={() => {}} />);
    act(() => appendCb?.({ path: '/a.jsonl', lines: [] }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('G6 · onReset 透传给前端去重读全量', () => {
    const spy = vi.fn();
    render(<Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={spy} />);
    act(() => resetCb?.({ path: '/a.jsonl' }));
    expect(spy).toHaveBeenCalled();
  });

  it('回调换了不重订阅（否则每次渲染都要往主进程收发一轮退订/订阅）', () => {
    const { rerender } = render(
      <Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />,
    );
    rerender(<Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />);
    expect(api.onAppend).toHaveBeenCalledTimes(1);
  });

  it('window.unroll 不存在时（纯浏览器/测试环境）静默降级，不抛', () => {
    (window as { unroll?: UnrollAPI }).unroll = undefined as never;
    expect(() =>
      render(<Harness enabled path="/a.jsonl" onAppend={() => {}} onReset={() => {}} />),
    ).not.toThrow();
  });
});
