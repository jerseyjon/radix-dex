import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarketSummary } from './api';
import { fmtUsd } from './format';
import { TOP_MARKETS, nextActive, readShowAll, visibleMarkets, writeShowAll } from './marketlist';
import { Empty, Icon } from './ui';

const storage = () => { try { return window.localStorage; } catch { return undefined; } };

/** The "show all markets" choice, remembered per browser and shared by the list and the picker. */
export function useShowAllMarkets(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readShowAll(storage()));
  const set = useCallback((v: boolean) => { setOn(v); writeShowAll(storage(), v); }, []);
  return [on, set];
}

function RowCells({ m }: { m: MarketSummary }) {
  return <>
    <span className="pair"><strong>{m.base.symbol}</strong><span className="quote">/{m.quote.symbol}</span></span>
    <span className="num">{fmtUsd(m.tvlUsd)}</span>
    <span className={`num ${m.volume24hUsd > 0 ? '' : 'zero'}`}>{fmtUsd(m.volume24hUsd)}</span>
  </>;
}

function ShowAll({ total, hidden, showAll, onToggle }: { total: number; hidden: number; showAll: boolean; onToggle: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button type="button" className="show-all" aria-pressed={showAll} onClick={onToggle}>
      {showAll ? `Show top ${TOP_MARKETS}` : `Show all (${total})`}
      <span className={`caret ${showAll ? 'up' : ''}`}><Icon name="chevron" size={12} /></span>
    </button>
  );
}

export function Markets({ markets, selected, onSelect, showAll, onShowAll }: {
  markets: MarketSummary[]; selected: string | undefined; onSelect: (id: string) => void; showAll: boolean; onShowAll: (on: boolean) => void;
}) {
  const [filter, setFilter] = useState('');
  const { rows, hidden } = useMemo(() => visibleMarkets(markets, { query: filter, showAll, selected }), [markets, filter, showAll, selected]);
  return (
    <aside className="panel markets" id="markets-panel" aria-label="Markets">
      <header className="panel-head"><h2 className="panel-title">Markets</h2><span className="count">{markets.length}</span></header>
      <label className="search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Search all pairs" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search markets" />
      </label>
      <div className="market-cols" aria-hidden="true"><span>Pair</span><span>Liquidity</span><span>24h vol</span></div>
      <div className="market-list">
        {rows.map((m) => (
          <button key={m.id} className={`market-row ${m.id === selected ? 'on' : ''}`} aria-current={m.id === selected ? 'true' : undefined} onClick={() => onSelect(m.id)}
            title={m.base.name ? `${m.base.name} / ${m.quote.symbol}` : undefined}>
            <RowCells m={m} />
          </button>
        ))}
        {rows.length === 0 && <Empty icon="search">No markets match.</Empty>}
        {!filter.trim() && <ShowAll total={markets.length} hidden={hidden} showAll={showAll} onToggle={() => onShowAll(!showAll)} />}
      </div>
    </aside>
  );
}

const PHONE = '(max-width: 760px)';

/**
 * The pair button in the market bar and its dropdown: a search box (focused on open), the deepest
 * markets, and a search over all of them. Picking one calls `onSelect`, the same handler as the list.
 * A combobox: focus stays in the search box, arrow keys move the active row, Enter picks it, Escape
 * closes. On phones it opens as a sheet above the tab bar.
 */
export function PairPicker({ markets, market, onSelect, showAll, onShowAll }: {
  markets: MarketSummary[]; market: MarketSummary; onSelect: (id: string) => void; showAll: boolean; onShowAll: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId().replace(/:/g, '');
  const listId = `pair-list-${uid}`, optId = (i: number) => `pair-opt-${uid}-${i}`;

  const { rows, hidden } = useMemo(() => visibleMarkets(markets, { query, showAll, selected: market.id }), [markets, query, showAll, market.id]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false); setQuery(''); setActive(-1);
    if (refocus) btn.current?.focus();
  }, []);
  const pick = (id: string) => { onSelect(id); close(true); };

  // Anchor under the button (the phone sheet is placed by CSS instead).
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: Math.round(r.bottom + 8), left: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 8 - 420))) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, close, place]);

  // Start on the market on screen when nothing is typed, on the first hit when searching.
  useEffect(() => {
    if (!open) return;
    setActive(query.trim() ? (rows.length ? 0 : -1) : rows.findIndex((m) => m.id === market.id));
  }, [open, query, rows, market.id]);
  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === 'Enter') {
      const m = rows[active];
      if (m) { e.preventDefault(); pick(m.id); }
      return;
    }
    if (e.key === 'Tab') { close(false); return; }
    const n = nextActive(e.key, active, rows.length);
    if (n !== undefined) { e.preventDefault(); setActive(n); }
  };

  const phone = typeof matchMedia === 'function' && matchMedia(PHONE).matches;
  const label = `${market.base.symbol}/${market.quote.symbol}`;

  return (
    <>
      <button ref={btn} type="button" className="pair-btn" onClick={() => (open ? close(false) : setOpen(true))}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={`${label}: choose a market`}>
        <span className="pair-base">{market.base.symbol}</span><span className="pair-quote">/{market.quote.symbol}</span> <span className="caret"><Icon name="chevron" size={14} /></span>
      </button>
      {open && createPortal(
        <>
          <div className="pair-scrim" aria-hidden="true" onClick={() => close(false)} />
          <div ref={pop} className="pair-pop glass" role="dialog" aria-label="Choose a market" style={phone || !pos ? undefined : { top: pos.top, left: pos.left }} onKeyDown={onKeyDown}>
            <label className="search">
              <Icon name="search" size={14} />
              <input ref={input} type="search" placeholder={`Search all ${markets.length} pairs`} value={query} onChange={(e) => setQuery(e.target.value)}
                role="combobox" aria-label="Search markets" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
                aria-activedescendant={active >= 0 && rows[active] ? optId(active) : undefined} autoComplete="off" spellCheck={false} />
            </label>
            <div className="market-cols" aria-hidden="true"><span>Pair</span><span>Liquidity</span><span>24h vol</span></div>
            <ul ref={list} className="pair-list" id={listId} role="listbox" aria-label="Markets">
              {rows.map((m, i) => (
                <li key={m.id} id={optId(i)} role="option" aria-selected={m.id === market.id}
                  className={`market-row ${m.id === market.id ? 'on' : ''} ${i === active ? 'active' : ''}`}
                  title={m.base.name ? `${m.base.name} / ${m.quote.symbol}` : undefined}
                  onPointerMove={() => { if (i !== active) setActive(i); }}
                  onMouseDown={(e) => e.preventDefault() /* keep focus in the search box */}
                  onClick={() => pick(m.id)}>
                  <RowCells m={m} />
                </li>
              ))}
              {rows.length === 0 && <li className="pair-empty" role="presentation"><Empty icon="search">No markets match.</Empty></li>}
            </ul>
            <div className="pair-foot">
              <span className="muted small" aria-live="polite">{query.trim() ? `${rows.length} of ${markets.length} pairs` : showAll || hidden <= 0 ? `All ${markets.length} pairs` : `Top ${Math.min(TOP_MARKETS, rows.length)} by liquidity${rows.length > TOP_MARKETS ? ' + this pair' : ''}`}</span>
              {!query.trim() && <ShowAll total={markets.length} hidden={hidden} showAll={showAll} onToggle={() => { onShowAll(!showAll); input.current?.focus(); }} />}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
