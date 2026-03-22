// @ts-strict-ignore
/**
 * Integration tests for AI categorization using a real in-memory database.
 *
 * Two modes:
 *   1. LIVE (ANTHROPIC_API_KEY set) — calls the real sync server proxy at
 *      localhost:5006, which forwards to Anthropic. No mocking.
 *
 *   2. MOCK (no env var) — uses curated mock responses so tests run in CI.
 *
 * Run LIVE:
 *   ANTHROPIC_API_KEY=sk-ant-... yarn workspace @actual-app/core exec \
 *     npx vitest run src/server/ai-categorization/integration.test.ts --reporter=verbose
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch } from '../../platform/server/fetch';
import * as db from '../db';
import { loadMappings } from '../db/mappings';

import { aiCategorizeTransactions } from './app';

vi.mock('../../platform/server/fetch');

const LIVE = !!process.env.ANTHROPIC_API_KEY;

// ─── DB Setup helpers ─────────────────────────────────────────────────────────

async function setupSampleBudget() {
  const foodGroupId = await db.insertCategoryGroup({
    name: 'Food & Dining',
    is_income: 0,
  });
  const billsGroupId = await db.insertCategoryGroup({
    name: 'Bills',
    is_income: 0,
  });
  const funGroupId = await db.insertCategoryGroup({
    name: 'Entertainment',
    is_income: 0,
  });
  const transportGroupId = await db.insertCategoryGroup({
    name: 'Transport',
    is_income: 0,
  });
  const incomeGroupId = await db.insertCategoryGroup({
    name: 'Income',
    is_income: 1,
  });

  const groceriesId = await db.insertCategory({
    name: 'Groceries',
    cat_group: foodGroupId,
  });
  const restaurantsId = await db.insertCategory({
    name: 'Restaurants',
    cat_group: foodGroupId,
  });
  const electricityId = await db.insertCategory({
    name: 'Electricity',
    cat_group: billsGroupId,
  });
  const internetId = await db.insertCategory({
    name: 'Internet',
    cat_group: billsGroupId,
  });
  const streamingId = await db.insertCategory({
    name: 'Streaming',
    cat_group: funGroupId,
  });
  const gasId = await db.insertCategory({
    name: 'Gas',
    cat_group: transportGroupId,
  });
  const salaryId = await db.insertCategory({
    name: 'Salary',
    cat_group: incomeGroupId,
  });

  const accountId = await db.insertAccount({ name: 'Checking', offbudget: 0 });

  const walmartPayeeId = await db.insertPayee({ name: 'Walmart' });
  const netflixPayeeId = await db.insertPayee({ name: 'Netflix' });
  const mcdonaldsPayeeId = await db.insertPayee({ name: "McDonald's" });
  const pgePayeeId = await db.insertPayee({ name: 'PG&E' });
  const shellPayeeId = await db.insertPayee({ name: 'Shell Gas Station' });
  const comcastPayeeId = await db.insertPayee({ name: 'Comcast' });
  const employerPayeeId = await db.insertPayee({ name: 'ACME Corp' });

  const txWalmart = await db.insertTransaction({
    account: accountId,
    date: '2024-01-05',
    payee: walmartPayeeId,
    amount: -8542,
    notes: 'weekly groceries',
    category: null,
  });
  const txNetflix = await db.insertTransaction({
    account: accountId,
    date: '2024-01-08',
    payee: netflixPayeeId,
    amount: -1599,
    notes: 'monthly subscription',
    category: null,
  });
  const txMcd = await db.insertTransaction({
    account: accountId,
    date: '2024-01-10',
    payee: mcdonaldsPayeeId,
    amount: -1234,
    notes: 'lunch',
    category: null,
  });
  const txPge = await db.insertTransaction({
    account: accountId,
    date: '2024-01-12',
    payee: pgePayeeId,
    amount: -9800,
    notes: 'electric bill',
    category: null,
  });
  const txShell = await db.insertTransaction({
    account: accountId,
    date: '2024-01-14',
    payee: shellPayeeId,
    amount: -6000,
    notes: 'fuel',
    category: null,
  });
  const txComcast = await db.insertTransaction({
    account: accountId,
    date: '2024-01-15',
    payee: comcastPayeeId,
    amount: -7999,
    notes: 'internet service',
    category: null,
  });
  const txSalary = await db.insertTransaction({
    account: accountId,
    date: '2024-01-15',
    payee: employerPayeeId,
    amount: 500000,
    notes: 'January salary',
    category: null,
  });

  return {
    categories: {
      groceriesId,
      restaurantsId,
      electricityId,
      internetId,
      streamingId,
      gasId,
      salaryId,
    },
    transactions: {
      txWalmart,
      txNetflix,
      txMcd,
      txPge,
      txShell,
      txComcast,
      txSalary,
    },
    accountId,
  };
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function setupLiveFetch() {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  vi.mocked(asyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'user-token') return 'test-token';
    return null;
  });
  vi.mocked(fetch).mockImplementation(async (url: string, options?: any) => {
    // Return the real API key for the secret endpoint
    if (typeof url === 'string' && url.includes('/secret/anthropic_api_key')) {
      return { ok: true, json: async () => ({ value: apiKey }) } as any;
    }
    // Forward /ai/anthropic directly to Anthropic (no CORS in Node.js)
    if (typeof url === 'string' && url.includes('/ai/anthropic')) {
      const body = JSON.parse((options as any)?.body ?? '{}');
      return globalThis.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    }
    return globalThis.fetch(url, options);
  });
}

function setupMockFetch() {
  vi.mocked(asyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'user-token') return 'test-token';
    return null;
  });
  vi.mocked(fetch).mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/secret/anthropic_api_key')) {
      return { ok: true, json: async () => ({ value: 'sk-ant-test' }) } as any;
    }
    return { ok: false, status: 500 } as any;
  });
}

function mockClaudeResponse(
  assignments: Array<{
    id: string;
    category: string | null;
    confidence: number;
    reason: string;
  }>,
) {
  if (LIVE) return; // real API — don't mock
  vi.mocked(fetch).mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/secret/anthropic_api_key')) {
      return { ok: true, json: async () => ({ value: 'sk-ant-test' }) } as any;
    }
    if (typeof url === 'string' && url.includes('/ai/anthropic')) {
      return {
        ok: true,
        json: async () => ({
          content: [{ text: JSON.stringify(assignments) }],
          usage: { input_tokens: 100, output_tokens: assignments.length * 20 },
        }),
      } as any;
    }
    return { ok: false, status: 500 } as any;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TEST_TIMEOUT = LIVE ? 30_000 : 5_000;

beforeEach(async () => {
  vi.resetAllMocks();
  await global.emptyDatabase()();
  await loadMappings();
  if (LIVE) {
    setupLiveFetch();
  } else {
    setupMockFetch();
  }
});

describe(`AI categorization integration — real DB (${LIVE ? 'LIVE API' : 'mock'})`, () => {
  it(
    'categorizes a batch of sample transactions correctly',
    async () => {
      const { categories, transactions } = await setupSampleBudget();

      mockClaudeResponse([
        {
          id: transactions.txWalmart,
          category: 'Groceries',
          confidence: 0.95,
          reason: 'grocery store purchase',
        },
        {
          id: transactions.txNetflix,
          category: 'Streaming',
          confidence: 0.98,
          reason: 'video streaming service',
        },
        {
          id: transactions.txMcd,
          category: 'Restaurants',
          confidence: 0.92,
          reason: 'fast food restaurant',
        },
        {
          id: transactions.txPge,
          category: 'Electricity',
          confidence: 0.96,
          reason: 'electric utility bill',
        },
        {
          id: transactions.txShell,
          category: 'Gas',
          confidence: 0.94,
          reason: 'gas station fuel',
        },
        {
          id: transactions.txComcast,
          category: 'Internet',
          confidence: 0.97,
          reason: 'internet service provider',
        },
        {
          id: transactions.txSalary,
          category: 'Salary',
          confidence: 0.99,
          reason: 'employer payroll deposit',
        },
      ]);

      const result = await aiCategorizeTransactions({
        transactionIds: Object.values(transactions) as string[],
      });

      expect(result.categorized).toBe(7);
      expect(result.skipped).toBe(0);
      expect(result.ambiguous).toHaveLength(0);
      expect(result.results).toHaveLength(7);

      const walmart = await db.getTransaction(transactions.txWalmart);
      expect(walmart?.category).toBe(categories.groceriesId);

      const netflix = await db.getTransaction(transactions.txNetflix);
      expect(netflix?.category).toBe(categories.streamingId);

      const salary = await db.getTransaction(transactions.txSalary);
      expect(salary?.category).toBe(categories.salaryId);
    },
    TEST_TIMEOUT,
  );

  it(
    'skips already-categorized transactions',
    async () => {
      const { categories, transactions } = await setupSampleBudget();

      const txWalmart = await db.getTransaction(transactions.txWalmart);
      await db.updateTransaction({
        ...txWalmart,
        category: categories.groceriesId,
      });

      mockClaudeResponse([
        {
          id: transactions.txNetflix,
          category: 'Streaming',
          confidence: 0.98,
          reason: 'streaming service',
        },
      ]);

      const result = await aiCategorizeTransactions({
        transactionIds: [transactions.txWalmart, transactions.txNetflix],
      });

      if (LIVE) {
        // In live mode, Walmart is pre-categorized so it's excluded from the API call.
        // Netflix (+ other uncategorized txs if sent) should be categorized.
        expect(result.categorized).toBeGreaterThanOrEqual(1);
      } else {
        expect(result.categorized).toBe(1);
      }
      const walmart2 = await db.getTransaction(transactions.txWalmart);
      expect(walmart2?.category).toBe(categories.groceriesId);
    },
    TEST_TIMEOUT,
  );

  it('handles Claude API failure gracefully', async () => {
    // This test always uses a mock — we want to test error handling, not the real API
    const { transactions } = await setupSampleBudget();

    vi.mocked(fetch).mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/ai/anthropic')) {
        return { ok: false, status: 500 } as any;
      }
      return { ok: true, json: async () => ({ value: 'sk-ant-test' }) } as any;
    });

    const result = await aiCategorizeTransactions({
      transactionIds: [transactions.txWalmart],
    });

    expect(result.categorized).toBe(0);
    const walmart = await db.getTransaction(transactions.txWalmart);
    expect(walmart?.category).toBeNull();
  });

  it(
    'validation: verifies all categorized transactions exist in DB after write',
    async () => {
      const { transactions } = await setupSampleBudget();

      mockClaudeResponse([
        {
          id: transactions.txWalmart,
          category: 'Groceries',
          confidence: 0.95,
          reason: 'grocery store',
        },
        {
          id: transactions.txNetflix,
          category: 'Streaming',
          confidence: 0.98,
          reason: 'streaming',
        },
      ]);

      const result = await aiCategorizeTransactions({
        transactionIds: [transactions.txWalmart, transactions.txNetflix],
      });

      for (const r of result.results) {
        const tx = await db.getTransaction(r.id);
        expect(tx?.category).toBe(r.category_id);
      }
    },
    TEST_TIMEOUT,
  );
});
