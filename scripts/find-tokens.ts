// Print addresses of tokens whose symbol matches a pattern, from Ociswap's pool list. Usage: tsx scripts/find-tokens.ts USD
import { listOciswap } from '../packages/core/src/index.ts';
const re = new RegExp(process.argv[2] ?? '.', 'i');
listOciswap({ minTvlUsd: 50 }).then((o) => { for (const t of o.tokens) if (re.test(t.symbol)) console.log(t.symbol, t.address); });
