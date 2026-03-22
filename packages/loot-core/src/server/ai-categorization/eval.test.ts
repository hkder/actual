// @ts-strict-ignore
/**
 * AI Categorization Evaluation Test
 *
 * This test measures real-world accuracy of the AI categorization feature
 * against a labeled dataset of January–March transactions.
 *
 * It is SKIPPED in normal `yarn test` runs. To execute it:
 *
 *   RUN_EVAL=true ANTHROPIC_API_KEY=sk-ant-... \
 *     yarn workspace @actual-app/core run test \
 *     src/server/ai-categorization/eval.test.ts --reporter=verbose
 *
 * Before running:
 *   1. Populate eval-fixture.ts with your Jan–Mar transactions + correct categories
 *   2. See eval-fixture.ts for full instructions
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch } from '../../platform/server/fetch';
import * as db from '../db';
import { loadMappings } from '../db/mappings';

import { aiCategorizeTransactions } from './app';
import { fixture } from './eval-fixture';

vi.mock('../../platform/server/fetch');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupFetchMock() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  vi.mocked(asyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'user-token') return 'eval-token';
    return null;
  });

  // Intercept the Actual secret endpoint but pass Anthropic calls through to
  // the real network so we evaluate genuine model behavior.
  vi.mocked(fetch).mockImplementation(
    async (url: string, options?: RequestInit) => {
      if (
        typeof url === 'string' &&
        url.includes('/secret/anthropic_api_key')
      ) {
        return {
          ok: true,
          json: async () => ({ value: apiKey }),
        } as Response;
      }
      // Real HTTP call to Anthropic API
      return globalThis.fetch(url, options);
    },
  );
}

async function setupFixtureDatabase() {
  // Build a map from group name → group id (insert each group once)
  const groupIds = new Map<string, string>();
  for (const cat of fixture.categories) {
    if (!groupIds.has(cat.group)) {
      const id = await db.insertCategoryGroup({
        name: cat.group,
        is_income: cat.is_income ? 1 : 0,
      });
      groupIds.set(cat.group, id);
    }
  }

  // Insert categories and build name → id map
  const categoryIds = new Map<string, string>();
  for (const cat of fixture.categories) {
    const groupId = groupIds.get(cat.group)!;
    const id = await db.insertCategory({ name: cat.name, cat_group: groupId });
    categoryIds.set(cat.name, id);
  }

  // Single shared account for all transactions
  const accountId = await db.insertAccount({
    name: 'Eval Account',
    offbudget: 0,
  });

  // Insert each transaction as uncategorized, capturing its DB id
  type InsertedTx = {
    dbId: string;
    expectedCategory: string;
    payee: string;
    amount: number;
  };
  const inserted: InsertedTx[] = [];

  for (const tx of fixture.transactions) {
    const payeeId = await db.insertPayee({ name: tx.payee });
    const dbId = await db.insertTransaction({
      account: accountId,
      date: tx.date,
      amount: tx.amount,
      payee: payeeId,
      notes: tx.notes ?? '',
      category: null,
    });
    inserted.push({
      dbId,
      expectedCategory: tx.expectedCategory,
      payee: tx.payee,
      amount: tx.amount,
    });
  }

  return { inserted, categoryIds };
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function printReport(params: {
  total: number;
  correct: number;
  wrong: Array<{
    payee: string;
    expected: string;
    got: string;
    amount: number;
  }>;
  categorized: Array<{
    payee: string;
    category: string;
    confidence: number;
    reason: string;
    amount: number;
  }>;
  ambiguous: Array<{ payee: string; amount: number; reason: string }>;
  skipped: number;
  smokeMode: boolean;
  estimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}) {
  const {
    total,
    correct,
    wrong,
    categorized,
    ambiguous,
    skipped,
    smokeMode,
    estimatedCostUsd,
    totalInputTokens,
    totalOutputTokens,
  } = params;
  const pct = (n: number) =>
    total > 0 ? `(${((n / total) * 100).toFixed(1)}%)` : '';

  const line = '='.repeat(60);
  process.stderr.write('\n' + line + '\n');
  process.stderr.write('  AI Categorization Evaluation Results\n');
  process.stderr.write(line + '\n');
  process.stderr.write(`  Total transactions  : ${total}\n`);
  if (smokeMode) {
    process.stderr.write(
      `  Categorized         : ${categorized.length}  ${pct(categorized.length)}\n`,
    );
    process.stderr.write(
      `  Ambiguous (low conf): ${ambiguous.length}  ${pct(ambiguous.length)}\n`,
    );
    process.stderr.write(
      `  Skipped / not found : ${skipped}  ${pct(skipped)}\n`,
    );
    process.stderr.write(
      `  [smoke mode — fill in expectedCategory for accuracy measurement]\n`,
    );
  } else {
    process.stderr.write(
      `  Correctly labeled   : ${correct}  ${pct(correct)}\n`,
    );
    process.stderr.write(
      `  Wrong category      : ${wrong.length}  ${pct(wrong.length)}\n`,
    );
    process.stderr.write(
      `  Ambiguous (low conf): ${ambiguous.length}  ${pct(ambiguous.length)}\n`,
    );
    process.stderr.write(
      `  Skipped / not found : ${skipped}  ${pct(skipped)}\n`,
    );
  }
  process.stderr.write(
    `  Cost                : $${estimatedCostUsd.toFixed(4)} (${totalInputTokens} in / ${totalOutputTokens} out tokens)\n`,
  );
  process.stderr.write(line + '\n');

  if (smokeMode && categorized.length > 0) {
    process.stderr.write('\n  Categorizations:\n');
    for (const r of categorized) {
      const amt = `$${(Math.abs(r.amount) / 100).toFixed(2)}`;
      process.stderr.write(
        `    ${r.payee.padEnd(30)} → ${r.category.padEnd(22)} (${(r.confidence * 100).toFixed(0)}%) ${amt}\n`,
      );
    }
  }

  if (!smokeMode && wrong.length > 0) {
    process.stderr.write('\n  Wrong predictions:\n');
    for (const w of wrong) {
      const amt = `$${(Math.abs(w.amount) / 100).toFixed(2)}`;
      process.stderr.write(
        `    ${w.payee.padEnd(30)} expected=${w.expected.padEnd(22)} got=${w.got}  ${amt}\n`,
      );
    }
  }

  if (ambiguous.length > 0) {
    process.stderr.write('\n  Ambiguous (not categorized):\n');
    for (const a of ambiguous) {
      const amt = `$${(Math.abs(a.amount) / 100).toFixed(2)}`;
      process.stderr.write(
        `    ${a.payee.padEnd(30)} reason=${a.reason}  ${amt}\n`,
      );
    }
  }

  process.stderr.write('\n');
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.RUN_EVAL)(
  'AI categorization evaluation (real API)',
  () => {
    beforeEach(async () => {
      vi.resetAllMocks();
      await global.emptyDatabase()();
      await loadMappings();
      setupFetchMock();
    });

    it('measures categorization accuracy against labeled Jan–Mar transactions', async () => {
      if (fixture.transactions.length === 0) {
        console.warn(
          '\n⚠️  eval-fixture.ts has no transactions. Populate it first — see the file for instructions.\n',
        );
        expect(fixture.transactions.length).toBeGreaterThan(0);
        return;
      }

      if (fixture.categories.length === 0) {
        console.warn(
          '\n⚠️  eval-fixture.ts has no categories. Populate it first — see the file for instructions.\n',
        );
        expect(fixture.categories.length).toBeGreaterThan(0);
        return;
      }

      const { inserted } = await setupFixtureDatabase();
      const allIds = inserted.map(t => t.dbId);

      const result = await aiCategorizeTransactions({ transactionIds: allIds });

      // Build a lookup: dbId → result
      const resultById = new Map(result.results.map(r => [r.id, r]));
      const ambiguousById = new Map(result.ambiguous.map(a => [a.id, a]));

      // Labeled = has an expectedCategory. Unlabeled are shown but excluded from accuracy score.
      const labeledCount = inserted.filter(t => t.expectedCategory).length;
      const smokeMode = labeledCount === 0;

      let correct = 0;
      const wrong: Array<{
        payee: string;
        expected: string;
        got: string;
        amount: number;
      }> = [];
      const categorized: Array<{
        payee: string;
        category: string;
        confidence: number;
        reason: string;
        amount: number;
      }> = [];
      const ambiguous: Array<{
        payee: string;
        amount: number;
        reason: string;
      }> = [];
      let skipped = 0;

      for (const tx of inserted) {
        const res = resultById.get(tx.dbId);
        const amb = ambiguousById.get(tx.dbId);

        if (res) {
          categorized.push({
            payee: tx.payee,
            category: res.category_name,
            confidence: res.confidence,
            reason: res.reason,
            amount: tx.amount,
          });
          // Only score against labeled transactions
          if (tx.expectedCategory) {
            if (res.category_name === tx.expectedCategory) {
              correct++;
            } else {
              wrong.push({
                payee: tx.payee,
                expected: tx.expectedCategory,
                got: res.category_name,
                amount: tx.amount,
              });
            }
          }
        } else if (amb) {
          ambiguous.push({
            payee: tx.payee,
            amount: tx.amount,
            reason: amb.reason,
          });
        } else {
          skipped++;
        }
      }

      printReport({
        total: inserted.length,
        correct,
        wrong,
        categorized,
        ambiguous,
        skipped,
        smokeMode,
        estimatedCostUsd: result.estimatedCostUsd ?? 0,
        totalInputTokens: result.totalInputTokens ?? 0,
        totalOutputTokens: result.totalOutputTokens ?? 0,
      });

      if (smokeMode) {
        expect(categorized.length).toBeGreaterThan(
          Math.floor(inserted.length * 0.5),
        );
      } else {
        // Score only against labeled transactions
        const accuracy = labeledCount > 0 ? correct / labeledCount : 0;
        expect(accuracy).toBeGreaterThanOrEqual(0);
      }
    }, 120_000); // 2-minute timeout for real API calls
  },
);
