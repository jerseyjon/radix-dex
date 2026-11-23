import { useCallback, useEffect, useMemo, useState } from 'react';
import { type OperatorLimits, type OwnerAction, type PoolDetail, type PoolRow, type PreparedAction, type ServerConfig, ApiError, api } from './api';
import { fmtAmount, fmtPrice, fmtUsd, shortAddr } from './format';
import { PoolGlance, MiniGap } from './PoolGraphics';
import { ago, canSign, fmtGap, gapTone, healthLabel, poolStatus, shortId } from './pools';
import { Empty, Icon, Logo, SkeletonRows } from './ui';
import { type Wallet, type WalletAccount, getWallet } from './wallet';

/**
 * The owner's pools: a table of the OwnerPools the server lists, and one pool in detail with the
 * owner's actions. Routes: #/pools and #/pools/<component>. Read only for everyone; the owner's
 * actions appear only for an account that holds the pool's owner badge on the ledger, and each one is
 * built and previewed by the server, then signed in the owner's own wallet.
 */
export function PoolsPage({ route }: { route: string }) {
  const component = route.startsWith('#/pools/') ? decodeURIComponent(route.slice('#/pools/'.length)) : undefined;
  const [config, setConfig] = useState<ServerConfig>();
  const [error, setError] = useState<string>();
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [account, setAccount] = useState<string>();

  useEffect(() => { api.config().then(setConfig, (e: Error) => setError(e.message)); }, []);
  const wallet = useMemo(() => (config ? getWallet(config.networkId, config.dAppDefinition) : undefined), [config]);
  useEffect(() => wallet?.onAccounts((a) => { setAccounts(a); setAccount((cur) => (cur && a.some((x) => x.address === cur) ? cur : a[0]?.address)); }), [wallet]);
  useEffect(() => { document.title = component ? 'Pool · Radix DEX' : 'Pools · Radix DEX'; return () => { document.title = 'Radix DEX'; }; }, [component]);
  const explorer = config?.networkId === 1 ? 'https://dashboard.radixdlt.com' : 'https://stokenet-dashboard.radixdlt.com';

  return (
    <div className="pools-page">
      <header className="top">
        <Logo />
        <nav className="nav" aria-label="Sections">
          <a href="#">Trade</a>
          <a href="#/pools" aria-current={component ? undefined : 'page'} className="on">Pools</a>
        </nav>
        <div className="right">
          {config && <span className={`net ${config.network}`}><span className="dot" aria-hidden="true" />{config.network}</span>}
          {accounts.length > 1 && (
            <select className="account" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
              {accounts.map((a) => <option key={a.address} value={a.address}>{a.label || shortAddr(a.address)}</option>)}
            </select>
          )}
          {wallet ? <radix-connect-button /> : config && <span className="muted small">wallet not configured</span>}
        </div>
      </header>
      <main className="pools-main">
        {error && <p className="error">{error}</p>}
        {component ? <PoolView component={component} account={account} wallet={wallet} explorer={explorer} /> : <PoolTable />}
      </main>
    </div>
  );
}

