/**
 * claude-restructure-categories.mjs
 * Restructures Income & Savings categories, moves Sinking Funds,
 * and re-categorizes transactions using AI.
 * Run from monorepo root: node claude-restructure-categories.mjs [--dry-run]
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
const BATCH_SIZE = 20;
const CONFIDENCE = 0.7;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

// ── Helpers ──────────────────────────────────────────────────────

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

async function classifyBatch(transactions, targetCategories) {
  const catList = targetCategories
    .map(c => `${c.id}|${c.group_name}|${c.name}`)
    .join('\n');
  const txnList = transactions
    .map((t, i) => {
      const payee = t.payee || t.imported_payee || 'Unknown';
      const amt = (t.amount / 100).toFixed(2);
      return `${i}. payee="${payee}" amount=${amt} notes="${t.notes || ''}"`;
    })
    .join('\n');

  const prompt = `You are a personal finance assistant categorizing transactions into specific subcategories.

TARGET CATEGORIES (id|group|name):
${catList}

TRANSACTIONS (index. payee amount notes):
${txnList}

For each transaction, respond with exactly one line:
<index> <category_id> <confidence>

Rules:
- confidence 0.0–1.0
- Positive amounts are income/savings inflows
- Negative amounts could be transfers to savings/investment accounts
- Pick the BEST matching subcategory
- If truly ambiguous, still pick the closest match with lower confidence
- Output ONLY the data lines, nothing else`;

  const text = await callClaude(prompt);
  const lines = text.split('\n');
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

function printSection(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('Connecting to Actual Budget...');
  await actualAPI.init({
    dataDir: DATA_DIR,
    serverURL: SERVER_URL,
    password: PASSWORD,
  });
  await actualAPI.downloadBudget(BUDGET_ID);
  console.log('Budget loaded.\n');

  // ── Get current state ──
  const groups = await actualAPI.getCategoryGroups();
  const allCats = groups.flatMap(g =>
    g.categories.map(c => ({ ...c, group_name: g.name })),
  );
  const catById = Object.fromEntries(allCats.map(c => [c.id, c]));

  console.log(
    `Current: ${allCats.length} categories across ${groups.length} groups`,
  );
  for (const g of groups) {
    console.log(`  [${g.name}]`);
    for (const c of g.categories) {
      console.log(`    - ${c.name} (${c.id})`);
    }
  }

  // Find key groups
  const incomeGroup = groups.find(g => g.name === 'Income');
  const investGroup = groups.find(g => g.name === 'Investments and Savings');
  const usualGroup = groups.find(g => g.name === 'Usual Expenses');

  if (!incomeGroup) throw new Error('Could not find "Income" group');
  if (!investGroup) {
    throw new Error('Could not find "Investments and Savings" group');
  }

  // ── A. Create new Income subcategories ──
  printSection('Creating Income subcategories');

  const incomeSubcats = [
    'Salary / Paycheck',
    'Freelance / Side Income',
    'Investment Income',
    'Refunds & Reimbursements',
    'Other Income',
  ];

  const existingIncomeNames = new Set(incomeGroup.categories.map(c => c.name));
  const newIncomeCatIds = {};

  for (const name of incomeSubcats) {
    if (existingIncomeNames.has(name)) {
      const existing = incomeGroup.categories.find(c => c.name === name);
      newIncomeCatIds[name] = existing.id;
      console.log(`  ✓ "${name}" already exists (${existing.id})`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] Would create "${name}" under Income`);
      newIncomeCatIds[name] = `dry-run-${name}`;
    } else {
      const id = await actualAPI.createCategory({
        name,
        group_id: incomeGroup.id,
        is_income: true,
      });
      newIncomeCatIds[name] = id;
      console.log(`  + Created "${name}" (${id})`);
    }
  }

  // ── B. Create new Investments & Savings subcategories ──
  printSection('Creating Investments & Savings subcategories');

  const savingsSubcats = [
    'Emergency Fund',
    'Retirement (401k / IRA)',
    'Brokerage / Investments',
  ];

  const existingSavingsNames = new Set(investGroup.categories.map(c => c.name));
  const newSavingsCatIds = {};

  for (const name of savingsSubcats) {
    if (existingSavingsNames.has(name)) {
      const existing = investGroup.categories.find(c => c.name === name);
      newSavingsCatIds[name] = existing.id;
      console.log(`  ✓ "${name}" already exists (${existing.id})`);
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `  [dry-run] Would create "${name}" under Investments and Savings`,
      );
      newSavingsCatIds[name] = `dry-run-${name}`;
    } else {
      const id = await actualAPI.createCategory({
        name,
        group_id: investGroup.id,
        is_income: false,
      });
      newSavingsCatIds[name] = id;
      console.log(`  + Created "${name}" (${id})`);
    }
  }

  // ── C. Move "Sinking Funds" from Usual Expenses to Investments & Savings ──
  printSection('Moving "Sinking Funds"');

  let sinkingFundsCat = null;
  if (usualGroup) {
    sinkingFundsCat = usualGroup.categories.find(
      c => c.name === 'Sinking Funds',
    );
  }
  // Also check all groups in case it's elsewhere
  if (!sinkingFundsCat) {
    sinkingFundsCat = allCats.find(c => c.name === 'Sinking Funds');
  }

  let newSinkingFundsId = null;
  if (sinkingFundsCat) {
    const alreadyInInvest = investGroup.categories.find(
      c => c.name === 'Sinking Funds',
    );
    if (alreadyInInvest) {
      console.log(
        `  ✓ "Sinking Funds" already in Investments and Savings (${alreadyInInvest.id})`,
      );
      newSinkingFundsId = alreadyInInvest.id;
    } else if (DRY_RUN) {
      console.log(
        `  [dry-run] Would move "Sinking Funds" (${sinkingFundsCat.id}) from "${sinkingFundsCat.group_name}" to "Investments and Savings"`,
      );
    } else {
      // Create new Sinking Funds in invest group
      newSinkingFundsId = await actualAPI.createCategory({
        name: 'Sinking Funds',
        group_id: investGroup.id,
        is_income: false,
      });
      console.log(
        `  + Created new "Sinking Funds" (${newSinkingFundsId}) in Investments and Savings`,
      );

      // Move transactions from old to new
      const accounts = await actualAPI.getAccounts();
      let movedCount = 0;
      for (const acct of accounts) {
        const txns = await actualAPI.getTransactions(
          acct.id,
          '2000-01-01',
          null,
        );
        for (const t of txns) {
          if (t.category === sinkingFundsCat.id) {
            await actualAPI.updateTransaction(t.id, {
              category: newSinkingFundsId,
            });
            movedCount++;
          }
        }
      }
      console.log(`  ↪ Moved ${movedCount} transactions to new Sinking Funds`);

      // Delete old category
      await actualAPI.deleteCategory(sinkingFundsCat.id);
      console.log(
        `  ✗ Deleted old "Sinking Funds" (${sinkingFundsCat.id}) from "${sinkingFundsCat.group_name}"`,
      );
    }
  } else {
    console.log('  (no "Sinking Funds" category found — skipping)');
  }

  // ── D. Re-categorize transactions ──
  printSection('Re-categorizing transactions');

  if (DRY_RUN) {
    console.log('  [dry-run] Skipping AI re-categorization');
    console.log('\nDry run complete — no changes written.');
    await actualAPI.shutdown();
    return;
  }

  // Refresh categories after changes
  const updatedGroups = await actualAPI.getCategoryGroups();
  const updatedCats = updatedGroups.flatMap(g =>
    g.categories.map(c => ({ ...c, group_name: g.name })),
  );
  const updatedCatById = Object.fromEntries(updatedCats.map(c => [c.id, c]));

  // Find the original "Income" category (the generic one, not the group)
  const incomeCat = updatedCats.find(
    c =>
      c.name === 'Income' &&
      c.group_name === 'Income' &&
      !incomeSubcats.includes(c.name),
  );

  // Find any "Savings" category
  const savingsCat = updatedCats.find(
    c => c.name === 'Savings' || c.name === 'Investments & Savings',
  );

  // Build target category lists for AI
  const incomeTargets = updatedCats.filter(
    c => c.group_name === 'Income' && incomeSubcats.includes(c.name),
  );
  const savingsTargets = updatedCats.filter(
    c => c.group_name === 'Investments and Savings',
  );

  // Collect transactions to re-categorize
  const accounts = await actualAPI.getAccounts();
  const seen = new Set();
  const incomeTransactions = [];
  const savingsTransactions = [];

  // Category IDs to re-categorize
  const incomeCatIds = new Set();
  if (incomeCat) incomeCatIds.add(incomeCat.id);

  const savingsCatIds = new Set();
  if (savingsCat) savingsCatIds.add(savingsCat.id);
  // Also include the generic invest group categories that aren't the new subcats
  const newSavingsNames = new Set([...savingsSubcats, 'Sinking Funds']);

  for (const acct of accounts) {
    const txns = await actualAPI.getTransactions(acct.id, '2000-01-01', null);
    for (const t of txns) {
      if (t.is_parent || seen.has(t.id)) continue;
      seen.add(t.id);

      if (t.category && incomeCatIds.has(t.category)) {
        incomeTransactions.push(t);
      } else if (t.category && savingsCatIds.has(t.category)) {
        savingsTransactions.push(t);
      }
    }
  }

  console.log(
    `  Income transactions to re-categorize: ${incomeTransactions.length}`,
  );
  console.log(
    `  Savings transactions to re-categorize: ${savingsTransactions.length}`,
  );

  let totalReassigned = 0;
  const changes = [];

  // Re-categorize income transactions
  if (incomeTransactions.length > 0 && incomeTargets.length > 0) {
    printSection('AI: Re-categorizing Income transactions');
    const fallbackCat = incomeTargets.find(c => c.name === 'Other Income');
    const totalBatches = Math.ceil(incomeTransactions.length / BATCH_SIZE);

    for (let i = 0; i < incomeTransactions.length; i += BATCH_SIZE) {
      const batch = incomeTransactions.slice(i, i + BATCH_SIZE);
      const bNum = Math.floor(i / BATCH_SIZE) + 1;
      process.stdout.write(`  Batch ${bNum}/${totalBatches}... `);

      try {
        const results = await classifyBatch(batch, incomeTargets);
        for (let j = 0; j < batch.length; j++) {
          const t = batch[j];
          const r = results[j];
          const payee = (t.payee || t.imported_payee || 'Unknown').substring(
            0,
            32,
          );
          const amt = (t.amount / 100).toFixed(2);

          let targetId;
          if (r && r.confidence >= CONFIDENCE && r.categoryId !== 'none') {
            const match = incomeTargets.find(c => c.id === r.categoryId);
            targetId = match ? match.id : (fallbackCat?.id ?? t.category);
          } else {
            targetId = fallbackCat?.id ?? t.category;
          }

          if (targetId && targetId !== t.category) {
            await actualAPI.updateTransaction(t.id, { category: targetId });
            totalReassigned++;
            const newName = updatedCatById[targetId]?.name ?? targetId;
            changes.push({
              payee,
              amt,
              from: 'Income',
              to: newName,
              conf: r?.confidence ?? 0,
            });
          }
        }
        console.log('ok');
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }
    }
  }

  // Re-categorize savings transactions
  if (savingsTransactions.length > 0 && savingsTargets.length > 0) {
    printSection('AI: Re-categorizing Savings transactions');
    const totalBatches = Math.ceil(savingsTransactions.length / BATCH_SIZE);

    for (let i = 0; i < savingsTransactions.length; i += BATCH_SIZE) {
      const batch = savingsTransactions.slice(i, i + BATCH_SIZE);
      const bNum = Math.floor(i / BATCH_SIZE) + 1;
      process.stdout.write(`  Batch ${bNum}/${totalBatches}... `);

      try {
        const results = await classifyBatch(batch, savingsTargets);
        for (let j = 0; j < batch.length; j++) {
          const t = batch[j];
          const r = results[j];
          const payee = (t.payee || t.imported_payee || 'Unknown').substring(
            0,
            32,
          );
          const amt = (t.amount / 100).toFixed(2);
          const fromName = updatedCatById[t.category]?.name ?? '?';

          let targetId = t.category; // keep as-is by default
          if (r && r.confidence >= CONFIDENCE && r.categoryId !== 'none') {
            const match = savingsTargets.find(c => c.id === r.categoryId);
            if (match) targetId = match.id;
          }

          if (targetId !== t.category) {
            await actualAPI.updateTransaction(t.id, { category: targetId });
            totalReassigned++;
            const newName = updatedCatById[targetId]?.name ?? targetId;
            changes.push({
              payee,
              amt,
              from: fromName,
              to: newName,
              conf: r?.confidence ?? 0,
            });
          }
        }
        console.log('ok');
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }
    }
  }

  // ── Results ──
  printSection('Results');

  if (changes.length > 0) {
    for (const c of changes) {
      const sign = parseFloat(c.amt) < 0 ? '-' : '+';
      const absAmt = Math.abs(parseFloat(c.amt)).toFixed(2).padStart(9);
      console.log(
        `  ${sign}$${absAmt}  ${c.payee.padEnd(33)} ${c.from.padEnd(25)} → ${c.to} (${c.conf.toFixed(2)})`,
      );
    }
  } else {
    console.log('  No transactions were re-categorized.');
  }

  printSection('Summary');
  console.log(
    `  New income subcategories created    : ${incomeSubcats.length}`,
  );
  console.log(
    `  New savings subcategories created   : ${savingsSubcats.length}`,
  );
  console.log(
    `  Sinking Funds moved                 : ${sinkingFundsCat ? 'yes' : 'n/a'}`,
  );
  console.log(`  Transactions re-categorized         : ${totalReassigned}`);
  console.log(`  Total changes logged                : ${changes.length}`);

  // Sync
  if (totalReassigned > 0) {
    console.log('\nSyncing...');
    await actualAPI.sync();
    console.log('Done! Open http://localhost:5006 to see results.');
  } else {
    console.log('\nNo transaction changes to sync.');
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
