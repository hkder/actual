import * as asyncStorage from '../../platform/server/asyncStorage';
import { fetch } from '../../platform/server/fetch';
import { logger } from '../../platform/server/log';
import { createApp } from '../app';
import * as db from '../db';
import { mutator } from '../mutators';
import { getServer } from '../server-config';
import { undoable } from '../undo';

export type AICategorizationHandlers = {
  'ai-categorize-transactions': typeof aiCategorizeTransactions;
};

export const app = createApp<AICategorizationHandlers>();

type CategoryInfo = {
  id: string;
  name: string;
  group_name: string;
  is_income: boolean;
};

export type CategorizationResult = {
  id: string;
  payee: string;
  category_name: string;
  category_id: string;
  reason: string;
  confidence: number;
};

export type AmbiguousTransaction = {
  id: string;
  payee: string;
  amount: number;
  notes: string;
  reason: string;
};

// ~80 output tokens per transaction (id + category + confidence + reason)
// ~25 input tokens per transaction line
// ~500 tokens for prompt overhead + category list
// Keep batches small enough that output fits within max_tokens budget
const TOKENS_PER_TX_OUTPUT = 80;
const MAX_OUTPUT_TOKENS = 4096;
const BATCH_SIZE = Math.floor(MAX_OUTPUT_TOKENS / TOKENS_PER_TX_OUTPUT); // ~51, use 40 for safety
const SAFE_BATCH_SIZE = 40;

// claude-haiku-4-5-20251001 pricing (USD per token)
const PRICE_INPUT_PER_TOKEN = 0.8 / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 4.0 / 1_000_000;

async function getAnthropicApiKey(): Promise<string | null> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return null;

  const serverConfig = getServer();
  if (!serverConfig) return null;

  try {
    const res = await fetch(
      serverConfig.BASE_SERVER + '/secret/anthropic_api_key',
      { headers: { 'X-ACTUAL-TOKEN': userToken } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.value as string) ?? null;
  } catch {
    return null;
  }
}

async function loadCategories(): Promise<CategoryInfo[]> {
  const groups = await db.getCategoriesGrouped();
  const result: CategoryInfo[] = [];
  for (const group of groups) {
    for (const cat of group.categories) {
      result.push({
        id: cat.id,
        name: cat.name,
        group_name: group.name,
        is_income: group.is_income === 1,
      });
    }
  }
  return result;
}

type ClaudeAssignment = {
  id: string;
  category: string | null;
  confidence: number;
  reason: string;
};

type BatchResult = {
  assignments: ClaudeAssignment[];
  inputTokens: number;
  outputTokens: number;
};

