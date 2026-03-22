// @ts-strict-ignore
/**
 * Realistic Jan–March budget data test for AI categorization.
 *
 * Two modes:
 *   1. LIVE (ANTHROPIC_API_KEY env var set) — calls real Claude API.
 *      Run with: ANTHROPIC_API_KEY=sk-ant-... yarn workspace @actual-app/core exec npx vitest run src/server/ai-categorization/realistic-e2e.test.ts
 *
 *   2. MOCK (no env var) — uses a curated mock response that mirrors what
 *      Claude should return for well-known payees, so the suite runs in CI.
 *
 * The dataset mirrors a realistic household budget:
 *   • 3 months (Jan, Feb, Mar 2024)
 *   • 7 categories across 5 groups
 *   • ~30 transactions: groceries, restaurants, utilities, streaming, gas, salary
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch as platformFetch } from '../../platform/server/fetch';
import * as db from '../db';
import { loadMappings } from '../db/mappings';

import { app } from './app';

vi.mock('../../platform/server/fetch');

const handler = app.handlers['ai-categorize-transactions'];
const LIVE = !!process.env.RUN_EVAL && !!process.env.ANTHROPIC_API_KEY;

// ─── Category / payee definitions ────────────────────────────────────────────

const CATEGORY_GROUPS = [
  { name: 'Food & Dining', is_income: 0 as const },
  { name: 'Bills & Utilities', is_income: 0 as const },
  { name: 'Entertainment', is_income: 0 as const },
  { name: 'Transport', is_income: 0 as const },
  { name: 'Income', is_income: 1 as const },
];

const CATEGORIES = [
  { name: 'Groceries', group: 'Food & Dining' },
  { name: 'Restaurants', group: 'Food & Dining' },
  { name: 'Electricity', group: 'Bills & Utilities' },
  { name: 'Internet', group: 'Bills & Utilities' },
  { name: 'Streaming', group: 'Entertainment' },
  { name: 'Gas', group: 'Transport' },
  { name: 'Salary', group: 'Income' },
];

// Transactions: [date, payee, amount (cents, negative=expense), notes, expectedCategory]
const TRANSACTIONS: [string, string, number, string, string][] = [
  // January
  ['2024-01-03', 'Walmart', -9412, 'weekly groceries', 'Groceries'],
  ['2024-01-05', "McDonald's", -1234, 'lunch', 'Restaurants'],
  ['2024-01-08', 'Netflix', -1599, 'monthly streaming', 'Streaming'],
  ['2024-01-10', 'PG&E', -11200, 'electric bill', 'Electricity'],
  ['2024-01-12', 'Shell Gas Station', -6200, 'fuel', 'Gas'],
  ['2024-01-14', 'Whole Foods', -7830, 'organic groceries', 'Groceries'],
  ['2024-01-15', 'ACME Corp', 500000, 'January salary', 'Salary'],
  ['2024-01-18', 'Comcast', -7999, 'internet service', 'Internet'],
  ['2024-01-20', 'Chipotle', -1875, 'dinner', 'Restaurants'],
  ['2024-01-22', 'Spotify', -999, 'music subscription', 'Streaming'],
  ['2024-01-25', 'Costco', -14350, 'bulk groceries', 'Groceries'],
  ['2024-01-28', 'Chevron', -5800, 'gas station', 'Gas'],

  // February
  ['2024-02-01', "Trader Joe's", -8100, 'groceries', 'Groceries'],
  ['2024-02-04', 'Starbucks', -875, 'morning coffee', 'Restaurants'],
  ['2024-02-08', 'Netflix', -1599, 'monthly streaming', 'Streaming'],
  ['2024-02-10', 'PG&E', -9800, 'electric bill', 'Electricity'],
  ['2024-02-12', 'Shell Gas Station', -5400, 'fuel', 'Gas'],
  ['2024-02-14', 'Olive Garden', -4250, 'valentines dinner', 'Restaurants'],
  ['2024-02-15', 'ACME Corp', 500000, 'February salary', 'Salary'],
  ['2024-02-18', 'Comcast', -7999, 'internet service', 'Internet'],
  ['2024-02-22', 'Walmart', -8650, 'weekly groceries', 'Groceries'],
  ['2024-02-25', 'Hulu', -1799, 'streaming bundle', 'Streaming'],

  // March
  ['2024-03-01', 'Whole Foods', -9200, 'groceries', 'Groceries'],
  ['2024-03-05', 'Chipotle', -2100, 'lunch bowls', 'Restaurants'],
  ['2024-03-08', 'Netflix', -1599, 'monthly streaming', 'Streaming'],
  ['2024-03-10', 'PG&E', -10500, 'electric bill', 'Electricity'],
  ['2024-03-12', 'BP Gas', -7300, 'fuel fill-up', 'Gas'],
  ['2024-03-15', 'ACME Corp', 500000, 'March salary', 'Salary'],
  ['2024-03-18', 'Comcast', -7999, 'internet service', 'Internet'],
  ['2024-03-22', "Trader Joe's", -7650, 'weekly groceries', 'Groceries'],
];

// ─── DB setup ─────────────────────────────────────────────────────────────────

async function setupRealisticBudget() {
  // Groups
  const groupIds: Record<string, string> = {};
  for (const g of CATEGORY_GROUPS) {
    groupIds[g.name] = await db.insertCategoryGroup(g);
  }

  // Categories
  const categoryIds: Record<string, string> = {};
  for (const c of CATEGORIES) {
    categoryIds[c.name] = await db.insertCategory({
      name: c.name,
      cat_group: groupIds[c.group],
    });
  }

  // Account
  const accountId = await db.insertAccount({ name: 'Checking', offbudget: 0 });

  // Payees (deduplicated)
  const payeeIds: Record<string, string> = {};
  for (const [, payeeName] of TRANSACTIONS) {
    if (!payeeIds[payeeName]) {
      payeeIds[payeeName] = await db.insertPayee({ name: payeeName });
    }
  }

  // Transactions (all uncategorized)
  const txIds: string[] = [];
  for (const [date, payeeName, amount, notes] of TRANSACTIONS) {
    const id = await db.insertTransaction({
      account: accountId,
      date,
      payee: payeeIds[payeeName],
      amount,
      notes,
      category: null,
    });
    txIds.push(id);
  }

  return { categoryIds, txIds, payeeIds };
}

// ─── Mock fetch (used when no real API key) ────────────────────────────────────

function buildMockAssignments(txIds: string[]) {
  return TRANSACTIONS.map(([, , , , expectedCategory], i) => ({
    id: txIds[i],
    category: expectedCategory,
    confidence: 0.95,
    reason: `matched by payee/notes context`,
  }));
}

function setupMockFetch(
  assignments: Array<{
    id: string;
    category: string | null;
    confidence: number;
    reason: string;
  }>,
) {
  vi.mocked(platformFetch).mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/secret/anthropic_api_key')) {
      return { ok: true, json: async () => ({ value: 'sk-ant-mock' }) } as any;
    }
    if (typeof url === 'string' && url.includes('/ai/anthropic')) {
      return {
        ok: true,
        json: async () => ({
          content: [{ text: JSON.stringify(assignments) }],
          usage: { input_tokens: 500, output_tokens: assignments.length * 20 },
        }),
      } as any;
    }
    return { ok: false, status: 500 } as any;
  });
}

function setupLiveFetch() {
  // Only mock the secret endpoint — let the real Anthropic call through via
  // the platform fetch mock by returning the real API key.
  // Since platformFetch is mocked at the vi.mock level, we restore it for
  // Anthropic calls by delegating to the real global fetch.
  const realApiKey = process.env.ANTHROPIC_API_KEY!;
  vi.mocked(platformFetch).mockImplementation(
    async (url: string, options?: any) => {
      if (
        typeof url === 'string' &&
        url.includes('/secret/anthropic_api_key')
      ) {
        return { ok: true, json: async () => ({ value: realApiKey }) } as any;
      }
      // Live mode: pass all other calls (including /ai/anthropic proxy) through to real fetch
      return globalThis.fetch(url, options);
    },
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  await global.emptyDatabase()();
  await loadMappings();
  vi.mocked(asyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'user-token') return 'test-token';
    return null;
  });
});

// Live API calls take ~4-5s each for a batch of 30 transactions
const TEST_TIMEOUT = 30_000;

describe(`AI categorization — realistic Jan–March budget (${LIVE ? 'LIVE API' : 'mock'})`, () => {
  it(
    `categorizes all ${TRANSACTIONS.length} transactions across 3 months`,
    async () => {
      const { categoryIds, txIds } = await setupRealisticBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        setupMockFetch(buildMockAssignments(txIds));
      }

      const result = await handler({ transactionIds: txIds });

      process.stderr.write(
        '\n── Categorization results ──────────────────────────────\n',
      );
      for (const r of result.results) {
        process.stderr.write(
          `  ✓ ${r.payee.padEnd(25)} → ${r.category_name.padEnd(15)} (${(r.confidence * 100).toFixed(0)}%) — ${r.reason}\n`,
        );
      }
      if (result.ambiguous.length > 0) {
        process.stderr.write(
          '\n── Ambiguous ───────────────────────────────────────────\n',
        );
        for (const a of result.ambiguous) {
          process.stderr.write(`  ? ${a.payee.padEnd(25)} — ${a.reason}\n`);
        }
      }
      process.stderr.write(
        `\n  Total: ${result.categorized} categorized, ${result.skipped} skipped, ${result.ambiguous.length} ambiguous\n`,
      );

      // All transactions should be categorized (0 ambiguous in mock mode)
      if (!LIVE) {
        expect(result.categorized).toBe(TRANSACTIONS.length);
        expect(result.ambiguous).toHaveLength(0);
      }

      // At minimum: majority should be categorized
      expect(result.categorized).toBeGreaterThanOrEqual(
        Math.floor(TRANSACTIONS.length * 0.8),
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'each expected category maps to a known category ID in DB',
    async () => {
      const { categoryIds, txIds } = await setupRealisticBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        setupMockFetch(buildMockAssignments(txIds));
      }

      const result = await handler({ transactionIds: txIds });

      // Every result's category_id must be a real category in our DB
      const knownIds = new Set(Object.values(categoryIds));
      for (const r of result.results) {
        expect(knownIds.has(r.category_id)).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'DB reflects the categorizations from the result',
    async () => {
      const { txIds } = await setupRealisticBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        setupMockFetch(buildMockAssignments(txIds));
      }

      const result = await handler({ transactionIds: txIds });

      // Post-write validation: every result entry must be in DB with correct category
      for (const r of result.results) {
        const tx = await db.getTransaction(r.id);
        expect(tx?.category).toBe(r.category_id);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'salary (positive amount) is categorized as income, not expense',
    async () => {
      const { categoryIds, txIds } = await setupRealisticBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        setupMockFetch(buildMockAssignments(txIds));
      }

      const result = await handler({ transactionIds: txIds });

      // Find salary results
      const salaryResults = result.results.filter(
        r => r.category_name === 'Salary',
      );
      expect(salaryResults.length).toBeGreaterThan(0);

      for (const r of salaryResults) {
        expect(r.category_id).toBe(categoryIds['Salary']);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'recurring transactions (same payee each month) get consistent categories',
    async () => {
      const { categoryIds, txIds } = await setupRealisticBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        setupMockFetch(buildMockAssignments(txIds));
      }

      const result = await handler({ transactionIds: txIds });

      // Netflix appears in Jan, Feb, Mar — all should map to Streaming
      const netflixResults = result.results.filter(r => r.payee === 'Netflix');
      expect(netflixResults.length).toBeGreaterThanOrEqual(2);
      const uniqueCategories = new Set(netflixResults.map(r => r.category_id));
      expect(uniqueCategories.size).toBe(1); // consistent
      expect([...uniqueCategories][0]).toBe(categoryIds['Streaming']);
    },
    TEST_TIMEOUT,
  );
});
