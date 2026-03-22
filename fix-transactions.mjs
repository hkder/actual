/**
 * fix-transactions.mjs
 * Fixes miscategorized transactions:
 * 1. Credit card "Payment" transactions → clear category (they're transfers)
 * 2. Chase Auto Loan "Payment" → clear category (it's a loan payoff transfer)
 * 3. Amazon Marketplace transactions → Personal Splurge
 * 4. NTH ST CAFE → Dining & Social (should already be correct, but ensure)
 *
 * Run: node fix-transactions.mjs [--dry-run]
 */

import { mkdirSync, readFileSync } from 'fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const actualAPI = await import('./packages/api/dist/index.js');

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('DRY RUN — no changes will be saved\n');

const DATA_DIR = '/tmp/actual-fix-txns';
const envVars = Object.fromEntries(
  readFileSync(new URL('.actual.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim()))
);
const SERVER_URL = envVars.ACTUAL_SERVER_URL || 'http://localhost:5006';
const PASSWORD = envVars.ACTUAL_PASSWORD;
const BUDGET_ID = envVars.ACTUAL_BUDGET_ID;

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('Connecting...');
  await actualAPI.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD });
  await actualAPI.downloadBudget(BUDGET_ID);
  console.log('Budget loaded.\n');

  const groups = await actualAPI.getCategoryGroups();
  const categories = groups.flatMap(g => g.categories.map(c => ({ ...c, group_name: g.name })));

  const findCat = (groupName, catName) =>
    categories.find(
      c =>
        c.group_name.toLowerCase().includes(groupName.toLowerCase()) &&
        c.name.toLowerCase().includes(catName.toLowerCase()),
    );

  const personalSplurge = findCat('personal', 'splurge') || findCat('', 'personal splurge');
  const diningCat = findCat('dining', '') || findCat('', 'dining');

  console.log('Categories found:');
  console.log(`  Personal Splurge: ${personalSplurge?.id} (${personalSplurge?.name})`);
  console.log(`  Dining & Social:  ${diningCat?.id} (${diningCat?.name})`);
  console.log();

  const accounts = await actualAPI.getAccounts();
  console.log('Accounts:');
  for (const a of accounts) console.log(`  ${a.id.slice(0, 8)} ${a.name} (offbudget: ${!!a.offbudget})`);
  console.log();

  // Find accounts by name patterns — credit cards and charge cards
  const creditCardAccounts = accounts.filter(a =>
    (/amex|american express|visa|mastercard|sapphire|discover.*card|amazon.*rewards/i.test(a.name) ||
     a.name.toLowerCase().includes('credit')) &&
    !a.offbudget &&
    !/auto|loan|checking|savings|401k|hsa|brokerage|splitwise|equity|individual/i.test(a.name),
  );
  const autoLoanAccount = accounts.find(a => /chase auto|auto loan/i.test(a.name));

  console.log('Credit card accounts:', creditCardAccounts.map(a => a.name).join(', '));
  console.log('Auto loan account:', autoLoanAccount?.name ?? 'NOT FOUND');
  console.log();

  const since = '2025-01-01';
  const updates = [];

  // ── 1. Credit card "Payment" transactions → clear category (null = transfer) ──
  console.log('=== Fix 1: Credit card payment transactions ===');
  for (const acct of creditCardAccounts) {
    const txns = await actualAPI.getTransactions(acct.id, since, null);
    const paymentTxns = txns.filter(t => {
      const payee = (t.payee || t.imported_payee || '').toLowerCase();
      const notes = (t.notes || '').toLowerCase();
      return (
        payee.includes('payment') ||
        payee.includes('thank you') ||
        notes.includes('payment') ||
        notes.includes('thank you')
      );
    });

    console.log(`  ${acct.name}: ${paymentTxns.length} payment transactions`);
    for (const t of paymentTxns) {
      const payeeStr = t.payee || t.imported_payee || '';
      const amt = (t.amount / 100).toFixed(2);
      console.log(`    ${t.date} ${payeeStr.padEnd(35)} $${amt}  cat=${t.category || 'none'}`);
      if (t.category) {
        // Only clear if it has a wrong category (income categories)
        // Setting category to null removes it (makes it uncategorized/transfer)
        updates.push({ id: t.id, category: null, reason: `CC payment in ${acct.name}` });
      }
    }
  }

  // ── 2. Chase Auto Loan "Payment" transaction → clear category ──
  console.log('\n=== Fix 2: Chase Auto Loan payment transactions ===');
  if (autoLoanAccount) {
    const txns = await actualAPI.getTransactions(autoLoanAccount.id, since, null);
    const paymentTxns = txns.filter(t => {
      const payee = (t.payee || t.imported_payee || '').toLowerCase();
      return payee.includes('payment') || t.amount > 0;
    });

    console.log(`  Found ${paymentTxns.length} payment/positive transactions in ${autoLoanAccount.name}`);
    for (const t of paymentTxns) {
      const amt = (t.amount / 100).toFixed(2);
      console.log(`    ${t.date} ${(t.payee || t.imported_payee || '').padEnd(35)} $${amt}  cat=${t.category || 'none'}`);
      if (t.category) {
        updates.push({ id: t.id, category: null, reason: 'Auto loan payment (not income)' });
      }
    }
  }

  // ── 3. Amazon Marketplace → Personal Splurge ──
  console.log('\n=== Fix 3: Amazon Marketplace → Personal Splurge ===');
  const amazonDates = new Set([
    '2026-03-11', '2026-03-15', '2026-03-16', '2026-03-17',
  ]);
  const amazonAmounts = new Set([
    -818, -1065, -2699, -2399, -2110, -3995, -745, -25040, // cents (negative = expense)
  ]);

  for (const acct of accounts.filter(a => !a.offbudget)) {
    const txns = await actualAPI.getTransactions(acct.id, '2026-03-01', '2026-03-31');
    const amazonTxns = txns.filter(t => {
      const payee = (t.payee || t.imported_payee || '').toLowerCase();
      const isAmazon =
        payee.includes('amazon') ||
        payee.includes('amzn');
      const onDate = amazonDates.has(t.date);
      const onAmount = amazonAmounts.has(t.amount);
      return isAmazon || (onDate && onAmount);
    });

    if (amazonTxns.length > 0) {
      console.log(`  ${acct.name}: ${amazonTxns.length} Amazon transactions`);
      for (const t of amazonTxns) {
        const amt = (t.amount / 100).toFixed(2);
        console.log(`    ${t.date} ${(t.payee || t.imported_payee || '').padEnd(35)} $${amt}  cat=${t.category || 'none'}`);
        if (personalSplurge && t.category !== personalSplurge.id) {
          updates.push({ id: t.id, category: personalSplurge.id, reason: 'Amazon → Personal Splurge' });
        }
      }
    }
  }

  // ── 4. Also broad search for Amazon in wrong categories ──
  console.log('\n=== Fix 4: Amazon in non-personal categories (broader search) ===');
  for (const acct of accounts.filter(a => !a.offbudget)) {
    const txns = await actualAPI.getTransactions(acct.id, '2025-01-01', null);
    const amazonWrong = txns.filter(t => {
      const payee = (t.payee || t.imported_payee || '').toLowerCase();
      if (!payee.includes('amazon') && !payee.includes('amzn')) return false;
      if (!t.category) return false;
      const cat = categories.find(c => c.id === t.category);
      // Only flag if NOT already in personal splurge
      return !cat?.name.toLowerCase().includes('splurge') &&
             !cat?.name.toLowerCase().includes('personal');
    });

    if (amazonWrong.length > 0) {
      console.log(`  ${acct.name}: ${amazonWrong.length} Amazon transactions in wrong category`);
      for (const t of amazonWrong) {
        const cat = categories.find(c => c.id === t.category);
        const amt = (t.amount / 100).toFixed(2);
        console.log(`    ${t.date} ${(t.payee || t.imported_payee || '').padEnd(35)} $${amt}  → ${cat?.name}`);
        if (personalSplurge) {
          updates.push({ id: t.id, category: personalSplurge.id, reason: 'Amazon → Personal Splurge (broad fix)' });
        }
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  Total updates: ${updates.length}`);
  const grouped = {};
  for (const u of updates) {
    grouped[u.reason] = (grouped[u.reason] || 0) + 1;
  }
  for (const [r, n] of Object.entries(grouped)) {
    console.log(`  ${n.toString().padStart(3)}  ${r}`);
  }

  if (!DRY_RUN && updates.length > 0) {
    console.log('\nApplying updates...');
    for (const u of updates) {
      await actualAPI.updateTransaction(u.id, { category: u.category });
    }
    await actualAPI.sync();
    console.log('Done! Synced.');
  } else if (updates.length > 0) {
    console.log('\nDry run — no changes written.');
  }

  await actualAPI.shutdown();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
