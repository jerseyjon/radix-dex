// Move the solver's earnings on mainnet to the owner account recorded by mainnet-setup.ts.
//
//   tsx scripts/mainnet-withdraw.ts                 show balances and what would move (previewed; sends nothing)
//   tsx scripts/mainnet-withdraw.ts --keep 300      keep 300 XRD in the solver instead of the default 250
//   tsx scripts/mainnet-withdraw.ts --send          send it
//
// The solver keeps `--keep` XRD as its float for network fees and for buying book orders. Everything
// above that, and every other token it has collected as fees, goes to the owner. The solver badge never moves.
import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { Gateway, NETWORKS, accountOf, addr, buildTransaction, dec, isAccount, keyFromHex, submitAndWait } from '../packages/core/src/index.ts';

const net = NETWORKS.mainnet, gw = new Gateway(net);
const state = JSON.parse(readFileSync('data/mainnet-setup.json', 'utf8')) as Record<string, string>;
const key = keyFromHex(readFileSync('data/mainnet-solver.key', 'utf8').trim());
const solver = await accountOf(key, net.networkId);
if (solver !== state.solver) throw new Error('The key file does not match the solver account in data/mainnet-setup.json');
if (!isAccount(state.owner ?? '') || !state.owner!.startsWith('account_rdx') || !state.solverBadge) throw new Error('data/mainnet-setup.json has no owner account or solver badge');

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const unknown = args.filter((a, i) => !['--send', '--keep'].includes(a) && args[i - 1] !== '--keep');
if (unknown.length) throw new Error('Unknown argument: ' + unknown.join(' '));
const keep = new Decimal(flag('--keep') ?? '250');
if (!keep.isFinite() || keep.lt(20)) throw new Error('--keep must be at least 20 XRD, or the solver cannot pay network fees');

const balances = await gw.fungibleBalances(solver);
const moves: [string, Decimal][] = [];
console.log('Solver ' + solver);
for (const [resource, amount] of Object.entries(balances)) {
  const have = new Decimal(amount);
  if (!have.gt(0)) continue;
  const label = resource === net.xrd ? 'XRD' : resource === state.solverBadge ? 'solver badge (stays)' : resource;
  console.log('  ' + have.toFixed() + '  ' + label);
  if (resource === state.solverBadge) continue;
  // One XRD is left over the float for this transaction's own fee.
  const move = resource === net.xrd ? have.minus(keep).minus(1) : have;
  if (move.gt(0)) moves.push([resource, move]);
}
if (!moves.length) { console.log(`\nNothing to withdraw: the solver holds no more than the ${keep.toFixed()} XRD it keeps.`); process.exit(0); }

const manifest = [
  `CALL_METHOD ${addr(solver)} "lock_fee" ${dec('5')};`,
  ...moves.map(([r, a]) => `CALL_METHOD ${addr(solver)} "withdraw" ${addr(r)} ${dec(a)};`),
  // Fails as a whole if the owner account refuses a deposit, so nothing is ever left in between.
  `CALL_METHOD ${addr(state.owner!)} "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;`,
].join('\n');
console.log('\nTo owner ' + state.owner);
for (const [r, a] of moves) console.log('  ' + a.toFixed() + '  ' + (r === net.xrd ? 'XRD' : r));

const { epoch } = await gw.status();
const preview = await gw.preview(manifest, epoch);
if (!preview.ok) throw new Error('Preview failed, nothing sent: ' + preview.error);
console.log(`\nPreview: would succeed, network fee about ${preview.feeXrd} XRD.`);
if (!args.includes('--send')) { console.log('Nothing sent. Add --send to do it.'); process.exit(0); }

const tx = await buildTransaction({ manifest, window: { networkId: net.networkId, startEpoch: epoch, endEpoch: epoch + 10 }, notary: key });
const out = await submitAndWait(gw, tx);
if (out.status !== 'CommittedSuccess') throw new Error(`Not sent: ${out.status}: ${out.error}`);
console.log('Sent: ' + tx.intentHashId);
