import { useState } from 'react';
import { bookCancelManifest } from '@radix-dex/core/browser';
import { type MarketSummary, type OrderView, type ServerConfig, type TradeView, api } from './api';
import { fmtAmount, fmtPrice, fmtTime } from './format';
import { secrets } from './OrderForm';
import { Empty, Icon } from './ui';
import type { Wallet } from './wallet';

export function Orders({ orders, trades, explorer, markets, account, onChanged, wallet, orderBook }: {
  orders: OrderView[]; trades: TradeView[]; explorer: string; markets: MarketSummary[]; account: string | undefined; onChanged: () => void;
  wallet?: Wallet; orderBook?: ServerConfig['orderBook'];
}) {
  const [tab, setTab] = useState<'open' | 'trades' | 'history'>('open');
  const [error, setError] = useState<string | undefined>();
  const symbol = new Map(markets.flatMap((m) => [[m.base.address, m.base.symbol], [m.quote.address, m.quote.symbol]] as [string, string][]));
  const sym = (a: string) => symbol.get(a) ?? a.slice(-6);
  // An expired book order still holds its unsold tokens, so it stays with the open orders until cancelled.
  const isOpen = (o: OrderView) => o.status === 'open' || (o.kind === 'book' && o.status === 'expired' && Number(o.remaining) > 0);
  const rows = orders.filter((o) => (tab === 'open' ? isOpen(o) : !isOpen(o)));

  // Show each order the way a trader reads it: side, price and size in the market's own terms.
  // A completed trade from the ledger, in the market's own terms.
  const describeTrade = (t: TradeView) => {
    const m = markets.find((x) => (x.base.address === t.sell && x.quote.address === t.buy) || (x.base.address === t.buy && x.quote.address === t.sell));
    const selling = m ? m.base.address === t.sell : true;
    const size = Number(selling ? t.sellAmount : t.buyAmount), total = Number(selling ? t.buyAmount : t.sellAmount);
    return { pair: m ? `${m.base.symbol}/${m.quote.symbol}` : `${sym(t.sell)}→${sym(t.buy)}`, side: selling ? 'Sell' : 'Buy', size, total, price: total / size, baseSym: m?.base.symbol ?? sym(t.sell), quoteSym: m?.quote.symbol ?? sym(t.buy) };
  };

  const describe = (o: OrderView) => {
    const m = markets.find((x) => (x.base.address === o.sell && x.quote.address === o.buy) || (x.base.address === o.buy && x.quote.address === o.sell));
    const selling = m ? m.base.address === o.sell : true;
    const gross = Number(o.limitBuyAmount ?? o.minBuyAmount); // the order's price times its size
    const size = selling ? Number(o.sellAmount) : gross;
    const price = selling ? gross / Number(o.sellAmount) : Number(o.sellAmount) / gross;
    return { pair: m ? `${m.base.symbol}/${m.quote.symbol}` : `${sym(o.sell)}→${sym(o.buy)}`, side: selling ? 'Sell' : 'Buy', size, price, baseSym: m?.base.symbol ?? sym(o.sell) };
  };

  // Why an open order has not filled yet, in price terms.
  const waiting = (o: OrderView) => {
    if (o.kind === 'book') {
      const part = `${fmtAmount(o.sold)} of ${fmtAmount(o.sellAmount)} ${sym(o.sell)} sold`;
      return o.status === 'expired' ? `expired, ${part}: cancel to take back the rest` : `fills in parts: ${part}`;
    }
    if (!o.outlook) return 'checking…';
    const d = describe(o), sell = Number(o.sellAmount), avail = Number(o.outlook.available), need = Number(o.outlook.needed);
    if (avail >= need) return 'filling now';
    if (o.kind === 'market') return 'price moved beyond your slippage limit';
    const [have, want] = d.side === 'Sell' ? [avail / sell, need / sell] : [avail > 0 ? sell / avail : Infinity, sell / need];
    return d.side === 'Sell'
      ? `market pays ${fmtPrice(have)} for this size; fills at ${fmtPrice(want)}`
      : `market charges ${fmtPrice(have)} for this size; fills at ${fmtPrice(want)}`;
  };

  async function cancel(o: OrderView) {
    setError(undefined);
    if (o.kind === 'book') {
      // Cancelling a book order is a transaction: it burns the receipt and returns what has not sold.
      if (!wallet || !orderBook || !account || o.bookId === undefined) { setError('Connect the wallet that holds this order\'s receipt to cancel it.'); return; }
      try { await wallet.sendTransaction(bookCancelManifest({ account, book: orderBook.component, receipts: orderBook.receipts, id: o.bookId }), 'Cancel limit order'); onChanged(); } catch (e) { setError((e as Error).message); }
      return;
    }
    const secret = secrets.get(o.id);
    if (!secret) { setError('This order was placed from another browser, so it cannot be cancelled here. It will expire on its own.'); return; }
    try { await api.cancelOrder(o.id, secret); onChanged(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="panel orders">
      <header className="panel-head">
        <div className="tabs" role="tablist" aria-label="Your orders">
          <button role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open orders <span className="badge">{orders.filter(isOpen).length}</span></button>
          <button role="tab" aria-selected={tab === 'trades'} className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades <span className="badge">{trades.length}</span></button>
          <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>Order history</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {!account ? <Empty>Connect your wallet to see your orders.</Empty> : tab === 'trades' ? (trades.length === 0 ? <Empty>No completed trades yet.</Empty> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th className="r">Total</th><th className="r">Network fee</th><th /></tr></thead>
            <tbody>
              {trades.map((t) => {
                const d = describeTrade(t);
                return (
                  <tr key={t.txid + (t.book ?? '')}>
                    <td>{fmtTime(t.time)}</td>
                    <td>{d.pair}</td>
                    <td className={d.side === 'Buy' ? 'up' : 'down'}>{d.side}{t.book ? ` (order #${t.book})` : ''}</td>
                    <td className="r num">{fmtPrice(d.price)}</td>
                    <td className="r">{fmtAmount(d.size)} {d.baseSym}</td>
                    <td className="r">{fmtAmount(d.total)} {d.quoteSym}</td>
                    <td className="r">{t.book ? 'none' : Number(t.feeXrd) > 0 ? `${fmtAmount(t.feeXrd)} XRD` : 'paid for you'}</td>
                    <td className="r"><a className="link" href={`${explorer}/transaction/${t.txid}`} target="_blank" rel="noreferrer">View <Icon name="external" size={11} /></a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )) : rows.length === 0 ? <Empty>{tab === 'open' ? 'No open orders.' : 'No filled, cancelled or expired orders.'}</Empty> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Placed</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th>{tab === 'open' && <th>Fills when</th>}<th>{tab === 'open' ? 'Expires' : 'Status'}</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => {
                const d = describe(o);
                return (
                  <tr key={o.id}>
                    <td>{o.createdAt ? fmtTime(o.createdAt) : `Book #${o.bookId ?? ''}`}</td>
                    <td>{d.pair}</td>
                    <td className={d.side === 'Buy' ? 'up' : 'down'}>{o.kind === 'market' ? 'Market ' : ''}{d.side}</td>
                    <td className="r">{o.kind === 'market' ? 'Market' : fmtPrice(d.price)}</td>
                    <td className="r">{fmtAmount(d.size)} {d.baseSym}</td>
                    {tab === 'open' && <td className="muted">{waiting(o)}</td>}
                    <td>{tab === 'open' ? (o.expiresAt ? fmtTime(o.expiresAt) : 'Never') : o.status === 'filled' ? `Filled, received ${fmtAmount(o.received)} ${sym(o.buy)}` : o.status[0]!.toUpperCase() + o.status.slice(1) + (o.kind === 'book' && Number(o.sold) > 0 ? `, after ${fmtAmount(o.sold)} ${sym(o.sell)} sold for ${fmtAmount(o.received)} ${sym(o.buy)}` : '')}</td>
                    <td className="r">{tab === 'open' && <button className="btn-ghost" onClick={() => cancel(o)}>Cancel</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
