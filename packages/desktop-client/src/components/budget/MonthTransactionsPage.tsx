import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { Button } from '@actual-app/components/button';
import {
  SvgCheveronLeft,
  SvgCheveronRight,
} from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { Pie, PieChart, Sector } from 'recharts';
import type { PieSectorShapeProps } from 'recharts';

import * as monthUtils from 'loot-core/shared/months';
import { q } from 'loot-core/shared/query';
import type { TransactionEntity } from 'loot-core/types/models';

import { FinancialText } from '@desktop-client/components/FinancialText';
import { PrivacyFilter } from '@desktop-client/components/PrivacyFilter';
import {
  getColorScale,
  useRechartsAnimation,
} from '@desktop-client/components/reports/chart-theme';
import { Container } from '@desktop-client/components/reports/Container';
import { useAccounts } from '@desktop-client/hooks/useAccounts';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useFormat } from '@desktop-client/hooks/useFormat';
import { useLocale } from '@desktop-client/hooks/useLocale';
import { useNavigate } from '@desktop-client/hooks/useNavigate';
import { usePayees } from '@desktop-client/hooks/usePayees';
import { useTransactions } from '@desktop-client/hooks/useTransactions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CategorySpending = {
  id: string;
  name: string;
  amount: number;
  color: string;
};

