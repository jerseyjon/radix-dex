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
