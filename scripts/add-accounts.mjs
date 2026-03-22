/**
 * add-accounts.mjs
 * Adds specific accounts to the Actual Budget instance.
 * Run from monorepo root: node scripts/add-accounts.mjs [--dry-run]
 */

import fs from 'fs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Allow self-signed / Tailscale TLS for local script use (must be set before API import)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Use locally built API
const actualAPI = await import('../packages/api/dist/index.js');

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

const DATA_DIR = '/tmp/actual-add-accounts';
const envVars = Object.fromEntries(
  fs.readFileSync(new URL('../.actual.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()))
);
const SERVER_URL = envVars.ACTUAL_SERVER_URL || 'http://localhost:5006';
const PASSWORD = envVars.ACTUAL_PASSWORD;
const BUDGET_ID = envVars.ACTUAL_BUDGET_ID;

// Accounts to create. 'type' is informational only (Actual doesn't store it).
// initialBalance is in cents (Actual API integer format).
const ACCOUNTS_TO_CREATE = [
  {
    name: 'Discover Savings',
    offbudget: false,
    closed: false,
    initialBalance: 0, // $0.00
    note: 'type: savings, on-budget',
  },
  {
    name: 'Fidelity 401k',
    offbudget: true,
    closed: false,
    initialBalance: 0,
    note: 'type: investment, off-budget',
  },
  {
    name: 'Schwab Brokerage',
    offbudget: true,
    closed: false,
    initialBalance: 0,
    note: 'type: investment, off-budget (NVDA RSU + ESPP)',
  },
  {
    name: 'HSA (Health Savings)',
    offbudget: true,
    closed: false,
    initialBalance: 0,
    note: 'type: investment, off-budget',
  },
  {
    name: 'Splitwise',
    offbudget: true,
    closed: false,
    initialBalance: 395823, // $3,958.23 in cents
    note: 'type: other asset, off-budget',
  },
];

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('Connecting to Actual Budget...');
  // password in init() signs in; password in downloadBudget() is for encrypted budgets
  await actualAPI.init({
    dataDir: DATA_DIR,
    serverURL: SERVER_URL,
    password: PASSWORD,
  });
  await actualAPI.downloadBudget(BUDGET_ID);
  console.log('Budget loaded.\n');

  // Get existing accounts to check for duplicates
  const existingAccounts = await actualAPI.getAccounts();
  const existingNames = new Set(
    existingAccounts.map(a => a.name.trim().toLowerCase()),
  );
  console.log(`Found ${existingAccounts.length} existing accounts:`);
  for (const a of existingAccounts) {
    console.log(`  - ${a.name} (offbudget: ${a.offbudget === 1})`);
  }
  console.log();

  const results = [];

  for (const acct of ACCOUNTS_TO_CREATE) {
    const nameLower = acct.name.trim().toLowerCase();

    if (existingNames.has(nameLower)) {
      console.log(`  SKIP   "${acct.name}" — already exists`);
      results.push({ name: acct.name, status: 'skipped (already exists)' });
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  DRY    "${acct.name}" — would create (${acct.note}, balance: ${acct.initialBalance / 100})`,
      );
      results.push({ name: acct.name, status: 'dry-run (would create)' });
      continue;
    }

    try {
      const accountPayload = {
        name: acct.name,
        offbudget: acct.offbudget,
        closed: acct.closed,
      };

      // createAccount(account, initialBalance) — initialBalance is in cents (integer)
      const id = await actualAPI.createAccount(
        accountPayload,
        acct.initialBalance || null,
      );

      console.log(`  CREATE "${acct.name}" → id=${id} (${acct.note})`);
      results.push({ name: acct.name, status: 'created', id });
    } catch (err) {
      console.error(`  ERROR  "${acct.name}": ${err.message}`);
      results.push({ name: acct.name, status: `error: ${err.message}` });
    }
  }

  if (!DRY_RUN) {
    console.log('\nSyncing changes...');
    await actualAPI.sync();
    console.log('Sync complete.');
  }

  console.log(
    '\n── Summary ──────────────────────────────────────────────────────',
  );
  for (const r of results) {
    console.log(`  ${r.name.padEnd(30)} → ${r.status}`);
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
