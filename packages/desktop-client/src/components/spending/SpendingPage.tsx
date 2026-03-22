// @ts-strict-ignore
import React, { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgCheveronLeft, SvgCheveronRight } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';

import { q } from 'loot-core/shared/query';
import * as monthUtils from 'loot-core/shared/months';

import { useCategories } from '@desktop-client/hooks/useCategories';
import { useFormat } from '@desktop-client/hooks/useFormat';
import { usePayees } from '@desktop-client/hooks/usePayees';
import { useTransactions } from '@desktop-client/hooks/useTransactions';

const COLORS = [
  '#6C8EBF', '#82B366', '#D6A520', '#AE4132', '#9B59B6',
  '#1ABC9C', '#E67E22', '#3498DB', '#E74C3C', '#2ECC71',
  '#F39C12', '#8E44AD', '#16A085', '#D35400', '#2980B9',
];

type AiStatus = 'idle' | 'loading' | 'done' | 'error';

function formatCurrency(cents: number): string {
  return '$' + Math.abs(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function SpendingPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [currentMonth, setCurrentMonth] = useState(() => monthUtils.currentMonth());
  const [aiText, setAiText] = useState('');
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle');

  const monthStart = monthUtils.firstDayOfMonth(currentMonth);
  const monthEnd = monthUtils.lastDayOfMonth(currentMonth);
  const monthLabel = monthUtils.format(currentMonth, 'MMMM yyyy');

  const { data: categoryData } = useCategories();
  const { data: payeesRaw } = usePayees();
  const payeesList = (payeesRaw ?? []) as Array<{ id: string; name: string }>;

  // Transfer category IDs to exclude
  const transferCatIds = useMemo(() => {
    const group = categoryData?.grouped?.find(g => g.name === 'Transfers & Payments');
    return new Set((group?.categories ?? []).map(c => c.id));
  }, [categoryData]);

  const catById = useMemo(() => {
    const m = new Map<string, { name: string; isIncome: boolean }>();
    for (const g of categoryData?.grouped ?? []) {
      for (const c of g.categories) {
        m.set(c.id, { name: c.name, isIncome: !!g.is_income });
      }
    }
    return m;
  }, [categoryData]);

  const payeeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of payeesList) m.set(p.id, p.name);
    return m;
  }, [payeesList]);

  // Memoize the query object so it only changes when the month changes
  const txnQuery = useMemo(
    () =>
      q('transactions')
        .filter({ date: { $gte: monthStart, $lte: monthEnd } })
        .filter({ is_parent: false })
        .select(['id', 'amount', 'category', 'payee', 'imported_payee', 'date']),
    [monthStart, monthEnd],
  );

  const { transactions, isLoading } = useTransactions({
    query: txnQuery,
    options: { pageSize: 2000 },
  });

  // Spending by category (expenses only, exclude transfers/income)
  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      if (!t.category) continue;
      if (transferCatIds.has(t.category)) continue;
      const cat = catById.get(t.category);
      if (!cat || cat.isIncome) continue;
      totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
    }
    return Array.from(totals.entries())
      .map(([id, amount]) => ({ id, name: catById.get(id)?.name ?? 'Unknown', amount }))
      .sort((a, b) => a.amount - b.amount);
  }, [transactions, catById, transferCatIds]);

  const totalSpending = categoryTotals.reduce((s, c) => s + c.amount, 0);

  const pieData = categoryTotals.map(c => ({
    name: c.name,
    value: Math.abs(c.amount),
  }));

  // Top payees (expenses, exclude transfers)
  const payeeTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      if (t.category && transferCatIds.has(t.category)) continue;
      const name = t.payee
        ? (payeeById.get(t.payee) ?? t.imported_payee ?? 'Unknown')
        : (t.imported_payee ?? 'Unknown');
      totals.set(name, (totals.get(name) ?? 0) + t.amount);
    }
    return Array.from(totals.entries())
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => a.amount - b.amount)
      .slice(0, 12);
  }, [transactions, payeeById, transferCatIds]);

  async function handleAiAnalysis() {
    setAiStatus('loading');
    setAiText('');
    try {
      const catSummary = categoryTotals
        .map(c => `${c.name}: ${formatCurrency(c.amount)}`)
        .join('\n');
      const payeeSummary = payeeTotals.slice(0, 10)
        .map(p => `${p.name}: ${formatCurrency(p.amount)}`)
        .join('\n');

      const prompt = `You are a personal finance advisor. Here is ${monthLabel} spending data:\n\nSPENDING BY CATEGORY:\n${catSummary}\n\nTOP PAYEES:\n${payeeSummary}\n\nTotal spending: ${formatCurrency(totalSpending)}\n\nGive a brief, actionable analysis (3-4 sentences):\n1. Biggest spending area and whether it's normal\n2. One specific thing that stands out as reducible\n3. One concrete recommendation to save $100+/month\n\nBe direct and specific.`;

      // Try the server-side AI proxy
      const tryFetch = async (url: string) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };

      let data;
      try { data = await tryFetch('/ai/anthropic'); }
      catch { data = await tryFetch('/api/ai/anthropic'); }

      setAiText(data?.content?.[0]?.text ?? 'No response from AI.');
      setAiStatus('done');
    } catch (e) {
      setAiStatus('error');
      setAiText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const card = (children: React.ReactNode) => (
    <View style={{
      backgroundColor: theme.tableBackground,
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      {children}
    </View>
  );

  const sectionLabel = (label: string) => (
    <View style={{
      fontSize: 11,
      fontWeight: 600,
      color: theme.pageTextSubdued,
      marginBottom: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    }}>
      {label}
    </View>
  );

  return (
    <View style={{
      flex: 1,
      padding: '16px 20px',
      overflowY: 'auto',
      backgroundColor: theme.pageBackground,
    }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 8 }}>
        <View style={{ flex: 1, fontSize: 18, fontWeight: 700, color: theme.pageText }}>
          <Trans>Spending</Trans>
        </View>
        <Button variant="bare" onPress={() => setCurrentMonth(m => monthUtils.subMonths(m, 1))}>
          <SvgCheveronLeft width={16} height={16} />
        </Button>
        <View style={{ fontSize: 14, fontWeight: 600, color: theme.pageText, minWidth: 110, textAlign: 'center' }}>
          {monthLabel}
        </View>
        <Button variant="bare" onPress={() => setCurrentMonth(m => monthUtils.addMonths(m, 1))}>
          <SvgCheveronRight width={16} height={16} />
        </Button>
      </View>

      {isLoading ? (
        <View style={{ color: theme.pageTextSubdued, fontSize: 14, textAlign: 'center', marginTop: 40 }}>
          <Trans>Loading…</Trans>
        </View>
      ) : transactions.length === 0 ? (
        <View style={{ color: theme.pageTextSubdued, fontSize: 14, textAlign: 'center', marginTop: 40 }}>
          <Trans>No transactions for this month.</Trans>
        </View>
      ) : (
        <>
          {/* Donut + total */}
          {card(<>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              {pieData.length > 0 && (
                <PieChart width={180} height={180}>
                  <Pie data={pieData} cx={90} cy={86} innerRadius={45} outerRadius={80} paddingAngle={2} dataKey="value">
                    {pieData.map((_, idx) => (
                      <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => ['$' + (value / 100).toFixed(2)]}
                    contentStyle={{ fontSize: 11, backgroundColor: theme.menuBackground, border: `1px solid ${theme.menuBorder}`, color: theme.menuItemText }}
                  />
                </PieChart>
              )}
              <View style={{ flex: 1 }}>
                {sectionLabel(t('Total Spending'))}
                <View style={{ fontSize: 28, fontWeight: 700, color: theme.errorText, marginBottom: 12 }}>
                  {formatCurrency(totalSpending)}
                </View>
                {/* Category legend */}
                {categoryTotals.slice(0, 6).map((cat, idx) => (
                  <View key={cat.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: COLORS[idx % COLORS.length], flexShrink: 0 }} />
                    <View style={{ flex: 1, fontSize: 12, color: theme.pageText }}>{cat.name}</View>
                    <View style={{ fontSize: 12, color: theme.errorText, fontWeight: 500 }}>{formatCurrency(cat.amount)}</View>
                  </View>
                ))}
              </View>
            </View>
          </>)}

          {/* Full category breakdown */}
          {card(<>
            {sectionLabel(t('By Category'))}
            {categoryTotals.map((cat, idx) => {
              const pct = totalSpending !== 0 ? (cat.amount / totalSpending) * 100 : 0;
              return (
                <View key={cat.id} style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 5, paddingBottom: 5, borderBottom: `1px solid ${theme.tableBorder}`, gap: 8 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: COLORS[idx % COLORS.length], flexShrink: 0 }} />
                  <View style={{ flex: 1, fontSize: 13, color: theme.pageText }}>{cat.name}</View>
                  <View style={{ width: 70, height: 5, backgroundColor: theme.tableBorder, borderRadius: 3, overflow: 'hidden' }}>
                    <View style={{ width: `${Math.abs(pct)}%`, height: '100%', backgroundColor: COLORS[idx % COLORS.length] }} />
                  </View>
                  <View style={{ fontSize: 13, color: theme.errorText, fontWeight: 500, minWidth: 75, textAlign: 'right' }}>{formatCurrency(cat.amount)}</View>
                  <View style={{ fontSize: 11, color: theme.pageTextSubdued, minWidth: 30, textAlign: 'right' }}>{Math.abs(pct).toFixed(0)}%</View>
                </View>
              );
            })}
          </>)}

          {/* Top payees */}
          {card(<>
            {sectionLabel(t('Top Payees'))}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {payeeTotals.map((p, idx) => (
                <View key={p.name} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.tableRowBackgroundHover, borderRadius: 6, padding: '5px 10px', gap: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 3, backgroundColor: COLORS[idx % COLORS.length], flexShrink: 0 }} />
                  <View style={{ fontSize: 12, color: theme.pageText }}>{p.name.length > 24 ? p.name.slice(0, 22) + '…' : p.name}</View>
                  <View style={{ fontSize: 12, color: theme.errorText, fontWeight: 600 }}>{formatCurrency(p.amount)}</View>
                </View>
              ))}
            </View>
          </>)}

          {/* AI Analysis */}
          {card(<>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: aiStatus !== 'idle' ? 12 : 0, gap: 8 }}>
              <View style={{ flex: 1, fontSize: 11, fontWeight: 600, color: theme.pageTextSubdued, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                <Trans>AI Analysis</Trans>
              </View>
              <Button variant="primary" onPress={handleAiAnalysis} isDisabled={aiStatus === 'loading'} style={{ fontSize: 13 }}>
                {aiStatus === 'loading' ? t('Analyzing…') : t('Analyze with AI')}
              </Button>
            </View>
            {aiStatus !== 'idle' && (
              <View style={{ fontSize: 13, lineHeight: 1.6, color: aiStatus === 'error' ? theme.errorText : theme.pageText, whiteSpace: 'pre-wrap' }}>
                {aiStatus === 'loading' ? <View style={{ color: theme.pageTextSubdued }}><Trans>Thinking…</Trans></View> : aiText}
              </View>
            )}
          </>)}
        </>
      )}
    </View>
  );
}
