/**
 * 详情面板内的「原始 JSON」段（§6.1）——下钻的第二层，也是最后一层。
 *
 * 默认折叠（F9：aria-expanded === 'false'）。
 * 内容是 rollout.ts 脱敏后的 rawPretty——用户复制粘贴的就是这份，
 * 所以 §9.1 的脱敏必须覆盖到它（验收 B7）。
 */
import { useState } from 'react';

export interface RawJsonProps {
  pretty: string;
}

export function RawJson({ pretty }: RawJsonProps) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rawjson" data-testid="rawjson">
      <button
        className="rawjson-toggle"
        aria-expanded={open}
        aria-controls="rawjson-body"
        data-testid="rawjson-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>原始 JSON</span>
      </button>
      {open && (
        <pre className="rawjson-pre" id="rawjson-body" data-testid="rawjson-body">
          {pretty}
        </pre>
      )}
    </section>
  );
}
