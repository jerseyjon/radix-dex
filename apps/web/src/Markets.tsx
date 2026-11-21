import { useMemo, useState } from 'react';
import type { MarketSummary } from './api';
import { fmtUsd } from './format';
import { Empty, Icon } from './ui';

export function Markets({ markets, selected, onSelect }: { markets: MarketSummary[]; selected: string | undefined; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? markets.filter((m) => `${m.base.symbol}/${m.quote.symbol} ${m.base.name}`.toLowerCase().includes(f)) : markets;
  }, [markets, filter]);
  return (
    <aside className="panel markets" id="markets-panel" aria-label="Markets">
      <header className="panel-head"><h2 className="panel-title">Markets</h2><span className="count">{markets.length}</span></header>
      <label className="search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Search pairs" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search markets" />
      </label>
      <div className="market-cols" aria-hidden="true"><span>Pair</span><span>Liquidity</span><span>24h vol</span></div>
      <div className="market-list">
        {shown.map((m) => (
          <button key={m.id} className={`market-row ${m.id === selected ? 'on' : ''}`} aria-current={m.id === selected ? 'true' : undefined} onClick={() => onSelect(m.id)}
            title={m.base.name ? `${m.base.name} / ${m.quote.symbol}` : undefined}>
            <span className="pair"><strong>{m.base.symbol}</strong><span className="quote">/{m.quote.symbol}</span></span>
            <span className="num">{fmtUsd(m.tvlUsd)}</span>
            <span className={`num ${m.volume24hUsd > 0 ? '' : 'zero'}`}>{fmtUsd(m.volume24hUsd)}</span>
          </button>
        ))}
        {shown.length === 0 && <Empty icon="search">No markets match.</Empty>}
      </div>
    </aside>
  );
}
