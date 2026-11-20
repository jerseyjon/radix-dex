import { useMemo, useState } from 'react';
import type { MarketSummary } from './api';
import { fmtUsd } from './format';

export function Markets({ markets, selected, onSelect }: { markets: MarketSummary[]; selected: string | undefined; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? markets.filter((m) => `${m.base.symbol}/${m.quote.symbol} ${m.base.name}`.toLowerCase().includes(f)) : markets;
  }, [markets, filter]);
  return (
    <aside className="panel markets">
      <header className="panel-head"><h2>Markets</h2><span className="muted small">{markets.length}</span></header>
      <input className="search" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search markets" />
      <div className="market-cols small muted"><span>Pair</span><span>Liquidity</span><span>24h vol</span></div>
      <div className="market-list">
        {shown.map((m) => (
          <button key={m.id} className={`market-row ${m.id === selected ? 'on' : ''}`} onClick={() => onSelect(m.id)}>
            <span className="pair"><strong>{m.base.symbol}</strong><span className="muted">/{m.quote.symbol}</span></span>
            <span>{fmtUsd(m.tvlUsd)}</span>
            <span>{fmtUsd(m.volume24hUsd)}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="empty">No markets match.</p>}
      </div>
    </aside>
  );
}
