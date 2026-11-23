import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import { type Candle, type MarketSummary, type MarketTrade, type OrderView, type ServerConfig, type TradeView, ApiError, STATIC, api } from './api';
import { Book } from './Book';
import { Chart } from './Chart';
import { DepthChart } from './DepthChart';
import { fmtPrice, fmtTime, fmtUsd, shortAddr, venueName } from './format';
import { Markets } from './Markets';
import { OrderForm } from './OrderForm';
import { Orders } from './Orders';
import { type Keyed, forKey, headerChange, pollGuard, retryWaitMs } from './live';
import { Icon, Logo, Mark, TabPanel, Tabs } from './ui';
import { type WalletAccount, getWallet } from './wallet';

const RESOLUTIONS = ['15m', '1h', '4h', '1d', '1w'];

const EMPTY_CANDLES: Candle[] = [];
const NO_BALANCES: Record<string, string> = {};
const NO_ORDERS: OrderView[] = [];
const NO_TRADES: TradeView[] = [];
const WIDE = '(min-width: 1101px)'; // above this the markets list is always shown, not a drawer

/**
 * Run `load` now and every `ms`. `load` gets `isCurrent`, which turns false once the inputs change
 * or the component unmounts: check it after every await and drop the reply if it is false.
 */
function usePolling(load: (isCurrent: () => boolean) => Promise<void> | void, ms: number, deps: unknown[]) {
  useEffect(() => {
    const guard = pollGuard();
    const run = () => { if (guard.isCurrent() && !document.hidden) void load(guard.isCurrent); };
    run();
    const t = setInterval(run, ms);
    return () => { guard.stop(); clearInterval(t); };
  }, deps); // the caller names the inputs `load` depends on
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query), f = () => setOn(m.matches);
    // Some environments (device emulation, older engines) miss the change event: also check on resize.
    f(); m.addEventListener('change', f); window.addEventListener('resize', f);
    return () => { m.removeEventListener('change', f); window.removeEventListener('resize', f); };
  }, [query]);
  return on;
}

