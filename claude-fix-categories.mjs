/**
 * claude-fix-categories.mjs
 * Fix known miscategorizations in Actual Budget.
 * Run from monorepo root: node claude-fix-categories.mjs [--dry-run]
 */

import { mkdirSync } from 'fs';

const actualAPI = await import('./packages/api/dist/index.js');

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

const DATA_DIR = '/tmp/actual-claude-cat';
import { readFileSync } from 'fs';
const envVars = Object.fromEntries(
  readFileSync(new URL('.actual.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()))
);
const SERVER_URL = envVars.ACTUAL_SERVER_URL || 'http://localhost:5006';
const PASSWORD = envVars.ACTUAL_PASSWORD;
const BUDGET_ID = envVars.ACTUAL_BUDGET_ID;

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

  // ── Load categories ──
  const groups = await actualAPI.getCategoryGroups();
  const categories = groups.flatMap(g =>
    g.categories.map(c => ({ ...c, group_name: g.name, group_id: g.id })),
  );

  console.log(`${categories.length} categories across ${groups.length} groups`);
  for (const g of groups) {
    console.log(`  Group: "${g.name}" (${g.id}) — ${g.categories.length} cats`);
  }

  // ── Find required groups ──
  const investGroup = groups.find(
    g =>
      g.name.toLowerCase().includes('investment') &&
      g.name.toLowerCase().includes('saving'),
  );
  const usualGroup = groups.find(g =>
    g.name.toLowerCase().includes('usual expense'),
  );

  if (!investGroup) {
    console.error('Could not find "Investments and Savings" group');
    await actualAPI.shutdown();
    return;
  }
  if (!usualGroup) {
    console.error('Could not find "Usual Expenses" group');
    await actualAPI.shutdown();
    return;
  }

  console.log(`\nInvestments group: "${investGroup.name}" (${investGroup.id})`);
  console.log(`Usual Expenses group: "${usualGroup.name}" (${usualGroup.id})`);

  // ── Create new categories (or find existing) ──
  let ccPaymentsCat = categories.find(c => c.name === 'Credit Card Payments');
  let transfersCat = categories.find(c => c.name === 'Transfers');
  let foodDeliveryCat = categories.find(c => c.name === 'Food Delivery');

  if (!ccPaymentsCat) {
    if (DRY_RUN) {
      console.log(
        '\n[DRY] Would create category "Credit Card Payments" in Investments and Savings',
      );
      ccPaymentsCat = { id: 'DRY_CC', name: 'Credit Card Payments' };
    } else {
      const id = await actualAPI.createCategory({
        name: 'Credit Card Payments',
        group_id: investGroup.id,
      });
      ccPaymentsCat = { id, name: 'Credit Card Payments' };
      console.log(`\nCreated "Credit Card Payments" (${id})`);
    }
  } else {
    console.log(
      `\n"Credit Card Payments" already exists (${ccPaymentsCat.id})`,
    );
  }

  if (!transfersCat) {
    if (DRY_RUN) {
      console.log(
        '[DRY] Would create category "Transfers" in Investments and Savings',
      );
      transfersCat = { id: 'DRY_TR', name: 'Transfers' };
    } else {
      const id = await actualAPI.createCategory({
        name: 'Transfers',
        group_id: investGroup.id,
      });
      transfersCat = { id, name: 'Transfers' };
      console.log(`Created "Transfers" (${id})`);
    }
  } else {
    console.log(`"Transfers" already exists (${transfersCat.id})`);
  }

  if (!foodDeliveryCat) {
    if (DRY_RUN) {
      console.log(
        '[DRY] Would create category "Food Delivery" in Usual Expenses',
      );
      foodDeliveryCat = { id: 'DRY_FD', name: 'Food Delivery' };
    } else {
      const id = await actualAPI.createCategory({
        name: 'Food Delivery',
        group_id: usualGroup.id,
      });
      foodDeliveryCat = { id, name: 'Food Delivery' };
      console.log(`Created "Food Delivery" (${id})`);
    }
  } else {
    console.log(`"Food Delivery" already exists (${foodDeliveryCat.id})`);
  }

  // ── Find target categories for rules ──
  const housingCat = categories.find(
    c =>
      c.name.toLowerCase().includes('housing') &&
      c.name.toLowerCase().includes('utilit'),
  );
  const diningCat = categories.find(c =>
    c.name.toLowerCase().includes('dining'),
  );
  const incomeCategories = categories.filter(c =>
    c.group_name.toLowerCase().includes('income'),
  );
  const incomeCatIds = new Set(incomeCategories.map(c => c.id));

  if (housingCat) {
    console.log(`Housing & Utilities: "${housingCat.name}" (${housingCat.id})`);
  } else {
    console.warn('WARNING: Could not find Housing & Utilities category');
  }

  if (diningCat) {
    console.log(`Dining category: "${diningCat.name}" (${diningCat.id})`);
  } else {
    console.warn('WARNING: Could not find Dining & Social category');
  }

  console.log(
    `Income categories: ${incomeCategories.map(c => c.name).join(', ')}`,
  );

  // ── Load all transactions ──
  const accounts = await actualAPI.getAccounts();
  const allTxns = [];
  const seen = new Set();
  for (const acct of accounts) {
    const txns = await actualAPI.getTransactions(acct.id, '2000-01-01', null);
    for (const t of txns) {
      if (!seen.has(t.id) && !t.is_parent) {
        seen.add(t.id);
        allTxns.push(t);
      }
    }
  }
  console.log(
    `\nLoaded ${allTxns.length} transactions across ${accounts.length} accounts\n`,
  );

  // ── Apply rules ──
  const updates = [];

  function getSearchText(t) {
    // Combine imported_payee and notes for pattern matching (payee is a UUID)
    return [t.imported_payee || '', t.notes || ''].join(' ').toUpperCase();
  }

  for (const t of allTxns) {
    const text = getSearchText(t);
    const displayPayee = (t.imported_payee || t.notes || '').substring(0, 40);
    const amt = t.amount; // in cents

    // Rule 2: Credit Card Payments — match on notes field
    if (
      text.includes('AMERICAN EXPRESS ACH PMT') ||
      text.includes('CHASE CREDIT CRD EPAY')
    ) {
      if (t.category !== ccPaymentsCat.id) {
        const oldCat = categories.find(c => c.id === t.category);
        updates.push({
          id: t.id,
          category: ccPaymentsCat.id,
          rule: 'Credit Card Payments',
          payee: displayPayee,
          amt: (amt / 100).toFixed(2),
          oldCat: oldCat?.name || '(none)',
        });
      }
    }

    // Rule 3: Transfers (only if currently in Income)
    if (incomeCatIds.has(t.category)) {
      const transferPatterns = [
        'NET/MOBILE',
        'PREARRANGE',
        'MOBILE PAYMENT - THANK YOU',
        'PAYMENT THANK YOU-MOBILE',
        'ONLINE PAYMENT - THANK YOU',
      ];
      if (transferPatterns.some(p => text.includes(p.toUpperCase()))) {
        updates.push({
          id: t.id,
          category: transfersCat.id,
          rule: 'Transfers',
          payee: displayPayee,
          amt: (amt / 100).toFixed(2),
          oldCat: categories.find(c => c.id === t.category)?.name || '(none)',
        });
      }
    }

    // Rule 4: Housing — PURCHASE BANK CHECK OR DRAFT, -$6010
    if (
      text.includes('PURCHASE BANK CHECK OR DRAFT') &&
      amt < 0 &&
      housingCat
    ) {
      // Match -$6010 specifically (amount = -601000 in cents)
      if (Math.abs(amt) >= 600000 && Math.abs(amt) <= 602000) {
        if (t.category !== housingCat.id) {
          updates.push({
            id: t.id,
            category: housingCat.id,
            rule: 'Housing (rent check)',
            payee: displayPayee,
            amt: (amt / 100).toFixed(2),
            oldCat: categories.find(c => c.id === t.category)?.name || '(none)',
          });
        }
      }
    }

    // Rule 5: Food Delivery — DOORDASH or UBER EATS currently in Dining
    if (diningCat && t.category === diningCat.id) {
      if (text.includes('DOORDASH') || text.includes('UBER EATS')) {
        updates.push({
          id: t.id,
          category: foodDeliveryCat.id,
          rule: 'Food Delivery',
          payee: displayPayee,
          amt: (amt / 100).toFixed(2),
          oldCat: diningCat.name,
        });
      }
    }
  }

  // ── Print results ──
  console.log(
    '── Planned Changes ─────────────────────────────────────────────',
  );
  const byRule = {};
  for (const u of updates) {
    if (!byRule[u.rule]) byRule[u.rule] = [];
    byRule[u.rule].push(u);
  }

  for (const [rule, items] of Object.entries(byRule)) {
    console.log(`\n  ${rule} (${items.length} transactions):`);
    for (const u of items) {
      const sign = parseFloat(u.amt) < 0 ? '-' : '+';
      const absAmt = Math.abs(parseFloat(u.amt)).toFixed(2).padStart(9);
      console.log(
        `    ${sign}$${absAmt}  ${u.payee.padEnd(42)} ${u.oldCat} → ${rule}`,
      );
    }
  }

  console.log(
    `\n── Summary ─────────────────────────────────────────────────────`,
  );
  console.log(`  Total updates: ${updates.length}`);
  for (const [rule, items] of Object.entries(byRule)) {
    console.log(`    ${rule}: ${items.length}`);
  }

  // ── Apply ──
  if (!DRY_RUN && updates.length > 0) {
    console.log(`\nApplying ${updates.length} updates and syncing...`);
    for (const u of updates) {
      await actualAPI.updateTransaction(u.id, { category: u.category });
    }
    await actualAPI.sync();
    console.log('Done! Changes synced.');
  } else if (DRY_RUN) {
    console.log('\nDry run complete — no changes written.');
  } else {
    console.log('\nNo changes to apply.');
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message, e.stack);
  process.exit(1);
});
