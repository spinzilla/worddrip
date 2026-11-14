import { useState } from 'react';
import { CircleHelp } from 'lucide-react';

/** 小「？」：长说明收在里面，点一下展开/收起（手机没有悬停，所以用点击）。 */
export default function HelpHint({ text, label = '说明' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`inline-flex min-w-0 flex-col align-middle ${open ? 'basis-full' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={label}
        title={text}
        className="press inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-faint hover:text-ink"
        data-testid="help-hint"
      >
        <CircleHelp size={14} />
      </button>
      {open && <span className="vocab-wrap mt-1 rounded-lg bg-shade px-2.5 py-1.5 text-xs leading-relaxed text-mute" data-testid="help-hint-text">{text}</span>}
    </span>
  );
}
