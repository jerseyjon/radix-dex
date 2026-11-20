import type { Depth } from '@radix-dex/core/browser';
import { ladder } from './book';
import { fmtAmount, fmtPrice } from './format';

const ROWS = 11;

export function Book({ depth, baseSymbol, quoteSymbol, onPick }: { depth: Depth | undefined; baseSymbol: string; quoteSymbol: string; onPick: (price: number) => void }) {
  const asks = ladder(depth?.asks ?? [], ROWS);
  const bids = ladder(depth?.bids ?? [], ROWS);
  const max = Math.max(asks[asks.length - 1]?.total ?? 0, bids[bids.length - 1]?.total ?? 0, 1e-18);
  const spread = asks[0] && bids[0] ? ((asks[0].price - bids[0].price) / ((asks[0].price + bids[0].price) / 2)) * 100 : undefined;

  const row = (side: 'ask' | 'bid') => (l: (typeof asks)[number], i: number) => (
    <button key={side + i} className={`book-row ${side}`} onClick={() => onPick(l.price)} title={`Liquidity from ${l.sources.join(', ')}`}>
      <span className="bar" style={{ width: `${(l.total / max) * 100}%` }} />
      <span className="p">{fmtPrice(l.price)}</span>
      <span>{fmtAmount(l.size)}</span>
      <span className="src">{l.sources[0] === 'orders' ? '●' : ''}{fmtAmount(l.total)}</span>
    </button>
  );

  return (
    <section className="panel book">
      <header className="panel-head"><h2>Order book</h2><span className="muted small">pools + limit orders</span></header>
      <div className="book-cols small muted"><span>Price ({quoteSymbol})</span><span>Size ({baseSymbol})</span><span>Total</span></div>
      <div className="book-side asks">{[...asks].reverse().map(row('ask'))}</div>
      <div className="book-mid">
        <strong>{fmtPrice(depth?.mid)}</strong>
        <span className="muted small">{spread === undefined ? (depth ? 'one-sided' : 'loading…') : `spread ${spread.toFixed(2)}%`}</span>
      </div>
      <div className="book-side bids">{bids.map(row('bid'))}</div>
      {depth && !asks.length && !bids.length && <p className="empty">No liquidity found for this market.</p>}
    </section>
  );
}
