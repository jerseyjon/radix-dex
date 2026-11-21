import { useEffect, useMemo, useState } from 'react';
import { type Depth, bookPlaceManifest, limitOrderManifest, marketOrderManifest, newCancelSecret, orderKeyFromSecret } from '@radix-dex/core/browser';
import { type MarketSummary, type QuoteResult, type ServerConfig, STATIC, api } from './api';
import { estimate } from './book';
import { cleanAmount, fmtAmount, fmtPrice, toPlain } from './format';
import type { Wallet } from './wallet';

type Side = 'buy' | 'sell';
type Kind = 'limit' | 'market';
const EXPIRIES: [string, number][] = [['1 hour', 3600], ['24 hours', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400 - 3600]];
const SLIPPAGES = [0.5, 1, 2, 5];
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

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
  // Limit orders: in the on-ledger order book (fills in part) or signed and kept in the wallet (fills whole).
  const [inBook, setInBook] = useState(true);
  const [quote, setQuote] = useState<QuoteResult | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const base = market.base, quoteTok = market.quote;
  const sellTok = side === 'buy' ? quoteTok : base, buyTok = side === 'buy' ? base : quoteTok;
  const sellBalance = Number(balances[sellTok.address] ?? 0);
  const book = config.orderBook ?? undefined;
  const useBook = kind === 'limit' && inBook && Boolean(book);
  const limitsOn = config.limitOrders.enabled || Boolean(book);

  useEffect(() => { setAmount(''); setTotal(''); setPrice(''); setQuote(undefined); setError(undefined); }, [market.id]);
  useEffect(() => { if (props.pickedPrice) { setKind('limit'); setPrice(fmtPrice(props.pickedPrice).replace(/,/g, '')); } }, [props.pickedPrice]);

  // What the user is selling, as a clean decimal string.
  const sellAmount = useMemo(() => {
    if (kind === 'market') return cleanAmount(side === 'buy' ? total : amount);
    const p = Number(price), a = Number(amount);
    if (!(p > 0) || !(a > 0)) return undefined;
    return side === 'buy' ? cleanAmount(toPlain(p * a)) : cleanAmount(amount);
  }, [kind, side, price, amount, total]);

  // A limit order's price times its size: what the market must pay, before fees, for it to fill.
  const limitGross = useMemo(() => {
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

  const execPrice = quote && sellAmount
    ? (side === 'buy' ? Number(sellAmount) / Number(quote.buyAmount) : Number(quote.buyAmount) / Number(sellAmount))
    : bookEstimate?.avgPrice;
  const impact = execPrice && depth?.mid ? ((side === 'buy' ? execPrice / depth.mid : depth.mid / execPrice) - 1) * 100 : undefined;

  // Orders are filled for the user by the solver, which pays the network fee and takes it,
  // with the service fee, out of what the order buys.
  const lo = config.limitOrders.enabled ? config.limitOrders : undefined;
  const viaSolver = Boolean(lo?.filling);
  const feesOn = (gross: number | undefined) => {
    if (gross === undefined || !lo || !sellAmount) return undefined;
    const network = buyTok.address === config.xrd ? Number(lo.gasXrd) : sellTok.address === config.xrd ? gross / Number(sellAmount) * Number(lo.gasXrd) : 0;
    return { network, service: gross * config.feeBps / 10_000 };
  };
  const limitFees = feesOn(limitGross ? Number(limitGross) : undefined);
  const limitMinBuy = limitGross && limitFees ? cleanAmount(toPlain(Number(limitGross) - limitFees.network - limitFees.service)) : undefined;
  const fillsNow = kind === 'limit' && quote && limitGross ? Number(quote.buyAmount) >= Number(limitGross) : undefined;
  const marketFees = kind === 'market' && viaSolver && quote ? feesOn(Number(quote.buyAmount)) : undefined;
  const marketNet = marketFees ? Number(quote!.buyAmount) - marketFees.network - marketFees.service : undefined;
  const expectedOut = marketNet ?? (quote ? Number(quote.buyAmount) : bookEstimate?.received);

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
  else if (kind === 'market' && marketNet !== undefined && !(marketNet > 0)) blocker = 'Too small to cover the network fee';
  else if (kind === 'limit' && !useBook && !config.limitOrders.enabled) blocker = 'Only order-book orders are enabled';
  else if (kind === 'limit' && !useBook && limitGross && !(Number(limitMinBuy) > 0)) blocker = 'Too small to cover the network fee';

  async function submit() {
    if (blocker || !wallet || !account || !sellAmount) return;
    setBusy(true); setError(undefined);
    try {
      const sign = async (minBuyAmount: string, limitBuyAmount: string, orderKind: Kind, lifetime: number, label: string) => {
        if (!config.limitOrders.enabled) throw new Error('Orders are not enabled');
        const secret = newCancelSecret();
        const orderKeyHex = orderKeyFromSecret(secret);
        const p = { account, sell: sellTok.address, sellAmount, buy: buyTok.address, minBuyAmount };
        const manifest = limitOrderManifest({
          ...p, solverBadge: config.limitOrders.solverBadge,
          registry: config.limitOrders.registry ? { component: config.limitOrders.registry, orderKeyHex } : undefined,
        });
        const signed = await wallet.signOrder(manifest, lifetime, label);
        const placed = await api.placeOrder({ ...p, limitBuyAmount, kind: orderKind, orderKeyHex, signedPartialTransactionHex: signed.signedPartialTransactionHex });
        secrets.set(placed.id, secret);
        return placed;
      };
      if (kind === 'market' && viaSolver && lo && marketNet) {
        // Filled by the solver so it can take limit orders in the book as well as the pools.
        const minBuy = cleanAmount(toPlain(marketNet * (1 - slippage / 100)));
        if (!minBuy) return;
        const placed = await sign(minBuy, minBuy, 'market', lo.marketOrderLifetimeSec, `Market ${side} ${base.symbol}`);
        props.onDone('Market order sent, filling…');
        const deadline = placed.expiresAt * 1000;
        let outcome = 'Market order not filled: the price moved beyond your slippage limit';
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const mine = (await api.orders(account).catch(() => [])).find((o) => o.id === placed.id);
          if (mine?.status === 'filled') { outcome = `Market order filled: received ${fmtAmount(mine.received)} ${buyTok.symbol}`; break; }
          if (mine && mine.status !== 'open') break;
        }
        props.onDone(outcome);
      } else if (kind === 'market') {
        const minBuy = toPlain(Number(quote!.buyAmount) * (1 - slippage / 100));
        const txid = await wallet.sendTransaction(
          marketOrderManifest({ account, sell: sellTok.address, sellAmount, minBuyAmount: minBuy, route: quote!.route }),
          `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`);
        props.onDone(`Market order submitted: ${txid}`);
      } else if (useBook && book) {
        // The contract's price is what the order is owed for each token it sells.
        const p = Number(price);
        const perSell = cleanAmount(side === 'sell' ? price : toPlain(1 / p));
        if (!perSell) return;
        await wallet.sendTransaction(
          bookPlaceManifest({ account, book: book.component, sell: sellTok.address, sellAmount, buy: buyTok.address, price: perSell, expiresAt: Math.floor(Date.now() / 1000) + expiry }),
          `Limit ${side} ${base.symbol} @ ${price}`);
        props.onDone('Limit order placed in the order book');
      } else {
        if (!limitMinBuy || !limitGross) return;
        await sign(limitMinBuy, limitGross, 'limit', expiry, `Limit ${side} ${base.symbol} @ ${price}`);
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
          {marketFees
            ? <div><dt>Fees, already taken off</dt><dd>{fmtAmount(marketFees.network + marketFees.service)} {buyTok.symbol} (network fee + {pct(config.feeBps)})</dd></div>
            : <div><dt>Route</dt><dd>{quote ? quote.route.map((p) => p.venue).join(' → ') : '—'}</dd></div>}
          <div><dt>Max slippage</dt><dd className="seg mini">{SLIPPAGES.map((s) => <button key={s} className={s === slippage ? 'on' : ''} onClick={() => setSlippage(s)}>{s}%</button>)}</dd></div>
        </dl>
      ) : useBook && book ? (
        <dl className="summary">
          <div><dt>Fills</dt><dd className="seg mini"><button className="on">In parts</button>{config.limitOrders.enabled && <button onClick={() => setInBook(false)}>Whole only</button>}</dd></div>
          <div><dt>Moves into the order book</dt><dd>{sellAmount ? `${fmtAmount(sellAmount)} ${sellTok.symbol}` : '—'}</dd></div>
          <div><dt>You receive, as it fills</dt><dd>{limitGross ? `${fmtAmount(Number(limitGross) * (1 - book.makerFeeBps / 10_000))} ${buyTok.symbol}` : '—'}</dd></div>
          <div><dt>Fee</dt><dd>{book.makerFeeBps > 0 ? pct(book.makerFeeBps) : 'None'}, plus the network fee to place it (about 0.8 XRD)</dd></div>
          <div><dt>Right now</dt><dd className={fillsNow ? 'up' : ''}>{fillsNow === undefined ? '—' : fillsNow ? 'The market already pays your price: it should fill soon' : `Would wait: the market pays ${fmtAmount(quote!.buyAmount)} ${buyTok.symbol} for this size`}</dd></div>
          <div><dt>Expires in</dt><dd><select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRIES.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></dd></div>
        </dl>
      ) : (
        <dl className="summary">
          {book && <div><dt>Fills</dt><dd className="seg mini"><button onClick={() => setInBook(true)}>In parts</button><button className="on">Whole only</button></dd></div>}
          <div><dt>You pay</dt><dd>{sellAmount ? `${fmtAmount(sellAmount)} ${sellTok.symbol}` : '—'}</dd></div>
          <div><dt>At your price you get</dt><dd>{limitGross ? `${fmtAmount(limitGross)} ${buyTok.symbol}` : '—'}</dd></div>
          <div><dt>Fees, taken from that</dt><dd>{limitFees ? `${fmtAmount(limitFees.network + limitFees.service)} ${buyTok.symbol} (network fee + ${pct(config.feeBps)})` : '—'}</dd></div>
          <div><dt>If another trader takes it</dt><dd>{(config.makerFeeBps ?? 0) > 0 ? `Fee ${pct(config.makerFeeBps ?? 0)}, no network fee` : 'No fee: you get your full price'}</dd></div>
          <div><dt>You receive at least</dt><dd>{limitMinBuy && Number(limitMinBuy) > 0 ? `${fmtAmount(limitMinBuy)} ${buyTok.symbol}` : '—'}</dd></div>
          <div><dt>Right now</dt><dd className={fillsNow ? 'up' : ''}>{fillsNow === undefined ? '—' : fillsNow ? 'Would fill straight away' : `Would wait: the market pays ${fmtAmount(quote!.buyAmount)} ${buyTok.symbol} for this size`}</dd></div>
          <div><dt>Expires in</dt><dd><select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRIES.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></dd></div>
        </dl>
      )}

      <button className={`submit ${side}`} disabled={Boolean(blocker) || busy} onClick={submit}>
        {busy ? 'Working…' : blocker ?? `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`}
      </button>
      {error && <p className="error">{error}</p>}
      {kind === 'market' && viaSolver && (
        <p className="note">Your wallet will ask you to approve a pre-authorization. The order is then filled for you within a few seconds at the best price from the order book and the pools, and you pay no separate network fee.</p>
      )}
      {useBook && (
        <p className="note">Your tokens move into the order book contract, where the ledger enforces your price. Other traders can buy any part of the order, and each part is paid straight to your account at your price. You can cancel at any time and take back what has not sold. This contract has not been audited.</p>
      )}
      {kind === 'limit' && !useBook && (
        <p className="note">A limit order is a signed permission, not a transaction: placing it is free and your funds stay in your account until it fills. It fills in full or not at all, as soon as the market reaches your price. The fees come out of what you receive, and you never get less than the “at least” amount, which is what your wallet shows.</p>
      )}
    </section>
  );
}