async function batchSuggestCategories(
  transactions: Array<{
    id: string;
    payee: string;
    notes: string;
    amount: number;
  }>,
  categories: CategoryInfo[],
  apiKey: string,
  serverBase: string,
  userToken: string,
): Promise<BatchResult> {
  const expenseCategories = categories.filter(c => !c.is_income);
  const incomeCategories = categories.filter(c => c.is_income);

  const categoryList = [
    '=== EXPENSE CATEGORIES ===',
    ...expenseCategories.map(c => `${c.name} (${c.group_name})`),
    '=== INCOME CATEGORIES ===',
    ...incomeCategories.map(c => `${c.name} (${c.group_name})`),
  ].join('\n');

  const txLines = transactions
    .map(t => {
      const context = [t.payee, t.notes].filter(Boolean).join(' - ');
      const sign = t.amount < 0 ? '-' : '+';
      return `id=${t.id} | "${context}" | ${sign}$${Math.abs(t.amount / 100).toFixed(2)}`;
    })
    .join('\n');

  const prompt = `You are categorizing personal finance transactions. Assign each to the best matching category.

Available categories:
${categoryList}

Transactions to categorize:
${txLines}

Rules:
- Use expense categories for negative amounts, income categories for positive amounts
- confidence >= 0.7 means you're sure; < 0.7 means ambiguous (set category to null)
- Be concise in reason (max 10 words)

Respond with ONLY a JSON array, no markdown:
[{"id":"...","category":"exact category name or null","confidence":0.0-1.0,"reason":"..."}]`;

  try {
    const res = await fetch(`${serverBase}/ai/anthropic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ACTUAL-TOKEN': userToken,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.min(
          MAX_OUTPUT_TOKENS,
          transactions.length * TOKENS_PER_TX_OUTPUT + 200,
        ),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      logger.warn('Anthropic API error', { status: res.status });
      return { assignments: [], inputTokens: 0, outputTokens: 0 };
    }

    const data = await res.json();
    const inputTokens: number = data?.usage?.input_tokens ?? 0;
    const outputTokens: number = data?.usage?.output_tokens ?? 0;
    const text: string = data?.content?.[0]?.text?.trim() ?? '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.warn('Could not parse Claude batch response', {
        text: text.slice(0, 200),
      });
      return { assignments: [], inputTokens, outputTokens };
    }
    return {
      assignments: JSON.parse(jsonMatch[0]) as ClaudeAssignment[],
      inputTokens,
      outputTokens,
    };
  } catch (err) {
    logger.warn('Failed batch Anthropic call', err);
    return { assignments: [], inputTokens: 0, outputTokens: 0 };
  }
}

async function findOrCreateUncategorizedCategory(
  categories: CategoryInfo[],
): Promise<string> {
  // Look for existing "Uncategorized" category (case-insensitive)
  const existing = categories.find(
    c => c.name.toLowerCase() === 'uncategorized',
  );
  if (existing) return existing.id;

  // Find the first expense category group to host the new category
  const groups = await db.getCategoriesGrouped();
  const expenseGroup = groups.find(g => g.is_income !== 1);
  if (!expenseGroup) {
    throw new Error('No expense category group found');
  }

  const id = await db.insertCategory(
    { name: 'Uncategorized', cat_group: expenseGroup.id },
    { atEnd: true },
  );
  return id;
}

export async function aiCategorizeTransactions({
  transactionIds,
}: {
  transactionIds: string[];
}): Promise<{
  error?: string;
  categorized: number;
  skipped: number;
  assignedToUncategorized: number;
  results: CategorizationResult[];
  ambiguous: AmbiguousTransaction[];
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}> {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return {
      error: 'missing-api-key',
      categorized: 0,
      skipped: 0,
      assignedToUncategorized: 0,
      results: [],
      ambiguous: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }
  const serverConfig = getServer();
  if (!serverConfig) {
    return {
      error: 'missing-api-key',
      categorized: 0,
      skipped: 0,
      assignedToUncategorized: 0,
      results: [],
      ambiguous: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }
  const apiKey = await getAnthropicApiKey();
  if (!apiKey) {
    return {
      error: 'missing-api-key',
      categorized: 0,
      skipped: 0,
      assignedToUncategorized: 0,
      results: [],
      ambiguous: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  const categories = await loadCategories();
  logger.info(
    `AI categorization: loaded ${categories.length} categories: [${categories.map(c => c.name).join(', ')}]`,
  );
  if (categories.length === 0) {
    return {
      error: 'no-categories',
      categorized: 0,
      skipped: 0,
      assignedToUncategorized: 0,
      results: [],
      ambiguous: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  // Pre-load payee name map for efficient lookup (v_transactions only stores payee UUID)
  const allPayees = await db.getPayees();
  const payeeNameById = new Map(allPayees.map(p => [p.id, p.name]));

  // Load all transactions upfront
  const txsToProcess: Array<{
    id: string;
    payee: string;
    notes: string;
    amount: number;
    raw: ReturnType<typeof db.getTransaction> extends Promise<infer T>
      ? T
      : never;
  }> = [];
  for (const id of transactionIds) {
    const tx = await db.getTransaction(id);
    if (!tx || tx.category) continue;
    const payeeName =
      (tx.payee ? payeeNameById.get(tx.payee) : null) ||
      tx.imported_payee ||
      'Unknown';
    txsToProcess.push({
      id: tx.id,
      payee: payeeName,
      notes: tx.notes || '',
      amount: tx.amount,
      raw: tx,
    });
  }

  const results: CategorizationResult[] = [];
  const ambiguous: AmbiguousTransaction[] = [];
  let categorized = 0;
  let skipped = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  logger.info(
    `AI categorization: processing ${txsToProcess.length} transactions in batches of ${SAFE_BATCH_SIZE}`,
  );

  // Process in batches — one API call per batch
  for (let i = 0; i < txsToProcess.length; i += SAFE_BATCH_SIZE) {
    const batch = txsToProcess.slice(i, i + SAFE_BATCH_SIZE);
    logger.info(
      `AI categorization: batch ${Math.floor(i / SAFE_BATCH_SIZE) + 1} / ${Math.ceil(txsToProcess.length / SAFE_BATCH_SIZE)} (${batch.length} transactions)`,
    );
    const { assignments, inputTokens, outputTokens } =
      await batchSuggestCategories(
        batch,
        categories,
        apiKey,
        serverConfig.BASE_SERVER,
        userToken,
      );
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    logger.info(
      `AI categorization: Claude returned ${assignments.length} assignments for batch of ${batch.length}`,
    );
    for (const assignment of assignments) {
      const tx = batch.find(t => t.id === assignment.id);
      if (!tx) continue;

      logger.info(
        `AI categorization: tx="${tx.payee}" → category="${assignment.category}" confidence=${assignment.confidence}`,
      );
      if (!assignment.category || assignment.confidence < 0.7) {
        ambiguous.push({
          id: tx.id,
          payee: tx.payee,
          amount: tx.amount,
          notes: tx.notes,
          reason: assignment.reason,
        });
        skipped++;
        continue;
      }

      const isExpense = tx.amount < 0;
      const relevant = categories.filter(c => c.is_income === !isExpense);
      const categoryName = assignment.category
        .split(' (')[0]
        .trim()
        .toLowerCase();
      const match = relevant.find(c => c.name.toLowerCase() === categoryName);

      if (!match) {
        logger.warn(
          `AI categorization: no match for "${assignment.category}" (normalized: "${categoryName}") — available: [${relevant.map(c => c.name).join(', ')}]`,
        );
        ambiguous.push({
          id: tx.id,
          payee: tx.payee,
          amount: tx.amount,
          notes: tx.notes,
          reason: `No category match for "${assignment.category}"`,
        });
        skipped++;
        continue;
      }

      await db.updateTransaction({ ...tx.raw, category: match.id });
      categorized++;
      results.push({
        id: tx.id,
        payee: tx.payee,
        category_name: match.name,
        category_id: match.id,
        reason: assignment.reason,
        confidence: assignment.confidence,
      });
    }

    // Transactions in the batch that Claude didn't include in its response
    const respondedIds = new Set(assignments.map(a => a.id));
    for (const tx of batch) {
      if (!respondedIds.has(tx.id)) skipped++;
    }
  }

  // Auto-assign ambiguous transactions to "Uncategorized" category
  let assignedToUncategorized = 0;
  if (ambiguous.length > 0) {
    try {
      const uncategorizedId =
        await findOrCreateUncategorizedCategory(categories);
      for (const amb of ambiguous) {
        const tx = txsToProcess.find(t => t.id === amb.id);
        if (!tx) continue;
        await db.updateTransaction({ ...tx.raw, category: uncategorizedId });
        assignedToUncategorized++;
      }
      logger.info(
        `AI categorization: assigned ${assignedToUncategorized} ambiguous transactions to Uncategorized`,
      );
    } catch (err) {
      logger.warn('AI categorization: failed to assign uncategorized', err);
    }
  }

  // Post-categorization validation: verify each result was actually written to DB
  let validationFailed = 0;
  for (const result of results) {
    const verify = await db.getTransaction(result.id);
    if (!verify || verify.category !== result.category_id) {
      logger.warn(
        `AI categorization validation failed for tx ${result.id}: expected ${result.category_id}, got ${verify?.category}`,
      );
      validationFailed++;
    }
  }
  if (validationFailed > 0) {
    logger.warn(
      `AI categorization: ${validationFailed} of ${results.length} writes failed validation`,
    );
  } else {
    logger.info(
      `AI categorization: all ${results.length} writes validated successfully`,
    );
  }

  const estimatedCostUsd =
    totalInputTokens * PRICE_INPUT_PER_TOKEN +
    totalOutputTokens * PRICE_OUTPUT_PER_TOKEN;

  logger.info(
    `AI categorization complete: ${categorized} categorized, ${skipped} skipped, ${ambiguous.length} ambiguous, ${assignedToUncategorized} assigned to Uncategorized` +
      ` | tokens: ${totalInputTokens} in / ${totalOutputTokens} out | cost: $${estimatedCostUsd.toFixed(4)}`,
  );

  return {
    categorized,
    skipped,
    assignedToUncategorized,
    results,
    ambiguous,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd,
  };
}

app.method(
  'ai-categorize-transactions',
  mutator(undoable(aiCategorizeTransactions)),
);