type SortField = 'date' | 'payee' | 'category' | 'amount';
type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MonthTransactionsPage() {
  const { month: monthParam } = useParams<{ month: string }>();
  const month = monthParam ?? monthUtils.currentMonth();
  const navigate = useNavigate();
  const locale = useLocale();
  const { t } = useTranslation();
  const format = useFormat();
  const animationProps = useRechartsAnimation({ isAnimationActive: false });

  const { data: categories = { grouped: [], list: [] } } = useCategories();
  const { data: accounts = [] } = useAccounts();
  const { data: payees = [] } = usePayees();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [filterAccountId, setFilterAccountId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Build a map of category id → name for display
  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories.list) {
      map.set(cat.id, cat.name);
    }
    return map;
  }, [categories.list]);

  // Build a map of account id → name for display
  const accountMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) {
      map.set(acc.id, acc.name);
    }
    return map;
  }, [accounts]);

  // Build a map of payee id → name for display
  const payeeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of payees) {
      map.set(p.id, p.name);
    }
    return map;
  }, [payees]);

  // Query transactions for the month
  const startDate = monthUtils.firstDayOfMonth(month);
  const endDate = monthUtils.lastDayOfMonth(month);

  const transactionQuery = useMemo(
    () =>
      q('transactions')
        .filter({
          date: { $gte: startDate, $lte: endDate },
          is_parent: false,
        })
        .select('*')
        .orderBy({ date: 'desc' }),
    [startDate, endDate],
  );

  const { transactions, isLoading } = useTransactions({
    query: transactionQuery,
    options: { pageSize: 500 },
  });

  // Compute spending by category (only expenses — negative amounts)
  const colors = getColorScale('qualitative');

  const categorySpending = useMemo(() => {
    const totals = new Map<string, number>();
    for (const txn of transactions) {
      if (txn.amount >= 0) continue; // skip income
      const catId = txn.category ?? 'uncategorized';
      totals.set(catId, (totals.get(catId) ?? 0) + Math.abs(txn.amount));
    }

    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.map(
      ([id, amount], i): CategorySpending => ({
        id,
        name: categoryMap.get(id) ?? t('Uncategorized'),
        amount,
        color: colors[i % colors.length],
      }),
    );
  }, [transactions, categoryMap, colors, t]);

  // Filter and sort transactions for the table
  const filteredTransactions = useMemo(() => {
    let filtered = [...transactions];

    if (selectedCategoryId) {
      if (selectedCategoryId === 'uncategorized') {
        filtered = filtered.filter(txn => !txn.category);
      } else {
        filtered = filtered.filter(txn => txn.category === selectedCategoryId);
      }
    }

    if (filterAccountId) {
      filtered = filtered.filter(txn => txn.account === filterAccountId);
    }

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'date':
          cmp = a.date.localeCompare(b.date);
          break;
        case 'amount':
          cmp = a.amount - b.amount;
          break;
        case 'category':
          cmp = (categoryMap.get(a.category ?? '') ?? '').localeCompare(
            categoryMap.get(b.category ?? '') ?? '',
          );
          break;
        case 'payee':
          cmp = (payeeMap.get(a.payee ?? '') ?? '').localeCompare(
            payeeMap.get(b.payee ?? '') ?? '',
          );
          break;
        default:
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return filtered;
  }, [
    transactions,
    selectedCategoryId,
    filterAccountId,
    sortField,
    sortDirection,
    categoryMap,
    payeeMap,
  ]);

  const totalSpending = useMemo(
    () => categorySpending.reduce((sum, c) => sum + c.amount, 0),
    [categorySpending],
  );

  function handlePrevMonth() {
    void navigate(`/budget/${monthUtils.prevMonth(month)}/transactions`);
  }

  function handleNextMonth() {
    void navigate(`/budget/${monthUtils.nextMonth(month)}/transactions`);
  }

  function handleSliceClick(categoryId: string) {
    setSelectedCategoryId(prev => (prev === categoryId ? null : categoryId));
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'date' ? 'desc' : 'asc');
    }
  }

  const displayMonth = monthUtils.format(month, 'MMMM yyyy', locale);

  return (
    <View
      style={{
        flex: 1,
        padding: 20,
        paddingTop: 50,
        maxWidth: 900,
        width: '100%',
        marginInline: 'auto',
      }}
    >
      {/* Month Header with navigation arrows */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 20,
          gap: 12,
        }}
      >
        <Button
          variant="bare"
          onPress={handlePrevMonth}
          aria-label={t('Previous month')}
        >
          <SvgCheveronLeft
            style={{ width: 24, height: 24, color: theme.pageTextSubdued }}
          />
        </Button>
        <Text
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: theme.pageTextPositive || theme.pageText,
          }}
        >
          {displayMonth}
        </Text>
        <Button
          variant="bare"
          onPress={handleNextMonth}
          aria-label={t('Next month')}
        >
          <SvgCheveronRight
            style={{ width: 24, height: 24, color: theme.pageTextSubdued }}
          />
        </Button>
        <Button
          variant="bare"
          onPress={() => void navigate('/budget')}
          style={{ marginLeft: 'auto' }}
        >
          <Text style={{ color: theme.pageTextLink }}>
            {t('Back to Budget')}
          </Text>
        </Button>
      </View>

      {/* Donut chart */}
      {isLoading ? (
        <View
          style={{
            height: 300,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.pageTextSubdued }}>
            {t('Loading...')}
          </Text>
        </View>
      ) : categorySpending.length === 0 ? (
        <View
          style={{
            height: 200,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>No spending this month</Trans>
          </Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 20 }}>
          <Container style={{ height: 320, flex: 1 }}>
            {(width, height) => (
              <PieChart width={width} height={height}>
                <Pie
                  dataKey="amount"
                  nameKey="name"
                  {...animationProps}
                  data={categorySpending}
                  innerRadius={Math.min(width, height) * 0.2}
                  outerRadius={Math.min(width, height) * 0.38}
                  startAngle={90}
                  endAngle={-270}
                  style={{ cursor: 'pointer' }}
                  shape={(props: PieSectorShapeProps, index: number) => {
                    const item = categorySpending[index];
                    const fill = item?.color ?? props.fill;
                    const isActive = selectedCategoryId === item?.id;
                    return (
                      <Sector
                        {...props}
                        fill={fill}
                        outerRadius={
                          isActive
                            ? (props.outerRadius ?? 0) + 6
                            : props.outerRadius
                        }
                      />
                    );
                  }}
                  onClick={(_item, index) => {
                    const item = categorySpending[index];
                    if (item) {
                      handleSliceClick(item.id);
                    }
                  }}
                />
              </PieChart>
            )}
          </Container>

          {/* Legend */}
          <View
            style={{ flex: 1, maxWidth: 300, gap: 4, justifyContent: 'center' }}
          >
            {categorySpending.map(cat => {
              const pct =
                totalSpending > 0
                  ? ((cat.amount / totalSpending) * 100).toFixed(1)
                  : '0';
              const isActive = selectedCategoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => handleSliceClick(cat.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    border: 'none',
                    width: '100%',
                    backgroundColor: isActive
                      ? theme.tableRowBackgroundHover
                      : 'transparent',
                  }}
                >
                  <View
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 2,
                      backgroundColor: cat.color,
                      flexShrink: 0,
                    }}
                  />
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color: theme.pageText,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cat.name}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.pageTextSubdued,
                      flexShrink: 0,
                    }}
                  >
                    {pct}%
                  </Text>
                  <PrivacyFilter>
                    <FinancialText
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {format(-cat.amount, 'financial')}
                    </FinancialText>
                  </PrivacyFilter>
                </button>
              );
            })}
          </View>
        </View>
      )}

      {/* Filter bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginTop: 20,
          marginBottom: 12,
        }}
      >
        <Text style={{ fontSize: 13, color: theme.pageTextSubdued }}>
          <Trans>Filter:</Trans>
        </Text>

        <select
          value={selectedCategoryId ?? ''}
          onChange={e => setSelectedCategoryId(e.target.value || null)}
          style={{
            padding: '4px 8px',
            borderRadius: 4,
            border: `1px solid ${theme.tableBorder}`,
            backgroundColor: theme.tableBackground,
            color: theme.pageText,
            fontSize: 13,
          }}
        >
          <option value="">{t('All Categories')}</option>
          {categories.list.map(cat => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
          <option value="uncategorized">
            <Trans>Uncategorized</Trans>
          </option>
        </select>

        <select
          value={filterAccountId ?? ''}
          onChange={e => setFilterAccountId(e.target.value || null)}
          style={{
            padding: '4px 8px',
            borderRadius: 4,
            border: `1px solid ${theme.tableBorder}`,
            backgroundColor: theme.tableBackground,
            color: theme.pageText,
            fontSize: 13,
          }}
        >
          <option value="">{t('All Accounts')}</option>
          {accounts.map(acc => (
            <option key={acc.id} value={acc.id}>
              {acc.name}
            </option>
          ))}
        </select>

        {(selectedCategoryId || filterAccountId) && (
          <Button
            variant="bare"
            onPress={() => {
              setSelectedCategoryId(null);
              setFilterAccountId(null);
            }}
          >
            <Text style={{ color: theme.pageTextLink, fontSize: 13 }}>
              <Trans>Clear filters</Trans>
            </Text>
          </Button>
        )}

        <Text
          style={{
            marginLeft: 'auto',
            fontSize: 13,
            color: theme.pageTextSubdued,
          }}
        >
          {t('{{count}} transactions', { count: filteredTransactions.length })}
        </Text>
      </View>

      {/* Transaction table */}
      <View
        style={{
          border: `1px solid ${theme.tableBorder}`,
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {/* Table header */}
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: theme.tableHeaderBackground,
            borderBottom: `1px solid ${theme.tableBorder}`,
          }}
        >
          <SortableHeader
            label={t('Date')}
            field="date"
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            style={{ width: 110 }}
          />
          <SortableHeader
            label={t('Payee')}
            field="payee"
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            style={{ flex: 1 }}
          />
          <SortableHeader
            label={t('Category')}
            field="category"
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            style={{ flex: 1 }}
          />
          <View
            style={{
              padding: '8px 12px',
              flex: 1,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                color: theme.pageTextSubdued,
              }}
            >
              <Trans>Account</Trans>
            </Text>
          </View>
          <SortableHeader
            label={t('Amount')}
            field="amount"
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            style={{ width: 120, textAlign: 'right' }}
          />
        </View>

        {/* Table body */}
        <View style={{ maxHeight: 500, overflow: 'auto' }}>
          {filteredTransactions.length === 0 ? (
            <View
              style={{
                padding: 20,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>No transactions found</Trans>
              </Text>
            </View>
          ) : (
            filteredTransactions.map((txn: TransactionEntity) => (
              <TransactionRow
                key={txn.id}
                transaction={txn}
                payeeName={payeeMap.get(txn.payee ?? '') ?? ''}
                categoryName={
                  categoryMap.get(txn.category ?? '') ?? t('Uncategorized')
                }
                accountName={accountMap.get(txn.account) ?? ''}
                format={format}
              />
            ))
          )}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sortable header
// ---------------------------------------------------------------------------

type SortableHeaderProps = {
  label: string;
  field: SortField | string;
  sortField: SortField | string;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  style?: CSSProperties;
};

function SortableHeader({
  label,
  field,
  sortField,
  sortDirection,
  onSort,
  style,
}: SortableHeaderProps) {
  const isActive = field === sortField;
  return (
    <button
      type="button"
      onClick={() => onSort(field as SortField)}
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
// Transaction row
// ---------------------------------------------------------------------------

type TransactionRowProps = {
  transaction: TransactionEntity;
  payeeName: string;
  categoryName: string;
  accountName: string;
  format: ReturnType<typeof useFormat>;
};

function TransactionRow({
  transaction,
  payeeName,
  categoryName,
  accountName,
  format,
}: TransactionRowProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        borderBottom: `1px solid ${theme.tableBorder}`,
      }}
    >
      <View style={{ width: 110, padding: '8px 12px' }}>
        <Text style={{ fontSize: 13, color: theme.pageText }}>
          {transaction.date}
        </Text>
      </View>
      <View style={{ flex: 1, padding: '8px 12px' }}>
        <Text
          style={{
            fontSize: 13,
            color: theme.pageText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {payeeName}
        </Text>
      </View>
      <View style={{ flex: 1, padding: '8px 12px' }}>
        <Text
          style={{
            fontSize: 13,
            color: theme.pageText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {categoryName}
        </Text>
      </View>
      <View style={{ flex: 1, padding: '8px 12px' }}>
        <Text
          style={{
            fontSize: 13,
            color: theme.pageText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {accountName}
        </Text>
      </View>
      <View style={{ width: 120, padding: '8px 12px', alignItems: 'flex-end' }}>
        <PrivacyFilter>
          <FinancialText
            style={{
              fontSize: 13,
              fontWeight: 500,
              color:
                transaction.amount >= 0
                  ? theme.noticeTextLight
                  : theme.errorText,
            }}
          >
            {format(transaction.amount, 'financial')}
          </FinancialText>
        </PrivacyFilter>
      </View>
    </View>
  );
}
