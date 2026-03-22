/**
 * claude-recategorize.mjs
 * Re-evaluates ALL categorized transactions and reassigns any that are a poor fit.
 * Run from monorepo root: node claude-recategorize.mjs [--dry-run]
 */

import { mkdirSync } from 'fs';

const actualAPI = await import('./packages/api/dist/index.js');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = '/tmp/actual-claude-cat';
import { readFileSync } from 'fs';
const envVars = Object.fromEntries(
  readFileSync(new URL('.actual.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()))
);
const SERVER_URL = envVars.ACTUAL_SERVER_URL || 'http://localhost:5006';
const PASSWORD = envVars.ACTUAL_PASSWORD;
const BUDGET_ID = envVars.ACTUAL_BUDGET_ID;
const FIT_THRESHOLD = 0.6; // below this → reassign
const CONF_THRESHOLD = 0.7; // confidence needed for new assignment
const BATCH_SIZE = 20;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

async function callClaude(prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Anthropic API error: ${resp.status} ${await resp.text()}`);
  }
  const res = await resp.json();
  return res.content[0].text.trim();
}

async function reviewBatch(transactions, categories, catById) {
  const catList = categories
    .map(c => `${c.id}|${c.group_name}|${c.name}`)
    .join('\n');

  const txnList = transactions
    .map((t, i) => {
      const payee = t.payee || t.imported_payee || 'Unknown';
      const amt = (t.amount / 100).toFixed(2);
      const currentCat = catById[t.category]?.name ?? 'Unknown';
      return `${i}. payee="${payee}" amount=${amt} notes="${t.notes || ''}" current_category="${currentCat}"`;
    })
    .join('\n');

  const prompt = `You are a personal finance assistant reviewing whether bank transactions are in the right category.

AVAILABLE CATEGORIES (id|group|name):
${catList}

TRANSACTIONS TO REVIEW (index. payee amount notes current_category):
${txnList}

For each transaction, respond with exactly one line:
<index> <fit_score> <new_category_id> <new_confidence>

Where:
- fit_score: 0.0–1.0 — how well the CURRENT category fits (1.0 = perfect fit)
- new_category_id: the best category id (can be same as current if it fits well)
- new_confidence: 0.0–1.0 — confidence in the new assignment
- If truly ambiguous, use: <index> 0.0 none 0.0

Rules:
- Negative amounts = expenses, positive = income
- Only suggest a different category if you're confident it's clearly better
- Output ONLY the data lines, nothing else`;

  const text = await callClaude(prompt);
  const lines = text.split('\n');
  const results = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const idx = parseInt(parts[0]);
    const fit = parseFloat(parts[1]);
    const newCatId = parts[2];
    const newConf = parseFloat(parts[3]);
    if (!isNaN(idx) && !isNaN(fit) && !isNaN(newConf)) {
      results[idx] = { fit, newCatId, newConf };
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
  const catById = Object.fromEntries(categories.map(c => [c.id, c]));
  console.log(`${categories.length} categories across ${groups.length} groups`);
  categories.forEach(c => console.log(`  - [${c.group_name}] ${c.name}`));

  // Fetch ALL categorized transactions (no date filter)
  const accounts = await actualAPI.getAccounts();
  const seen = new Set();
  const categorized = [];

  for (const acct of accounts) {
    const txns = await actualAPI.getTransactions(acct.id, '2000-01-01', null);
    for (const t of txns) {
      if (t.category && !t.is_parent && !seen.has(t.id)) {
        seen.add(t.id);
        categorized.push(t);
      }
    }
  }

  console.log(
    `\nFound ${categorized.length} categorized transactions to review\n`,
  );

  let kept = 0,
    reassigned = 0,
    skipped = 0;
  const updates = [];
  const changes = [];
  const totalBatches = Math.ceil(categorized.length / BATCH_SIZE);

  for (let i = 0; i < categorized.length; i += BATCH_SIZE) {
    const batch = categorized.slice(i, i + BATCH_SIZE);
    const bNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`  Batch ${bNum}/${totalBatches}... `);

    try {
      const results = await reviewBatch(batch, categories, catById);

      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        const r = results[j];
        const payee = (t.payee || t.imported_payee || 'Unknown').substring(
          0,
          32,
        );
        const amt = (t.amount / 100).toFixed(2);
        const currentCatName = catById[t.category]?.name ?? '?';

        if (!r) {
          skipped++;
          continue;
        }

        // Good fit — leave it
        if (r.fit >= FIT_THRESHOLD) {
          kept++;
          continue;
        }

        // Poor fit — reassign if confident
        if (r.newCatId === 'none' || r.newConf < CONF_THRESHOLD) {
          skipped++;
          changes.push({
            payee,
            amt,
            from: currentCatName,
            to: '(left as-is — no confident match)',
            fit: r.fit,
          });
          continue;
        }

        const newCat = catById[r.newCatId];
        if (!newCat || newCat.id === t.category) {
          kept++;
          continue;
        }

        updates.push({ id: t.id, category: newCat.id });
        reassigned++;
        changes.push({
          payee,
          amt,
          from: currentCatName,
          to: newCat.name,
          fit: r.fit,
          conf: r.newConf,
        });
      }
      console.log('ok');
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      skipped += batch.length;
    }
  }

  if (changes.length > 0) {
    console.log(
      '\n── Reassignments ────────────────────────────────────────────────',
    );
    for (const c of changes) {
      const sign = parseFloat(c.amt) < 0 ? '-' : '+';
      const absAmt = Math.abs(parseFloat(c.amt)).toFixed(2).padStart(9);
      const conf = c.conf ? ` (conf: ${c.conf.toFixed(2)})` : '';
      console.log(
        `  ${sign}$${absAmt}  ${c.payee.padEnd(33)} ${c.from.padEnd(25)} → ${c.to}${conf}`,
      );
    }
  } else {
    console.log('\nAll transactions already fit their categories well.');
  }

  console.log(
    '\n── Summary ──────────────────────────────────────────────────────',
  );
  console.log(`  Total reviewed    : ${categorized.length}`);
  console.log(`  Good fit (kept)   : ${kept}`);
  console.log(`  Reassigned        : ${reassigned}`);
  console.log(`  Left as-is (ambig): ${skipped}`);

  if (!DRY_RUN && updates.length > 0) {
    console.log(`\nApplying ${updates.length} reassignments and syncing...`);
    for (const u of updates) {
      await actualAPI.updateTransaction(u.id, { category: u.category });
    }
    await actualAPI.sync();
    console.log('Done!');
  } else if (DRY_RUN) {
    console.log('\nDry run — no changes written.');
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
