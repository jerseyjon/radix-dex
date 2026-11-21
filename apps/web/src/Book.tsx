import { useState } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import type { MarketTrade } from './api';
import { ladder } from './book';
import { fmtAmount, fmtPrice } from './format';

const ROWS = 11;
const clock = (sec: number) => {
  const d = new Date(sec * 1000), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour12: false }) : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

export function Book({ depth, trades, explorer, baseSymbol, quoteSymbol, onPick }: {
  depth: Depth | undefined; trades: MarketTrade[] | undefined; explorer: string; baseSymbol: string; quoteSymbol: string; onPick: (price: number) => void;
}) {
  const [tab, setTab] = useState<'book' | 'trades'>('book');
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
      <header className="panel-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'on' : ''} onClick={() => setTab('book')}>Order book</button>
          <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button>
        </div>
        <span className="muted small">{tab === 'book' ? 'pools + limit orders' : 'on this exchange'}</span>
      </header>
      {tab === 'book' ? <>
        <div className="book-cols small muted"><span>Price ({quoteSymbol})</span><span>Size ({baseSymbol})</span><span>Total</span></div>
        <div className="book-side asks">{[...asks].reverse().map(row('ask'))}</div>
        <div className="book-mid">
          <strong>{fmtPrice(depth?.mid)}</strong>
          <span className="muted small">{spread === undefined ? (depth ? 'one-sided' : 'loading…') : `spread ${spread.toFixed(2)}%`}</span>
        </div>
        <div className="book-side bids">{bids.map(row('bid'))}</div>
        {depth && !asks.length && !bids.length && <p className="empty">No liquidity found for this market.</p>}
      </> : <>
        <div className="book-cols small muted"><span>Price ({quoteSymbol})</span><span>Size ({baseSymbol})</span><span>Time</span></div>
        <div className="trade-list">
          {(trades ?? []).map((t) => (
            <a key={t.txid} className={`book-row ${t.side === 'buy' ? 'bid' : 'ask'}`} href={`${explorer}/transaction/${t.txid}`} target="_blank" rel="noreferrer" title={`${t.side === 'buy' ? 'Bought' : 'Sold'} ${baseSymbol}. Open the transaction.`}>
              <span className="p">{fmtPrice(t.price)}</span>
              <span>{fmtAmount(t.size)}</span>
              <span className="src">{clock(t.time)}</span>
            </a>
          ))}
          {trades === undefined && <p className="empty">Loading…</p>}
          {trades?.length === 0 && <p className="empty">No trades on this exchange in this market yet.</p>}
        </div>
      </>}
    </section>
  );
}