function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]): { value: T | undefined; error: string | undefined; reload: () => void } {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () => load().then((v) => { if (live) { setValue(v); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    void run();
    // Later refreshes only while the page is visible.
    const t = setInterval(() => { if (!document.hidden) void run(); }, ms);
    return () => { live = false; clearInterval(t); };
  }, [...deps, n]);
  return { value, error, reload: () => setN((x) => x + 1) };
}

// ------------------------------------------------------------------ the table

function PoolTable() {
  const { value: rows, error } = usePoll(api.pools, 30_000, []);
  const now = Date.now();
  return (
    <section className="panel pools-table" aria-label="Pools">
      <header className="panel-head"><h1 className="panel-title">Pools</h1><span className="head-note">The owner's own pools (OwnerPool), read from the ledger</span></header>
      {error && <p className="error">{error}</p>}
      {!rows && !error && <SkeletonRows rows={3} label="Loading pools" />}
      {rows && rows.length === 0 && <Empty>No pools are listed on this server.</Empty>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Pair</th><th className="r">Price</th><th className="r">vs market</th><th className="r">TVL</th><th className="r">Fee</th><th>Status</th><th>Bot</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                if ('error' in r) return <tr key={r.address}><td>{shortId(r.address)}</td><td colSpan={7} className="down">Cannot be read: {r.error}</td></tr>;
                const st = poolStatus(r), bot = healthLabel(r.bot.bot, now);
                const href = `#/pools/${encodeURIComponent(r.address)}`;
                return (
                  <tr key={r.address} className="clickable" onClick={() => { location.hash = href; }}>
                    <td><a className="pair-link" href={href}><strong>{r.pair.a.symbol}</strong><span className="muted">/{r.pair.b.symbol}</span></a></td>
                    <td className="r">{fmtPrice(r.price)} <span className="muted small">{r.pair.b.symbol}</span></td>
                    <td className={`r ${gapTone(r.gapBps)}`} title={r.market ? `${r.market.source}: ${r.market.reason}` : 'No market reference for this pair'}><span className="gapcell"><MiniGap gapBps={r.gapBps} feeBps={r.feeBps} />{fmtGap(r.gapBps)}</span></td>
                    <td className="r">{r.tvl.usd != null ? fmtUsd(r.tvl.usd) : `${fmtAmount(r.tvl.a)} ${r.pair.a.symbol}`}</td>
                    <td className="r">{(r.feeBps / 100).toFixed(2)}%</td>
                    <td><span className={`chip ${st.tone}`}>{st.label}</span></td>
                    <td><span className={`chip ${r.bot.healthy ? 'up' : bot.tone}`} title={`bot: ${bot.label}; watcher: ${healthLabel(r.bot.watcher, now).label}`}>{r.bot.healthy ? 'healthy' : bot.label}</span></td>
                    <td className="r"><a className="link" href={href}>Open</a></td>
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

// ------------------------------------------------------------------ one pool

function Stat({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return <div className="stat"><dt>{label}</dt><dd className={tone}>{children}</dd></div>;
}

function PoolView({ component, account, wallet, explorer }: { component: string; account: string | undefined; wallet: Wallet | undefined; explorer: string }) {
  const { value: p, error, reload } = usePoll(() => api.pool(component), 20_000, [component]);
  if (error && !p) return <section className="panel"><p className="error">{error}</p><p className="pad"><a className="link" href="#/pools">Back to the pools</a></p></section>;
  if (!p) return <section className="panel"><SkeletonRows rows={6} label="Loading the pool" /></section>;
  const now = Date.now();
  const A = p.pair.a.symbol, B = p.pair.b.symbol;
  const st = poolStatus(p);
  const op = p.operator, bs = p.botState;
  const tx = (id: string, text = 'View') => <a className="link" href={`${explorer}/transaction/${id}`} target="_blank" rel="noreferrer">{text} <Icon name="external" size={11} /></a>;
  const entity = (id: string | null | undefined) => (id ? <a className="link mono" href={`${explorer}/${id.startsWith('resource_') ? 'resource' : id.startsWith('account_') ? 'account' : 'component'}/${id}`} target="_blank" rel="noreferrer" title={id}>{shortId(id)}</a> : '—');
  const h5 = p.markout?.all.horizons['5'], h30 = p.markout?.all.horizons['30'];

  return (
    <>
      <section className="panel pool-head">
        <div className="pool-title">
          <a className="link small" href="#/pools">← Pools</a>
          <h1>{A}<span className="muted">/{B}</span></h1>
          <span className={`chip ${st.tone}`}>{st.label}</span>
          <span className={`chip ${p.bot.healthy ? 'up' : 'down'}`}>{p.bot.healthy ? 'bot healthy' : 'bot not healthy'}</span>
          <span className="muted small grow">{entity(p.address)} · read {ago(p.readAt, now)}{error ? ` · refresh failed: ${error}` : ''}</span>
          <button className="btn-ghost neutral" onClick={reload}>Refresh</button>
        </div>
        {p.errors.length > 0 && <p className="error">{p.errors.join('; ')}</p>}
      </section>

      <PoolGlance p={p} />

      <div className="pool-grid">
        <section className="panel card">
          <h2 className="panel-title">Price</h2>
          <dl className="kv">
            <Stat label={`Pool (${B} per ${A})`}>{fmtPrice(p.price)}</Stat>
            <Stat label="Market reference">{p.market?.price ? fmtPrice(p.market.price) : '—'}</Stat>
            <Stat label="Pool vs market" tone={gapTone(p.gapBps)}>{fmtGap(p.gapBps)}</Stat>
            <Stat label="Reference">{p.market ? <span title={p.market.reason}>{p.market.source}{p.market.status === 'disagree' ? ' (venues disagree)' : ''}, {ago(p.market.at, now)}</span> : 'none for this pair'}</Stat>
          </dl>
          {p.market?.venues && p.market.venues.length > 0 && (
            <ul className="venues-list">
              {p.market.venues.map((v) => <li key={v.venue} className={v.used ? '' : 'muted'}><b>{v.venue}</b> {v.mid ? fmtPrice(v.mid) : ''} {v.used ? '· used' : `· left out: ${v.dropped ?? ''}`}</li>)}
            </ul>
          )}
        </section>

        <section className="panel card">
          <h2 className="panel-title">Liquidity</h2>
          <dl className="kv">
            <Stat label="Reserves (traded)">{fmtAmount(p.reserves.a)} {A} · {fmtAmount(p.reserves.b)} {B}</Stat>
            <Stat label="TVL">{p.tvl.usd != null ? <>{fmtUsd(p.tvl.usd)} <span className="muted small">({fmtAmount(p.tvl.a)} {A})</span></> : `${fmtAmount(p.tvl.a)} ${A}`}</Stat>
            {p.inventory && <Stat label="Inventory (not traded)">{fmtAmount(p.inventory.a)} {A} · {fmtAmount(p.inventory.b)} {B}</Stat>}
            <Stat label="Fee">{p.feeBps} bps ({(p.feeBps / 100).toFixed(2)}%)</Stat>
            <Stat label="Owner pause" tone={p.ownerPaused ? 'down' : ''}>{p.ownerPaused ? 'ON' : 'off'}</Stat>
            <Stat label="Operator pause" tone={p.operatorPaused ? 'warn' : ''}>{p.operatorPaused ? 'ON' : 'off'}</Stat>
          </dl>
        </section>

        {op && (
          <section className="panel card">
            <h2 className="panel-title">Operator (the bot's badge)</h2>
            <dl className="kv">
              <Stat label="Operator badge" tone={op.badge ? '' : 'warn'}>{op.badge ? entity(op.badge) : 'none (revoked or never appointed)'}</Stat>
              <Stat label="Anchor">1 {A} : {fmtPrice(Number(op.anchor[1]) / Number(op.anchor[0]))} {B}</Stat>
              <Stat label="Allowance now">{op.allowance ? `${(Number(op.allowance.now) * 10_000).toFixed(1)} of ${(Number(op.allowance.budget) * 10_000).toFixed(0)} bps (window ${op.allowance.windowEpochs} epochs)` : '—'}</Stat>
              <Stat label="Operator account XRD" tone={op.accountXrd != null && Number(op.accountXrd) < 5 ? 'warn' : ''}>{op.account ? <>{fmtAmount(op.accountXrd)} XRD · {entity(op.account)}</> : '—'}</Stat>
            </dl>
            <LimitsTable limits={op.limits} a={A} b={B} />
          </section>
        )}

        <section className="panel card">
          <h2 className="panel-title">Bot and watcher</h2>
          <dl className="kv">
            <Stat label="Bot" tone={healthLabel(p.bot.bot, now).tone === 'up' ? 'up' : healthLabel(p.bot.bot, now).tone}>{healthLabel(p.bot.bot, now).label}{p.bot.bot.tick != null ? ` · tick ${p.bot.bot.tick}` : ''}</Stat>
            <Stat label="Watcher" tone={healthLabel(p.bot.watcher, now).tone === 'up' ? 'up' : healthLabel(p.bot.watcher, now).tone}>{healthLabel(p.bot.watcher, now).label}</Stat>
            {bs && <>
              <Stat label="Last bot transaction">{bs.lastTx ? <>{bs.lastTx.type} · {bs.lastTx.status} · {ago(Date.parse(bs.lastTx.at), now)} · {tx(bs.lastTx.txid)}</> : 'none yet'}</Stat>
              {bs.pending && <Stat label="Waiting for" tone="warn">{bs.pending.type} {tx(bs.pending.txid)}</Stat>}
              <Stat label="Bot's reference">{bs.reference ? `${fmtPrice(bs.reference.price)} · ${ago(bs.reference.at, now)}` : '—'}</Stat>
              <Stat label="Venues it trusts">{bs.confirmedVenues.join(', ') || '—'}{bs.singleVenueSince ? ' (single venue: wider fee, smaller moves)' : ''}</Stat>
              <Stat label="Behind the market" tone={bs.behindTicks > 10 ? 'warn' : ''}>{bs.behindTicks ? `${bs.behindTicks} ticks in a row` : 'no'}</Stat>
              <Stat label="Failures / halt" tone={bs.consecutiveFailures || bs.haltedUntil ? 'down' : ''}>{bs.consecutiveFailures} in a row{bs.haltedUntil && bs.haltedUntil > now ? ` · halted until ${new Date(bs.haltedUntil).toLocaleTimeString()}` : ''}</Stat>
              {bs.pausedByBot && <Stat label="Operator pause set by the bot" tone="warn">{bs.pauseReason ?? 'yes'}</Stat>}
            </>}
          </dl>
        </section>

        <section className="panel card">
          <h2 className="panel-title">Fees earned</h2>
          <dl className="kv">
            <Stat label="Swaps">{p.fees.swaps}{p.fees.complete ? '' : ' (still counting)'}</Stat>
            <Stat label="Fees kept">{fmtAmount(p.fees.feeA)} {A} + {fmtAmount(p.fees.feeB)} {B}</Stat>
            <Stat label="Worth">{p.fees.valueA != null ? `${fmtAmount(p.fees.valueA)} ${A}` : '—'}{p.fees.valueUsd != null ? ` · ${p.fees.valueUsd < 1 ? '$' + p.fees.valueUsd.toFixed(3) : fmtUsd(p.fees.valueUsd)}` : ''}</Stat>
            <Stat label="Volume in">{fmtAmount(p.fees.volumeA)} {A} · {fmtAmount(p.fees.volumeB)} {B}</Stat>
            <Stat label="Last swap">{ago(p.fees.lastAt, now)}</Stat>
          </dl>
          {p.markout ? (
            <dl className="kv sub">
              <Stat label="Markout record">{p.markout.trades} trades, {p.markout.pending} marks pending</Stat>
              {h5 && <Stat label="+5 min (fees + price)" tone={h5.profitA < 0 ? 'down' : 'up'}>{h5.marked ? `${h5.profitA.toFixed(4)} ${A} (markout ${h5.markoutA.toFixed(4)})` : '—'}</Stat>}
              {h30 && <Stat label="+30 min (fees + price)" tone={h30.profitA < 0 ? 'down' : 'up'}>{h30.marked ? `${h30.profitA.toFixed(4)} ${A}, break-even fee ${h30.breakEvenFeeBps.toFixed(0)} bps` : '—'}</Stat>}
            </dl>
          ) : <p className="muted small pad-t">No markout record for this pool (the watcher writes it from the first swap).</p>}
        </section>
      </div>

      <section className="panel activity">
        <header className="panel-head"><h2 className="panel-title">Recent activity</h2><span className="head-note">the pool's own events, newest first</span></header>
        {p.activity.length === 0 ? <Empty>No events yet.</Empty> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>What</th><th className="r" /></tr></thead>
              <tbody>
                {p.activity.map((a) => (
                  <tr key={a.txid}>
                    <td className="muted">{new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td><span className={`chip ${a.kind === 'owner' ? 'accent' : a.kind === 'operator' ? 'warn' : ''}`}>{a.kind}</span></td>
                    <td className="wrap">{a.methods.length ? <b>{a.methods.join(', ')}</b> : null} {a.lines.join(' · ') || (a.kind === 'owner' && !a.methods.length ? 'pool created and funded' : '')}</td>
                    <td className="r">{tx(a.txid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OwnerPanel pool={p} account={account} wallet={wallet} explorer={explorer} onDone={reload} />
    </>
  );
}

function LimitsTable({ limits, a, b }: { limits: OperatorLimits; a: string; b: string }) {
  return (
    <table className="limits">
      <tbody>
        <tr><td className="muted">Budget</td><td className="r">{limits.moveBudgetBps} bps per {limits.windowEpochs} epochs</td></tr>
        <tr><td className="muted">Caps</td><td className="r">{fmtAmount(limits.maxReserveA)} {a} · {fmtAmount(limits.maxReserveB)} {b}</td></tr>
        <tr><td className="muted">Floors</td><td className="r">{fmtAmount(limits.minReserveA)} {a} · {fmtAmount(limits.minReserveB)} {b}</td></tr>
        <tr><td className="muted">Fee range</td><td className="r">{limits.minFeeBps}-{limits.maxFeeBps} bps</td></tr>
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ the owner's actions

const ACTIONS: [OwnerAction, string][] = [
  ['deposit', 'Deposit'], ['withdraw', 'Withdraw'], ['pause', 'Pause'], ['unpause', 'Unpause'], ['fee', 'Fee'], ['anchor', 'Anchor'], ['limits-fee', 'Limits + fee'], ['revoke', 'Revoke'],
];
const LIMIT_KEYS: (keyof OperatorLimits)[] = ['moveBudgetBps', 'windowEpochs', 'maxReserveA', 'maxReserveB', 'minReserveA', 'minReserveB', 'minFeeBps', 'maxFeeBps'];

function OwnerPanel({ pool, account, wallet, explorer, onDone }: { pool: PoolDetail; account: string | undefined; wallet: Wallet | undefined; explorer: string; onDone: () => void }) {
  // Without a connected wallet, any account can be checked: actions are previewed, never sent.
  const [typed, setTyped] = useState('');
  const viewAccount = account ?? (/^account_[a-z0-9_]{40,90}$/.test(typed.trim()) ? typed.trim() : undefined);
  const [owner, setOwner] = useState<{ for: string; owner: boolean } | { for: string; error: string }>();
  const [action, setAction] = useState<OwnerAction>('pause');
  const [form, setForm] = useState<Record<string, string>>({});
  const [force, setForce] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [prepared, setPrepared] = useState<{ value: PreparedAction; for: string; at: number }>();
  const [sent, setSent] = useState<{ txid: string; status?: string; mismatches?: string[] | null; error?: string | null }>();
  const A = pool.pair.a.symbol, B = pool.pair.b.symbol;

  useEffect(() => {
    if (!viewAccount || !pool.ownerBadge) { setOwner(undefined); return; }
    let live = true;
    api.poolOwner(pool.address, viewAccount).then((r) => { if (live) setOwner({ for: viewAccount, owner: r.owner }); }, (e: Error) => { if (live) setOwner({ for: viewAccount, error: e.message }); });
    return () => { live = false; };
  }, [viewAccount, pool.address, pool.ownerBadge]);

  const pick = (a: OwnerAction) => { setAction(a); setPrepared(undefined); setErr(undefined); setForce(false); setForm({}); setConfirmRevoke(''); };
  const field = (k: string) => ({ value: form[k] ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setForm((f) => ({ ...f, [k]: e.target.value })); setPrepared(undefined); } });

  const params = useCallback((): Record<string, unknown> => {
    switch (action) {
      case 'deposit': return { amountA: form.amountA ?? '', amountB: form.amountB ?? '', force };
      case 'withdraw': return { amountA: form.amountA ?? '', ...(form.amountB ? { amountB: form.amountB } : {}) };
      case 'fee': return { feeBps: form.feeBps ?? '' };
      case 'anchor': return form.price ? { price: form.price } : {};
      case 'limits-fee': return { feeBps: form.feeBps ?? '', limits: Object.fromEntries(LIMIT_KEYS.filter((k) => form[k]).map((k) => [k, ['moveBudgetBps', 'windowEpochs', 'minFeeBps', 'maxFeeBps'].includes(k) ? Number(form[k]) : form[k]])) };
      case 'revoke': return { confirm: confirmRevoke };
      default: return {};
    }
  }, [action, form, force, confirmRevoke]);

  async function preview() {
    if (!viewAccount) return;
    setBusy(true); setErr(undefined); setPrepared(undefined); setSent(undefined);
    try {
      const value = await api.preparePoolAction(pool.address, { account: viewAccount, action, params: params() });
      setPrepared({ value, for: viewAccount, at: Date.now() });
    } catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function sign() {
    if (!wallet || !prepared) return;
    setBusy(true); setErr(undefined);
    try {
      const txid = await wallet.sendTransaction(prepared.value.manifest, `DIFD pools: ${prepared.value.title}`.slice(0, 250));
      setSent({ txid });
      // The wallet returns once the transaction is submitted: ask the ledger until it is final, then check the pool.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const v = await api.verifyPoolAction(pool.address, txid, prepared.value.want).catch(() => undefined);
        if (v && v.status !== 'Pending') { setSent({ txid, status: v.status, mismatches: v.mismatches, error: v.error }); break; }
      }
      setPrepared(undefined);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!pool.ownerBadge) return null;
  const isOwner = owner && owner.for === viewAccount && 'owner' in owner && owner.owner;
  const signable = canSign({ walletAccount: account, prepared: prepared?.value, preparedFor: prepared?.for, preparedAt: prepared?.at ?? 0, now: Date.now() });
  const limits = pool.operator?.limits;

  return (
    <section className="panel owner" aria-label="Owner actions">
      <header className="panel-head"><h2 className="panel-title">Owner actions</h2>
        <span className="head-note">owner badge {shortId(pool.ownerBadge)} · checked on the ledger · built and previewed here, signed in your wallet</span></header>
      <div className="owner-body">
        {!account && (
          <label className="field wide">
            <span>Account</span>
            <input placeholder="Connect the owner account, or type one to preview (nothing is sent)" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
          </label>
        )}
        {viewAccount && owner && owner.for === viewAccount && 'error' in owner && <p className="error">{owner.error}</p>}
        {viewAccount && owner && owner.for === viewAccount && 'owner' in owner && !owner.owner && (
          <p className="muted">{shortAddr(viewAccount)} does not hold this pool's owner badge, so there is nothing it can do here.</p>
        )}
        {!viewAccount && <p className="muted">The owner's actions appear for the account that holds the pool's owner badge.</p>}
        {isOwner && (
          <>
            {!account && <p className="note-warn"><Icon name="info" size={13} /> Preview only: connect this account in the Radix Wallet to sign.</p>}
            <div className="seg action-seg" role="group" aria-label="Action">
              {ACTIONS.map(([k, label]) => <button key={k} className={`${k === action ? 'on' : ''} ${k === 'revoke' ? 'danger' : ''}`} aria-pressed={k === action} onClick={() => pick(k)}>{label}</button>)}
            </div>
            <div className={`action-form ${action === 'revoke' ? 'danger-zone' : ''}`}>
              {action === 'deposit' && <>
                <p className="muted small">Into the reserves (traded at once). Guarded by the reserves read now; refused when the curve is more than 1% from the market unless you confirm.</p>
                <div className="row2">
                  <label className="field"><span>{A}</span><input inputMode="decimal" placeholder="0" {...field('amountA')} /></label>
                  <label className="field"><span>{B}</span><input inputMode="decimal" placeholder="0" {...field('amountB')} /></label>
                </div>
                <label className="check"><input type="checkbox" checked={force} onChange={(e) => { setForce(e.target.checked); setPrepared(undefined); }} /> Go ahead even if the price is not within 1% of the market (I checked it myself)</label>
              </>}
              {action === 'withdraw' && <>
                <p className="muted small">From the reserves to the signing account. Leave {B} empty for the proportional amount (the price stays). Reserves now {fmtAmount(pool.reserves.a)} {A} · {fmtAmount(pool.reserves.b)} {B}.</p>
                <div className="row2">
                  <label className="field"><span>{A}</span><input inputMode="decimal" placeholder="0" {...field('amountA')} /></label>
                  <label className="field"><span>{B}</span><input inputMode="decimal" placeholder="proportional" {...field('amountB')} /></label>
                </div>
              </>}
              {action === 'pause' && <p className="muted small">The owner's pause: swaps, the operator's rebalance and its fee changes stop until the owner lifts it.</p>}
              {action === 'unpause' && <p className="muted small">Lift the owner's pause. Swaps reopen at the curve as it stands ({fmtGap(pool.gapBps)} from the market now).</p>}
              {action === 'fee' && <>
                <p className="muted small">Now {pool.feeBps} bps. The operator keeps it inside {limits ? `${limits.minFeeBps}-${limits.maxFeeBps}` : 'its range'} bps on its next change; to move the range, use Limits + fee.</p>
                <label className="field narrow"><span>Fee</span><input inputMode="numeric" placeholder={String(pool.feeBps)} {...field('feeBps')} /><em>bps</em></label>
              </>}
              {action === 'anchor' && <>
                <p className="muted small">Restate the anchor at the market ({pool.market?.price ? fmtPrice(pool.market.price) : 'none available'} {B} per {A}), or at a price you give. Zeroes the operator's allowance.</p>
                <label className="field narrow"><span>Price</span><input inputMode="decimal" placeholder="market" {...field('price')} /><em>{B}/{A}</em></label>
              </>}
              {action === 'limits-fee' && limits && <>
                <p className="muted small">The operator's limits and the fee in one transaction. Empty fields keep their current value.</p>
                <div className="limits-grid">
                  {LIMIT_KEYS.map((k) => <label key={k} className="field"><span className="lbl">{k}</span><input placeholder={String(limits[k])} {...field(k)} /></label>)}
                  <label className="field"><span className="lbl">fee (bps)</span><input placeholder={String(pool.feeBps)} {...field('feeBps')} /></label>
                </div>
              </>}
              {action === 'revoke' && <>
                <p className="danger-text"><Icon name="warn" size={14} /> <b>Emergency stop.</b> The operator badge loses every right at once and for good, and the owner's pause goes on: swaps stop. Restarting needs a new operator badge and a new appointment (the runbook, section 6).</p>
                <label className="field narrow"><span>Type</span><input placeholder="REVOKE" value={confirmRevoke} onChange={(e) => { setConfirmRevoke(e.target.value); setPrepared(undefined); }} /></label>
              </>}
              <div className="actions-row">
                <button className={action === 'revoke' ? 'btn-danger' : 'btn-primary'} disabled={busy || (action === 'revoke' && confirmRevoke !== 'REVOKE')} onClick={() => void preview()}>{busy && !prepared ? 'Previewing…' : 'Preview'}</button>
                {prepared && (
                  <button className={action === 'revoke' ? 'btn-danger' : 'btn-primary'} disabled={busy || !signable.ok} title={signable.why} onClick={() => void sign()}>
                    {busy ? 'Waiting for the wallet…' : 'Sign in wallet'}
                  </button>
                )}
                {prepared && !signable.ok && <span className="muted small">{signable.why}</span>}
              </div>
              {err && <p className="error">{err}</p>}
              {prepared && <PreviewCard p={prepared.value} account={prepared.for} />}
              {sent && (
                <p className={`result ${sent.status === 'CommittedSuccess' && !sent.mismatches?.length ? 'up' : sent.status ? 'down' : ''}`}>
                  Sent: <a className="link" href={`${explorer}/transaction/${sent.txid}`} target="_blank" rel="noreferrer">{shortId(sent.txid)} <Icon name="external" size={11} /></a>{' '}
                  {!sent.status ? 'waiting for the ledger…' : sent.status === 'CommittedSuccess'
                    ? (sent.mismatches?.length ? `committed, but the pool does not show what it set: ${sent.mismatches.join('; ')}` : 'committed; the pool shows what it set.')
                    : `${sent.status}${sent.error ? `: ${sent.error}` : ''}`}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PreviewCard({ p, account }: { p: PreparedAction; account: string }) {
  return (
    <div className={`preview-card ${p.preview.ok ? '' : 'failed'}`}>
      <h3>{p.title}</h3>
      <p className={p.preview.ok ? 'up' : 'down'}>
        Preview on {p.network}: <b>{p.preview.ok ? 'succeeds' : 'FAILS'}</b>{p.preview.ok ? `, network fee about ${Number(p.preview.feeXrd).toFixed(3)} XRD (the wallet adds its own fee lock)` : `: ${p.preview.error}`}
      </p>
      <ul className="notes">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      <dl className="kv">
        {p.preview.proofs.map((x, i) => <Stat key={i} label="Proves">{x.label} from {x.account === account ? 'your account' : shortAddr(x.account)}</Stat>)}
        {p.preview.changes.length === 0 && <Stat label="Balances">no token moves</Stat>}
        {p.preview.changes.map((c) => <Stat key={c.entity} label={c.label === c.entity ? shortAddr(c.entity) : c.label}>{c.items.map((i) => `${Number(i.amount) > 0 ? '+' : ''}${i.amount} ${i.symbol}`).join(', ')}</Stat>)}
      </dl>
      <details><summary>Manifest (what the wallet will be asked to sign)</summary><pre>{p.manifest}</pre></details>
      <p className="muted small">Same step as <code>scripts/mainnet-owner-pool.ts {p.scriptStep}</code>. Guards read at state version {p.readAt.stateVersion ?? '?'}.</p>
    </div>
  );
}
