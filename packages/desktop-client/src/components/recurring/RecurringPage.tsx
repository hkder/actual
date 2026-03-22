import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAdd, SvgRefresh } from '@actual-app/components/icons/v1';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { q } from 'loot-core/shared/query';

import { FinancialText } from '@desktop-client/components/FinancialText';
import { PrivacyFilter } from '@desktop-client/components/PrivacyFilter';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useFormat } from '@desktop-client/hooks/useFormat';
import { usePayees } from '@desktop-client/hooks/usePayees';
import { useTransactions } from '@desktop-client/hooks/useTransactions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

type RecurringItem = {
  payeeId: string;
  payeeName: string;
  categoryId: string | null;
  categoryName: string;
  frequency: Frequency;
  avgAmount: number;
  lastDate: string;
  nextExpected: string;
  occurrences: number;
  dismissed: boolean;
  confirmed: boolean;
  isManual?: boolean;
};

type ManualRecurringItem = {
  id: string;
  payeeName: string;
  amount: number;
  frequency: Frequency;
  startDate: string;
  categoryId: string | null;
  categoryName: string;
};

type SortField = 'payee' | 'amount' | 'frequency' | 'nextDate';
type SortDirection = 'asc' | 'desc';

type DetailTransaction = {
  id: string;
  date: string;
  amount: number;
  accountName: string;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

const FREQUENCY_MONTHLY_FACTOR: Record<Frequency, number> = {
  weekly: 4.33,
  biweekly: 2.17,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

const MANUAL_STORAGE_KEY = 'actual-recurring-manual';
const CONFIRMED_STORAGE_KEY = 'actual-recurring-confirmed';
const DISMISSED_STORAGE_KEY = 'actual-recurring-dismissed';

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveStringSet(key: string, set: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

/** Parse a YYYY-MM-DD string into a Date object (UTC noon to avoid DST issues). */
function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/** Format a Date to YYYY-MM-DD. */
function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format a YYYY-MM-DD string to a human-friendly display (e.g. "Mar 15, 2026"). */
function formatDisplayDate(dateStr: string): string {
  const d = parseDate(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Return today as a YYYY-MM-DD string. */
function today(): string {
  return formatDate(new Date());
}

/** Return the number of days between two YYYY-MM-DD strings (positive = future). */
function daysDiff(dateStr: string): number {
  const target = parseDate(dateStr);
  const now = parseDate(today());
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

/** Compute median gap in days between sorted date strings. */
function medianGapDays(sortedDates: string[]): number | null {
  if (sortedDates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = parseDate(sortedDates[i - 1]);
    const curr = parseDate(sortedDates[i]);
    gaps.push((curr.getTime() - prev.getTime()) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
}

/** Map median gap to a frequency label. */
function gapToFrequency(gapDays: number): Frequency {
  if (gapDays <= 10) return 'weekly';
  if (gapDays <= 20) return 'biweekly';
  if (gapDays <= 45) return 'monthly';
  if (gapDays <= 120) return 'quarterly';
  return 'yearly';
}

/** Advance a date string by approximately one period of the given frequency. */
function addPeriod(dateStr: string, freq: Frequency): string {
  const d = parseDate(dateStr);
  switch (freq) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      break;
  }
  return formatDate(d);
}

/** Compute next expected date after lastDate, projected forward past today. */
function nextExpectedDate(lastDate: string, freq: Frequency): string {
  let next = addPeriod(lastDate, freq);
  const todayStr = today();
  // Keep advancing until we are in the future
  while (next <= todayStr) {
    next = addPeriod(next, freq);
  }
  return next;
}

/** Load manually added recurring items from localStorage. */
function loadManualItems(): ManualRecurringItem[] {
  try {
    const raw = localStorage.getItem(MANUAL_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ManualRecurringItem[];
  } catch {
    return [];
  }
}

/** Save manually added recurring items to localStorage. */
function saveManualItems(items: ManualRecurringItem[]): void {
  try {
    localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

type RawTxn = {
  payee?: string | null;
  category?: string | null;
  amount: number;
  date: string;
};

/**
 * Analyse raw transactions and return a list of detected recurring items.
 * A payee is considered recurring if it appears at least 3 times within the
 * lookback period AND the median gap between occurrences fits one of the
 * supported frequencies.
 */
function detectRecurring(
  transactions: readonly RawTxn[],
  payeeMap: Map<string, string>,
  categoryMap: Map<string, string>,
): RecurringItem[] {
  // Group by payee, only expenses (negative amounts)
  const byPayee = new Map<
    string,
    { dates: string[]; amounts: number[]; category: string | null }
  >();

  for (const txn of transactions) {
    if (!txn.payee || txn.amount >= 0) continue;
    const existing = byPayee.get(txn.payee);
    if (existing) {
      existing.dates.push(txn.date);
      existing.amounts.push(Math.abs(txn.amount));
    } else {
      byPayee.set(txn.payee, {
        dates: [txn.date],
        amounts: [Math.abs(txn.amount)],
        category: txn.category ?? null,
      });
    }
    // Update category to the most recent one (dates processed in desc order)
    const entry = byPayee.get(txn.payee)!;
    if (txn.category && !entry.category) {
      entry.category = txn.category;
    }
  }

  const results: RecurringItem[] = [];

  for (const [payeeId, { dates, amounts, category }] of byPayee.entries()) {
    if (dates.length < 3) continue;

    // Sort dates ascending for gap analysis
    const sorted = [...dates].sort();
    const gap = medianGapDays(sorted);
    if (gap === null) continue;

    // Reject very irregular patterns: require median gap to be somewhat consistent
    // (coefficient of variation of gaps < 0.5 for most frequencies)
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(
        (parseDate(sorted[i]).getTime() - parseDate(sorted[i - 1]).getTime()) /
          86400000,
      );
    }
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance =
      gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length;
    const cv = Math.sqrt(variance) / meanGap;
    if (cv > 0.6) continue; // too irregular

    const freq = gapToFrequency(gap);
    const lastDate = sorted[sorted.length - 1];
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;

    results.push({
      payeeId,
      payeeName: payeeMap.get(payeeId) ?? payeeId,
      categoryId: category,
      categoryName: category ? (categoryMap.get(category) ?? '') : '',
      frequency: freq,
      avgAmount: Math.round(avgAmount),
      lastDate,
      nextExpected: nextExpectedDate(lastDate, freq),
      occurrences: dates.length,
      dismissed: false,
      confirmed: false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecurringPage() {
  const { t } = useTranslation();
  const format = useFormat();

  const { data: payees = [] } = usePayees();
  const { data: accounts = [] } = useAccounts();
  const { data: categories = { grouped: [], list: [] } } = useCategories();

  const [sortField, setSortField] = useState<SortField>('amount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    loadStringSet(DISMISSED_STORAGE_KEY),
  );
  const [confirmed, setConfirmed] = useState<Set<string>>(() =>
    loadStringSet(CONFIRMED_STORAGE_KEY),
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [manualItems, setManualItems] =
    useState<ManualRecurringItem[]>(loadManualItems);
  const [showAddForm, setShowAddForm] = useState(false);

  // Build lookup maps
  const payeeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of payees) m.set(p.id, p.name);
    return m;
  }, [payees]);

  const categoryMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories.list) m.set(c.id, c.name);
    return m;
  }, [categories.list]);

  const accountMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  // Fetch last 13 months of transactions for analysis
  const lookbackDate = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 13);
    return formatDate(d);
  }, []);

  const txnQuery = useMemo(
    () =>
      q('transactions')
        .filter({ date: { $gte: lookbackDate }, is_parent: false })
        .select(['payee', 'category', 'amount', 'date'])
        .orderBy({ date: 'desc' }),
    [lookbackDate],
  );

  const { transactions, isLoading } = useTransactions({
    query: txnQuery,
    options: { pageSize: 2000 },
  });

  // Fetch all transactions for detail expansion (with account info)
  const detailTxnQuery = useMemo(
    () =>
      q('transactions')
        .filter({ date: { $gte: lookbackDate }, is_parent: false })
        .select(['id', 'payee', 'date', 'amount', 'account', 'notes'])
        .orderBy({ date: 'desc' }),
    [lookbackDate],
  );

  const { transactions: detailTransactions } = useTransactions({
    query: detailTxnQuery,
    options: { pageSize: 5000 },
  });

  // Build a map of payeeId -> detail transactions
  const detailByPayee = useMemo(() => {
    const m = new Map<string, DetailTransaction[]>();
    for (const txn of detailTransactions) {
      if (!txn.payee) continue;
      const payeeId = txn.payee as string;
      const entry: DetailTransaction = {
        id: txn.id,
        date: txn.date as string,
        amount: txn.amount as number,
        accountName:
          accountMap.get(txn.account as string) ?? (txn.account as string),
        notes: (txn.notes as string | null) ?? null,
      };
      const list = m.get(payeeId);
      if (list) {
        list.push(entry);
      } else {
        m.set(payeeId, [entry]);
      }
    }
    return m;
  }, [detailTransactions, accountMap]);

  // Detect recurring items
  const allRecurring = useMemo(
    () => detectRecurring(transactions, payeeMap, categoryMap),
    [transactions, payeeMap, categoryMap],
  );

  // Apply dismissed / confirmed state and sort
  const recurringItems = useMemo(() => {
    const items = allRecurring
      .filter(item => !dismissed.has(item.payeeId))
      .map(item => ({
        ...item,
        confirmed: confirmed.has(item.payeeId),
      }));

    items.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'payee':
          cmp = a.payeeName.localeCompare(b.payeeName);
          break;
        case 'amount':
          cmp = a.avgAmount - b.avgAmount;
          break;
        case 'frequency': {
          const order: Frequency[] = [
            'weekly',
            'biweekly',
            'monthly',
            'quarterly',
            'yearly',
          ];
          cmp = order.indexOf(a.frequency) - order.indexOf(b.frequency);
          break;
        }
        case 'nextDate':
          cmp = a.nextExpected.localeCompare(b.nextExpected);
          break;
        default:
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return items;
  }, [allRecurring, dismissed, confirmed, sortField, sortDirection]);

  // Convert manual items to RecurringItems
  const manualRecurringItems = useMemo((): RecurringItem[] => {
    return manualItems.map(m => ({
      payeeId: m.id,
      payeeName: m.payeeName,
      categoryId: m.categoryId,
      categoryName: m.categoryName,
      frequency: m.frequency,
      avgAmount: m.amount,
      lastDate: m.startDate,
      nextExpected: nextExpectedDate(m.startDate, m.frequency),
      occurrences: 1,
      dismissed: false,
      confirmed: true,
      isManual: true,
    }));
  }, [manualItems]);

  // Split into confirmed and auto-detected sections
  const confirmedItems = useMemo(() => {
    const autoConfirmed = recurringItems.filter(i => i.confirmed);
    return [...manualRecurringItems, ...autoConfirmed];
  }, [recurringItems, manualRecurringItems]);

  const autoDetectedItems = useMemo(
    () => recurringItems.filter(i => !i.confirmed),
    [recurringItems],
  );

  // Total monthly cost estimate across all items
  const totalMonthly = useMemo(
    () =>
      [...confirmedItems, ...autoDetectedItems].reduce(
        (sum, item) =>
          sum + item.avgAmount * FREQUENCY_MONTHLY_FACTOR[item.frequency],
        0,
      ),
    [confirmedItems, autoDetectedItems],
  );

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'nextDate' ? 'asc' : 'desc');
    }
  }

  function handleDismiss(payeeId: string) {
    setDismissed(prev => {
      const next = new Set([...prev, payeeId]);
      saveStringSet(DISMISSED_STORAGE_KEY, next);
      return next;
    });
  }

  function handleConfirm(payeeId: string) {
    setConfirmed(prev => {
      const next = new Set(prev);
      if (next.has(payeeId)) {
        next.delete(payeeId);
      } else {
        next.add(payeeId);
      }
      saveStringSet(CONFIRMED_STORAGE_KEY, next);
      return next;
    });
  }

  function handleToggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleAddManual(item: ManualRecurringItem) {
    const updated = [...manualItems, item];
    setManualItems(updated);
    saveManualItems(updated);
    setShowAddForm(false);
  }

  function handleRemoveManual(id: string) {
    const updated = manualItems.filter(m => m.id !== id);
    setManualItems(updated);
    saveManualItems(updated);
  }

  const allItems = [...confirmedItems, ...autoDetectedItems];
  const hasItems = allItems.length > 0 || manualItems.length > 0;

  const tableHeader = (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.tableHeaderBackground,
        borderBottom: `1px solid ${theme.tableBorder}`,
      }}
    >
      {/* Expand toggle column */}
      <View style={{ width: 32, padding: '8px 4px' }} />
      <RecurringSortHeader
        label={t('Payee')}
        field="payee"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        style={{ flex: 2 }}
      />
      <RecurringSortHeader
        label={t('Category')}
        field="payee"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        style={{ flex: 1 }}
        noSort
      />
      <RecurringSortHeader
        label={t('Frequency')}
        field="frequency"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        style={{ width: 110 }}
      />
      <RecurringSortHeader
        label={t('Avg. amount')}
        field="amount"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        style={{ width: 120, justifyContent: 'flex-end' }}
      />
      <RecurringSortHeader
        label={t('Next expected')}
        field="nextDate"
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        style={{ width: 160 }}
      />
      {/* Actions column header */}
      <View style={{ width: 140, padding: '8px 12px' }} />
    </View>
  );

  return (
    <View
      style={{
        flex: 1,
        padding: 20,
        paddingTop: 50,
        maxWidth: 960,
        width: '100%',
        marginInline: 'auto',
      }}
    >
      {/* Page heading */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 24,
          gap: 12,
        }}
      >
        <SvgRefresh
          style={{ width: 22, height: 22, color: theme.pageTextPositive }}
        />
        <Text style={{ fontSize: 22, fontWeight: 700, color: theme.pageText }}>
          <Trans>Recurring Expenses</Trans>
        </Text>
        <View style={{ flex: 1 }} />
        <Button
          variant="primary"
          onPress={() => setShowAddForm(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <SvgAdd style={{ width: 14, height: 14 }} />
          <Trans>Add Recurring</Trans>
        </Button>
      </View>

      {/* Inline "Add Recurring" form */}
      {showAddForm && (
        <AddRecurringForm
          categories={categories.list}
          onAdd={handleAddManual}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Summary card */}
      {!isLoading && hasItems && (
        <View
          style={{
            backgroundColor: theme.tableBackground,
            border: `1px solid ${theme.tableBorder}`,
            borderRadius: 8,
            padding: 20,
            marginBottom: 24,
            flexDirection: 'row',
            gap: 40,
          }}
        >
          <View>
            <Text
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                color: theme.pageTextSubdued,
                marginBottom: 4,
              }}
            >
              <Trans>Est. monthly total</Trans>
            </Text>
            <PrivacyFilter>
              <FinancialText
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: theme.errorText,
                }}
              >
                {format(-Math.round(totalMonthly), 'financial')}
              </FinancialText>
            </PrivacyFilter>
          </View>
          <View>
            <Text
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                color: theme.pageTextSubdued,
                marginBottom: 4,
              }}
            >
              <Trans>Detected recurring</Trans>
            </Text>
            <Text
              style={{ fontSize: 28, fontWeight: 700, color: theme.pageText }}
            >
              {allItems.length}
            </Text>
          </View>
          <View>
            <Text
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                color: theme.pageTextSubdued,
                marginBottom: 4,
              }}
            >
              <Trans>Confirmed</Trans>
            </Text>
            <Text
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: theme.noticeTextLight,
              }}
            >
              {confirmedItems.length}
            </Text>
          </View>
        </View>
      )}

      {/* Loading */}
      {isLoading && (
        <View
          style={{
            height: 300,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>Analysing transactions…</Trans>
          </Text>
        </View>
      )}

      {/* Empty state */}
      {!isLoading && !hasItems && (
        <View
          style={{
            height: 200,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.pageTextSubdued, fontSize: 15 }}>
            <Trans>
              No recurring transactions detected yet. Add more transaction
              history for better detection.
            </Trans>
          </Text>
        </View>
      )}

      {/* Table */}
      {!isLoading && hasItems && (
        <View
          style={{
            border: `1px solid ${theme.tableBorder}`,
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          {tableHeader}

          <View style={{ maxHeight: 700, overflow: 'auto' }}>
            {/* Confirmed section */}
            {confirmedItems.length > 0 && (
              <>
                <SectionHeader label={t('Confirmed')} isConfirmed />
                {confirmedItems.map(item => (
                  <RecurringRow
                    key={item.payeeId}
                    item={item}
                    format={format}
                    isExpanded={expandedIds.has(item.payeeId)}
                    detailTransactions={detailByPayee.get(item.payeeId) ?? []}
                    onDismiss={handleDismiss}
                    onConfirm={handleConfirm}
                    onToggleExpand={handleToggleExpand}
                    onRemoveManual={
                      item.isManual ? handleRemoveManual : undefined
                    }
                  />
                ))}
              </>
            )}

            {/* Auto-detected section */}
            {autoDetectedItems.length > 0 && (
              <>
                <SectionHeader label={t('Auto-detected')} isConfirmed={false} />
                {autoDetectedItems.map(item => (
                  <RecurringRow
                    key={item.payeeId}
                    item={item}
                    format={format}
                    isExpanded={expandedIds.has(item.payeeId)}
                    detailTransactions={detailByPayee.get(item.payeeId) ?? []}
                    onDismiss={handleDismiss}
                    onConfirm={handleConfirm}
                    onToggleExpand={handleToggleExpand}
                  />
                ))}
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

type SectionHeaderProps = {
  label: string;
  isConfirmed: boolean;
};

function SectionHeader({ label, isConfirmed }: SectionHeaderProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        padding: '6px 12px',
        backgroundColor: isConfirmed
          ? `${theme.noticeBackground}44`
          : theme.tableHeaderBackground,
        borderBottom: `1px solid ${theme.tableBorder}`,
        gap: 8,
      }}
    >
      {isConfirmed && (
        <Text style={{ fontSize: 13, color: theme.noticeTextLight }}>✓</Text>
      )}
      <Text
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'uppercase',
          color: isConfirmed ? theme.noticeTextLight : theme.pageTextSubdued,
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sort header
// ---------------------------------------------------------------------------

type RecurringSortHeaderProps = {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  style?: CSSProperties;
  noSort?: boolean;
};

function RecurringSortHeader({
  label,
  field,
  sortField,
  sortDirection,
  onSort,
  style,
  noSort = false,
}: RecurringSortHeaderProps) {
  const isActive = !noSort && field === sortField;

  if (noSort) {
    return (
      <View style={{ padding: '8px 12px', ...style }}>
        <Text
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: theme.pageTextSubdued,
          }}
        >
          {label}
        </Text>
      </View>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      style={{
        display: 'flex',
        padding: '8px 12px',
        cursor: 'pointer',
        userSelect: 'none',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        border: 'none',
        background: 'none',
        ...style,
      }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase',
          color: isActive ? theme.pageText : theme.pageTextSubdued,
        }}
      >
        {label}
        {isActive && (sortDirection === 'asc' ? ' ↑' : ' ↓')}
      </Text>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

type RecurringRowProps = {
  item: RecurringItem;
  format: ReturnType<typeof useFormat>;
  isExpanded: boolean;
  detailTransactions: DetailTransaction[];
  onDismiss: (payeeId: string) => void;
  onConfirm: (payeeId: string) => void;
  onToggleExpand: (id: string) => void;
  onRemoveManual?: (id: string) => void;
};

function RecurringRow({
  item,
  format,
  isExpanded,
  detailTransactions,
  onDismiss,
  onConfirm,
  onToggleExpand,
  onRemoveManual,
}: RecurringRowProps) {
  const { t } = useTranslation();

  const diff = daysDiff(item.nextExpected);
  const isOverdue = diff < 0;
  const isUpcoming = !isOverdue && diff <= 7;
  const nextDateColor = isOverdue
    ? theme.errorText
    : isUpcoming
      ? theme.warningText
      : theme.pageText;

  const nextDateLabel = isOverdue
    ? `${formatDisplayDate(item.nextExpected)} (${t('overdue by {{n}} day', { count: Math.abs(diff), n: Math.abs(diff) })})`
    : diff === 0
      ? `${formatDisplayDate(item.nextExpected)} (${t('today')})`
      : `${formatDisplayDate(item.nextExpected)} (${t('in {{n}} days', { count: diff, n: diff })})`;

  return (
    <>
      {/* Main row */}
      <View
        style={{
          flexDirection: 'row',
          borderBottom: isExpanded ? 'none' : `1px solid ${theme.tableBorder}`,
          backgroundColor: item.confirmed
            ? `${theme.noticeBackground}22`
            : 'transparent',
          alignItems: 'center',
          cursor: 'pointer',
        }}
        onClick={() => onToggleExpand(item.payeeId)}
      >
        {/* Expand chevron */}
        <View
          style={{
            width: 32,
            padding: '10px 4px',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            style={{
              fontSize: 10,
              color: theme.pageTextSubdued,
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}
          >
            ▶
          </Text>
        </View>

        {/* Payee */}
        <View style={{ flex: 2, padding: '10px 12px' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text
              style={{
                fontSize: 13,
                color: theme.pageText,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: item.confirmed ? 600 : 400,
              }}
            >
              {item.payeeName}
            </Text>
            {item.isManual && (
              <View
                style={{
                  backgroundColor: theme.noticeBackground,
                  border: `1px solid ${theme.noticeBorder}`,
                  borderRadius: 3,
                  padding: '1px 5px',
                }}
              >
                <Text
                  style={{
                    fontSize: 10,
                    color: theme.noticeTextLight,
                    fontWeight: 600,
                  }}
                >
                  <Trans>Manual</Trans>
                </Text>
              </View>
            )}
          </View>
          {!item.isManual && (
            <Text
              style={{
                fontSize: 11,
                color: theme.pageTextSubdued,
                marginTop: 2,
              }}
            >
              {t('{{count}} occurrences', { count: item.occurrences })}
            </Text>
          )}
        </View>

        {/* Category */}
        <View style={{ flex: 1, padding: '10px 12px' }}>
          <Text
            style={{
              fontSize: 13,
              color: item.categoryName ? theme.pageText : theme.pageTextSubdued,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.categoryName || t('Uncategorized')}
          </Text>
        </View>

        {/* Frequency */}
        <View style={{ width: 110, padding: '10px 12px' }}>
          <Text style={{ fontSize: 13, color: theme.pageText }}>
            {FREQUENCY_LABEL[item.frequency]}
          </Text>
        </View>

        {/* Amount */}
        <View
          style={{
            width: 120,
            padding: '10px 12px',
            alignItems: 'flex-end',
          }}
        >
          <PrivacyFilter>
            <FinancialText
              style={{ fontSize: 13, fontWeight: 600, color: theme.errorText }}
            >
              {format(-item.avgAmount, 'financial')}
            </FinancialText>
          </PrivacyFilter>
        </View>

        {/* Next date with countdown */}
        <View style={{ width: 160, padding: '10px 12px' }}>
          <Text
            style={{
              fontSize: 12,
              color: nextDateColor,
              fontWeight: isOverdue || isUpcoming ? 600 : 400,
              whiteSpace: 'normal',
              lineHeight: '1.4',
            }}
          >
            {nextDateLabel}
          </Text>
        </View>

        {/* Actions */}
        <View
          style={{
            width: 140,
            padding: '10px 12px',
            flexDirection: 'row',
            gap: 6,
            justifyContent: 'flex-end',
          }}
          onClick={e => e.stopPropagation()}
        >
          {!item.isManual && (
            <>
              <Button
                variant={item.confirmed ? 'normal' : 'bare'}
                onPress={() => onConfirm(item.payeeId)}
                style={{ fontSize: 11, padding: '3px 8px' }}
              >
                {item.confirmed ? (
                  <Trans>Confirmed</Trans>
                ) : (
                  <Trans>Confirm</Trans>
                )}
              </Button>
              <Button
                variant="bare"
                onPress={() => onDismiss(item.payeeId)}
                style={{ fontSize: 11, padding: '3px 8px' }}
              >
                <Trans>Dismiss</Trans>
              </Button>
            </>
          )}
          {item.isManual && onRemoveManual && (
            <Button
              variant="bare"
              onPress={() => onRemoveManual(item.payeeId)}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                color: theme.errorText,
              }}
            >
              <Trans>Remove</Trans>
            </Button>
          )}
        </View>
      </View>

      {/* Expanded detail sub-table */}
      {isExpanded && (
        <TransactionDetailTable
          transactions={detailTransactions}
          format={format}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Transaction detail sub-table
// ---------------------------------------------------------------------------

type TransactionDetailTableProps = {
  transactions: DetailTransaction[];
  format: ReturnType<typeof useFormat>;
};

function TransactionDetailTable({
  transactions,
  format,
}: TransactionDetailTableProps) {
  const { t } = useTranslation();

  if (transactions.length === 0) {
    return (
      <View
        style={{
          backgroundColor: theme.tableRowBackgroundHover,
          borderBottom: `1px solid ${theme.tableBorder}`,
          padding: '10px 16px',
        }}
      >
        <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
          <Trans>No transaction history available.</Trans>
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        backgroundColor: theme.tableRowBackgroundHover,
        borderBottom: `1px solid ${theme.tableBorder}`,
      }}
    >
      {/* Sub-header */}
      <View
        style={{
          flexDirection: 'row',
          padding: '6px 16px 6px 48px',
          borderBottom: `1px solid ${theme.tableBorderHover}`,
        }}
      >
        <Text
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: theme.pageTextSubdued,
          }}
        >
          <Trans>Date</Trans>
        </Text>
        <Text
          style={{
            width: 120,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: theme.pageTextSubdued,
            textAlign: 'right',
          }}
        >
          <Trans>Amount</Trans>
        </Text>
        <Text
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: theme.pageTextSubdued,
            paddingLeft: 16,
          }}
        >
          <Trans>Account</Trans>
        </Text>
        <Text
          style={{
            flex: 2,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: theme.pageTextSubdued,
            paddingLeft: 16,
          }}
        >
          <Trans>Notes</Trans>
        </Text>
      </View>

      {/* Transaction rows */}
      {transactions.slice(0, 20).map(txn => {
        const isExpense = txn.amount < 0;
        const amountColor = isExpense ? theme.errorText : theme.noticeTextLight;
        return (
          <View
            key={txn.id}
            style={{
              flexDirection: 'row',
              padding: '6px 16px 6px 48px',
              borderBottom: `1px solid ${theme.tableBorderHover}`,
              alignItems: 'center',
            }}
          >
            <Text style={{ flex: 1, fontSize: 12, color: theme.pageText }}>
              {formatDisplayDate(txn.date)}
            </Text>
            <View style={{ width: 120, alignItems: 'flex-end' }}>
              <PrivacyFilter>
                <FinancialText
                  style={{ fontSize: 12, fontWeight: 600, color: amountColor }}
                >
                  {format(txn.amount, 'financial')}
                </FinancialText>
              </PrivacyFilter>
            </View>
            <Text
              style={{
                flex: 1,
                fontSize: 12,
                color: theme.pageTextSubdued,
                paddingLeft: 16,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {txn.accountName}
            </Text>
            <Text
              style={{
                flex: 2,
                fontSize: 12,
                color: theme.pageTextSubdued,
                paddingLeft: 16,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {txn.notes ?? '—'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Add Recurring inline form
// ---------------------------------------------------------------------------

type AddRecurringFormProps = {
  categories: Array<{ id: string; name: string }>;
  onAdd: (item: ManualRecurringItem) => void;
  onCancel: () => void;
};

function AddRecurringForm({
  categories,
  onAdd,
  onCancel,
}: AddRecurringFormProps) {
  const { t } = useTranslation();
  const [payeeName, setPayeeName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [startDate, setStartDate] = useState(today());
  const [categoryId, setCategoryId] = useState<string>('');

  const freqOptions: Array<[Frequency, string]> = [
    ['weekly', t('Weekly')],
    ['biweekly', t('Biweekly')],
    ['monthly', t('Monthly')],
    ['quarterly', t('Quarterly')],
    ['yearly', t('Yearly')],
  ];

  const categoryOptions: Array<[string, string]> = [
    ['', t('None')],
    ...categories.map((c): [string, string] => [c.id, c.name]),
  ];

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const parsedAmount = Math.round(parseFloat(amount) * 100);
    if (!payeeName.trim() || isNaN(parsedAmount) || parsedAmount <= 0) return;

    const selectedCategory = categories.find(c => c.id === categoryId);
    onAdd({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payeeName: payeeName.trim(),
      amount: parsedAmount,
      frequency,
      startDate,
      categoryId: categoryId || null,
      categoryName: selectedCategory?.name ?? '',
    });
  }

  return (
    <View
      style={{
        backgroundColor: theme.tableBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 8,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <Text
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: theme.pageText,
          marginBottom: 16,
        }}
      >
        <Trans>Add Recurring Item</Trans>
      </Text>

      <form onSubmit={handleSubmit}>
        <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
          {/* Payee name */}
          <View style={{ flex: 2, minWidth: 160 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              <Trans>Payee name</Trans>
            </Text>
            <Input
              value={payeeName}
              onChange={e => setPayeeName(e.target.value)}
              placeholder={t('e.g. Netflix')}
              style={{ fontSize: 13 }}
            />
          </View>

          {/* Amount */}
          <View style={{ width: 120 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              <Trans>Amount</Trans>
            </Text>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              style={{ fontSize: 13 }}
            />
          </View>

          {/* Frequency */}
          <View style={{ width: 140 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              <Trans>Frequency</Trans>
            </Text>
            <Select
              options={freqOptions}
              value={frequency}
              onChange={v => setFrequency(v)}
              style={{ fontSize: 13 }}
            />
          </View>

          {/* Start date */}
          <View style={{ width: 150 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              <Trans>Start date</Trans>
            </Text>
            <Input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              style={{ fontSize: 13 }}
            />
          </View>

          {/* Category */}
          <View style={{ flex: 1, minWidth: 140 }}>
            <Text
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: theme.pageTextSubdued,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              <Trans>Category (optional)</Trans>
            </Text>
            <Select
              options={categoryOptions}
              value={categoryId}
              onChange={v => setCategoryId(v)}
              style={{ fontSize: 13 }}
            />
          </View>
        </View>

        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            marginTop: 16,
            justifyContent: 'flex-end',
          }}
        >
          <Button variant="bare" onPress={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" type="submit">
            <Trans>Add</Trans>
          </Button>
        </View>
      </form>
    </View>
  );
}
