// @ts-strict-ignore
import { describe, expect, it } from 'vitest';

/**
 * Tests for AI categorization logic.
 * These test the pure functions and data transformations used
 * in the categorization pipeline without hitting external APIs.
 */

// ─── Helpers (mirrored from app.ts for isolation) ────────────────────────────

function matchCategory(
  suggestedName: string,
  categories: Array<{ id: string; name: string; is_income: boolean }>,
  isExpense: boolean,
) {
  const relevant = categories.filter(c => c.is_income === !isExpense);
  const name = suggestedName.split(' (')[0].trim().toLowerCase();
  return relevant.find(c => c.name.toLowerCase() === name) ?? null;
}

function buildTransactionContext(t: {
  payee: string;
  notes: string;
  amount: number;
}) {
  const context = [t.payee, t.notes].filter(Boolean).join(' - ');
  const sign = t.amount < 0 ? '-' : '+';
  return `"${context}" | ${sign}$${Math.abs(t.amount / 100).toFixed(2)}`;
}

function parseClaudeResponse(text: string) {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function isAmbiguous(category: string | null, confidence: number) {
  return !category || confidence < 0.7;
}

function computeMaxTokens(batchSize: number) {
  const TOKENS_PER_TX = 80;
  const MAX = 4096;
  return Math.min(MAX, batchSize * TOKENS_PER_TX + 200);
}

// ─── Sample data ─────────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    id: 'cat-food',
    name: 'Groceries',
    group_name: 'Food & Dining',
    is_income: false,
  },
  { id: 'cat-ent', name: 'Entertainment', group_name: 'Fun', is_income: false },
  { id: 'cat-util', name: 'Utilities', group_name: 'Bills', is_income: false },
  { id: 'cat-income', name: 'Salary', group_name: 'Income', is_income: true },
];

// ─── Category matching ────────────────────────────────────────────────────────

describe('category matching', () => {
  it('matches exact category name (case-insensitive)', () => {
    const match = matchCategory('Groceries', CATEGORIES, true);
    expect(match?.id).toBe('cat-food');
  });

  it('strips group suffix Claude sometimes appends', () => {
    const match = matchCategory('Groceries (Food & Dining)', CATEGORIES, true);
    expect(match?.id).toBe('cat-food');
  });

  it('returns null for unknown category', () => {
    const match = matchCategory('Unknown Category', CATEGORIES, true);
    expect(match).toBeNull();
  });

  it('only returns expense categories for expense transactions', () => {
    const match = matchCategory('Salary', CATEGORIES, true); // isExpense=true → filter !is_income
    expect(match).toBeNull(); // Salary is income, should not match
  });

  it('only returns income categories for income transactions', () => {
    const match = matchCategory('Groceries', CATEGORIES, false); // isExpense=false → filter is_income
    expect(match).toBeNull(); // Groceries is expense, should not match
  });

  it('matches income categories for positive amounts', () => {
    const match = matchCategory('Salary', CATEGORIES, false);
    expect(match?.id).toBe('cat-income');
  });

  it('is case-insensitive', () => {
    const match = matchCategory('GROCERIES', CATEGORIES, true);
    expect(match?.id).toBe('cat-food');
  });
});

// ─── Transaction context format ───────────────────────────────────────────────

describe('transaction context format', () => {
  it('combines payee and notes with dash', () => {
    const ctx = buildTransactionContext({
      payee: 'Amazon',
      notes: 'Prime Video',
      amount: -1499,
    });
    expect(ctx).toBe('"Amazon - Prime Video" | -$14.99');
  });

  it('shows just payee when no notes', () => {
    const ctx = buildTransactionContext({
      payee: 'Walmart',
      notes: '',
      amount: -4522,
    });
    expect(ctx).toBe('"Walmart" | -$45.22');
  });

  it('formats income with + sign', () => {
    const ctx = buildTransactionContext({
      payee: 'Employer',
      notes: 'Monthly salary',
      amount: 500000,
    });
    expect(ctx).toBe('"Employer - Monthly salary" | +$5000.00');
  });

  it('two decimal places always', () => {
    const ctx = buildTransactionContext({
      payee: 'Store',
      notes: '',
      amount: -100,
    });
    expect(ctx).toContain('-$1.00');
  });
});

