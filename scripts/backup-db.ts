// Take a consistent copy of the order database while the server runs.
//
//   tsx scripts/backup-db.ts [database] [backup-dir]
//   defaults: data/orders-mainnet.sqlite  data/backups
//
// Uses SQLite's VACUUM INTO, which reads one consistent snapshot of the database including what is
// still only in its WAL file (copying the .sqlite file alone would miss that). The copy is a single
// self-contained file, mode 600, named orders-<network>-<UTC time>.sqlite. Keeps the newest 30.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

process.umask(0o077);
const source = resolve(process.argv[2] ?? 'data/orders-mainnet.sqlite');
const dir = resolve(process.argv[3] ?? 'data/backups');
if (!existsSync(source)) throw new Error(`No database at ${source}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(dir, `${basename(source, '.sqlite')}-${stamp}.sqlite`);
// The path is spliced into SQL: allow only ordinary path characters.
if (!/^[\w./-]+$/.test(target)) throw new Error(`Unsafe backup path: ${target}`);

const db = new DatabaseSync(source);
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`VACUUM INTO '${target}'`);
db.close();
chmodSync(target, 0o600);

// Check the copy opens and holds the orders table.
const check = new DatabaseSync(target, { readOnly: true });
const n = (check.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
const ok = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
check.close();
if (ok !== 'ok') throw new Error(`Backup ${target} failed its integrity check: ${ok}`);
console.log(`backed up ${n} orders to ${target}`);

const prefix = basename(source, '.sqlite') + '-';
const old = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.sqlite')).sort().slice(0, -30);
for (const f of old) rmSync(join(dir, f));
