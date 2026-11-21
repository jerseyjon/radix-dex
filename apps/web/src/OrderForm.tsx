import { useEffect, useMemo, useState } from 'react';
import { type Depth, limitOrderManifest, marketOrderManifest, newCancelSecret, orderKeyFromSecret } from '@radix-dex/core/browser';
import { type MarketSummary, type QuoteResult, type ServerConfig, STATIC, api } from './api';
import { estimate } from './book';
import { cleanAmount, fmtAmount, fmtPrice, toPlain } from './format';
import type { Wallet } from './wallet';

type Side = 'buy' | 'sell';
type Kind = 'limit' | 'market';
const EXPIRIES: [string, number][] = [['1 hour', 3600], ['24 hours', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400 - 3600]];
const SLIPPAGES = [0.5, 1, 2, 5];

/** Cancel secrets stay in this browser only; the server has just their hashes. */
export const secrets = {
  get: (id: string): string | undefined => { try { return localStorage.getItem(`dex.cancel.${id}`) ?? undefined; } catch { return undefined; } },
  set: (id: string, secret: string) => { try { localStorage.setItem(`dex.cancel.${id}`, secret); } catch { /* private window: soft cancel unavailable */ } },
};

export function OrderForm(props: {
  market: MarketSummary; depth: Depth | undefined; config: ServerConfig; wallet: Wallet | undefined; account: string | undefined;
  balances: Record<string, string>; pickedPrice: number | undefined; onDone: (message: string) => void;
}) {
  const { market, depth, config, wallet, account, balances } = props;
  const [side, setSide] = useState<Side>('buy');
  const [kind, setKind] = useState<Kind>('market');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState(''); // base units
  const [total, setTotal] = useState('');   // quote units
  const [expiry, setExpiry] = useState(86400);
  const [slippage, setSlippage] = useState(1);
  const [quote, setQuote] = useState<QuoteResult | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const base = market.base, quoteTok = market.quote;
  const sellTok = side === 'buy' ? quoteTok : base, buyTok = side === 'buy' ? base : quoteTok;
  const sellBalance = Number(balances[sellTok.address] ?? 0);
  const limitsOn = config.limitOrders.enabled;

  useEffect(() => { setAmount(''); setTotal(''); setPrice(''); setQuote(undefined); setError(undefined); }, [market.id]);
  useEffect(() => { if (props.pickedPrice) { setKind('limit'); setPrice(fmtPrice(props.pickedPrice).replace(/,/g, '')); } }, [props.pickedPrice]);

  // What the user is selling, as a clean decimal string.
  const sellAmount = useMemo(() => {
    if (kind === 'market') return cleanAmount(side === 'buy' ? total : amount);
    const p = Number(price), a = Number(amount);
    if (!(p > 0) || !(a > 0)) return undefined;
    return side === 'buy' ? cleanAmount(toPlain(p * a)) : cleanAmount(amount);
  }, [kind, side, price, amount, total]);

  const limitMinBuy = useMemo(() => {
    const p = Number(price), a = Number(amount);
    if (kind !== 'limit' || !(p > 0) || !(a > 0)) return undefined;
    return side === 'buy' ? cleanAmount(amount) : cleanAmount(toPlain(p * a));
  }, [kind, side, price, amount]);

  const bookEstimate = kind === 'market' && sellAmount ? estimate(depth, side, Number(sellAmount)) : undefined;

  // Exact quote from the server (a ledger preview), debounced.
  useEffect(() => {
    setQuote(undefined); setQuoteError(undefined);
    if (!sellAmount || STATIC) return;
    let live = true;
    const t = setTimeout(() => {
      api.quote(sellTok.address, buyTok.address, sellAmount).then((q) => live && setQuote(q)).catch((e) => live && setQuoteError(e.message));
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [kind, sellAmount, sellTok.address, buyTok.address]);

  const expectedOut = quote ? Number(quote.buyAmount) : bookEstimate?.received;
  const execPrice = quote && sellAmount
    ? (side === 'buy' ? Number(sellAmount) / Number(quote.buyAmount) : Number(quote.buyAmount) / Number(sellAmount))
    : bookEstimate?.avgPrice;
  const impact = execPrice && depth?.mid ? ((side === 'buy' ? execPrice / depth.mid : depth.mid / execPrice) - 1) * 100 : undefined;

  // Would this limit order fill at once? Same sum the solver does: pool proceeds less the network fee against the limit plus a small margin.
  const lo = config.limitOrders.enabled ? config.limitOrders : undefined;
  const netNow = kind === 'limit' && quote && lo && sellAmount
    ? Math.max(0, Number(quote.buyAmount) - (buyTok.address === config.xrd ? Number(lo.gasXrd) : sellTok.address === config.xrd ? Number(quote.buyAmount) / Number(sellAmount) * Number(lo.gasXrd) : 0))
    : undefined;
  const fillsNow = netNow === undefined || !limitMinBuy ? undefined : netNow >= Number(limitMinBuy) * (1 + (lo?.bufferBps ?? 0) / 10_000);

  const setPct = (pct: number) => {
    if (!(sellBalance > 0)) return;
    const v = sellBalance * pct;
    if (kind === 'market') (side === 'buy' ? setTotal : setAmount)(toPlain(v, 8));
    else if (side === 'sell') setAmount(toPlain(v, 8));
    else if (Number(price) > 0) setAmount(toPlain(v / Number(price), 8));
  };

  let blocker: string | undefined;
  if (STATIC) blocker = 'Read-only preview';
  else if (!wallet) blocker = 'Wallet connection not configured';
  else if (!account) blocker = 'Connect your Radix Wallet';
  else if (kind === 'limit' && !limitsOn) blocker = 'Limit orders are not enabled';
  else if (!sellAmount) blocker = 'Enter an amount';
  else if (Number(sellAmount) > sellBalance) blocker = `Not enough ${sellTok.symbol}`;
  else if (kind === 'market' && !quote) blocker = quoteError ?? 'Getting a quote…';

  async function submit() {
    if (blocker || !wallet || !account || !sellAmount) return;
    setBusy(true); setError(undefined);
    try {
      if (kind === 'market') {
        const minBuy = toPlain(Number(quote!.buyAmount) * (1 - slippage / 100));
        const txid = await wallet.sendTransaction(
          marketOrderManifest({ account, sell: sellTok.address, sellAmount, minBuyAmount: minBuy, route: quote!.route }),
          `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`);
        props.onDone(`Market order submitted: ${txid}`);
      } else {
        if (!config.limitOrders.enabled || !limitMinBuy) return;
        const secret = newCancelSecret();
        const orderKeyHex = orderKeyFromSecret(secret);
        const p = { account, sell: sellTok.address, sellAmount, buy: buyTok.address, minBuyAmount: limitMinBuy };
        const manifest = limitOrderManifest({
          ...p, solverBadge: config.limitOrders.solverBadge,
          registry: config.limitOrders.registry ? { component: config.limitOrders.registry, orderKeyHex } : undefined,
        });
        const signed = await wallet.signOrder(manifest, expiry, `Limit ${side} ${base.symbol} @ ${price}`);
        const placed = await api.placeOrder({ ...p, orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex });
        secrets.set(placed.id, secret);
        props.onDone('Limit order placed');
      }
      setAmount(''); setTotal('');
    } catch (e) {
      setError((e as Error).message);
      props.onDone(`${kind === 'limit' ? 'Limit order' : 'Order'} not placed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const num = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value.replace(/[^0-9.]/g, ''));

  return (
    <section className="panel form">
      <div className="seg sides">
        <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>Buy {base.symbol}</button>
        <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>Sell {base.symbol}</button>
      </div>
      <div className="tabs">
        <button className={kind === 'market' ? 'on' : ''} onClick={() => setKind('market')}>Market</button>
        <button className={kind === 'limit' ? 'on' : ''} onClick={() => setKind('limit')}>Limit</button>
        <span className="muted small bal">Available: {fmtAmount(sellBalance)} {sellTok.symbol}</span>
      </div>

      {kind === 'limit' && (
        <label className="field"><span>Price</span><input inputMode="decimal" value={price} onChange={num(setPrice)} placeholder={fmtPrice(depth?.mid)} /><em>{quoteTok.symbol}</em></label>
      )}
      {(kind === 'limit' || side === 'sell') && (
        <label className="field"><span>Amount</span><input inputMode="decimal" value={amount} onChange={num(setAmount)} placeholder="0.0" /><em>{base.symbol}</em></label>
      )}
      {kind === 'market' && side === 'buy' && (
        <label className="field"><span>Spend</span><input inputMode="decimal" value={total} onChange={num(setTotal)} placeholder="0.0" /><em>{quoteTok.symbol}</em></label>
      )}
      <div className="pcts">{[0.25, 0.5, 0.75, 1].map((p) => <button key={p} onClick={() => setPct(p)} disabled={!(sellBalance > 0)}>{p * 100}%</button>)}</div>

      {kind === 'market' ? (
        <dl className="summary">
          <div><dt>You receive {quote ? '' : '(estimate)'}</dt><dd>{expectedOut ? `${fmtAmount(expectedOut)} ${buyTok.symbol}` : '—'}</dd></div>
          <div><dt>Average price</dt><dd>{fmtPrice(execPrice)} {execPrice ? quoteTok.symbol : ''}</dd></div>
          <div><dt>Price impact</dt><dd className={impact !== undefined && impact > 3 ? 'warn' : ''}>{impact === undefined ? '—' : `${Math.max(0, impact).toFixed(2)}%`}</dd></div>
          <div><dt>Route</dt><dd>{quote ? quote.route.map((p) => p.venue).join(' → ') : '—'}</dd></div>
          <div><dt>Max slippage</dt><dd className="seg mini">{SLIPPAGES.map((s) => <button key={s} className={s === slippage ? 'on' : ''} onClick={() => setSlippage(s)}>{s}%</button>)}</dd></div>
        </dl>
      ) : (
        <dl className="summary">
          <div><dt>You pay</dt><dd>{sellAmount ? `${fmtAmount(sellAmount)} ${sellTok.symbol}` : '—'}</dd></div>
          <div><dt>You receive at least</dt><dd>{limitMinBuy ? `${fmtAmount(limitMinBuy)} ${buyTok.symbol}` : '—'}</dd></div>
          <div><dt>Fee</dt><dd>Up to {(config.feeBps / 100).toFixed(2)}% plus the network fee, taken only from what the fill pays above your limit.</dd></div>
          <div><dt>Right now</dt><dd className={fillsNow ? 'up' : ''}>{fillsNow === undefined ? '—' : fillsNow ? 'Would fill straight away' : `Would wait: pools pay ${fmtAmount(netNow)} ${buyTok.symbol} for this size after the network fee`}</dd></div>
          <div><dt>Expires in</dt><dd><select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRIES.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></dd></div>
        </dl>
      )}

      <button className={`submit ${side}`} disabled={Boolean(blocker) || busy} onClick={submit}>
        {busy ? 'Waiting for wallet…' : blocker ?? `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`}
      </button>
      {error && <p className="error">{error}</p>}
      {kind === 'limit' && (
        <p className="note">A limit order is a signed permission, not a transaction: placing it is free and your funds stay in your account until it fills. It fills in full or not at all, never at a worse price than your limit.</p>
      )}
    </section>
  );
}
