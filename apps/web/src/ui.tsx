// Small presentational pieces shared by the panels: the logo, a few line icons, and quiet
// placeholders for loading and empty states. Inline SVG only, nothing fetched from elsewhere.

export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 8 16 12 12 16 8 12Z" fill="currentColor" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="brand" aria-label="Radix DEX">
      <Mark />
      <span className="wordmark" aria-hidden="true">Radix<span>DEX</span></span>
    </div>
  );
}

const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4',
  chevron: 'm7 10 5 5 5-5',
  warn: 'M12 4 2.8 19.5h18.4L12 4Zm0 6v4.5m0 2.5v.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v5m0-8.5v.01',
  inbox: 'M4 13h4.5l1.5 2.5h4l1.5-2.5H20M4 13l2.5-7h11l2.5 7v5.5H4V13Z',
  external: 'M14 4h6v6m0-6-8 8M18 14v5H5V6h5',
} as const;

export function Icon({ name, size = 14 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg className={`icon icon-${name}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** A quiet empty state: a faint icon over one line of text. */
export function Empty({ children, icon = 'inbox' }: { children: React.ReactNode; icon?: keyof typeof PATHS }) {
  return <div className="empty"><Icon name={icon} size={20} /><p>{children}</p></div>;
}

/** Placeholder rows shaped like the table they stand in for, while data loads. */
export function SkeletonRows({ rows, label }: { rows: number; label: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
      ))}
    </div>
  );
}

/**
 * A row of tabs with the keyboard behaviour screen-reader users expect: one tab stop, arrow keys
 * (and Home/End) move between tabs, and each tab names the panel it controls.
 */
export function Tabs<T extends string>({ label, value, onChange, items, panelId }: {
  label: string; value: T; onChange: (v: T) => void; items: [T, React.ReactNode][]; panelId: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex(([k]) => k === value);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : undefined;
    if (next === undefined || i < 0) return;
    e.preventDefault();
    const k = items[(next + items.length) % items.length]![0];
    onChange(k);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${k}"]`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map(([k, content]) => (
        <button key={k} role="tab" data-tab={k} id={`${panelId}-tab-${k}`} aria-selected={k === value} aria-controls={panelId}
          tabIndex={k === value ? 0 : -1} className={k === value ? 'on' : ''} onClick={() => onChange(k)}>{content}</button>
      ))}
    </div>
  );
}

/** The panel a `Tabs` row controls. It adds no box of its own, so the panel's layout is unchanged. */
export function TabPanel({ id, value, children }: { id: string; value: string; children: React.ReactNode }) {
  return <div className="tabpanel" role="tabpanel" id={id} aria-labelledby={`${id}-tab-${value}`}>{children}</div>;
}
