import type { PoolDetail } from './api';
import { fmtAmount, fmtPrice, venueName } from './format';
import {
  EPOCH_MINUTES, allowanceGauge, band, buyA, distance, fmtDuration, fmtPct, limitRow, miniGap, pctTicks, priceScale, sellA, splitParts, venueSellCost,
  type LimitRow, type SplitPart,
} from './poolgraphics';

/**
 * The pool at a glance: its split and limits, its price among the market, the owner's anchor and the
 * bot's bands, its depth, and the bot's allowance. Plain HTML and CSS marks (no chart library); every
 * figure is a role="img" with the key numbers in its label, and prints the same numbers as text.
 */
export function PoolGlance({ p }: { p: PoolDetail }) {
  return (
    <section className="panel glance" aria-label="The pool at a glance">
      <header className="panel-head"><h2 className="panel-title">At a glance</h2><span className="head-note">read {new Date(p.readAt).toLocaleTimeString()} · refreshes every 20 s</span></header>
      <div className="glance-grid">
        <SplitFigure p={p} />
        <PriceFigure p={p} />
        <DepthFigure p={p} />
        <AllowanceFigure p={p} />
      </div>
    </section>
  );
}

const n = (s: string | null | undefined) => (s == null ? 0 : Number(s));

// ------------------------------------------------------------------ 1. the split and the limits