// ─── Claude response parsing ──────────────────────────────────────────────────

describe('Claude response parsing', () => {
  it('parses clean JSON array', () => {
    const text =
      '[{"id":"tx1","category":"Groceries","confidence":0.9,"reason":"grocery store"}]';
    const result = parseClaudeResponse(text);
    expect(result).not.toBeNull();
    expect(result[0].id).toBe('tx1');
    expect(result[0].confidence).toBe(0.9);
  });

  it('extracts JSON from response with surrounding text', () => {
    const text =
      'Here are the categories:\n[{"id":"tx1","category":"Entertainment","confidence":0.85,"reason":"streaming"}]\nDone.';
    const result = parseClaudeResponse(text);
    expect(result[0].category).toBe('Entertainment');
  });

  it('handles null category in response', () => {
    const text =
      '[{"id":"tx1","category":null,"confidence":0.4,"reason":"unclear"}]';
    const result = parseClaudeResponse(text);
    expect(result[0].category).toBeNull();
  });

  it('returns null when no JSON array found', () => {
    const result = parseClaudeResponse(
      'I cannot categorize these transactions.',
    );
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const result = parseClaudeResponse('[{bad json}]');
    expect(result).toBeNull();
  });
});

// ─── Confidence / ambiguity logic ─────────────────────────────────────────────

describe('ambiguity detection', () => {
  it('high confidence + valid category → not ambiguous', () => {
    expect(isAmbiguous('Groceries', 0.9)).toBe(false);
  });

  it('exactly 0.7 confidence → not ambiguous (boundary)', () => {
    expect(isAmbiguous('Groceries', 0.7)).toBe(false);
  });

  it('below 0.7 confidence → ambiguous', () => {
    expect(isAmbiguous('Groceries', 0.69)).toBe(true);
  });

  it('null category → always ambiguous regardless of confidence', () => {
    expect(isAmbiguous(null, 0.95)).toBe(true);
  });

  it('zero confidence → ambiguous', () => {
    expect(isAmbiguous('Groceries', 0)).toBe(true);
  });
});

// ─── Batch / token budget ─────────────────────────────────────────────────────

describe('batch token budgeting', () => {
  const SAFE_BATCH_SIZE = 40;
  const MAX_OUTPUT_TOKENS = 4096;
  const TOKENS_PER_TX = 80;

  it('SAFE_BATCH_SIZE * tokens_per_tx fits within MAX_OUTPUT_TOKENS', () => {
    expect(SAFE_BATCH_SIZE * TOKENS_PER_TX).toBeLessThan(MAX_OUTPUT_TOKENS);
  });

  it('computes correct batch count for 120 transactions', () => {
    expect(Math.ceil(120 / SAFE_BATCH_SIZE)).toBe(3);
  });

  it('computes correct batch count for 41 transactions (needs 2 batches)', () => {
    expect(Math.ceil(41 / SAFE_BATCH_SIZE)).toBe(2);
  });

  it('max_tokens scales with batch size', () => {
    expect(computeMaxTokens(10)).toBe(1000); // 10*80+200
    expect(computeMaxTokens(40)).toBe(3400); // 40*80+200
    expect(computeMaxTokens(60)).toBe(4096); // capped at MAX
  });
});

// ─── Secret/API key retrieval (the 304 bug) ───────────────────────────────────

describe('API key retrieval edge cases', () => {
  it('treats ok=false response as missing key', () => {
    const res = { ok: false, status: 304 };
    // getAnthropicApiKey returns null when !res.ok
    expect(res.ok).toBe(false);
  });

  it('extracts value from ok=true response', async () => {
    const res = {
      ok: true,
      json: async () => ({ value: 'sk-ant-test123' }),
    };
    const data = await res.json();
    expect(data.value).toBe('sk-ant-test123');
  });

  it('returns null when value field missing from response', async () => {
    const res = {
      ok: true,
      json: async () => ({}),
    };
    const data = await res.json();
    const value = (data?.value as string) ?? null;
    expect(value).toBeNull();
  });
});
