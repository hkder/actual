/**
 * claude-categorize.mjs
 * Run from monorepo root: node claude-categorize.mjs [--dry-run]
 */

import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Use locally built API
const actualAPI = await import('./packages/api/dist/index.js');

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

const DATA_DIR = '/tmp/actual-claude-cat';
// Load credentials from .actual.env (never hardcode them)
import { readFileSync } from 'fs';
const envVars = Object.fromEntries(
  readFileSync(new URL('.actual.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()))
);
const SERVER_URL = envVars.ACTUAL_SERVER_URL || 'http://localhost:5006';
const PASSWORD = envVars.ACTUAL_PASSWORD;
const BUDGET_ID = envVars.ACTUAL_BUDGET_ID;
const CONFIDENCE = 0.7;
const BATCH_SIZE = 25;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function classifyBatch(transactions, categories) {
  const catList = categories
    .map(c => `${c.id}|${c.group_name}|${c.name}`)
    .join('\n');
  const txnList = transactions
    .map((t, i) => {
      const payee = t.payee || t.imported_payee || 'Unknown';
      const amt = (t.amount / 100).toFixed(2);
      return `${i}. payee="${payee}" amount=${amt} notes="${t.notes || ''}"`;
    })
    .join('\n');

  const prompt = `You are a personal finance assistant categorizing bank transactions.

CATEGORIES (id|group|name):
${catList}

TRANSACTIONS TO CATEGORIZE (index. payee amount notes):
${txnList}

For each transaction (0 to ${transactions.length - 1}), respond with exactly one line:
<index> <category_id> <confidence>

Rules:
- confidence 0.0–1.0. Use >= ${CONFIDENCE} only when clearly confident
- Negative amounts = expenses, positive = income — pick accordingly
- If ambiguous or no good fit, use: <index> none 0.0
- Output ONLY the data lines, nothing else`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic API error: ${resp.status} ${await resp.text()}`);
  }
  const res = await resp.json();

  const lines = res.content[0].text.trim().split('\n');
  const results = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const idx = parseInt(parts[0]);
    const catId = parts[1];
    const conf = parseFloat(parts[2]);
    if (!isNaN(idx) && !isNaN(conf)) {
      results[idx] = { categoryId: catId, confidence: conf };
    }
  }
  return results;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('Connecting to Actual Budget (My Finances)...');
  await actualAPI.init({
    dataDir: DATA_DIR,
    serverURL: SERVER_URL,
    password: PASSWORD,
  });
  await actualAPI.downloadBudget(BUDGET_ID);
  console.log('Budget loaded.\n');

  const groups = await actualAPI.getCategoryGroups();
  const categories = groups.flatMap(g =>
    g.categories.map(c => ({ ...c, group_name: g.name })),
  );
  console.log(`${categories.length} categories across ${groups.length} groups`);

  const uncatCat = categories.find(
    c => c.name.toLowerCase() === 'uncategorized',
  );
  if (uncatCat) console.log(`"Uncategorized" category: ${uncatCat.id}`);

  const accounts = await actualAPI.getAccounts();
  const since = new Date();
  since.setDate(since.getDate() - 365);
  const sinceStr = since.toISOString().slice(0, 10); // YYYY-MM-DD

  const seen = new Set();
  const uncategorized = [];
  for (const acct of accounts) {
    const txns = await actualAPI.getTransactions(acct.id, sinceStr, null);
    for (const t of txns) {
      if (!t.category && !t.is_parent && !seen.has(t.id)) {
        seen.add(t.id);
        uncategorized.push(t);
      }
    }
  }

  console.log(
    `\nFound ${uncategorized.length} uncategorized transactions (last 365 days)\n`,
  );
  if (uncategorized.length === 0) {
    console.log('Nothing to categorize!');
    await actualAPI.shutdown();
    return;
  }

  let confident = 0,
    assignedUncat = 0,
    failed = 0;
  const updates = [];
  const rows = [];
  const totalBatches = Math.ceil(uncategorized.length / BATCH_SIZE);

  for (let i = 0; i < uncategorized.length; i += BATCH_SIZE) {
    const batch = uncategorized.slice(i, i + BATCH_SIZE);
    const bNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Batch ${bNum}/${totalBatches}... `);
    try {
      const results = await classifyBatch(batch, categories);
      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        const r = results[j];
        const payee = (t.payee || t.imported_payee || 'Unknown').substring(
          0,
          32,
        );
        const amt = (t.amount / 100).toFixed(2);

        if (!r || r.confidence < CONFIDENCE || r.categoryId === 'none') {
          if (uncatCat) {
            updates.push({ id: t.id, category: uncatCat.id });
            assignedUncat++;
            rows.push({
              payee,
              amt,
              cat: 'Uncategorized',
              conf: r?.confidence ?? 0,
            });
          } else {
            failed++;
            rows.push({ payee, amt, cat: '(skipped)', conf: 0 });
          }
          continue;
        }

        const match = categories.find(c => c.id === r.categoryId);
        if (!match) {
          if (uncatCat) {
            updates.push({ id: t.id, category: uncatCat.id });
            assignedUncat++;
          } else {
            failed++;
          }
          rows.push({
            payee,
            amt,
            cat: 'Uncategorized (bad id)',
            conf: r.confidence,
          });
          continue;
        }

        updates.push({ id: t.id, category: match.id });
        confident++;
        rows.push({ payee, amt, cat: match.name, conf: r.confidence });
      }
      console.log('ok');
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed += batch.length;
    }
  }

  console.log(
    '\n── Transaction Results ──────────────────────────────────────────',
  );
  for (const r of rows) {
    const sign = parseFloat(r.amt) < 0 ? '-' : '+';
    const absAmt = Math.abs(parseFloat(r.amt)).toFixed(2).padStart(9);
    console.log(
      `  ${sign}$${absAmt}  ${r.payee.padEnd(33)} → ${r.cat.padEnd(28)} (${r.conf.toFixed(2)})`,
    );
  }

  console.log(
    '\n── Summary ──────────────────────────────────────────────────────',
  );
  console.log(`  Confident category matches : ${confident}`);
  console.log(`  Assigned to Uncategorized  : ${assignedUncat}`);
  console.log(`  Skipped / errors           : ${failed}`);
  console.log(`  Total processed            : ${uncategorized.length}`);

  if (!DRY_RUN && updates.length > 0) {
    console.log(`\nApplying ${updates.length} updates and syncing...`);
    for (const u of updates) {
      await actualAPI.updateTransaction(u.id, { category: u.category });
    }
    await actualAPI.sync();
    console.log('Done! Open http://localhost:5006 to see results.');
  } else {
    console.log('\nDry run complete — no changes written.');
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