function SplitFigure({ p }: { p: PoolDetail }) {
  const A = p.pair.a.symbol, B = p.pair.b.symbol;
  const price = p.market?.price ?? p.price;
  if (!price) return <figure className="glance-fig"><h3>Pool split</h3><p className="muted small">No price to value the two sides with.</p></figure>;
  const atMarket = p.market?.price != null;
  const parts = splitParts({ reserveA: n(p.reserves.a), reserveB: n(p.reserves.b), inventoryA: n(p.inventory?.a), inventoryB: n(p.inventory?.b) }, price);
  const name: Record<SplitPart['key'], string> = { reserveA: `${A} reserves`, inventoryA: `${A} inventory`, reserveB: `${B} reserves`, inventoryB: `${B} inventory` };
  const unit = (k: SplitPart['key']) => (k.endsWith('A') ? A : B);
  const shown = parts.filter((x) => x.share > 0);
  const hasInventory = parts.some((x) => x.key.startsWith('inventory') && x.amount > 0);
  const label = `Pool split by value in ${B} at the ${atMarket ? 'market' : 'pool'} price: ${shown.map((x) => `${name[x.key]} ${fmtAmount(x.amount)} ${unit(x.key)}, ${fmtPct(x.share, 0)}`).join('; ')}.`;

  const l = p.operator?.limits;
  const rows = l ? [
    { key: 'A', sym: A, row: limitRow(n(p.reserves.a), n(l.minReserveA), n(l.maxReserveA)), toB: price },
    { key: 'B', sym: B, row: limitRow(n(p.reserves.b), n(l.minReserveB), n(l.maxReserveB)), toB: 1 },
  ] : [];
  // One value scale (in B) for both rows, so the two sides compare.
  const top = Math.max(1e-18, ...rows.map((r) => Math.max(r.row.cap, r.row.reserve) * r.toB)) * 1.04;
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / top) * 100))}%`;

  return (
    <figure className="glance-fig">
      <h3>Pool split <span className="muted">value in {B} at the {atMarket ? 'market' : 'pool'} price</span></h3>
      <div className="seg-bar" role="img" aria-label={label}>
        {shown.map((x) => (
          <div key={x.key} className={`part ${x.key.endsWith('A') ? 'sa' : 'sb'} ${x.key.startsWith('inventory') ? 'inv' : ''}`} style={{ flex: `${x.share} 1 0` }}
            title={`${name[x.key]}: ${fmtAmount(x.amount)} ${unit(x.key)} ≈ ${fmtAmount(x.valueB)} ${B} (${fmtPct(x.share, 1)})`}>
            {x.share >= 0.14 && <span>{fmtPct(x.share, 0)}</span>}
          </div>
        ))}
      </div>
      <ul className="legend">
        {parts.filter((x) => !x.key.startsWith('inventory') || hasInventory).map((x) => (
          <li key={x.key}><i className={`sw ${x.key.endsWith('A') ? 'sa' : 'sb'} ${x.key.startsWith('inventory') ? 'inv' : ''}`} aria-hidden="true" />{name[x.key]} <b>{fmtAmount(x.amount)} {unit(x.key)}</b>{x.key.endsWith('A') ? <span className="muted"> ≈ {fmtAmount(x.valueB)} {B}</span> : null}</li>
        ))}
        {!hasInventory && <li className="muted">no inventory</li>}
      </ul>
      {l && (
        <div className="limit-rows" role="img" aria-label={rows.map((r) => `${r.sym} reserves ${fmtAmount(r.row.reserve)}, floor ${fmtAmount(r.row.floor)}, cap ${fmtAmount(r.row.cap)}: ${limitWords(r.row, r.sym)}`).join('. ')}>
          <h4>Reserves against the bot's floor and cap <span className="muted">same {B} scale</span></h4>
          {rows.map((r) => (
            <div key={r.key} className="limit-row">
              <div className="limit-label"><span><i className={`sw ${r.key === 'A' ? 'sa' : 'sb'}`} aria-hidden="true" />{r.sym}</span><span className={r.row.state === 'past' ? 'down' : r.row.state === 'near' ? 'warn' : 'muted'}>{limitWords(r.row, r.sym)}</span></div>
              <div className="track">
                <div className="out lo" style={{ width: at(r.row.floor * r.toB) }} />
                <div className="out hi" style={{ left: at(r.row.cap * r.toB) }} />
                <div className={`fill ${r.key === 'A' ? 'sa' : 'sb'}`} style={{ width: at(r.row.reserve * r.toB) }} title={`${fmtAmount(r.row.reserve)} ${r.sym}`} />
                <div className="lim" style={{ left: at(r.row.floor * r.toB) }} title={`floor ${fmtAmount(r.row.floor)} ${r.sym}`}><span>floor</span></div>
                <div className="lim" style={{ left: at(r.row.cap * r.toB) }} title={`cap ${fmtAmount(r.row.cap)} ${r.sym}`}><span>cap</span></div>
              </div>
              <div className="limit-nums muted small"><span>floor {fmtAmount(r.row.floor)}</span><b>{fmtAmount(r.row.reserve)} {r.sym}</b><span>cap {fmtAmount(r.row.cap)}</span></div>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

function limitWords(r: LimitRow, sym: string): string {
  if (r.reserve > r.cap) return `${fmtAmount(-r.toCap)} ${sym} over the cap`;
  if (r.reserve < r.floor) return `${fmtAmount(-r.aboveFloor)} ${sym} under the floor`;
  return r.toCap <= r.aboveFloor ? `${fmtAmount(r.toCap)} below the cap` : `${fmtAmount(r.aboveFloor)} above the floor`;
}

// ------------------------------------------------------------------ 2. the price among the market and the anchor

function PriceFigure({ p }: { p: PoolDetail }) {
  const A = p.pair.a.symbol, B = p.pair.b.symbol;
  const pool = p.price ?? undefined, market = p.market?.price ?? undefined;
  const anchor = p.ownerAnchor?.price ?? (p.operator ? Number(p.operator.anchor[1]) / Number(p.operator.anchor[0]) : undefined);
  const r = p.rules;
  const stop = anchor && r ? band(anchor, r.anchorStop) : undefined;
  const fee = market && r ? band(market, r.feeBandBps / 10_000) : undefined;
  const dead = market && r ? band(market, r.deadBandBps / 10_000) : undefined;
  const s = priceScale([pool, market, anchor, ...(stop ?? []), ...(fee ?? [])], 0.06);
  if (!s || !pool) return <figure className="glance-fig"><h3>Price position</h3><p className="muted small">No price yet.</p></figure>;
  const x = (v: number) => `${s.pos(v)}%`;
  const ticks = market ? pctTicks(s, market, 5) : [];
  const gap = market ? pool / market - 1 : undefined;
  const mktToAnchor = market && anchor ? distance(market, anchor) : undefined;
  const label = [`Pool price ${fmtPrice(pool)} ${B} per ${A}`, market ? `market ${fmtPrice(market)}, the pool is ${fmtPct(gap!, 2, true)} from it` : 'no market reference',
    anchor ? `owner's anchor ${fmtPrice(anchor)}` : '', stop && r ? `the bot stops following outside ${fmtPrice(stop[0])} to ${fmtPrice(stop[1])} (±${fmtPct(r.anchorStop, 0)} of the anchor)` : '',
    mktToAnchor !== undefined && r ? `the market is ${fmtPct(mktToAnchor)} from the anchor` : '', r && market ? `fee band ±${fmtPct(r.feeBandBps / 10_000)}, dead band ±${fmtPct(r.deadBandBps / 10_000)} around the market` : ''].filter(Boolean).join('; ');
  const tone = gap === undefined ? '' : Math.abs(gap) * 10_000 >= 200 ? 'down' : r && Math.abs(gap) * 10_000 > r.deadBandBps ? 'warn' : 'up';
  const lo = market ? Math.min(s.pos(pool), s.pos(market)) : 0, hi = market ? Math.max(s.pos(pool), s.pos(market)) : 0;

  return (
    <figure className="glance-fig">
      <h3>Price position <span className="muted">{B} per {A}</span></h3>
      <div className="pscale" role="img" aria-label={`${label}.`}>
        <div className="prow above">{market && <Tag at={s.pos(market)} cls="mk"><Shape k="market" /> market {fmtPrice(market)}</Tag>}</div>
        <div className="ptrack">
          {stop && <div className="band stop" style={{ left: x(stop[0]), width: `${s.pos(stop[1]) - s.pos(stop[0])}%` }} title={`The bot follows the market only inside ${fmtPrice(stop[0])} – ${fmtPrice(stop[1])} (±${fmtPct(r!.anchorStop, 0)} of the owner's anchor)`} />}
          {fee && <div className="band fee" style={{ left: x(fee[0]), width: `${s.pos(fee[1]) - s.pos(fee[0])}%` }} title={`Fee band ±${fmtPct(r!.feeBandBps / 10_000)}: inside it an arbitrage swap does not pay`} />}
          {dead && <div className="band dead" style={{ left: x(dead[0]), width: `${s.pos(dead[1]) - s.pos(dead[0])}%` }} title={`Dead band ±${fmtPct(r!.deadBandBps / 10_000)}: the bot does not rebalance inside it`} />}
          <div className="axis" />
          {stop && <><div className="edge" style={{ left: x(stop[0]) }} /><div className="edge" style={{ left: x(stop[1]) }} /></>}
          {anchor && <Mark at={s.pos(anchor)} k="anchor" title={`Owner's anchor ${fmtPrice(anchor)}`} />}
          {market && <Mark at={s.pos(market)} k="market" title={`Market ${fmtPrice(market)}`} />}
          <Mark at={s.pos(pool)} k="pool" title={`Pool ${fmtPrice(pool)}`} />
        </div>
        {market && hi - lo > 0.5 && (
          <div className="gapline" style={{ left: `${lo}%`, width: `${hi - lo}%` }}><span className={tone}>{fmtPct(gap!, 2, true)}</span></div>
        )}
        <div className="prow"><Tag at={s.pos(pool)} cls="pl"><Shape k="pool" /> pool {fmtPrice(pool)}</Tag></div>
        {anchor && <div className="prow"><Tag at={s.pos(anchor)} cls="an"><Shape k="anchor" /> anchor {fmtPrice(anchor)}</Tag></div>}
        <div className="pticks">{ticks.map((t) => <span key={t.pct} style={{ left: x(t.price) }}>{t.pct === 0 ? '0' : fmtPct(t.pct, Math.round(t.pct * 1000) % 10 ? 1 : 0, true)}</span>)}</div>
      </div>
      <ul className="legend">
        {r && <li><i className="sw stop" aria-hidden="true" />bot follows (±{fmtPct(r.anchorStop, 0)} of anchor)</li>}
        {r && market && <li><i className="sw fee" aria-hidden="true" />fee band ±{fmtPct(r.feeBandBps / 10_000)}</li>}
        {r && market && <li><i className="sw dead" aria-hidden="true" />dead band ±{fmtPct(r.deadBandBps / 10_000)}</li>}
        <li className="muted">axis: % from the market</li>
      </ul>
      <p className="glance-note">
        {gap !== undefined ? <>Pool is <b className={tone}>{fmtPct(gap, 2, true)}</b> from the market. </> : 'No market reference. '}
        {mktToAnchor !== undefined && r ? <>Market is {fmtPct(mktToAnchor)} from the {p.ownerAnchor?.source === 'owner-statement' ? "owner's anchor" : 'ledger anchor'}; the bot stops at {fmtPct(r.anchorStop, 0)}{mktToAnchor > r.anchorStop ? <b className="down"> (past it: restate the anchor)</b> : ''}.</> : null}
      </p>
    </figure>
  );
}

