// Guided mainnet set-up. This script never sends a transaction: it prints each manifest, after
// previewing it on mainnet, for the owner to sign in their own wallet, then reads the result back.
//
//   tsx scripts/mainnet-setup.ts init <owner account> <dApp definition account> <https origin>
//   tsx scripts/mainnet-setup.ts next            print the next manifest to sign (already previewed)
//   tsx scripts/mainnet-setup.ts record <txid>   read what that transaction created and move on
//   tsx scripts/mainnet-setup.ts status          where things stand, and the server's settings once done
//   tsx scripts/mainnet-setup.ts recall          manifest that takes the solver badge back (stops all filling)
//   tsx scripts/mainnet-setup.ts dry             preview the manifests with stand-in accounts; changes nothing
//
// Sign manifests at https://console.radixdlt.com/transaction-manifest with the wallet connected.
// The package is published at https://console.radixdlt.com/deploy-package (it carries a file).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Gateway, NETWORKS, accountOf, addr, isAccount, keyFromHex, requireResourceRule } from '../packages/core/src/index.ts';

const net = NETWORKS.mainnet;
const gw = new Gateway(net);
const STATE = 'data/mainnet-setup.json', KEY = 'data/mainnet-solver.key';
type State = Partial<Record<'owner' | 'dapp' | 'origin' | 'solver' | 'ownerBadge' | 'solverBadge' | 'package' | 'registry' | 'orderBook' | 'orderReceipts' | 'dappDone', string>>;
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
const text = (v: string) => { if (/["\\\n]/.test(v)) throw new Error('Bad text for a manifest: ' + v); return '"' + v + '"'; };
const str = (v: string) => 'Enum<Metadata::String>(' + text(v) + ')';
const named = (name: string, description: string) =>
  'Tuple(Map<String, Tuple>("name" => Tuple(Some(' + str(name) + '), true), "description" => Tuple(Some(' + str(description) + '), true)), Map<String, Enum>())';

/** Each step: what it is for, its manifest, and which new addresses to read back from its transaction. */
function steps(s: Required<Pick<State, 'owner' | 'dapp' | 'origin' | 'solver'>> & State) {
  return [
    {
      id: 'ownerBadge', title: 'Create the owner badge (controls the order book\'s fee and can recall the solver badge). It goes to your account.',
      manifest: () => [
        'CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<0u8>() true 0u8 Decimal("1") Tuple(None, None, None, None, None, None) '
          + named('Radix DEX owner badge', 'Controls the Radix DEX order book settings. Keep it safe.') + ' None;',
        'CALL_METHOD ' + addr(s.owner) + ' "deposit_batch" Expression("ENTIRE_WORKTOP");',
      ],
      record: (created: string[]) => ({ ownerBadge: created.find((a) => a.startsWith('resource_')) }),
    },
    {
      id: 'solverBadge', title: 'Create the solver badge and send it to the solver account. The owner badge can recall it at any time, which stops all filling.',
      manifest: () => [
        'CREATE_FUNGIBLE_RESOURCE_WITH_INITIAL_SUPPLY Enum<0u8>() true 0u8 Decimal("1") Tuple(None, None, None, '
          + 'Some(Tuple(Some(' + requireResourceRule(s.ownerBadge!) + '), Some(Enum<AccessRule::DenyAll>()))), None, None) '
          + named('Radix DEX solver badge', 'Held by the Radix DEX solver. Orders signed on the site can only be filled by a transaction that shows it.') + ' None;',
        'CALL_METHOD ' + addr(s.solver) + ' "try_deposit_batch_or_abort" Expression("ENTIRE_WORKTOP") None;',
      ],
      record: (created: string[]) => ({ solverBadge: created.find((a) => a.startsWith('resource_')) }),
    },
    {
      id: 'package', title: 'Publish the contracts. Do this at https://console.radixdlt.com/deploy-package: upload data/contracts/dex_contracts.wasm and .rpd, owner role "None". Then record the transaction id.',
      manifest: () => [] as string[],
      record: (created: string[]) => ({ package: created.find((a) => a.startsWith('package_')) }),
    },
    {
      id: 'orderBook', title: 'Create the cancel registry and the order book (maker fee 0, owned by the owner badge).',
      manifest: () => [
        'CALL_FUNCTION ' + addr(s.package!) + ' "OrderRegistry" "instantiate";',
        'CALL_FUNCTION ' + addr(s.package!) + ' "OrderBook" "instantiate" 0u16 ' + addr(s.ownerBadge!) + ';',
      ],
      // The registry is created first, the order book and its receipt resource second.
      record: (created: string[]) => { const c = created.filter((a) => a.startsWith('component_')); return { registry: c[0], orderBook: c[1], orderReceipts: created.find((a) => a.startsWith('resource_')) }; },
    },
    {
      id: 'dappDone', title: 'Make the dApp definition account name this site and the order book, and make the order book name it back. Sign with both accounts available in the wallet.',
      manifest: () => [
        'SET_METADATA ' + addr(s.dapp) + ' "account_type" ' + str('dapp definition') + ';',
        'SET_METADATA ' + addr(s.dapp) + ' "name" ' + str('Radix DEX') + ';',
        'SET_METADATA ' + addr(s.dapp) + ' "description" ' + str('Spot trading terminal for Radix: market and limit orders over existing pools and its own order book.') + ';',
        'SET_METADATA ' + addr(s.dapp) + ' "claimed_websites" Enum<Metadata::OriginArray>(Array<String>(' + text(s.origin) + '));',
        'SET_METADATA ' + addr(s.dapp) + ' "claimed_entities" Enum<Metadata::AddressArray>(Array<Address>(' + addr(s.orderBook!) + '));',
        'CALL_METHOD ' + addr(s.owner) + ' "create_proof_of_amount" ' + addr(s.ownerBadge!) + ' Decimal("1");',
        'SET_METADATA ' + addr(s.orderBook!) + ' "dapp_definition" Enum<Metadata::Address>(' + addr(s.dapp) + ');',
      ],
      record: () => ({ dappDone: 'yes' }),
    },
  ];
}

async function preview(lines: string[]): Promise<string> {
  const { epoch } = await gw.status();
  const r = await gw.preview(lines.join('\n'), epoch);
  return r.ok ? 'preview: would succeed, network fee about ' + r.feeXrd + ' XRD' : 'PREVIEW FAILED: ' + r.error;
}
const ready = (): Required<Pick<State, 'owner' | 'dapp' | 'origin' | 'solver'>> & State => {
  if (!state.owner || !state.dapp || !state.origin || !state.solver) throw new Error('Run "init <owner account> <dApp definition account> <https origin>" first');
  return state as any;
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'init') {
  const [owner, dapp, origin] = args;
  if (!owner || !dapp || !origin || !isAccount(owner) || !isAccount(dapp) || !owner.startsWith('account_rdx') || !dapp.startsWith('account_rdx')) throw new Error('Give two mainnet account addresses and the site origin');
  if (owner === dapp) throw new Error('Use a separate account for the dApp definition');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) throw new Error('The origin must look like https://dex.example.com, with no path');
  // The solver's own key: made here, never printed, readable only by this user.
  if (!existsSync(KEY)) writeFileSync(KEY, randomBytes(32).toString('hex'), { mode: 0o600 });
  Object.assign(state, { owner, dapp, origin, solver: await accountOf(keyFromHex(readFileSync(KEY, 'utf8').trim()), net.networkId) });
  save();
  console.log('Saved. Solver account (send it XRD for network fees before going live): ' + state.solver);
} else if (cmd === 'next') {
  const s = ready();
  const step = steps(s).find((x) => !s[x.id as keyof State]);
  if (!step) { console.log('All set-up steps are recorded. Run "status" for the server settings.'); process.exit(0); }
  console.log('STEP ' + step.id + ': ' + step.title + '\n');
  const lines = step.manifest();
  if (lines.length) console.log(lines.join('\n') + '\n\n' + (await preview(lines)));
  console.log('\nAfter it commits: tsx scripts/mainnet-setup.ts record <transaction id>');
} else if (cmd === 'record') {
  const s = ready();
  const step = steps(s).find((x) => !s[x.id as keyof State]);
  if (!step || !args[0]) throw new Error('Nothing to record, or no transaction id given');
  const j = await gw.post('/transaction/committed-details', { intent_hash: args[0], opt_ins: { receipt_state_changes: true } });
  if (j.transaction?.transaction_status !== 'CommittedSuccess') throw new Error('That transaction did not succeed: ' + j.transaction?.transaction_status);
  const created: string[] = (j.transaction?.receipt?.state_updates?.new_global_entities ?? []).map((e: any) => String(e.entity_address));
  const found = step.record(created);
  for (const [k, v] of Object.entries(found)) if (!v) throw new Error('That transaction did not create what step "' + step.id + '" expects (' + k + ' missing). Created: ' + created.join(', '));
  Object.assign(state, found);
  save();
  console.log('Recorded ' + JSON.stringify(found));
} else if (cmd === 'status') {
  console.log(JSON.stringify(state, null, 2));
  if (state.dappDone) {
    console.log('\nServer settings:\n' + [
      'DEX_NETWORK=mainnet', 'DEX_SOLVER_BADGE=' + state.solverBadge, 'DEX_SOLVER_KEY_FILE=' + KEY, 'DEX_REGISTRY=' + state.registry,
      'DEX_ORDER_BOOK=' + state.orderBook, 'DEX_DAPP_DEFINITION=' + state.dapp, 'DEX_CLIENT_IP_HEADER=cf-connecting-ip', 'DEX_TAKER_FEE_BPS=10', 'DEX_MAKER_FEE_BPS=0',
    ].join('\n'));
  }
} else if (cmd === 'recall') {
  const s = ready();
  if (!s.solverBadge || !s.ownerBadge) throw new Error('The badges are not recorded yet');
  const j = await gw.post('/state/entity/page/fungible-vaults/', { address: s.solver, resource_address: s.solverBadge });
  const vault = (j.items ?? []).find((v: any) => Number(v.amount) > 0)?.vault_address;
  if (!vault) throw new Error('The solver account holds no solver badge');
  const lines = [
    'CALL_METHOD ' + addr(s.owner) + ' "create_proof_of_amount" ' + addr(s.ownerBadge) + ' Decimal("1");',
    'RECALL_FROM_VAULT Address("' + vault + '") Decimal("1");',
    'CALL_METHOD ' + addr(s.owner) + ' "deposit_batch" Expression("ENTIRE_WORKTOP");',
  ];
  console.log(lines.join('\n') + '\n\n' + (await preview(lines)));
} else if (cmd === 'dry') {
  // Stand-ins that exist on mainnet, so the previews exercise the real engine. Nothing is saved or sent.
  const holders = await gw.resourceHolders(net.xrd, 5);
  const [a, b] = holders.filter((h) => h.address.startsWith('account_')).map((h) => h.address);
  if (!a || !b) throw new Error('No stand-in accounts found');
  const s = { owner: a, dapp: b, origin: 'https://dex.example.com', solver: await accountOf(keyFromHex(randomBytes(32).toString('hex')), net.networkId), ownerBadge: net.xrd } as any;
  for (const step of steps(s).slice(0, 2)) console.log(step.id + ': ' + (await preview(step.manifest())));
  console.log('dApp definition metadata: ' + (await preview(steps({ ...s, orderBook: 'component_rdx1cptxxxxxxxxxfaucetxxxxxxxxx000527798379xxxxxxxxxfaucet' }).at(-1)!.manifest().slice(0, 4))));
  console.log('(Publishing and creating the order book cannot be previewed before the package exists; the same calls run in scripts/stokenet-setup.ts.)');
} else {
  console.log('Commands: init, next, record, status, recall, dry. See the top of this file.');
}
