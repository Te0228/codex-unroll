/**
 * 空状态拖放区（§6.4 / F23 / F24）。
 *
 * 拖放是一等入口，不是附属功能：主区整块都是放置目标，
 * 并显式显示扫描目录路径，让「为什么左栏是空的」可自查。
 * （窗口任意位置的 drop 由 App 兜底处理。）
 */
import { useT } from '../i18n';

export interface DropZoneProps {
  sessionsDir: string;
  dragOver: boolean;
  onOpenDialog: () => void;
}

export function DropZone({ sessionsDir, dragOver, onOpenDialog }: DropZoneProps) {
  const { t } = useT();
  return (
    <div className={`dropzone${dragOver ? ' over' : ''}`} data-testid="dropzone">
      <div className="dropzone-box">
        <span className="dropzone-icon" aria-hidden="true">
          📜
        </span>
        <span className="dropzone-title">{t('ui.dropTitle')}</span>
        <span>
          {t('ui.orPickLeft')}{' '}
          <button className="link-btn" onClick={onOpenDialog}>
            {t('ui.openShortcut')}
          </button>
        </span>
      </div>
      <span className="dropzone-dir mono" data-testid="scan-dir">
        {t('ui.scanDir', { dir: sessionsDir || '~/.codex/sessions' })}
      </span>
    </div>
  );
}
