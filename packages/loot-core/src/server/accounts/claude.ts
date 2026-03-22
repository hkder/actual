import * as db from '../db';
import { batchMessages } from '../sync';

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 50;

export async function claudeCategorizeTransactions(apiKey: string): Promise<{
  categorized: number;
  skipped: number;
  errors: string[];
}> {
  const categories = await db.getCategories();
  const expenseCategories = categories.filter(
    c => !c.is_income && !c.tombstone,
  );

  if (!expenseCategories.length) {
    return {
      categorized: 0,
      skipped: 0,
      errors: ['No expense categories found'],
    };
  }

  const transactions = await db.all<{
    id: string;
    notes: string;
    amount: number;
    date: string;
    payee_name: string;
  }>(
    `SELECT t.id, t.notes, t.amount, t.date,
            COALESCE(p.name, '') as payee_name
     FROM v_transactions t
     LEFT JOIN payees p ON t.payee = p.id
     WHERE t.category IS NULL
       AND t.is_parent = 0
       AND t.tombstone = 0
       AND t.starting_balance_flag = 0
       AND t.amount < 0
     ORDER BY t.date DESC
     LIMIT 200`,
  );

  if (!transactions.length) {
    return { categorized: 0, skipped: 0, errors: [] };
  }

  const categoryContext = expenseCategories
    .map(c => `${c.id}: ${c.name}`)
    .join('\n');

  let totalCategorized = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = transactions.slice(i, i + BATCH_SIZE);

    try {
      const transactionContext = batch
        .map(
          t =>
            `${t.id}|${t.payee_name}|${t.notes || ''}|${Math.abs(t.amount / 100).toFixed(2)}`,
        )
        .join('\n');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: `You are a financial transaction categorizer. Match each transaction to the most appropriate category.

Available categories (id: name):
${categoryContext}

Transactions to categorize (format: id|payee|notes|amount_usd):
${transactionContext}

Respond with ONLY a JSON array of objects with "id" (transaction id) and "category" (category id) fields.
If a transaction doesn't clearly fit any category, omit it.
Example: [{"id":"abc123","category":"cat456"}]`,
            },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(
          `Claude API error: ${response.status} ${JSON.stringify(err)}`,
        );
      }

      const data = await response.json();
      const text = (data.content[0].text as string).trim();

      let assignments: Array<{ id: string; category: string }>;
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        assignments = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch {
        errors.push(`Failed to parse Claude response: ${text.slice(0, 100)}`);
        continue;
      }

      await batchMessages(async () => {
        for (const { id, category } of assignments) {
          const validCategory = expenseCategories.find(c => c.id === category);
          if (validCategory) {
            await db.updateTransaction({ id, category });
            totalCategorized++;
          } else {
            totalSkipped++;
          }
        }
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { categorized: totalCategorized, skipped: totalSkipped, errors };
}