function Shape({ k }: { k: 'pool' | 'market' | 'anchor' }) {
  return <i className={`shape ${k}`} aria-hidden="true" />;
}
function Mark({ at, k, title }: { at: number; k: 'pool' | 'market' | 'anchor'; title: string }) {
  return <div className={`pmark ${k}`} style={{ left: `${at}%` }} title={title}><Shape k={k} /></div>;
}
/** A label centred on `at`%, kept inside the figure at the ends. */
function Tag({ at, cls, children }: { at: number; cls: string; children: React.ReactNode }) {
  const align = at < 18 ? 'start' : at > 82 ? 'end' : 'mid';
  return <span className={`ptag ${cls} ${align}`} style={{ left: `${at}%` }}>{children}</span>;
}

// ------------------------------------------------------------------ 3. depth

const SIZES = [100, 1_000, 10_000, 50_000];

function DepthFigure({ p }: { p: PoolDetail }) {
  const A = p.pair.a.symbol, B = p.pair.b.symbol;
  const ra = n(p.reserves.a), rb = n(p.reserves.b);
  const rows = SIZES.map((size) => ({ size, sell: sellA(ra, rb, p.feeBps, size), buy: buyA(ra, rb, p.feeBps, size) }));
  // The reference venue: the deepest one the reference used, if the server sent its depth.
  const ven = (p.market?.venues ?? []).filter((v) => v.used && v.depth && v.fee != null).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))[0];
  const venCost = (size: number) => (ven ? venueSellCost(ven.depth!, ven.fee!, size) : undefined);
  const maxCost = Math.max(0.0001, ...rows.flatMap((r) => [r.sell?.cost ?? 0, r.buy?.cost ?? 0, venCost(r.size) ?? 0]));
  const w = (c: number | undefined) => `${c === undefined ? 0 : Math.max(1, (c / maxCost) * 100)}%`;
  const k1 = rows[1]!.sell;
  const label = `Depth at a ${p.feeBps} bps fee: ${rows.map((r) => `${fmtAmount(r.size)} ${A}: selling costs ${r.sell ? fmtPct(r.sell.cost) : 'n/a'} and moves the price ${r.sell ? fmtPct(r.sell.move, 2, true) : 'n/a'}; buying costs ${r.buy ? fmtPct(r.buy.cost) : 'more than the pool holds'}`).join('. ')}${ven ? `. ${venueName(ven.venue)} selling 1,000 ${A} costs about ${fmtPct(venCost(1_000)!)}` : ''}.`;
  if (!(ra > 0 && rb > 0)) return <figure className="glance-fig"><h3>Depth</h3><p className="muted small">The pool is empty.</p></figure>;

  return (
    <figure className="glance-fig">
      <h3>Depth <span className="muted">cost against the pool's price, {p.feeBps} bps fee included</span></h3>
      {k1 && <p className="glance-note lead">A 1,000 {A} sale gets {fmtAmount(k1.amountB)} {B}, <b>{fmtPct(k1.cost)}</b> under the pool's price, and moves it <b>{fmtPct(k1.move, 2, true)}</b>.</p>}
      <div className="table-scroll">
        <table className="depth" role="img" aria-label={label}>
          <thead><tr><th>{A}</th><th>Sell {A} <span className="muted">cost · move</span></th><th>Buy {A} <span className="muted">cost · move</span></th>{ven && <th title={`${venueName(ven.venue)}, read as a constant-product pool of its measured depth (${fmtAmount(ven.depth)} ${A}) and its own fee (${fmtPct(ven.fee!)}): approximate away from 1,000 ${A}`}>Sell on the reference <span className="muted">≈ cost</span></th>}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.size}>
                <td>{r.size.toLocaleString("en-US")}</td>
                <td><Cost c={r.sell?.cost} move={r.sell?.move} w={w(r.sell?.cost)} side="sell" title={r.sell ? `Selling ${fmtAmount(r.size)} ${A} gets ${fmtAmount(r.sell.amountB)} ${B} (avg ${fmtPrice(r.sell.avgPrice)}); pool price after ${fmtPrice(r.sell.priceAfter)}` : ''} /></td>
                <td>{r.buy ? <Cost c={r.buy.cost} move={r.buy.move} w={w(r.buy.cost)} side="buy" title={`Buying ${fmtAmount(r.size)} ${A} costs ${fmtAmount(r.buy.amountB)} ${B} (avg ${fmtPrice(r.buy.avgPrice)}); pool price after ${fmtPrice(r.buy.priceAfter)}`} /> : <span className="muted small">more than the pool can give</span>}</td>
                {ven && <td><Cost c={venCost(r.size)} w={w(venCost(r.size))} side="ven" title={`About ${fmtPct(venCost(r.size)!)} on ${venueName(ven.venue)}`} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ven && <p className="muted small">The venue column reads {venueName(ven.venue)} (the reference) as a constant-product pool of its measured depth and fee: a guide, not a quote.</p>}
    </figure>
  );
}