export function App() {
  const [config, setConfig] = useState<ServerConfig>();
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => decodeURIComponent(location.hash.slice(1)) || undefined);
  const [resolution, setResolution] = useState('1h');
  // Everything loaded for a market or an account is stored with the key it was loaded for, and
  // read back only under the current key: a late reply for the previous market or account can
  // never reach the screen, and switching clears the old data at once.
  const [candleSet, setCandleSet] = useState<Keyed<Candle[]> & { resolution: string }>();
  const [candlesBusy, setCandlesBusy] = useState(true);
  const [depthSet, setDepthSet] = useState<Keyed<Depth>>();
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [account, setAccount] = useState<string>();
  const [balanceSet, setBalanceSet] = useState<Keyed<Record<string, string>>>();
  const [orderSet, setOrderSet] = useState<Keyed<OrderView[]>>();
  const [historySet, setHistorySet] = useState<Keyed<TradeView[]>>();
  const [pickedSet, setPickedSet] = useState<Keyed<{ price: number; n: number }>>();
  const [marketTradeSet, setMarketTradeSet] = useState<Keyed<MarketTrade[]>>();
  const [chartTab, setChartTab] = useState<'price' | 'depth'>('price');
  const [toast, setToast] = useState<string>();
  const [loadError, setLoadError] = useState<{ message: string; retryInSec: number; attempt: number }>();
  const [reload, setReload] = useState(0);
  const [showMarkets, setShowMarkets] = useState(false);
  const wide = useMedia(WIDE);
  const pickCount = useRef(0);

  // First load, retried with backoff: one failure (a 429 after a burst, say) is not final.
  useEffect(() => {
    let live = true, attempt = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      Promise.all([api.config(), api.markets()]).then(([c, m]) => {
        if (!live) return;
        setLoadError(undefined); setConfig(c); setMarkets(m);
        // Open on XRD's own market if there is one, otherwise the deepest.
        setSelected((s) => (s && m.some((x) => x.id === s) ? s : (m.find((x) => x.base.address === c.xrd) ?? m[0])?.id));
      }).catch((e: Error) => {
        if (!live) return;
        // Never sooner than the server asked (Retry-After on a 429).
        const wait = retryWaitMs(attempt, e instanceof ApiError ? e.retryAfterSec : undefined);
        attempt++;
        setLoadError({ message: e.message, retryInSec: Math.round(wait / 1000), attempt });
        timer = setTimeout(go, wait);
      });
    };
    go();
    return () => { live = false; clearTimeout(timer); };
  }, [reload]);

  const market = useMemo(() => markets.find((m) => m.id === selected), [markets, selected]);
  const listedPools = useMemo(() => new Set(markets.flatMap((m) => m.pools ?? [])), [markets]);
  const marketId = market?.id;
  const depth = forKey(depthSet, marketId);
  const marketTrades = forKey(marketTradeSet, marketId);
  const candles = forKey(candleSet, marketId) ?? EMPTY_CANDLES;
  const candlesLoading = candlesBusy || candleSet?.key !== marketId || candleSet?.resolution !== resolution;
  const picked = forKey(pickedSet, marketId);
  const balances = forKey(balanceSet, account) ?? NO_BALANCES;
  const orders = forKey(orderSet, account) ?? NO_ORDERS;
  const trades = forKey(historySet, account) ?? NO_TRADES;
  const onPick = useCallback((price: number) => { if (marketId) setPickedSet({ key: marketId, value: { price, n: ++pickCount.current } }); }, [marketId]);

  // Above 1100 px there is no drawer: never leave one marked open for when the window narrows.
  useEffect(() => { if (wide) setShowMarkets(false); }, [wide]);
  useEffect(() => { if (selected) history.replaceState(null, '', '#' + encodeURIComponent(selected)); }, [selected]);

  const wallet = useMemo(() => (config && !STATIC ? getWallet(config.networkId, config.dAppDefinition) : undefined), [config]);
  useEffect(() => wallet?.onAccounts((a) => { setAccounts(a); setAccount((cur) => (cur && a.some((x) => x.address === cur) ? cur : a[0]?.address)); }), [wallet]);

  useEffect(() => {
    if (!marketId) return;
    const guard = pollGuard(), id = marketId;
    setCandlesBusy(true);
    const load = () => api.candles(id, resolution)
      .then((c) => { if (guard.isCurrent()) setCandleSet({ key: id, value: c, resolution }); })
      // A failed refresh keeps the chart; a failed first load shows "no history".
      .catch(() => { if (guard.isCurrent()) setCandleSet((cur) => (cur?.key === id && cur.resolution === resolution ? cur : { key: id, value: [], resolution })); })
      .finally(() => { if (guard.isCurrent()) setCandlesBusy(false); });
    void load();
    // Keep the chart moving while the page is open.
    const t = STATIC ? undefined : setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { guard.stop(); clearInterval(t); };
  }, [marketId, resolution]);

  usePolling(async (isCurrent) => {
    if (!marketId) return;
    const id = marketId;
    try { const d = await api.depth(id); if (isCurrent()) setDepthSet({ key: id, value: d }); } catch { /* keep the last book */ }
  }, STATIC ? 3_600_000 : 20_000, [marketId]);

  usePolling(async (isCurrent) => {
    if (!marketId) return;
    const id = marketId;
    try { const t = await api.trades(id); if (isCurrent()) setMarketTradeSet({ key: id, value: t }); } catch { /* keep the last list */ }
  }, STATIC ? 3_600_000 : 10_000, [marketId]);

  // Account data, also keyed: a slow reply for the previous account is dropped.
  const accountRef = useRef(account);
  accountRef.current = account;
  const refreshAccount = useCallback(async () => {
    const acc = account;
    if (!acc || STATIC) return;
    const [b, o, t] = await Promise.allSettled([api.balances(acc), api.orders(acc), api.history(acc)]);
    if (accountRef.current !== acc) return;
    if (t.status === 'fulfilled') setHistorySet({ key: acc, value: t.value });
    if (b.status === 'fulfilled') setBalanceSet({ key: acc, value: b.value });
    if (o.status === 'fulfilled') setOrderSet({ key: acc, value: o.value });
  }, [account]);
  usePolling(refreshAccount, 10_000, [refreshAccount]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), 6000); return () => clearTimeout(t); }, [toast]);

  if (loadError && (!config || !market)) {
    return (
      <div className="fatal" role="alert">
        <Logo /><h1>Market data is unavailable</h1>
        <p className="muted">Could not load market data: {loadError.message}. Trying again automatically in {loadError.retryInSec} s (attempt {loadError.attempt + 1}).</p>
        <button className="btn-primary" onClick={() => setReload((n) => n + 1)}>Try now</button>
      </div>
    );
  }
  if (!config || !market) {
    const none = config && markets.length === 0;
    return <div className="fatal" role="status"><span className={none ? 'fatal-mark' : 'fatal-mark pulse'}><Mark size={28} /></span><p className="muted">{none ? 'No markets are available right now.' : 'Loading markets…'}</p></div>;
  }

  const last = candles[candles.length - 1];
  const changeInfo = headerChange(candles, candleSet?.resolution ?? resolution, Date.now() / 1000);
  const change = changeInfo?.pct;
  const changeDir = change === undefined ? '' : change >= 0 ? 'up' : 'down';
  // The header shows the order book's mid; the chart's tag is the last trade. Say which is which.
  const priceIsMid = depth?.mid != null;
  const headPrice = priceIsMid ? depth?.mid : last?.close;
  const pairClick = () => {
    if (wide) { document.querySelector<HTMLInputElement>('.markets input[type="search"]')?.focus(); return; }
    setShowMarkets((v) => !v);
  };

  return (
    <div className={`app ${showMarkets ? 'show-markets' : ''}`}>
      <header className="top">
        <Logo />
        <button className="pair-btn" onClick={pairClick} aria-expanded={wide ? undefined : showMarkets} aria-controls="markets-panel" aria-label={`${market.base.symbol}/${market.quote.symbol}: choose a market`}>
          <span className="pair-base">{market.base.symbol}</span><span className="pair-quote">/{market.quote.symbol}</span> <span className="caret"><Icon name="chevron" size={14} /></span>
        </button>
        <div className="ticker">
          <span className="ticker-label" title={priceIsMid ? 'Mid price of the order book (pools and limit orders). The chart shows trade prices, so its last price can differ.' : 'Last trade price, from the chart'}>{headPrice === undefined ? 'Price' : priceIsMid ? 'Mid' : 'Last'}</span>
          <span className="ticker-price">{fmtPrice(headPrice)}</span>
          <span className={`ticker-change ${changeDir}`} title={changeInfo?.title ?? 'Price change'}>
            <span className="sr-only">{changeInfo?.label === '24h' ? 'Change over 24 hours' : `Change over the chart's ${changeInfo?.label ?? 'range'}`}</span>{change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
            {changeInfo && <span className="ticker-span" aria-hidden="true">{changeInfo.label}</span>}
          </span>
        </div>
        <dl className="stats">
          <div><dt>Liquidity</dt><dd>{fmtUsd(market.tvlUsd)}</dd></div>
          <div><dt>24h volume</dt><dd>{fmtUsd(market.volume24hUsd)}</dd></div>
          <div className="venues"><dt>Venues</dt><dd>{market.venues.map(venueName).join(', ') || 'orders only'}</dd></div>
        </dl>
        <div className="right">
          {!STATIC && (config.ownerPools ?? 0) > 0 && <nav className="nav" aria-label="Sections"><a href="#/pools">Pools</a></nav>}
          <span className={`net ${config.network}`}><span className="dot" aria-hidden="true" />{config.network}</span>
          {accounts.length > 1 && (
            <select className="account" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label || shortAddr(a.address)}</option>)}
            </select>
          )}
          {/* The Radix connect button is a web component registered by the dApp toolkit. */}
          {wallet ? <radix-connect-button /> : <span className="muted small">{STATIC ? 'read-only preview' : 'wallet not configured'}</span>}
        </div>
      </header>

      {(STATIC || config.warning || (config.network === 'mainnet' && wallet)) && (
        <div className="banner" role="note">
          <Icon name="warn" size={15} />
          <p>
            {config.network === 'mainnet' && wallet && !STATIC && <><strong>Early release with real funds.</strong> This software and its contracts have not been independently audited: trade only what you can afford to lose. </>}
            {STATIC && <><strong>Read-only preview.</strong> Market data is a snapshot taken {config.snapshotAt ? fmtTime(config.snapshotAt) : 'earlier'}; trading is switched off. </>}
            {config.warning && <>Some market data could not be refreshed ({config.warning}).</>}
          </p>
        </div>
      )}

      {showMarkets && <div className="scrim" onClick={() => setShowMarkets(false)} aria-hidden="true" />}
      <Markets markets={markets} selected={market.id} onSelect={(id) => { setSelected(id); setShowMarkets(false); }} />

      <main className="center">
        <section className="panel chart-panel">
          <header className="panel-head">
            <div className="head-left">
              <h2 className="panel-title">{market.base.symbol}<span>/{market.quote.symbol}</span></h2>
              <Tabs label="Chart" value={chartTab} onChange={setChartTab} panelId="chart-panel" items={[['price', 'Price'], ['depth', 'Depth']]} />
            </div>
            {chartTab === 'price'
              ? <div className="seg mini" role="group" aria-label="Candle interval">{RESOLUTIONS.map((r) => <button key={r} className={r === resolution ? 'on' : ''} aria-pressed={r === resolution} onClick={() => setResolution(r)}>{r}</button>)}</div>
              : <span className="head-note">cumulative {market.base.symbol} on offer, pools + limit orders</span>}
          </header>
          <TabPanel id="chart-panel" value={chartTab}>
            {chartTab === 'price'
              ? <Chart candles={candles} loading={candlesLoading} label={`${market.base.symbol}/${market.quote.symbol} price chart, ${resolution} candles`} />
              : <DepthChart depth={depth} baseSymbol={market.base.symbol} onPick={onPick} />}
          </TabPanel>
        </section>
        <Orders orders={orders} trades={trades} explorer={config?.networkId === 1 ? 'https://dashboard.radixdlt.com' : 'https://stokenet-dashboard.radixdlt.com'} markets={markets} account={account} onChanged={refreshAccount} wallet={wallet} orderBook={config.orderBook} registry={config.limitOrders.enabled ? config.limitOrders.registry : null} />
      </main>

      <div className="side">
        <Book depth={depth} trades={marketTrades} explorer={config.networkId === 1 ? 'https://dashboard.radixdlt.com' : 'https://stokenet-dashboard.radixdlt.com'} baseSymbol={market.base.symbol} quoteSymbol={market.quote.symbol} onPick={onPick} />
        <OrderForm market={market} depth={depth} config={config} wallet={wallet} account={account} balances={balances} picked={picked} listedPools={listedPools}
          onDone={(m) => { setToast(m); void refreshAccount(); }} />
      </div>
      {toast && <div className="toast" role="status"><Icon name="info" size={15} /><span>{toast}</span></div>}
    </div>
  );
}
