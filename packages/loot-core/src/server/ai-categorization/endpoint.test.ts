// @ts-strict-ignore
/**
 * Endpoint-level tests for AI categorization.
 * Calls through app.handlers['ai-categorize-transactions'] — the same path the client uses.
 *
 * Two modes:
 *   1. LIVE (ANTHROPIC_API_KEY set) — calls the real sync server proxy at
 *      localhost:5006, no mocking of the Anthropic call.
 *
 *   2. MOCK (no env var) — curated mock responses for CI.
 *
 * Run LIVE:
 *   ANTHROPIC_API_KEY=sk-ant-... yarn workspace @actual-app/core exec \
 *     npx vitest run src/server/ai-categorization/endpoint.test.ts --reporter=verbose
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch } from '../../platform/server/fetch';
import * as db from '../db';
import { loadMappings } from '../db/mappings';

import { app } from './app';

vi.mock('../../platform/server/fetch');

const handler = app.handlers['ai-categorize-transactions'];
const LIVE = !!process.env.ANTHROPIC_API_KEY;

// ─── DB setup ─────────────────────────────────────────────────────────────────

async function setupBudget() {
  const foodGroup = await db.insertCategoryGroup({
    name: 'Food & Dining',
    is_income: 0,
  });
  const billsGroup = await db.insertCategoryGroup({
    name: 'Bills',
    is_income: 0,
  });
  const funGroup = await db.insertCategoryGroup({
    name: 'Entertainment',
    is_income: 0,
  });
  const incomeGroup = await db.insertCategoryGroup({
    name: 'Income',
    is_income: 1,
  });

  const groceries = await db.insertCategory({
    name: 'Groceries',
    cat_group: foodGroup,
  });
  const restaurants = await db.insertCategory({
    name: 'Restaurants',
    cat_group: foodGroup,
  });
  const electricity = await db.insertCategory({
    name: 'Electricity',
    cat_group: billsGroup,
  });
  const streaming = await db.insertCategory({
    name: 'Streaming',
    cat_group: funGroup,
  });
  const salary = await db.insertCategory({
    name: 'Salary',
    cat_group: incomeGroup,
  });

  const account = await db.insertAccount({ name: 'Checking', offbudget: 0 });
  const walmartPayee = await db.insertPayee({ name: 'Walmart' });
  const netflixPayee = await db.insertPayee({ name: 'Netflix' });
  const pgePayee = await db.insertPayee({ name: 'PG&E' });
  const mcdsPayee = await db.insertPayee({ name: "McDonald's" });
  const acmePayee = await db.insertPayee({ name: 'ACME Corp' });

  const txWalmart = await db.insertTransaction({
    account,
    date: '2024-01-05',
    payee: walmartPayee,
    amount: -8542,
    notes: 'weekly shop',
    category: null,
  });
  const txNetflix = await db.insertTransaction({
    account,
    date: '2024-01-08',
    payee: netflixPayee,
    amount: -1599,
    notes: 'subscription',
    category: null,
  });
  const txPge = await db.insertTransaction({
    account,
    date: '2024-01-12',
    payee: pgePayee,
    amount: -9800,
    notes: 'electric bill',
    category: null,
  });
  const txMcd = await db.insertTransaction({
    account,
    date: '2024-01-14',
    payee: mcdsPayee,
    amount: -1234,
    notes: 'lunch',
    category: null,
  });
  const txSalary = await db.insertTransaction({
    account,
    date: '2024-01-15',
    payee: acmePayee,
    amount: 500000,
    notes: 'January salary',
    category: null,
  });

  return {
    categories: { groceries, restaurants, electricity, streaming, salary },
    transactions: { txWalmart, txNetflix, txPge, txMcd, txSalary },
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

function mockFetch(
  assignments: Array<{
    id: string;
    category: string | null;
    confidence: number;
    reason: string;
  }> | null,
) {
  vi.mocked(fetch).mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/secret/anthropic_api_key')) {
      return { ok: true, json: async () => ({ value: 'sk-ant-test' }) } as any;
    }
    if (typeof url === 'string' && url.includes('/ai/anthropic')) {
      if (assignments === null) {
        return { ok: false, status: 500 } as any;
      }
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

// ─── Tests ───────────────────────────────────────────────────────────────────

const TEST_TIMEOUT = LIVE ? 30_000 : 5_000;

beforeEach(async () => {
  vi.resetAllMocks();
  await global.emptyDatabase()();
  await loadMappings();
  vi.mocked(asyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'user-token') return 'test-token';
    return null;
  });
});

describe(`ai-categorize-transactions handler — endpoint (${LIVE ? 'LIVE API' : 'mock'})`, () => {
  it('handler is registered on the app', () => {
    expect(typeof handler).toBe('function');
  });

  it(
    'categorizes transactions and returns structured result',
    async () => {
      const { categories, transactions } = await setupBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        mockFetch([
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
            reason: 'streaming service',
          },
          {
            id: transactions.txPge,
            category: 'Electricity',
            confidence: 0.96,
            reason: 'electric utility',
          },
          {
            id: transactions.txMcd,
            category: 'Restaurants',
            confidence: 0.92,
            reason: 'fast food',
          },
          {
            id: transactions.txSalary,
            category: 'Salary',
            confidence: 0.99,
            reason: 'payroll deposit',
          },
        ]);
      }

      const result = await handler({
        transactionIds: Object.values(transactions) as string[],
      });

      expect(result.error).toBeUndefined();
      expect(result.categorized).toBe(5);
      expect(result.skipped).toBe(0);
      expect(result.ambiguous).toHaveLength(0);
      expect(result.results).toHaveLength(5);

      const walmart = await db.getTransaction(transactions.txWalmart);
      expect(walmart?.category).toBe(categories.groceries);

      const netflix = await db.getTransaction(transactions.txNetflix);
      expect(netflix?.category).toBe(categories.streaming);

      const salary = await db.getTransaction(transactions.txSalary);
      expect(salary?.category).toBe(categories.salary);
    },
    TEST_TIMEOUT,
  );

  it(
    'result includes payee, category_name, reason, and confidence per entry',
    async () => {
      const { transactions } = await setupBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        mockFetch([
          {
            id: transactions.txWalmart,
            category: 'Groceries',
            confidence: 0.95,
            reason: 'grocery store',
          },
        ]);
      }

      const result = await handler({
        transactionIds: [transactions.txWalmart],
      });

      expect(result.results.length).toBeGreaterThanOrEqual(1);
      const entry = result.results.find(r => r.id === transactions.txWalmart);
      expect(entry).toBeDefined();
      expect(entry?.category_name).toBeTruthy();
      expect(entry?.confidence).toBeGreaterThan(0);
      expect(entry?.reason).toBeTruthy();
      expect(entry?.category_id).toBeTruthy();
      expect(entry?.payee).toBeTruthy();
    },
    TEST_TIMEOUT,
  );

  it('returns error: missing-api-key when no token is set', async () => {
    const { transactions } = await setupBudget();
    vi.mocked(asyncStorage.getItem).mockResolvedValue(null);
    mockFetch([]);

    const result = await handler({ transactionIds: [transactions.txWalmart] });
    expect(result.error).toBe('missing-api-key');
    expect(result.categorized).toBe(0);
  });

  it('returns error: no-categories when budget has no categories', async () => {
    const account = await db.insertAccount({ name: 'Checking', offbudget: 0 });
    const payee = await db.insertPayee({ name: 'Walmart' });
    const tx = await db.insertTransaction({
      account,
      date: '2024-01-01',
      payee,
      amount: -1000,
      notes: '',
      category: null,
    });
    mockFetch([]);

    const result = await handler({ transactionIds: [tx] });
    expect(result.error).toBe('no-categories');
    expect(result.categorized).toBe(0);
  });

  it(
    'ambiguous transactions are not written to DB',
    async () => {
      const { transactions } = await setupBudget();

      if (LIVE) {
        setupLiveFetch();
        const result = await handler({
          transactionIds: [transactions.txWalmart, transactions.txNetflix],
        });
        for (const a of result.ambiguous) {
          const tx = await db.getTransaction(a.id);
          expect(tx?.category).toBeNull();
        }
      } else {
        mockFetch([
          {
            id: transactions.txWalmart,
            category: 'Groceries',
            confidence: 0.95,
            reason: 'grocery',
          },
          {
            id: transactions.txNetflix,
            category: null,
            confidence: 0.4,
            reason: 'unclear',
          },
        ]);
        const result = await handler({
          transactionIds: [transactions.txWalmart, transactions.txNetflix],
        });
        expect(result.categorized).toBe(1);
        expect(result.ambiguous).toHaveLength(1);
        expect(result.ambiguous[0].id).toBe(transactions.txNetflix);
        const netflix = await db.getTransaction(transactions.txNetflix);
        expect(netflix?.category).toBeNull();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'skips transactions that are already categorized',
    async () => {
      const { categories, transactions } = await setupBudget();
      const txWalmart = await db.getTransaction(transactions.txWalmart);
      await db.updateTransaction({
        ...txWalmart,
        category: categories.groceries,
      });

      if (LIVE) {
        setupLiveFetch();
      } else {
        mockFetch([
          {
            id: transactions.txNetflix,
            category: 'Streaming',
            confidence: 0.98,
            reason: 'streaming',
          },
        ]);
      }

      const result = await handler({
        transactionIds: [transactions.txWalmart, transactions.txNetflix],
      });

      expect(result.categorized).toBeGreaterThanOrEqual(1);
      const walmart = await db.getTransaction(transactions.txWalmart);
      expect(walmart?.category).toBe(categories.groceries); // unchanged
    },
    TEST_TIMEOUT,
  );

  it('handles Claude API failure gracefully without throwing', async () => {
    const { transactions } = await setupBudget();
    mockFetch(null);

    const result = await handler({ transactionIds: [transactions.txWalmart] });
    expect(result.error).toBeUndefined();
    expect(result.categorized).toBe(0);

    const walmart = await db.getTransaction(transactions.txWalmart);
    expect(walmart?.category).toBeNull();
  });

  it(
    'result entries match what was actually written to DB',
    async () => {
      const { transactions } = await setupBudget();

      if (LIVE) {
        setupLiveFetch();
      } else {
        mockFetch([
          {
            id: transactions.txWalmart,
            category: 'Groceries',
            confidence: 0.95,
            reason: 'grocery',
          },
          {
            id: transactions.txNetflix,
            category: 'Streaming',
            confidence: 0.98,
            reason: 'streaming',
          },
        ]);
      }

      const result = await handler({
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
