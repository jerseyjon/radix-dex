import { useState } from 'react';
import { type MarketSummary, type OrderView, type TradeView, api } from './api';
import { fmtAmount, fmtPrice, fmtTime } from './format';
import { secrets } from './OrderForm';

export function Orders({ orders, trades, explorer, markets, account, onChanged }: { orders: OrderView[]; trades: TradeView[]; explorer: string; markets: MarketSummary[]; account: string | undefined; onChanged: () => void }) {
  const [tab, setTab] = useState<'open' | 'trades' | 'history'>('open');
  const [error, setError] = useState<string | undefined>();
  const symbol = new Map(markets.flatMap((m) => [[m.base.address, m.base.symbol], [m.quote.address, m.quote.symbol]] as [string, string][]));
  const sym = (a: string) => symbol.get(a) ?? a.slice(-6);
  const rows = orders.filter((o) => (tab === 'open' ? o.status === 'open' : o.status !== 'open'));

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
    const size = selling ? Number(o.sellAmount) : Number(o.minBuyAmount);
    const price = selling ? Number(o.minBuyAmount) / Number(o.sellAmount) : Number(o.sellAmount) / Number(o.minBuyAmount);
    return { pair: m ? `${m.base.symbol}/${m.quote.symbol}` : `${sym(o.sell)}→${sym(o.buy)}`, side: selling ? 'Sell' : 'Buy', size, price, baseSym: m?.base.symbol ?? sym(o.sell) };
  };

  // Why an open order has not filled yet, in price terms.
  const waiting = (o: OrderView) => {
    if (!o.outlook) return 'checking…';
    const d = describe(o), sell = Number(o.sellAmount), avail = Number(o.outlook.available), need = Number(o.outlook.needed);
    if (avail >= need) return 'filling now';
    const [have, want] = d.side === 'Sell' ? [avail / sell, need / sell] : [avail > 0 ? sell / avail : Infinity, sell / need];
    return d.side === 'Sell'
      ? `pools pay ${fmtPrice(have)} after network fee; needs ${fmtPrice(want)}`
      : `pools charge ${fmtPrice(have)} after network fee; needs ${fmtPrice(want)}`;
  };

  async function cancel(o: OrderView) {
    setError(undefined);
    const secret = secrets.get(o.id);
    if (!secret) { setError('This order was placed from another browser, so it cannot be cancelled here. It will expire on its own.'); return; }
    try { await api.cancelOrder(o.id, secret); onChanged(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="panel orders">
      <header className="panel-head">
        <div className="tabs">
          <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open orders ({orders.filter((o) => o.status === 'open').length})</button>
          <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades ({trades.length})</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>Limit order history</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {!account ? <p className="empty">Connect your wallet to see your orders.</p> : tab === 'trades' ? (trades.length === 0 ? <p className="empty">No completed trades yet.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th><th className="r">Total</th><th className="r">Network fee</th><th /></tr></thead>
            <tbody>
              {trades.map((t) => {
                const d = describeTrade(t);
                return (
                  <tr key={t.txid}>
                    <td>{fmtTime(t.time)}</td>
                    <td>{d.pair}</td>
                    <td className={d.side === 'Buy' ? 'up' : 'down'}>{d.side}</td>
                    <td className="r">{fmtPrice(d.price)}</td>
                    <td className="r">{fmtAmount(d.size)} {d.baseSym}</td>
                    <td className="r">{fmtAmount(d.total)} {d.quoteSym}</td>
                    <td className="r">{Number(t.feeXrd) > 0 ? `${fmtAmount(t.feeXrd)} XRD` : 'paid for you'}</td>
                    <td className="r"><a className="link" href={`${explorer}/transaction/${t.txid}`} target="_blank" rel="noreferrer">View</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )) : rows.length === 0 ? <p className="empty">{tab === 'open' ? 'No open orders.' : 'No filled, cancelled or expired limit orders.'}</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Placed</th><th>Market</th><th>Side</th><th className="r">Price</th><th className="r">Size</th>{tab === 'open' && <th>Fills when</th>}<th>{tab === 'open' ? 'Expires' : 'Status'}</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => {
                const d = describe(o);
                return (
                  <tr key={o.id}>
                    <td>{fmtTime(o.createdAt)}</td>
                    <td>{d.pair}</td>
                    <td className={d.side === 'Buy' ? 'up' : 'down'}>{d.side}</td>
                    <td className="r">{fmtPrice(d.price)}</td>
                    <td className="r">{fmtAmount(d.size)} {d.baseSym}</td>
                    {tab === 'open' && <td className="muted">{waiting(o)}</td>}
                    <td>{tab === 'open' ? fmtTime(o.expiresAt) : o.status === 'filled' ? `Filled, received ${fmtAmount(o.received)} ${sym(o.buy)}` : o.status[0]!.toUpperCase() + o.status.slice(1)}</td>
                    <td className="r">{tab === 'open' && <button className="link" onClick={() => cancel(o)}>Cancel</button>}</td>
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
