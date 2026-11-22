import { useEffect, useMemo, useState } from 'react';
import { type Depth, Decimal, bookPlaceManifest, limitOrderManifest, marketOrderManifest, newCancelSecret, orderKeyFromSecret, routePath } from '@radix-dex/core/browser';
import { type MarketSummary, type QuoteResult, type ServerConfig, STATIC, api } from './api';
import { estimate } from './book';
import { cleanAmount, fmtAmount, fmtPrice } from './format';
import {
  type XrdCharges, bookContractPrice, bookOrderBelowMinimum, chargeAtFor, exceeds, limitTerms, minAfterXrdCharges, normaliseInput, numberToPlain, parsePlain, placesFor, placesIn,
  positivePlain, shareOf, toPlain, withSlippage, xrdCharges,
} from './money';
import { Icon } from './ui';
import type { Wallet } from './wallet';

type Side = 'buy' | 'sell';
type Kind = 'limit' | 'market';
const EXPIRIES: [string, number][] = [['1 hour', 3600], ['24 hours', 86400], ['7 days', 7 * 86400], ['30 days', 30 * 86400 - 3600]];
const SLIPPAGES = [0.5, 1, 2, 5];
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const NOT_FILLED = 'The exchange takes its fees in XRD, and this pair has no route through XRD, so it does not fill market or “Whole only” orders here. A Limit order “In parts” in the order book has no exchange fee and works.';

/** Cancel secrets stay in this browser only; the server has just their hashes. */
export const secrets = {
  get: (id: string): string | undefined => { try { return localStorage.getItem(`dex.cancel.${id}`) ?? undefined; } catch { return undefined; } },
  set: (id: string, secret: string) => { try { localStorage.setItem(`dex.cancel.${id}`, secret); } catch { /* private window: soft cancel unavailable */ } },
};

/** Does this quote answer the question the form is asking now (same tokens, same amount)? */
function quoteFor(q: QuoteResult | undefined, sell: string, buy: string, amount: string | undefined): QuoteResult | undefined {
  if (!q || !amount || q.sell !== sell || q.buy !== buy) return undefined;
  try { return new Decimal(q.sellAmount).eq(amount) ? q : undefined; } catch { return undefined; }
}

