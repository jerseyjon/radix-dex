// Read-only summary of the OwnerPool markout record written by the watcher (scripts/owner-pool-watch.ts,
// --markout, default data/owner-pool-markout.jsonl). docs/owner-pool-bot.md, "Markout".
//
//   tsx scripts/owner-pool-markout.ts [--file <path>] [--horizons 5,30] [--sizes 10,100,1000] [--json] [--trades]
//
// Values are in token A (XRD). markout < 0 means traders were right (the pool lost on price);
// profit = fees + markout. Break-even fee = the fee (bps of volume) that would have covered the markout.
import { existsSync, readFileSync } from 'node:fs';
import { parseMarkoutLines, summarizeMarkouts, type MarkoutBucket, type MarkoutRecord } from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = opt('file') ?? 'data/owner-pool-markout.jsonl';
const horizonsMin = (opt('horizons') ?? '5,30').split(',').map(Number).filter((x) => x > 0);
const sizeEdgesA = (opt('sizes') ?? '10,100,1000').split(',').map(Number).filter((x) => x > 0);
if (!existsSync(file)) { console.error(`no markout file at ${file} (the watcher writes it)`); process.exit(1); }

const records = parseMarkoutLines(readFileSync(file, 'utf8'));
const sum = summarizeMarkouts(records, { horizonsMin, sizeEdgesA });
if (argv.includes('--json')) { console.log(JSON.stringify(sum, null, 1)); process.exit(0); }

const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const row = (label: string, b: MarkoutBucket) => {
  const cells = [label.padEnd(12), String(b.trades).padStart(6), f(b.volumeA, 2).padStart(12), f(b.feesA).padStart(10), (b.volumeA > 0 ? f((b.feesA / b.volumeA) * 10_000, 1) : '-').padStart(8)];
  for (const h of horizonsMin) {
    const x = b.horizons[String(h)]!;
    cells.push(`${x.marked}`.padStart(4), f(x.markoutA).padStart(10), f(x.profitA).padStart(10), f(x.breakEvenFeeBps, 1).padStart(7), (x.poolMid.marked ? f(x.poolMid.markoutA) : '-').padStart(10));
  }
  return cells.join(' ');
};
const head = ['bucket'.padEnd(12), 'trades'.padStart(6), 'volume XRD'.padStart(12), 'fees XRD'.padStart(10), 'fee bps'.padStart(8)];
for (const h of horizonsMin) head.push(`n${h}`.padStart(4), `mk${h}m`.padStart(10), `profit${h}m`.padStart(10), `be${h}m`.padStart(7), `mid-mk${h}m`.padStart(10));
console.log(`markout summary: ${file}, ${sum.all.trades} trades, ${sum.pending} mark(s) still pending`);
console.log('(XRD; mkNm = markout at +N min vs the reference, negative = traders were right; profitNm = fees + markout of the trades');
console.log(' marked at N; beNm = fee in bps that would have broken even at N; mid-mkNm = markout vs the pool\'s own mid, a second view)');
console.log(head.join(' '));
console.log(row('ALL', sum.all));
console.log('-- by trade size (XRD)');
for (const [k, b] of Object.entries(sum.bySize).sort((a, b) => parseFloat(a[0].replace('>=', '')) - parseFloat(b[0].replace('>=', '')))) console.log(row(k, b));
console.log('-- by fee in force (bps)');
for (const [k, b] of Object.entries(sum.byFeeBps).sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(row(k, b));
if (argv.includes('--trades')) {
  console.log('-- trades');
  for (const r of records) {
    if (r.kind !== 'trade') continue;
    const marks = records.filter((m): m is Extract<MarkoutRecord, { kind: 'mark' }> => m.kind === 'mark' && m.txid === r.txid);
    console.log([new Date(r.at).toISOString().slice(11, 19), r.txid.slice(0, 20) + '…', r.side, f(r.volumeA, 3), `${r.feeBps}bps`, `fee ${f(r.feeA, 5)}`, `at0 ${r.at0 ? f(r.at0.markout, 5) : '-'}`,
      ...marks.sort((a, b) => a.horizonMin - b.horizonMin).map((m) => `+${m.horizonMin}m ${m.atRef ? f(m.atRef.markout, 5) : '-'} (mid ${m.atPoolMid ? f(m.atPoolMid.markout, 5) : '-'})`)].join('  '));
  }
}
