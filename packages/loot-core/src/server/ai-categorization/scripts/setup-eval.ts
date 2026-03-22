#!/usr/bin/env npx tsx
/**
 * Pulls categories + Jan–Mar transactions from your live Actual budget
 * and writes eval-fixture.ts — fully automatically, including expectedCategory.
 *
 * Transactions that are already categorized in your budget get their category
 * auto-filled as the ground truth. Nothing to fill in manually.
 *
 * Usage:
 *   ACTUAL_SERVER_URL=http://localhost:5006 \
 *   ACTUAL_PASSWORD=yourpassword \
 *   ACTUAL_SYNC_ID=your-budget-uuid \
 *   yarn setup-eval
 *
 * Optional flags:
 *   --start 2025-01-01   (default: 2025-01-01)
 *   --end   2025-03-31   (default: 2025-03-31)
 */

import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

// @ts-expect-error
import * as api from '@actual-app/api';

import { logger } from '../../../platform/server/log';

// ─── Args / config ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? fallback) : fallback;
};

const START = flag('--start', '2025-01-01');
const END = flag('--end', '2025-03-31');

const serverUrl = process.env.ACTUAL_SERVER_URL ?? '';
const password = process.env.ACTUAL_PASSWORD;
const sessionToken = process.env.ACTUAL_SESSION_TOKEN;
const syncId = process.env.ACTUAL_SYNC_ID ?? '';
const dataDir =
  process.env.ACTUAL_DATA_DIR ?? path.join(homedir(), '.actual-cli', 'data');

if (!serverUrl) {
  logger.error('Set ACTUAL_SERVER_URL');
  process.exit(1);
}
if (!password && !sessionToken) {
  logger.error('Set ACTUAL_PASSWORD or ACTUAL_SESSION_TOKEN');
  process.exit(1);
}
if (!syncId) {
  logger.error('Set ACTUAL_SYNC_ID');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  logger.log(`→ Connecting to ${serverUrl}...`);

  await api.init({
    serverURL: serverUrl,
    dataDir,
    ...(sessionToken ? { sessionToken } : { password }),
  });

  try {
    logger.log(`→ Downloading budget ${syncId}...`);
    await api.downloadBudget(syncId);

    // ── Categories ─────────────────────────────────────────────────────────
    const groups = await api.getCategoryGroups();

    // id → { name, groupName, is_income }
    const categoryById = new Map<
      string,
      { name: string; groupName: string; is_income: boolean }
    >();
    const categories: Array<{
      name: string;
      group: string;
      is_income: boolean;
    }> = [];

    for (const g of groups) {
      for (const c of g.categories ?? []) {
        categoryById.set(c.id, {
          name: c.name,
          groupName: g.name,
          is_income: Boolean(g.is_income),
        });
        categories.push({
          name: c.name,
          group: g.name,
          is_income: Boolean(g.is_income),
        });
      }
    }
    logger.log(
      `→ ${categories.length} categories across ${groups.length} groups.`,
    );

    // ── Transactions ───────────────────────────────────────────────────────
    const accounts = await api.getAccounts();
    const active = accounts.filter((a: any) => !a.offbudget && !a.closed);
    logger.log(
      `→ Fetching transactions from ${active.length} accounts (${START} → ${END})...`,
    );

    type Row = {
      payee: string;
      amount: number;
      date: string;
      notes?: string;
      expectedCategory: string;
    };
    const transactions: Row[] = [];
    let labeled = 0;

    for (const account of active) {
      const txs = await api.getTransactions(account.id, START, END);

      for (const tx of txs) {
        if (tx.transfer_id || tx.is_parent || (tx as any)._deleted) continue;

        const payee = String(
          (tx as any).imported_payee ??
            (tx as any).payee_name ??
            tx.payee ??
            '(unknown)',
        );

        // Auto-fill expectedCategory from the existing category in your budget
        const cat = tx.category ? categoryById.get(tx.category) : null;
        const expectedCategory = cat?.name ?? '';
        if (expectedCategory) labeled++;

        const row: Row = {
          payee,
          amount: tx.amount,
          date: tx.date,
          expectedCategory,
        };
        if (tx.notes?.trim()) row.notes = tx.notes.trim();
        transactions.push(row);
      }
    }

    transactions.sort((a, b) => a.date.localeCompare(b.date));

    const unlabeled = transactions.length - labeled;
    logger.log(
      `→ ${transactions.length} transactions — ${labeled} auto-labeled, ${unlabeled} uncategorized (will be skipped in eval).`,
    );

    // ── Write fixture ──────────────────────────────────────────────────────
    const out = path.resolve(__dirname, '../eval-fixture.ts');
    fs.writeFileSync(out, renderFixture(categories, transactions), 'utf8');

    logger.log(`\n✓ Written → ${out}`);
    logger.log(`\nRun the eval:`);
    logger.log(`  ANTHROPIC_API_KEY=sk-ant-... yarn eval:ai-categorization`);
  } finally {
    await api.shutdown();
  }
}

// ─── Template ─────────────────────────────────────────────────────────────────

function renderFixture(
  categories: Array<{ name: string; group: string; is_income: boolean }>,
  transactions: Array<{
    payee: string;
    amount: number;
    date: string;
    notes?: string;
    expectedCategory: string;
  }>,
): string {
  const q = JSON.stringify.bind(JSON);

  const catLines = categories
    .map(
      c =>
        `  { name: ${q(c.name)}, group: ${q(c.group)}, is_income: ${c.is_income} },`,
    )
    .join('\n');

  const txLines = transactions
    .map(tx => {
      const parts = [
        `payee: ${q(tx.payee)}`,
        `amount: ${tx.amount}`,
        `date: ${q(tx.date)}`,
      ];
      if (tx.notes) parts.push(`notes: ${q(tx.notes)}`);
      parts.push(`expectedCategory: ${q(tx.expectedCategory)}`);
      return `  { ${parts.join(', ')} },`;
    })
    .join('\n');

  return `// AUTO-GENERATED by scripts/setup-eval.ts — re-run to refresh.
// expectedCategory is auto-filled from your existing budget categories.

export type LabeledTransaction = {
  payee: string;
  amount: number;       // integer cents — negative = expense
  date: string;         // YYYY-MM-DD
  notes?: string;
  expectedCategory: string;  // '' = uncategorized (excluded from accuracy score)
};

export type EvalCategory = { name: string; group: string; is_income: boolean };
export type EvalFixture = { categories: EvalCategory[]; transactions: LabeledTransaction[] };

export const fixture: EvalFixture = {
  categories: [
${catLines}
  ],

  transactions: [
${txLines}
  ],
};
`;
}

main().catch(err => {
  logger.error(err?.message ?? err);
  process.exit(1);
});
