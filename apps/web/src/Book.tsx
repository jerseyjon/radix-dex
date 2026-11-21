import { useState } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import type { MarketTrade } from './api';
import { ladder } from './book';
import { fmtAmount, fmtPrice } from './format';
import { Empty, SkeletonRows, TabPanel, Tabs } from './ui';

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
      <span className="src">{l.sources[0] === 'orders' ? <i className="here" aria-label="limit order">●</i> : ''}{fmtAmount(l.total)}</span>
    </button>
  );

  return (
    <section className="panel book">
      <header className="panel-head">
        <Tabs label="Market activity" value={tab} onChange={setTab} panelId="activity-panel" items={[['book', 'Order book'], ['trades', 'Trades']]} />
        <span className="head-note">{tab === 'book' ? 'pools + limit orders' : <><i className="here">●</i> made here</>}</span>
      </header>
      <TabPanel id="activity-panel" value={tab}>
      {tab === 'book' ? <>
        <div className="book-cols"><span>Price ({quoteSymbol})</span><span>Size ({baseSymbol})</span><span>Total</span></div>
        <div className="book-side asks">{depth ? [...asks].reverse().map(row('ask')) : <SkeletonRows rows={ROWS} label="Loading the order book" />}</div>
        <div className="book-mid">
          <strong>{depth ? fmtPrice(depth.mid) : <span className="skeleton mid" />}</strong>
          <span className="head-note">{spread === undefined ? (depth ? 'one-sided' : 'loading…') : <>spread <b>{spread.toFixed(2)}%</b></>}</span>
        </div>
        <div className="book-side bids">{depth ? bids.map(row('bid')) : <SkeletonRows rows={ROWS} label="Loading the order book" />}</div>
        {depth && !asks.length && !bids.length && <Empty>No liquidity found for this market.</Empty>}
      </> : <>
        <div className="book-cols"><span>Price ({quoteSymbol})</span><span>Size ({baseSymbol})</span><span>Time</span></div>
        <div className="trade-list">
          {(trades ?? []).map((t, i) => (
            <a key={t.txid + i} className={`book-row ${t.side === 'buy' ? 'bid' : 'ask'}`} href={`${explorer}/transaction/${t.txid}`} target="_blank" rel="noreferrer"
              title={`${t.side === 'buy' ? 'Bought' : 'Sold'} ${baseSymbol} ${t.venue === 'here' ? 'on this exchange' : 'on ' + t.venue}. Open the transaction.`}>
              <span className="p">{fmtPrice(t.price)}</span>
              <span>{fmtAmount(t.size)}</span>
              <span className="src">{t.venue === 'here' ? <i className="here" aria-label="made here">●</i> : ''}{clock(t.time)}</span>
            </a>
          ))}
          {trades === undefined && <SkeletonRows rows={14} label="Loading trades" />}
          {trades?.length === 0 && <Empty>No recent trades in this market.</Empty>}
        </div>
      </>}
      </TabPanel>
    </section>
  );
}