export function OrderForm(props: {
  market: MarketSummary; depth: Depth | undefined; config: ServerConfig; wallet: Wallet | undefined; account: string | undefined;
  balances: Record<string, string>; picked: { price: number; n: number } | undefined; onDone: (message: string) => void;
  /** Every pool the site lists (all markets): a quoted route may only use these. */
  listedPools: Set<string>;
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
  const [rawQuote, setQuote] = useState<QuoteResult | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [hint, setHint] = useState<string | undefined>();

  const base = market.base, quoteTok = market.quote;
  const sellTok = side === 'buy' ? quoteTok : base, buyTok = side === 'buy' ? base : quoteTok;
  const balanceStr = balances[sellTok.address] ?? '0';
  const sellBalance = Number(balanceStr); // display and enabling only
  const book = config.orderBook ?? undefined;
  const useBook = kind === 'limit' && inBook && Boolean(book);
  const limitsOn = config.limitOrders.enabled || Boolean(book);
  const sellPlaces = placesFor(sellTok, config.xrd);

  useEffect(() => { setAmount(''); setTotal(''); setPrice(''); setQuote(undefined); setError(undefined); setHint(undefined); }, [market.id]);
  // A picked book level fills the price exactly; picking the same level again re-fills it.
  useEffect(() => { if (props.picked) { setKind('limit'); setPrice(numberToPlain(props.picked.price)); } }, [props.picked?.n]);

  // A limit order's terms, worked out exactly: what is sold, and the price times size it must fetch.
  const terms = useMemo(() => (kind === 'limit' ? limitTerms(side, price, amount, sellPlaces) : undefined), [kind, side, price, amount, sellPlaces]);
  // What the user is selling, as a clean decimal string, rounded down to the places the token allows
  // (the server refuses more, and the ledger cannot withdraw them).
  const typedSell = kind === 'market' ? (side === 'buy' ? total : amount) : side === 'sell' ? amount : undefined;
  const sellAmount = kind === 'market' ? positivePlain(cleanAmount(typedSell ?? ''), sellPlaces) : terms?.sellAmount;
  const roundedSell = typedSell !== undefined && parsePlain(typedSell) && placesIn(typedSell.replace(/,/g, '')) > sellPlaces ? sellAmount : undefined;
  const limitGross = terms?.gross;

  const bookEstimate = kind === 'market' && sellAmount ? estimate(depth, side, Number(sellAmount)) : undefined;

  // Exact quote from the server (a ledger preview), debounced.
  useEffect(() => {
    setQuote(undefined); setQuoteError(undefined);
    if (!sellAmount || STATIC) return;
    let live = true;
    const t = setTimeout(() => {
      api.quote(sellTok.address, buyTok.address, sellAmount).then((q) => {
        if (!live) return;
        // A pool short of liquidity hands part of the input back: say so rather than wait for a quote that never matches.
        if (new Decimal(q.sellAmount).lt(sellAmount)) setQuoteError(`The pools can take only ${fmtAmount(q.sellAmount)} of ${fmtAmount(sellAmount)} ${sellTok.symbol}`);
        else setQuote(q);
      }).catch((e) => live && setQuoteError(e.message));
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [kind, sellAmount, sellTok.address, buyTok.address]);
  const quote = quoteFor(rawQuote, sellTok.address, buyTok.address, sellAmount);

  const execPrice = quote && sellAmount
    ? (side === 'buy' ? Number(sellAmount) / Number(quote.buyAmount) : Number(quote.buyAmount) / Number(sellAmount))
    : bookEstimate?.avgPrice;
  const impact = execPrice && depth?.mid ? ((side === 'buy' ? execPrice / depth.mid : depth.mid / execPrice) - 1) * 100 : undefined;

  // Orders are filled for the user by the solver, which pays the network fee and takes it, with the
  // service fee, in XRD: from the XRD the order buys, from the XRD it sells (before the swap), or
  // between two swaps through XRD when neither token is XRD. All of this is exact decimal arithmetic.
  const lo = config.limitOrders.enabled ? config.limitOrders : undefined;
  const viaSolver = Boolean(lo?.filling);
  const at = chargeAtFor(sellTok.address, buyTok.address, config.xrd);
  const buyPlaces = placesFor(buyTok, config.xrd);
  // The solver fills a pair only with XRD on one side or a route through XRD.
  const solverFills = market.solverFills !== false && !(quote && quote.feeAt === null);
  const solverOrder = (kind === 'market' && viaSolver) || (kind === 'limit' && !useBook);
  const chargesOn = (gross: string | undefined, gasXrd: string | undefined) =>
    (gross === undefined || gasXrd === undefined || !lo || !sellAmount ? undefined : xrdCharges({ at, gross, sellAmount, xrdBase: quote?.xrdBase, gasXrd, feeBps: config.feeBps }));
  // A signed limit order allows the route's estimate plus the server's margin (25%) for the network
  // fee: the solver fills it at its price while the allowance covers 75% of its estimate then. The
  // fee shown is the allowance, so the form's figures are exactly what is signed.
  const margin = lo?.gasAllowanceMargin ?? 1;
  const limitAllowance = quote?.gasAllowanceXrd ?? (lo ? new Decimal(lo.gasXrd).times(String(margin)).toFixed() : undefined);
  const limitFees = kind === 'limit' && !useBook ? chargesOn(limitGross, limitAllowance) : undefined;
  const limitMinBuy = minAfterXrdCharges(limitFees, buyPlaces);
  const fillsNow = kind === 'limit' && quote && limitGross ? new Decimal(quote.buyAmount).gte(limitGross) : undefined;
  // A market order signs its expected proceeds less the estimated fees, less the slippage allowance.
  const marketFees = kind === 'market' && viaSolver && quote ? chargesOn(quote.buyAmount, quote.gasXrd ?? lo?.gasXrd) : undefined;
  const marketNet = minAfterXrdCharges(marketFees, buyPlaces);
  const marketMinBuy = kind === 'market' && viaSolver && marketNet ? positivePlain(withSlippage(marketNet, slippage), buyPlaces) : undefined;
  const expectedOut = marketNet !== undefined ? Number(marketNet) : marketFees ? 0 : quote ? Number(quote.buyAmount) : bookEstimate?.received;
  const feeWhere = at === 'proceeds' ? 'taken from the XRD you receive' : at === 'input' ? 'taken from the XRD you spend' : 'taken in XRD, between the swaps through XRD';
  // Always in XRD; where the fee is not taken from XRD the user receives, also its worth in the token bought, which is what it takes off the minimum.
  const feeText = (c: XrdCharges) => `${fmtAmount(c.totalXrd.toNumber())} XRD${at === 'proceeds' ? '' : ` (≈ ${fmtAmount(c.inBuyToken.toNumber())} ${buyTok.symbol})`}`;

  // Without a solver the market order is an ordinary transaction along the server's route: the route
  // must start at the token sold and end at the token the user chose, or we refuse to sign it.
  const routeProblem = useMemo(() => {
    if (kind !== 'market' || viaSolver || !quote) return undefined;
    try {
      const path = routePath(quote.route, sellTok.address);
      if (path[path.length - 1] !== buyTok.address) return `The quoted route does not end in ${buyTok.symbol}; not signing it`;
      // Every pool must be one the site lists (a route through XRD uses another market's pool).
      if (!quote.route.every((p) => props.listedPools.has(p.address))) return 'The quoted route uses a pool this site does not list; not signing it';
      return undefined;
    } catch { return 'The quoted route does not connect the two tokens; not signing it'; }
  }, [kind, viaSolver, quote, sellTok.address, buyTok.address, buyTok.symbol, props.listedPools]);

  // The order-book contract's price for this order, or why it cannot be expressed.
  const bookPrice = useBook && price ? bookContractPrice(side, price) : undefined;
  // The site's smallest book order, valued in XRD: taking a tiny one costs the exchange more in network fees than it is worth.
  const bookTooSmall = useBook && book
    ? bookOrderBelowMinimum({ sell: sellTok.address, buy: buyTok.address, xrd: config.xrd, sellAmount, gross: limitGross, minXrd: book.minOrderXrd })
    : undefined;
  // The value is shown rounded down, never up to the minimum itself (99.999 reads 99.999, not 100).
  const tooSmallValue = bookTooSmall && (toPlain(bookTooSmall.valueXrd, 6) === '0' ? bookTooSmall.valueXrd : toPlain(bookTooSmall.valueXrd, 6));
  const tooSmallText = bookTooSmall
    ? `Orders “In parts” must be worth at least ${fmtAmount(bookTooSmall.minXrd)} XRD; this one is worth ${tooSmallValue} XRD.`
    : undefined;

  const setPct = (share: number) => {
    setHint(undefined);
    if (!(sellBalance > 0)) return;
    if (kind === 'market' || side === 'sell') {
      // Rounded down to the sell token's places; 100% is the balance exactly.
      const v = shareOf(balanceStr, share, placesFor(sellTok, config.xrd, balanceStr)) ?? '';
      (kind === 'market' && side === 'buy' ? setTotal : setAmount)(v);
      return;
    }
    // Limit buy: the size the share of the quote balance buys at the typed price, rounded down,
    // so price × size never exceeds that share.
    const p = parsePlain(price), spend = shareOf(balanceStr, share, placesFor(sellTok, config.xrd, balanceStr));
    if (!p || p.lte(0) || !spend) { setHint('Enter a price first'); return; }
    setAmount(toPlain(new Decimal(spend).div(p), placesFor(base, config.xrd)));
  };

  let blocker: string | undefined;
  if (STATIC) blocker = 'Read-only preview';
  else if (!wallet) blocker = 'Wallet connection not configured';
  else if (!account) blocker = 'Connect your Radix Wallet';
  else if (kind === 'limit' && !limitsOn) blocker = 'Limit orders are not enabled';
  else if (kind === 'limit' && !parsePlain(price)?.gt(0)) blocker = 'Enter a price';
  else if (!sellAmount) blocker = 'Enter an amount';
  else if (exceeds(sellAmount, balanceStr)) blocker = `Not enough ${sellTok.symbol}`;
  else if (solverOrder && !solverFills) blocker = book ? 'Not filled here: use Limit, In parts' : 'Not available for this pair';
  else if (kind === 'market' && !quote) blocker = quoteError ?? 'Getting a quote…';
  else if (kind === 'market' && marketFees && !marketNet) blocker = 'Too small to cover the network fee';
  else if (kind === 'market' && viaSolver && !marketMinBuy) blocker = 'Too small for the slippage limit';
  else if (routeProblem) blocker = 'Route refused';
  else if (kind === 'limit' && !useBook && !config.limitOrders.enabled) blocker = 'Only order-book orders are enabled';
  // A whole-only order signs the route's network allowance: wait for the quote that gives it.
  else if (kind === 'limit' && !useBook && !quote && !quoteError) blocker = 'Getting a quote…';
  else if (kind === 'limit' && !useBook && at === 'hop' && !quote?.xrdBase) blocker = 'Cannot work out the XRD fees for this pair now';
  else if (kind === 'limit' && !useBook && limitGross && !limitMinBuy) blocker = 'Too small to cover the network fee';
  else if (bookPrice && !bookPrice.ok) blocker = 'Price cannot be held exactly';
  else if (bookTooSmall) blocker = `Below the ${fmtAmount(bookTooSmall.minXrd)} XRD minimum`;

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
      if (kind === 'market' && viaSolver && lo) {
        // Filled by the solver so it can take limit orders in the book as well as the pools.
        if (!marketMinBuy) { setError('This order is too small for the slippage limit after fees.'); return; }
        const placed = await sign(marketMinBuy, marketMinBuy, 'market', lo.marketOrderLifetimeSec, `Market ${side} ${base.symbol}`);
        props.onDone('Market order sent, filling…');
        const deadline = placed.expiresAt * 1000;
        let outcome = 'Market order not filled: the price moved beyond your slippage limit';
        let pending = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const mine = (await api.orders(account).catch(() => [])).find((o) => o.id === placed.id);
          if (mine?.status === 'filled') { outcome = `Market order filled: received ${fmtAmount(mine.received)} ${buyTok.symbol}`; pending = false; break; }
          // A fill transaction is in flight: its outcome comes from the ledger, so do not call it failed.
          pending = Boolean(mine?.pending);
          if (mine && mine.status !== 'open' && !pending) break;
        }
        props.onDone(pending ? 'Market order still being settled on the ledger: check Trades in a minute' : outcome);
      } else if (kind === 'market') {
        if (!quote || routeProblem) { setError(routeProblem ?? 'The quote has changed; try again.'); return; }
        const minBuy = withSlippage(quote.buyAmount, slippage);
        if (!minBuy) { setError('This order is too small for the slippage limit.'); return; }
        const txid = await wallet.sendTransaction(
          marketOrderManifest({ account, sell: sellTok.address, sellAmount, minBuyAmount: minBuy, route: quote.route }),
          `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`);
        props.onDone(`Market order submitted: ${txid}`);
      } else if (useBook && book) {
        // The contract's price is what the order is owed for each token it sells.
        const bp = bookContractPrice(side, price);
        if (!bp.ok) { setError(bp.reason); return; }
        if (tooSmallText) { setError(tooSmallText); return; }
        await wallet.sendTransaction(
          bookPlaceManifest({ account, book: book.component, sell: sellTok.address, sellAmount, buy: buyTok.address, price: bp.price, expiresAt: Math.floor(Date.now() / 1000) + expiry }),
          `Limit ${side} ${base.symbol} @ ${price}`);
        props.onDone('Limit order placed in the order book');
      } else {
        if (!limitMinBuy || !limitGross) { setError('This order is too small to cover the network fee.'); return; }
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

  // Keep what was typed unless the new text is a number: never delete characters silently
  // (pasting "1e-5" gives 0.00001, not 15; "-5" is refused, not turned into 5).
  const num = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = normaliseInput(e.target.value);
    if (v === undefined) { setHint('Numbers only: digits and one decimal point'); return; }
    setHint(undefined); set(v);
  };
  const partial = bookEstimate && !bookEstimate.filledAll && !quote;

  return (
    <section className={`panel form ${side}`} aria-label="Place an order">
      <div className="sides" role="group" aria-label="Side">
        <button className={side === 'buy' ? 'on buy' : 'buy'} aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>Buy {base.symbol}</button>
        <button className={side === 'sell' ? 'on sell' : 'sell'} aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>Sell {base.symbol}</button>
      </div>
      <div className="form-row">
        <div className="tabs" role="group" aria-label="Order type">
          <button aria-pressed={kind === 'market'} className={kind === 'market' ? 'on' : ''} onClick={() => setKind('market')}>Market</button>
          <button aria-pressed={kind === 'limit'} className={kind === 'limit' ? 'on' : ''} onClick={() => setKind('limit')}>Limit</button>
        </div>
        <span className="bal">Available <b>{fmtAmount(balanceStr)} {sellTok.symbol}</b></span>
      </div>

      {kind === 'limit' && (
        <label className="field"><span>Price</span><input inputMode="decimal" autoComplete="off" value={price} onChange={num(setPrice)} placeholder={fmtPrice(depth?.mid)} /><em>{quoteTok.symbol}</em></label>
      )}
      {(kind === 'limit' || side === 'sell') && (
        <label className="field"><span>Amount</span><input inputMode="decimal" autoComplete="off" value={amount} onChange={num(setAmount)} placeholder="0.0" /><em>{base.symbol}</em></label>
      )}
      {kind === 'market' && side === 'buy' && (
        <label className="field"><span>Spend</span><input inputMode="decimal" autoComplete="off" value={total} onChange={num(setTotal)} placeholder="0.0" /><em>{quoteTok.symbol}</em></label>
      )}
      {hint && <p className="hint" role="status">{hint}</p>}
      {!hint && roundedSell && <p className="hint" role="status">{sellTok.symbol} allows {sellPlaces} decimal places: {roundedSell} will be used</p>}
      <div className="pcts" role="group" aria-label="Share of available balance">{[0.25, 0.5, 0.75, 1].map((p) => <button key={p} onClick={() => setPct(p)} disabled={!(sellBalance > 0)}>{p * 100}%</button>)}</div>

      {kind === 'market' ? (
        <dl className="summary">
          <div><dt>You receive {quote ? '' : '(estimate)'}</dt><dd>{expectedOut ? `${fmtAmount(expectedOut)} ${buyTok.symbol}` : '—'}</dd></div>
          {partial && (
            <div><dt>Book depth</dt><dd className="warn">The book shown can take only {fmtAmount(bookEstimate.spent)} of {fmtAmount(sellAmount)} {sellTok.symbol}</dd></div>
          )}
          {quoteError && <div><dt>Quote</dt><dd className="warn">{quoteError}</dd></div>}
          {routeProblem && <div><dt>Route</dt><dd className="warn">{routeProblem}</dd></div>}
          <div><dt>Average price</dt><dd>{fmtPrice(execPrice)} {execPrice ? quoteTok.symbol : ''}</dd></div>
          <div><dt>Price impact</dt><dd className={impact !== undefined && impact > 3 ? 'warn' : ''}>{impact === undefined ? '—' : `${Math.max(0, impact).toFixed(2)}%`}</dd></div>
          {marketFees?.swappedXrd && <div><dt>Swapped</dt><dd>{fmtAmount(marketFees.swappedXrd.toNumber())} XRD</dd></div>}
          {marketFees
            ? <div title={`Network fee estimate + ${pct(config.feeBps)}, in XRD`}><dt>Fees ({feeWhere})</dt><dd>{feeText(marketFees)}</dd></div>
            : <div><dt>Route</dt><dd>{quote ? quote.route.map((p) => p.venue).join(' → ') : '—'}</dd></div>}
          {viaSolver && !solverFills && <div><dt>Note</dt><dd className="warn">{NOT_FILLED}</dd></div>}
          <div><dt>Max slippage</dt><dd className="seg mini" role="group" aria-label="Maximum slippage">{SLIPPAGES.map((s) => <button key={s} className={s === slippage ? 'on' : ''} aria-pressed={s === slippage} onClick={() => setSlippage(s)}>{s}%</button>)}</dd></div>
        </dl>
      ) : useBook && book ? (
        <dl className="summary">
          <div><dt>Fills</dt><dd className="seg mini" role="group" aria-label="How the order fills"><button className="on" aria-pressed="true">In parts</button>{config.limitOrders.enabled && <button aria-pressed="false" onClick={() => setInBook(false)}>Whole only</button>}</dd></div>
          <div><dt>Moves into the order book</dt><dd>{sellAmount ? `${fmtAmount(sellAmount)} ${sellTok.symbol}` : '—'}</dd></div>
          <div><dt>You receive, as it fills</dt><dd>{limitGross ? `${fmtAmount(Number(limitGross) * (1 - book.makerFeeBps / 10_000))} ${buyTok.symbol}` : '—'}</dd></div>
          {bookPrice && !bookPrice.ok && <div><dt>Price</dt><dd className="warn">{bookPrice.reason}</dd></div>}
          {bookTooSmall && (
            <div><dt>Too small</dt><dd className="warn">{tooSmallText} Filling a smaller one would cost more in network fees than it is worth. Enter a larger amount{config.limitOrders.enabled ? ', or choose “Whole only”' : ''}.</dd></div>
          )}
          {/* The exchange only spends and earns XRD, so it never buys from book orders in a pair without XRD. */}
          {at === 'hop' && <div><dt>Note</dt><dd className="warn">Neither token is XRD, so the exchange does not buy from this order itself or route market orders to it: it fills only when someone buys from the order book contract directly.</dd></div>}
          <div><dt>Fee</dt><dd>{book.makerFeeBps > 0 ? pct(book.makerFeeBps) : 'None'}, plus the network fee to place it (about 0.8 XRD)</dd></div>
          <div><dt>Right now</dt><dd className={fillsNow ? 'up' : ''}>{fillsNow === undefined ? '—' : fillsNow ? 'Would fill straight away, at your price' : `Would wait: the market pays ${fmtAmount(quote!.buyAmount)} ${buyTok.symbol} for this size`}</dd></div>
          {fillsNow && quote && limitGross && (
            <div><dt>Note</dt><dd className="warn">The market pays {fmtAmount(quote.buyAmount)} {buyTok.symbol} for this size now, more than the {fmtAmount(limitGross)} {buyTok.symbol} your price gives. An order filled in parts gets its own price and no better: the difference is kept by the exchange. For the market price, use a Market order{config.limitOrders.enabled ? ' or “Whole only”' : ''}.</dd></div>
          )}
          <div><dt>Expires in</dt><dd><select className="select" aria-label="Expires in" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRIES.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></dd></div>
        </dl>
      ) : (
        <dl className="summary">
          {book && <div><dt>Fills</dt><dd className="seg mini" role="group" aria-label="How the order fills"><button aria-pressed="false" onClick={() => setInBook(true)}>In parts</button><button className="on" aria-pressed="true">Whole only</button></dd></div>}
          <div><dt>You pay</dt><dd>{sellAmount ? `${fmtAmount(sellAmount)} ${sellTok.symbol}` : '—'}</dd></div>
          {limitFees?.swappedXrd && <div><dt>Swapped</dt><dd>{fmtAmount(limitFees.swappedXrd.toNumber())} XRD</dd></div>}
          <div><dt>At your price you get</dt><dd>{limitGross ? `${fmtAmount(limitGross)} ${buyTok.symbol}` : '—'}</dd></div>
          <div title={`Network fee allowance + ${pct(config.feeBps)}, in XRD`}><dt>Fees ({feeWhere})</dt><dd>{limitFees ? feeText(limitFees) : '—'}</dd></div>
          {!solverFills && <div><dt>Note</dt><dd className="warn">{NOT_FILLED}</dd></div>}
          <div><dt>If another trader takes it</dt><dd>{(config.makerFeeBps ?? 0) > 0 ? `Fee ${pct(config.makerFeeBps ?? 0)}, no network fee` : 'No fee: you get your full price'}</dd></div>
          <div><dt>You receive at least</dt><dd>{limitMinBuy ? `${fmtAmount(limitMinBuy)} ${buyTok.symbol}` : '—'}</dd></div>
          {/* Without a quote the network allowance is the server's fallback (gasXrd × margin): say why. */}
          {quoteError && <div><dt>Quote</dt><dd className="warn">{quoteError}</dd></div>}
          <div><dt>Right now</dt><dd className={fillsNow ? 'up' : ''}>{fillsNow === undefined ? '—' : fillsNow ? 'Would fill straight away' : `Would wait: the market pays ${fmtAmount(quote!.buyAmount)} ${buyTok.symbol} for this size`}</dd></div>
          <div><dt>Expires in</dt><dd><select className="select" aria-label="Expires in" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRIES.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select></dd></div>
        </dl>
      )}

      <button className={`submit ${side}${busy ? ' busy' : ''}`} disabled={Boolean(blocker) || busy} onClick={submit}>
        {busy ? 'Working…' : blocker ?? `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {kind === 'market' && viaSolver && (
        <p className="note"><Icon name="info" size={13} />Your wallet will ask you to approve a pre-authorization. The order is then filled for you within a few seconds at the best price from the order book and the pools, and you pay no separate network fee.</p>
      )}
      {useBook && (
        <p className="note"><Icon name="info" size={13} />Your tokens move into the order book contract, where the ledger enforces your price. Other traders can buy any part of the order, and each part is paid straight to your account at your price. You can cancel at any time and take back what has not sold. This contract has not been audited.</p>
      )}
      {kind === 'limit' && !useBook && (
        <p className="note"><Icon name="info" size={13} />A limit order is a signed permission, not a transaction: placing it is free and your funds stay in your account until it fills. It fills in full or not at all, as soon as the market reaches your price. The fees are taken in XRD, as shown above, and you never get less than the “at least” amount, which is what your wallet shows. Its cancel key is kept in this browser only: clearing site data loses the ability to cancel it before it expires.</p>
      )}
    </section>
  );
}