function Cost({ c, move, w, side, title }: { c: number | undefined; move?: number; w: string; side: 'sell' | 'buy' | 'ven'; title: string }) {
  if (c === undefined) return <span className="muted">—</span>;
  return (
    <div className="cost" title={title}>
      <div className="cbar"><div className={`cfill ${side}`} style={{ width: w }} /></div>
      <span className="cnum">{fmtPct(c)}{move !== undefined && <span className="muted"> · {fmtPct(move, 2, true)}</span>}</span>
    </div>
  );
}

// ------------------------------------------------------------------ 4. the allowance

function AllowanceFigure({ p }: { p: PoolDetail }) {
  const al = p.operator?.allowance, r = p.rules;
  const g = al && r ? allowanceGauge({ now: Number(al.now), budget: Number(al.budget), windowEpochs: al.windowEpochs }, r) : undefined;
  if (!g || !al) return <figure className="glance-fig"><h3>Bot allowance</h3><p className="muted small">{p.operator ? 'The allowance cannot be read now.' : 'This pool has no operator.'}</p></figure>;
  const tone = g.spendable <= 0 ? 'warn' : g.share < 0.25 ? 'warn' : 'ok';
  const fullIn = fmtDuration(g.minutesToFull);
  const label = `Bot allowance ${fmtPct(g.now)} of a ${fmtPct(g.budget)} price-move budget (${fmtPct(g.share, 0)} full). It keeps ${fmtPct(g.held)} back and can spend ${fmtPct(g.spendable)} on its next move. Full in ${g.epochsToFull} epochs, about ${fullIn}.`;
  return (
    <figure className="glance-fig">
      <h3>Bot allowance <span className="muted">how far it may move the price</span></h3>
      <div className="meter-wrap" role="img" aria-label={label}>
        <div className="meter">
          <div className={`mfill ${tone}`} style={{ width: `${g.share * 100}%` }} title={`${fmtPct(g.now)} of ${fmtPct(g.budget)}`} />
          <div className="mheld" style={{ left: `${(g.held / g.budget) * 100}%` }} title={`The bot keeps ${fmtPct(g.held)} back (${fmtPct(r!.reserveFraction, 0)} of the budget)`} />
        </div>
        <div className="mscale muted small"><span>0</span><span style={{ left: `${(g.held / g.budget) * 100}%` }}>kept back</span><span>{fmtPct(g.budget)}</span></div>
      </div>
      <dl className="kv">
        <div className="stat"><dt>Now</dt><dd><b>{fmtPct(g.now)}</b> of {fmtPct(g.budget)} ({fmtPct(g.share, 0)})</dd></div>
        <div className="stat"><dt>Next move may use</dt><dd className={g.spendable <= 0 ? 'warn' : ''}>{g.spendable > 0 ? fmtPct(g.spendable, 3) : `nothing (under the ${fmtPct(g.held)} it keeps back)`}</dd></div>
        <div className="stat"><dt>Full in</dt><dd>{g.epochsToFull ? `${g.epochsToFull} epochs, about ${fullIn}` : 'full now'}</dd></div>
        <div className="stat"><dt>Refill</dt><dd className="muted">{fmtPct(g.budget)} per {al.windowEpochs} epochs (about {fmtDuration(al.windowEpochs * EPOCH_MINUTES)})</dd></div>
      </dl>
    </figure>
  );
}

// ------------------------------------------------------------------ the table row's mini gauge

export function MiniGap({ gapBps, feeBps }: { gapBps: number | null; feeBps: number }) {
  const m = miniGap(gapBps, feeBps);
  if (!m) return null;
  return (
    <span className="minigap" role="img" aria-label={`pool ${gapBps! > 0 ? 'above' : 'below'} the market by ${(Math.abs(gapBps!) / 100).toFixed(2)}%, fee band ±${(feeBps / 100).toFixed(2)}%`}>
      <span className="mg-band" style={{ left: `${m.bandLo}%`, width: `${m.bandHi - m.bandLo}%` }} />
      <span className="mg-mid" />
      <span className="mg-dot" style={{ left: `${m.dot}%` }} />
    </span>
  );
}
