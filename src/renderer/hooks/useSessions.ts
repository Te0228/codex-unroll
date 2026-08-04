/**
 * 左栏会话列表（F1）。
 *
 * 渲染进程没有 fs，全部走 window.unroll.listSessions()。
 * 测试环境里 window.unroll 可能不存在——一律降级为空列表，不抛。
 */
import { useCallback, useEffect, useState } from 'react';
import type { SessionListItem } from '../../shared/types';

export interface SessionsState {
  items: SessionListItem[];
  codexHome: string;
  sessionsDir: string;
  loading: boolean;
  error: string | null;
  /** `r` 键刷新（§6.5） */
  reload: () => void;
}

export function useSessions(): SessionsState {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [codexHome, setCodexHome] = useState('');
  const [sessionsDir, setSessionsDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const api = window.unroll;
    if (!api?.listSessions) return;
    let cancelled = false;
    setLoading(true);
    api
      .listSessions()
      .then((r) => {
        if (cancelled) return;
        // 主进程已按 mtime 倒序（E1），这里不重排，免得掩盖主进程的错
        setItems(r.items ?? []);
        setCodexHome(r.codexHome ?? '');
        setSessionsDir(r.sessionsDir ?? '');
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { items, codexHome, sessionsDir, loading, error, reload };
}
