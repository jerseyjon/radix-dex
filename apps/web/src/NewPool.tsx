import { useEffect, useRef, useState } from 'react';
import { type NewPoolAccess, type NewPoolPrepared, type NewPoolTokenHit, type PreparedAction, ApiError, api } from './api';
import { fmtPrice, shortAddr } from './format';
import { canSign, seedPriceLabel, shortId } from './pools';
import { Icon } from './ui';
import type { Wallet } from './wallet';

/**
 * A new pool (#/pools/new), for an account holding the pool owner badge on the ledger. The server
 * builds the one transaction that creates AND funds the pool (instantiate_with_liquidity) with the
 * script's guards, previews it, and the owner signs it in his wallet. Then the page offers the pause.
 */
export function NewPool({ account, wallet, explorer }: { account: string | undefined; wallet: Wallet | undefined; explorer: string }) {
  const [typed, setTyped] = useState('');
  const viewAccount = account ?? (/^account_[a-z0-9_]{40,90}$/.test(typed.trim()) ? typed.trim() : undefined);
  const [access, setAccess] = useState<NewPoolAccess | { error: string }>();
  useEffect(() => {
    let live = true;
    setAccess(undefined);
    api.newPoolAccess(viewAccount).then((a) => { if (live) setAccess(a); }, (e: Error) => { if (live) setAccess({ error: e.message }); });
    return () => { live = false; };
  }, [viewAccount]);

  return (
    <section className="panel new-pool" aria-label="New pool">
      <header className="panel-head">
        <h1 className="panel-title">New pool</h1>
        <span className="head-note">created and funded in one transaction · built and previewed here, signed in your wallet</span>
      </header>
      <div className="owner-body">
        <p className="pad-b"><a className="link small" href="#/pools">← Pools</a></p>
        {!account && (
          <label className="field wide">
            <span>Account</span>
            <input placeholder="Connect the owner account, or type one to preview (nothing is sent)" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
          </label>
        )}
        {access && 'error' in access && <p className="error">{access.error}</p>}
        {access && !('error' in access) && !access.enabled && <p className="muted">Creating pools is off on this server.</p>}
        {access && !('error' in access) && access.enabled && viewAccount && !access.owner && (
          <p className="muted">{shortAddr(viewAccount)} does not hold the pool owner badge, so it cannot create pools here.</p>
        )}
        {!viewAccount && <p className="muted">The form appears for the account that holds the pool owner badge.</p>}
        {access && !('error' in access) && access.owner && viewAccount && <NewPoolForm access={access} account={viewAccount} walletAccount={account} wallet={wallet} explorer={explorer} />}
      </div>
    </section>
  );
}

function TokenPicker({ label, value, onChange, exclude }: { label: string; value: NewPoolTokenHit | undefined; onChange: (t: NewPoolTokenHit | undefined) => void; exclude?: string }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<NewPoolTokenHit[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string>();
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.newPoolTokens(text.trim()).then((h) => { if (n === seq.current) { setHits(h.filter((x) => x.address !== exclude)); setErr(undefined); } }, (e: Error) => { if (n === seq.current) { setHits([]); setErr(e.message); } });
    }, 200);
    return () => clearTimeout(t);
  }, [text, open, exclude]);

  async function pick(h: NewPoolTokenHit) {
    setOpen(false); setText('');
    // Read the token itself, with its role checks, by address.
    try { const [full] = await api.newPoolTokens(h.address); onChange(full ?? h); } catch (e) { setErr((e as Error).message); onChange(undefined); }
  }

  return (
    <div className="token-picker">
      <span className="lbl">{label}</span>
      {value && !open ? (
        <button type="button" className="token-chosen" onClick={() => setOpen(true)} aria-label={`${label}: ${value.symbol}, change`}>
          <b>{value.symbol}</b> <span className="muted small mono" title={value.address}>{shortId(value.address)}</span> <Icon name="chevron" size={12} />
        </button>
      ) : (
        <input autoFocus={open} placeholder="Symbol, or paste a resource address" value={text} onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} spellCheck={false} aria-label={`${label}: search`} />
      )}
      {open && (
        <ul className="token-hits" role="listbox" aria-label={`${label}: matches`}>
          {hits.map((h) => (
            <li key={h.address}><button type="button" role="option" aria-selected={value?.address === h.address} onClick={() => void pick(h)}>
              <b>{h.symbol}</b> <span className="muted small">{h.name}</span> <span className="muted small mono">{shortId(h.address)}</span>
            </button></li>
          ))}
          {hits.length === 0 && <li className="muted small pad">{err ?? 'No match: paste the resource address'}</li>}
        </ul>
      )}
      {value?.errors?.length ? <p className="down small">Refused: {value.errors.join('; ')}</p> : null}
      {value?.warnings?.length ? <p className="warn small">Issuer: {value.warnings.join('; ')}</p> : null}
    </div>
  );
}

