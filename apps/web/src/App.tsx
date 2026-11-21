import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import { type Candle, type MarketSummary, type MarketTrade, type OrderView, type ServerConfig, type TradeView, STATIC, api } from './api';
import { Book } from './Book';
import { Chart } from './Chart';
import { DepthChart } from './DepthChart';
import { fmtPrice, fmtTime, fmtUsd, shortAddr } from './format';
import { Markets } from './Markets';
import { OrderForm } from './OrderForm';
import { Orders } from './Orders';
import { Icon, Logo, Mark } from './ui';
import { type WalletAccount, getWallet } from './wallet';

const RESOLUTIONS = ['15m', '1h', '4h', '1d', '1w'];

/** Run `load` now and every `ms`, ignoring results that arrive after the inputs changed. */
function usePolling(load: () => Promise<void> | void, ms: number, deps: unknown[]) {
  useEffect(() => {
    let live = true;
    const run = () => { if (live && !document.hidden) void load(); };
    run();
    const t = setInterval(run, ms);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function App() {
  const [config, setConfig] = useState<ServerConfig>();
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => decodeURIComponent(location.hash.slice(1)) || undefined);
  const [resolution, setResolution] = useState('1h');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [depth, setDepth] = useState<Depth>();
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [account, setAccount] = useState<string>();
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [picked, setPicked] = useState<number>();
  const [marketTrades, setMarketTrades] = useState<MarketTrade[]>();
  const [chartTab, setChartTab] = useState<'price' | 'depth'>('price');
  const [toast, setToast] = useState<string>();
  const [fatal, setFatal] = useState<string>();
  const [showMarkets, setShowMarkets] = useState(false);

  useEffect(() => {
    Promise.all([api.config(), api.markets()]).then(([c, m]) => {
      setConfig(c); setMarkets(m);
      // Open on XRD's own market if there is one, otherwise the deepest.
      setSelected((s) => (s && m.some((x) => x.id === s) ? s : (m.find((x) => x.base.address === c.xrd) ?? m[0])?.id));
    }).catch((e) => setFatal(e.message));
  }, []);

  const market = useMemo(() => markets.find((m) => m.id === selected), [markets, selected]);
  useEffect(() => { if (selected) history.replaceState(null, '', '#' + encodeURIComponent(selected)); }, [selected]);

  const wallet = useMemo(() => (config && !STATIC ? getWallet(config.networkId, config.dAppDefinition) : undefined), [config]);
  useEffect(() => wallet?.onAccounts((a) => { setAccounts(a); setAccount((cur) => (cur && a.some((x) => x.address === cur) ? cur : a[0]?.address)); }), [wallet]);

  useEffect(() => {
    if (!market) return;
    let live = true;
    setCandlesLoading(true);
    const load = () => api.candles(market.id, resolution).then((c) => live && setCandles(c)).catch(() => live && setCandles([])).finally(() => live && setCandlesLoading(false));
    void load();
    // Keep the chart moving while the page is open.
    const t = STATIC ? undefined : setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [market?.id, resolution]);

  useEffect(() => setDepth(undefined), [market?.id]);
  usePolling(async () => {
    if (!market) return;
    const id = market.id;
    try { const d = await api.depth(id); setDepth((cur) => (id === market.id ? d : cur)); } catch { /* keep the last book */ }
  }, STATIC ? 3_600_000 : 20_000, [market?.id]);

  useEffect(() => setMarketTrades(undefined), [market?.id]);
  usePolling(async () => {
    if (!market) return;
    const id = market.id;
    try { const t = await api.trades(id); setMarketTrades((cur) => (id === market.id ? t : cur)); } catch { /* keep the last list */ }
  }, STATIC ? 3_600_000 : 10_000, [market?.id]);

  const refreshAccount = useCallback(async () => {
    if (!account || STATIC) { setBalances({}); setOrders([]); setTrades([]); return; }
    const [b, o, t] = await Promise.allSettled([api.balances(account), api.orders(account), api.history(account)]);
    if (t.status === 'fulfilled') setTrades(t.value);
    if (b.status === 'fulfilled') setBalances(b.value);
    if (o.status === 'fulfilled') setOrders(o.value);
  }, [account]);
  usePolling(refreshAccount, 10_000, [refreshAccount]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), 6000); return () => clearTimeout(t); }, [toast]);

  if (fatal) return <div className="fatal"><Logo /><h1>Market data is unavailable</h1><p className="muted">Could not load market data: {fatal}</p><button className="btn-primary" onClick={() => location.reload()}>Try again</button></div>;
  if (!config || !market) {
    const none = config && markets.length === 0;
    return <div className="fatal" role="status"><span className={none ? 'fatal-mark' : 'fatal-mark pulse'}><Mark size={28} /></span><p className="muted">{none ? 'No markets are available right now.' : 'Loading markets…'}</p></div>;
  }

  const last = candles[candles.length - 1], first = candles[0];
  const change = last && first ? (last.close / first.open - 1) * 100 : undefined;
  const changeDir = change === undefined ? '' : change >= 0 ? 'up' : 'down';

  return (
    <div className={`app ${showMarkets ? 'show-markets' : ''}`}>
      <header className="top">
        <Logo />
        <button className="pair-btn" onClick={() => setShowMarkets((v) => !v)} aria-expanded={showMarkets} aria-label={`${market.base.symbol}/${market.quote.symbol}: choose a market`}>
          <span className="pair-base">{market.base.symbol}</span><span className="pair-quote">/{market.quote.symbol}</span> <span className="caret"><Icon name="chevron" size={14} /></span>
        </button>
        <div className="ticker">
          <span className="sr-only">Price</span>
          <span className="ticker-price">{fmtPrice(depth?.mid ?? last?.close)}</span>
          <span className={`ticker-change ${changeDir}`} title="Change over the chart's range">
            <span className="sr-only">Change (chart)</span>{change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
          </span>
        </div>
        <dl className="stats">
          <div><dt>Liquidity</dt><dd>{fmtUsd(market.tvlUsd)}</dd></div>
          <div><dt>24h volume</dt><dd>{fmtUsd(market.volume24hUsd)}</dd></div>
          <div className="venues"><dt>Venues</dt><dd>{market.venues.join(', ') || 'orders only'}</dd></div>
        </dl>
        <div className="right">
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
              <div className="tabs" role="tablist" aria-label="Chart">
                <button role="tab" aria-selected={chartTab === 'price'} className={chartTab === 'price' ? 'on' : ''} onClick={() => setChartTab('price')}>Price</button>
                <button role="tab" aria-selected={chartTab === 'depth'} className={chartTab === 'depth' ? 'on' : ''} onClick={() => setChartTab('depth')}>Depth</button>
              </div>
            </div>
            {chartTab === 'price'
              ? <div className="seg mini" role="group" aria-label="Candle interval">{RESOLUTIONS.map((r) => <button key={r} className={r === resolution ? 'on' : ''} aria-pressed={r === resolution} onClick={() => setResolution(r)}>{r}</button>)}</div>
              : <span className="head-note">cumulative {market.base.symbol} on offer, pools + limit orders</span>}
          </header>
          {chartTab === 'price' ? <Chart candles={candles} loading={candlesLoading} /> : <DepthChart depth={depth} baseSymbol={market.base.symbol} onPick={setPicked} />}
        </section>
        <Orders orders={orders} trades={trades} explorer={config?.networkId === 1 ? 'https://dashboard.radixdlt.com' : 'https://stokenet-dashboard.radixdlt.com'} markets={markets} account={account} onChanged={refreshAccount} wallet={wallet} orderBook={config.orderBook} />
      </main>

      <div className="side">
        <Book depth={depth} trades={marketTrades} explorer={config.networkId === 1 ? 'https://dashboard.radixdlt.com' : 'https://stokenet-dashboard.radixdlt.com'} baseSymbol={market.base.symbol} quoteSymbol={market.quote.symbol} onPick={setPicked} />
        <OrderForm market={market} depth={depth} config={config} wallet={wallet} account={account} balances={balances} pickedPrice={picked}
          onDone={(m) => { setToast(m); void refreshAccount(); }} />
      </div>
      {toast && <div className="toast" role="status"><Icon name="info" size={15} /><span>{toast}</span></div>}
    </div>
  );
}
