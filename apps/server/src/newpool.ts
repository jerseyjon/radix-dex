// A new OwnerPool from the Pools page: the pure planning, with the same guards as
// scripts/mainnet-owner-pool.ts `instantiate` (allow-listed package, the tokens' roles, the seed price
// against the market) and the same builder (`ownerPoolInstantiateManifest`), which creates AND funds the
// pool in one transaction (`instantiate_with_liquidity`, pool audit F2: no empty pool ever exists).
// No I/O here; pools.ts reads the ledger and the market and calls this.
import { Decimal, OWNER_POOL_MAX_FEE_BPS, ownerPoolInstantiateManifest, priceGap, type ownerPoolStepMismatches } from '@radix-dex/core';

/** A token as the planner needs it, read from the ledger by the service. */
export interface NewPoolToken {
  address: string;
  symbol: string;
  divisibility: number;
  /** `poolTokenProblems` for the token (empty for the network's XRD, which is native). */
  errors: string[];
  warnings: string[];
}

export interface NewPoolInput {
  owner: { account: string; badge: string };
  /** The OwnerPool package to instantiate: must be in `packages`. */
  package: string;
  /** The allow-listed packages for this network (`OWNER_POOL_PACKAGES`). */
  packages: string[];
  tokenA: NewPoolToken;
  tokenB: NewPoolToken;
  params: Record<string, unknown>;
  /** The market price (B per A) when on-ledger venues quote the pair, else undefined. */
  market?: { price: number; source: string };
  /** Why there is no market price, when there is none (shown with the confirmation). */
  noMarketReason?: string;
  /** Largest gap between the seed price and the market (the script's --max-gap, 1%). */
  maxGap?: number;
  /** OwnerPools of the owner already listed for the same two tokens (a note, not a refusal). */
  samePair?: string[];
  /** The pairs the market-making bot manages on this network (mainnet: XRD/hUSDC). */
  botPairs?: string[];
}

export interface NewPoolPlan {
  title: string;
  /** Null while a confirmation is missing (`blocked`): nothing to preview or sign yet. */
  manifest: string | null;
  /** What the ledger must show afterwards (ownerPoolStepMismatches' `want`), for the check after the commit. */
  want: Parameters<typeof ownerPoolStepMismatches>[1];
  amountA: string;
  amountB: string;
  feeBps: number;
  /** The seed price, B per A, as the exact text the owner confirms when there is no market. */
  seedPrice: string;
  market: { price: number; source: string; gap: number } | null;
  /** What the owner must confirm before the manifest is built: 'price' (no market), 'issuer-risk' (a minter or burner exists). */
  needs: ('price' | 'issuer-risk')[];
  blocked: string[];
  notes: string[];
  warnings: string[];
  scriptStep: 'instantiate';
}

export class NewPoolError extends Error {}

const PLAIN = /^\d{1,30}(\.\d{1,18})?$/;
function amountOf(v: unknown, what: string, divisibility: number): string {
  if (v === undefined || v === null || v === '') throw new NewPoolError(`${what} is required`);
  const s = String(v).trim();
  if (!PLAIN.test(s)) throw new NewPoolError(`${what} must be a plain decimal amount`);
  const d = new Decimal(s);
  if (!d.gt(0)) throw new NewPoolError(`${what} must be more than zero`);
  if (d.decimalPlaces() > divisibility) throw new NewPoolError(`${what} has more than ${divisibility} decimal places (the token's limit)`);
  return d.toFixed();
}

/** B per A to 10 significant digits: the text the owner confirms, and compares with the market. */
export function seedPriceText(amountA: string, amountB: string): string {
  return new Decimal(amountB).div(amountA).toSignificantDigits(10, Decimal.ROUND_HALF_EVEN).toFixed();
}

/**
 * Plan a new pool. Throws NewPoolError when the request is refused outright (bad input, a refused
 * token, a package not allow-listed, a seed price more than `maxGap` from the market). Returns a plan
 * with `blocked` set and no manifest while the owner still has to confirm something: the price when
 * no on-ledger venue quotes the pair, and the issuer's power when a token has a minter or burner.
 */