function NewPoolForm({ access, account, walletAccount, wallet, explorer }: { access: NewPoolAccess; account: string; walletAccount: string | undefined; wallet: Wallet | undefined; explorer: string }) {
  const [a, setA] = useState<NewPoolTokenHit>();
  const [b, setB] = useState<NewPoolTokenHit>();
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [fee, setFee] = useState('50');
  const [confirmPrice, setConfirmPrice] = useState(false);
  const [acceptIssuer, setAcceptIssuer] = useState(false);
  const [seenSeed, setSeenSeed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [prepared, setPrepared] = useState<{ value: NewPoolPrepared; at: number }>();
  const [sent, setSent] = useState<{ txid: string; status?: string; error?: string | null; pool?: string | null; listed?: boolean; mismatches?: string[] | null }>();

  // XRD as token A by default: the bot's convention (prices are B per A).
  useEffect(() => { void api.newPoolTokens(access.xrd).then(([x]) => setA((cur) => cur ?? x), () => undefined); }, [access.xrd]);
  const reset = () => { setPrepared(undefined); setErr(undefined); setSeenSeed(undefined); setConfirmPrice(false); };
  const price = seedPriceLabel(amountA, amountB);
  const managed = a && b && access.botPairs.includes(`${a.symbol}/${b.symbol}`);

  async function preview() {
    if (!a || !b) return;
    setBusy(true); setErr(undefined); setPrepared(undefined); setSent(undefined);
    try {
      const value = await api.prepareNewPool({ account, params: {
        resourceA: a.address, resourceB: b.address, amountA: amountA.trim(), amountB: amountB.trim(), feeBps: fee.trim(),
        // The owner confirms the exact price the server stated (its 10 significant digits).
        ...(confirmPrice && seenSeed ? { confirmPrice: seenSeed } : {}),
        ...(acceptIssuer ? { acceptIssuerRisk: true } : {}),
      } });
      setPrepared({ value, at: Date.now() });
      setSeenSeed(value.seedPrice);
    } catch (e) { setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function sign() {
    if (!wallet || !prepared?.value.manifest) return;
    const p = prepared.value;
    setBusy(true); setErr(undefined);
    try {
      const txid = await wallet.sendTransaction(p.manifest!, `DIFD pools: ${p.title}`.slice(0, 250));
      setSent({ txid });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const v = await api.verifyNewPool(txid, p.want).catch(() => undefined);
        if (v && v.status !== 'Pending') { setSent({ txid, ...v }); break; }
      }
      setPrepared(undefined);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const p = prepared?.value;
  const signable = canSign({ walletAccount, prepared: p?.preview ? { preview: p.preview } : undefined, preparedFor: account, preparedAt: prepared?.at ?? 0, now: Date.now() });
  const ready = a && b && amountA && amountB && fee;

  return (
    <div className="action-form">
      <p className="note-info"><Icon name="info" size={13} /> {access.botPairs.length ? `The bot manages only ${access.botPairs.join(', ')} today.` : 'The bot manages no pair on this network.'} A new pair runs as a plain constant-product pool, kept at the market by arbitrage only; its operator steps (operator badge, limits, appoint) are in the script for now.</p>
      <div className="row2">
        <TokenPicker label="Token A" value={a} onChange={(t) => { setA(t); reset(); }} exclude={b?.address} />
        <TokenPicker label="Token B" value={b} onChange={(t) => { setB(t); reset(); }} exclude={a?.address} />
      </div>
      <div className="row3">
        <label className="field"><span>{a?.symbol ?? 'A'}</span><input inputMode="decimal" placeholder="0" value={amountA} onChange={(e) => { setAmountA(e.target.value); reset(); }} /></label>
        <label className="field"><span>{b?.symbol ?? 'B'}</span><input inputMode="decimal" placeholder="0" value={amountB} onChange={(e) => { setAmountB(e.target.value); reset(); }} /></label>
        <label className="field narrow"><span>Fee</span><input inputMode="numeric" value={fee} onChange={(e) => { setFee(e.target.value); reset(); }} /><em>bps</em></label>
      </div>
      <p className="muted small">Seed price: {price ? <b>1 {a?.symbol ?? 'A'} = {price} {b?.symbol ?? 'B'}</b> : '—'}{managed ? ' · this pair can be handed to the bot later (script steps)' : ''}. It must be within 1% of the market where on-ledger venues quote the pair.</p>
      {p && p.needs.includes('price') && price && (
        <label className="check"><input type="checkbox" checked={confirmPrice} onChange={(e) => setConfirmPrice(e.target.checked)} /> No venue quotes this pair. I confirm the price myself: <b>1 {a?.symbol} = {p.seedPrice} {b?.symbol}</b></label>
      )}
      {p && p.needs.includes('issuer-risk') && (
        <label className="check"><input type="checkbox" checked={acceptIssuer} onChange={(e) => setAcceptIssuer(e.target.checked)} /> I accept the token issuer's power over this pool (see the warnings)</label>
      )}
      <div className="actions-row">
        <button className="btn-primary" disabled={busy || !ready} onClick={() => void preview()}>{busy && !prepared ? 'Checking…' : 'Check and preview'}</button>
        {p?.manifest && (
          <button className="btn-primary" disabled={busy || !signable.ok} title={signable.why} onClick={() => void sign()}>{busy ? 'Waiting for the wallet…' : 'Sign in wallet'}</button>
        )}
        {p?.manifest && !signable.ok && <span className="muted small">{signable.why}</span>}
      </div>
      {err && <p className="error">{err}</p>}
      {p && (
        <div className={`preview-card ${p.preview && !p.preview.ok ? 'failed' : ''}`}>
          <h3>{p.title}</h3>
          {p.market && <p className="small">Market {fmtPrice(p.market.price)} {p.tokens.b.symbol} per {p.tokens.a.symbol} · gap {(p.market.gap * 100).toFixed(3)}% · <span className="muted">{p.market.source}</span></p>}
          {p.blocked.length > 0 && <ul className="notes warn">{p.blocked.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {p.warnings.length > 0 && <ul className="notes warn">{p.warnings.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {p.preview && (
            <p className={p.preview.ok ? 'up' : 'down'}>
              Preview on {p.network}: <b>{p.preview.ok ? 'succeeds' : 'FAILS'}</b>{p.preview.ok ? `, network fee about ${Number(p.preview.feeXrd).toFixed(3)} XRD (the wallet adds its own fee lock)` : `: ${p.preview.error}`}
            </p>
          )}
          <ul className="notes">{p.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          {p.preview && (
            <dl className="kv">
              {p.preview.proofs.map((x, i) => <div className="stat" key={i}><dt>Proves</dt><dd>{x.label} from {x.account === account ? 'your account' : shortAddr(x.account)}</dd></div>)}
              {p.preview.changes.map((c) => <div className="stat" key={c.entity}><dt>{c.label === c.entity ? shortAddr(c.entity) : c.label}</dt><dd>{c.items.map((i) => `${Number(i.amount) > 0 ? '+' : ''}${i.amount} ${i.symbol}`).join(', ')}</dd></div>)}
            </dl>
          )}
          {p.manifest && <details><summary>Manifest (what the wallet will be asked to sign)</summary><pre>{p.manifest}</pre></details>}
          <p className="muted small">Same step as <code>scripts/mainnet-owner-pool.ts instantiate</code>, package {shortId(p.package)}, owner badge {shortId(p.ownerBadge)}.</p>
        </div>
      )}
      {sent && <Created sent={sent} account={account} walletAccount={walletAccount} wallet={wallet} explorer={explorer} />}
    </div>
  );
}

/** After the wallet sent the new pool: what the ledger shows, the link to it, and the pause, offered at once. */
function Created({ sent, account, walletAccount, wallet, explorer }: {
  sent: { txid: string; status?: string; error?: string | null; pool?: string | null; listed?: boolean; mismatches?: string[] | null };
  account: string; walletAccount: string | undefined; wallet: Wallet | undefined; explorer: string;
}) {
  const [pause, setPause] = useState<{ value: PreparedAction; at: number }>();
  const [state, setState] = useState<string>();
  const [busy, setBusy] = useState(false);
  const txLink = <a className="link" href={`${explorer}/transaction/${sent.txid}`} target="_blank" rel="noreferrer">{shortId(sent.txid)} <Icon name="external" size={11} /></a>;
  if (!sent.status) return <p className="result">Sent: {txLink} waiting for the ledger…</p>;
  if (sent.status !== 'CommittedSuccess' || !sent.pool) return <p className="result down">Sent: {txLink} {sent.status}{sent.error ? `: ${sent.error}` : ''}</p>;
  const pool = sent.pool;

  async function preparePause() {
    setBusy(true); setState(undefined);
    try { setPause({ value: await api.preparePoolAction(pool, { account, action: 'pause', params: {} }), at: Date.now() }); } catch (e) { setState((e as Error).message); } finally { setBusy(false); }
  }
  async function signPause() {
    if (!wallet || !pause) return;
    setBusy(true);
    try {
      const txid = await wallet.sendTransaction(pause.value.manifest, 'DIFD pools: pause the new pool');
      setState(`Pause sent: ${txid}. Waiting for the ledger…`);
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const v = await api.verifyPoolAction(pool, txid, pause.value.want).catch(() => undefined);
        if (v && v.status !== 'Pending') { setState(v.status === 'CommittedSuccess' && !v.mismatches?.length ? 'Paused: swaps are closed until you lift the pause.' : `${v.status}${v.error ? `: ${v.error}` : ''}${v.mismatches?.length ? ` (${v.mismatches.join('; ')})` : ''}`); break; }
      }
      setPause(undefined);
    } catch (e) { setState((e as Error).message); } finally { setBusy(false); }
  }
  const signable = canSign({ walletAccount, prepared: pause?.value, preparedFor: account, preparedAt: pause?.at ?? 0, now: Date.now() });

  return (
    <div className="created">
      <p className={`result ${sent.mismatches?.length ? 'down' : 'up'}`}>
        Created: {txLink} · pool <a className="link mono" href={`#/pools/${encodeURIComponent(pool)}`}>{shortId(pool)}</a>
        {sent.mismatches?.length ? ` · the pool does not show what was set: ${sent.mismatches.join('; ')}` : ' · the pool shows what was set'}
        {sent.listed ? ' · listed on this page' : ' · not listed yet (discovery reads the ledger again within minutes)'}
      </p>
      <p className="note-warn"><Icon name="warn" size={13} /> Swaps are open now, at the seed price. <b>Pause it</b> unless you are watching it: an unattended curve at a fixed price is free money for arbitrage when the market moves.</p>
      <div className="actions-row">
        <button className="btn-primary" disabled={busy} onClick={() => void preparePause()}>Pause it now (recommended)</button>
        {pause && <button className="btn-primary" disabled={busy || !signable.ok} title={signable.why} onClick={() => void signPause()}>Sign the pause</button>}
        {pause && !signable.ok && <span className="muted small">{signable.why}</span>}
      </div>
      {pause && <p className={pause.value.preview.ok ? 'up small' : 'down small'}>Pause preview: {pause.value.preview.ok ? 'succeeds' : `FAILS: ${pause.value.preview.error}`}</p>}
      {state && <p className="small">{state}</p>}
      <p className="muted small">Next, if this pool is to be operated (script only for now): <code>operator-badge</code>, <code>limits</code>, <code>appoint</code> in <code>scripts/mainnet-owner-pool.ts --name &lt;pool&gt;</code> (docs/MAINNET-POOLS.md sections 4 and 13).</p>
    </div>
  );
}
