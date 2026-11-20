import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Depth } from '@radix-dex/core/browser';
import { type Candle, type MarketSummary, type OrderView, type ServerConfig, STATIC, api } from './api';
import { Book } from './Book';
import { Chart } from './Chart';
import { fmtPrice, fmtTime, fmtUsd, shortAddr } from './format';
import { Markets } from './Markets';
import { OrderForm } from './OrderForm';
import { Orders } from './Orders';
import { DAPP_DEFINITION, type WalletAccount, getWallet } from './wallet';

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
  const [picked, setPicked] = useState<number>();
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

  const wallet = useMemo(() => (config && !STATIC ? getWallet(config.networkId) : undefined), [config]);
  useEffect(() => wallet?.onAccounts((a) => { setAccounts(a); setAccount((cur) => (cur && a.some((x) => x.address === cur) ? cur : a[0]?.address)); }), [wallet]);

  useEffect(() => {
    if (!market) return;
    let live = true;
    setCandlesLoading(true);
    api.candles(market.id, resolution).then((c) => live && setCandles(c)).catch(() => live && setCandles([])).finally(() => live && setCandlesLoading(false));
    return () => { live = false; };
  }, [market?.id, resolution]);

  useEffect(() => setDepth(undefined), [market?.id]);
  usePolling(async () => {
    if (!market) return;
    const id = market.id;
    try { const d = await api.depth(id); setDepth((cur) => (id === market.id ? d : cur)); } catch { /* keep the last book */ }
  }, STATIC ? 3_600_000 : 20_000, [market?.id]);

  const refreshAccount = useCallback(async () => {
    if (!account || STATIC) { setBalances({}); setOrders([]); return; }
    const [b, o] = await Promise.allSettled([api.balances(account), api.orders(account)]);
    if (b.status === 'fulfilled') setBalances(b.value);
    if (o.status === 'fulfilled') setOrders(o.value);
  }, [account]);
  usePolling(refreshAccount, 10_000, [refreshAccount]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), 6000); return () => clearTimeout(t); }, [toast]);

  if (fatal) return <div className="fatal"><h1>Radix DEX</h1><p>Could not load market data: {fatal}</p><button onClick={() => location.reload()}>Try again</button></div>;
  if (!config || !market) return <div className="fatal"><p className="muted">{config && markets.length === 0 ? 'No markets are available right now.' : 'Loading markets…'}</p></div>;

  const last = candles[candles.length - 1], first = candles[0];
  const change = last && first ? (last.close / first.open - 1) * 100 : undefined;

  return (
    <div className={`app ${showMarkets ? 'show-markets' : ''}`}>
      <header className="top">
        <div className="brand"><span className="logo">◆</span> Radix DEX</div>
        <button className="pair-btn" onClick={() => setShowMarkets((v) => !v)} aria-expanded={showMarkets}>
          <strong>{market.base.symbol}</strong>/{market.quote.symbol} <span className="caret">▾</span>
        </button>
        <div className="stats">
          <div><span className="muted small">Price</span><strong>{fmtPrice(depth?.mid ?? last?.close)}</strong></div>
          <div><span className="muted small">Change (chart)</span><strong className={change === undefined ? '' : change >= 0 ? 'up' : 'down'}>{change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}</strong></div>
          <div><span className="muted small">Liquidity</span><strong>{fmtUsd(market.tvlUsd)}</strong></div>
          <div><span className="muted small">24h volume</span><strong>{fmtUsd(market.volume24hUsd)}</strong></div>
          <div><span className="muted small">Venues</span><strong>{market.venues.join(', ') || 'orders only'}</strong></div>
        </div>
        <div className="right">
          <span className={`net ${config.network}`}>{config.network}</span>
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label || shortAddr(a.address)}</option>)}
            </select>
          )}
          {/* The Radix connect button is a web component registered by the dApp toolkit. */}
          {wallet ? <radix-connect-button /> : <span className="muted small">{STATIC ? 'read-only preview' : DAPP_DEFINITION ? '' : 'wallet not configured'}</span>}
        </div>
      </header>

      {(STATIC || config.warning) && (
        <div className="banner">
          {STATIC && <>Read-only preview. Market data is a snapshot taken {config.snapshotAt ? fmtTime(config.snapshotAt) : 'earlier'}; trading is switched off. </>}
          {config.warning && <>Some market data could not be refreshed ({config.warning}).</>}
        </div>
      )}

      <Markets markets={markets} selected={market.id} onSelect={(id) => { setSelected(id); setShowMarkets(false); }} />

      <main className="center">
        <section className="panel chart-panel">
          <header className="panel-head">
            <h2>{market.base.symbol}/{market.quote.symbol}</h2>
            <div className="seg mini">{RESOLUTIONS.map((r) => <button key={r} className={r === resolution ? 'on' : ''} onClick={() => setResolution(r)}>{r}</button>)}</div>
          </header>
          <Chart candles={candles} loading={candlesLoading} />
        </section>
        <Orders orders={orders} markets={markets} account={account} onChanged={refreshAccount} />
      </main>

      <div className="side">
        <Book depth={depth} baseSymbol={market.base.symbol} quoteSymbol={market.quote.symbol} onPick={setPicked} />
        <OrderForm market={market} depth={depth} config={config} wallet={wallet} account={account} balances={balances} pickedPrice={picked}
          onDone={(m) => { setToast(m); void refreshAccount(); }} />
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