export function planNewPool(i: NewPoolInput): NewPoolPlan {
  const A = i.tokenA, B = i.tokenB, p = i.params;
  const maxGap = i.maxGap ?? 0.01;
  if (!i.packages.includes(i.package)) throw new NewPoolError(`Package ${i.package} is not allow-listed for OwnerPools on this network`);
  if (A.address === B.address) throw new NewPoolError('The two tokens must differ');
  if (A.address === i.owner.badge || B.address === i.owner.badge) throw new NewPoolError('The owner badge cannot be one of the pool\'s tokens');
  for (const t of [A, B]) if (t.errors.length) throw new NewPoolError(`${t.symbol} (${t.address}) is refused as a pool token: ${t.errors.join('; ')}`);
  const amountA = amountOf(p.amountA, `Amount of ${A.symbol}`, A.divisibility);
  const amountB = amountOf(p.amountB, `Amount of ${B.symbol}`, B.divisibility);
  const fee = p.feeBps;
  const feeBps = typeof fee === 'number' ? fee : typeof fee === 'string' && /^\d{1,5}$/.test(fee.trim()) ? Number(fee) : NaN;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > OWNER_POOL_MAX_FEE_BPS) throw new NewPoolError(`The fee must be a whole number of basis points from 0 to ${OWNER_POOL_MAX_FEE_BPS}`);

  const seedPrice = seedPriceText(amountA, amountB);
  const price = new Decimal(amountB).div(amountA).toNumber();
  const notes: string[] = [], warnings: string[] = [], blocked: string[] = [], needs: NewPoolPlan['needs'] = [];
  let market: NewPoolPlan['market'] = null;

  if (i.market) {
    const gap = priceGap(price, i.market.price);
    market = { ...i.market, gap };
    const line = `Seed price ${seedPrice} ${B.symbol} per ${A.symbol}; market ${i.market.price.toPrecision(8)} (${i.market.source}); gap ${(gap * 100).toFixed(3)}% (limit ${(maxGap * 100).toFixed(2)}%).`;
    if (!(gap <= maxGap)) throw new NewPoolError(`${line} Refused: seed the pool at the market. (Only the script's --force goes past this, deliberately.)`);
    notes.push(line);
  } else {
    needs.push('price');
    const confirmed = typeof p.confirmPrice === 'string' && p.confirmPrice.trim() === seedPrice;
    if (!confirmed) blocked.push(`No on-ledger venue quotes ${A.symbol}/${B.symbol}${i.noMarketReason ? ` (${i.noMarketReason})` : ''}: confirm the price yourself, 1 ${A.symbol} = ${seedPrice} ${B.symbol}.`);
    else notes.push(`No market price for this pair: you confirmed the seed price 1 ${A.symbol} = ${seedPrice} ${B.symbol} yourself.`);
  }

  const issuer = [A, B].flatMap((t) => t.warnings.map((w) => `${t.symbol}: ${w}`));
  if (issuer.length) {
    needs.push('issuer-risk');
    warnings.push(...issuer.map((w) => `Issuer risk: ${w}. Whoever holds that role can mint (or burn) the token and buy the other side out of the pool.`));
    if (p.acceptIssuerRisk !== true) blocked.push('Accept the token issuer\'s power over this pool (listed above) to go ahead.');
  }
  if (i.samePair?.length) warnings.push(`You already have ${i.samePair.length === 1 ? 'a pool' : `${i.samePair.length} pools`} for these two tokens: ${i.samePair.join(', ')}. A second one splits the liquidity.`);

  notes.push(
    'Created and funded in this one transaction (instantiate_with_liquidity): no empty pool ever exists (pool audit F2).',
    `Exactly ${amountA} ${A.symbol} and ${amountB} ${B.symbol} leave your account; the pool's owner is your owner badge ${i.owner.badge}, proved in the same transaction.`,
    'Swaps are open from the moment it commits, at this price. Pause it straight away (offered next) unless you will watch it.',
    `${i.botPairs?.length ? `The bot manages only ${i.botPairs.join(', ')} today` : 'The bot manages no pair on this network'}: this pool runs as a plain constant-product pool, kept at the market by arbitrage only. Operator steps (operator badge, limits, appoint) are in the script for now.`,
  );

  const manifest = blocked.length ? null : ownerPoolInstantiateManifest({
    owner: i.owner, package: i.package, resourceA: A.address, resourceB: B.address, amountA, amountB, feeBps,
  });
  return {
    title: `New pool ${A.symbol}/${B.symbol}: ${amountA} ${A.symbol} + ${amountB} ${B.symbol}, fee ${feeBps} bps`,
    manifest,
    want: { resources: [A.address, B.address], reserves: [amountA, amountB], inventory: ['0', '0'], feeBps, ownerPaused: false, operatorPaused: false, operator: null, ownerBadge: i.owner.badge },
    amountA, amountB, feeBps, seedPrice, market, needs, blocked, notes, warnings, scriptStep: 'instantiate',
  };
}

/**
 * The market mid (B per A) from a two-way probe of the router over the on-ledger venues: `bid` is B
 * received per A sold, `ask` is B paid per A bought. Fees and impact widen the two symmetrically, so
 * their geometric mean is the mid. A spread wider than `maxSpread` is too thin to check a price
 * against: no market.
 */
export function probeMid(o: { sellA: string; getB: string; sellB: string; getA: string; maxSpread?: number }): { price: number; spread: number } | { reason: string } {
  const bid = Number(o.getB) / Number(o.sellA), ask = Number(o.sellB) / Number(o.getA);
  if (!(bid > 0 && ask > 0 && Number.isFinite(bid) && Number.isFinite(ask))) return { reason: 'the router returned no usable quote' };
  const spread = ask / bid - 1;
  if (spread > (o.maxSpread ?? 0.05)) return { reason: `the venues' two-way spread is ${(spread * 100).toFixed(2)}%, too thin to check a price against` };
  return { price: Math.sqrt(bid * ask), spread };
}

/** The OwnerPool package new pools are made from: the newest allow-listed one (the last listed). */
export function newPoolPackage(packages: string[]): string | undefined {
  return packages[packages.length - 1];
}

/** The component an instantiate transaction created (its receipt's new global entities). */
export function createdPool(newEntities: string[]): string | undefined {
  const c = newEntities.filter((a) => a.startsWith('component_'));
  return c.length === 1 ? c[0] : undefined;
}
