// @ts-strict-ignore
import React, { memo } from 'react';
import type { ComponentProps } from 'react';
import { Trans } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import * as monthUtils from 'loot-core/shared/months';

import { AiCategorizeButton } from './AiCategorizeButton';
import { MonthPicker } from './MonthPicker';
import { getScrollbarWidth } from './util';

import { FinancialText } from '@desktop-client/components/FinancialText';
import { useCategories } from '@desktop-client/hooks/useCategories';
import { useFormat } from '@desktop-client/hooks/useFormat';
import { useGlobalPref } from '@desktop-client/hooks/useGlobalPref';
import { SheetNameProvider } from '@desktop-client/hooks/useSheetName';
import { useSheetValue } from '@desktop-client/hooks/useSheetValue';
import { useSyncedPref } from '@desktop-client/hooks/useSyncedPref';

type CashFlowSummaryProps = {
  startMonth: string;
};

function CashFlowSummaryInner() {
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  const format = useFormat();
  const { data: categoryData } = useCategories();

  const transfersGroup = categoryData?.grouped?.find(
    g => g.name === 'Transfers & Payments',
  );

  const totalIncome = useSheetValue<'envelope-budget', 'total-income'>(
    budgetType === 'tracking' ? ('total-income' as const) : 'total-income',
  );
  const totalSpent = useSheetValue<'envelope-budget', 'total-spent'>(
    budgetType === 'tracking' ? ('total-spent' as const) : 'total-spent',
  );
  // group-sum-amount-{id} is negative (expenses); subtracting it removes transfers from total-spent
  const transfersSpent = useSheetValue(
    transfersGroup ? (`group-sum-amount-${transfersGroup.id}` as 'total-spent') : 'total-spent',
  );

  const income = totalIncome ?? 0;
  // Exclude transfers group from spending total (both are negative; subtracting removes transfers)
  const adjustedSpent = (totalSpent ?? 0) - (transfersGroup ? (transfersSpent ?? 0) : 0);
  const spending = -adjustedSpent;
  const net = income - spending;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        paddingBottom: 4,
        paddingTop: 2,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
          <Trans>Income</Trans>
        </Text>
        <FinancialText
          style={{ fontSize: 12, color: theme.noticeText, fontWeight: 600 }}
        >
          +{format(income, 'financial')}
        </FinancialText>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
          <Trans>Spending</Trans>
        </Text>
        <FinancialText
          style={{ fontSize: 12, color: theme.errorText, fontWeight: 600 }}
        >
          -{format(spending, 'financial')}
        </FinancialText>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
        <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
          <Trans>Net</Trans>
        </Text>
        <FinancialText
          style={{
            fontSize: 12,
            color: net >= 0 ? theme.noticeText : theme.errorText,
            fontWeight: 600,
          }}
        >
          {net >= 0 ? '+' : ''}
          {format(net, 'financial')}
        </FinancialText>
      </View>
    </View>
  );
}

function CashFlowSummary({ startMonth }: CashFlowSummaryProps) {
  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(startMonth)}>
      <CashFlowSummaryInner />
    </SheetNameProvider>
  );
}

type BudgetPageHeaderProps = {
  startMonth: string;
  onMonthSelect: (month: string) => void;
  numMonths: number;
  monthBounds: ComponentProps<typeof MonthPicker>['monthBounds'];
};

export const BudgetPageHeader = memo<BudgetPageHeaderProps>(
  ({ startMonth, onMonthSelect, numMonths, monthBounds }) => {
    const [categoryExpandedStatePref] = useGlobalPref('categoryExpandedState');
    const categoryExpandedState = categoryExpandedStatePref ?? 0;
    const offsetMultipleMonths = numMonths === 1 ? 4 : 0;

    return (
      <View style={{ flexShrink: 0 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              flex: 1,
              marginLeft:
                200 + 100 * categoryExpandedState + 5 - offsetMultipleMonths,
            }}
          >
            <View
              style={{
                marginRight: 5 + getScrollbarWidth() - offsetMultipleMonths,
              }}
            >
              <MonthPicker
                startMonth={startMonth}
                numDisplayed={numMonths}
                monthBounds={monthBounds}
                style={{ paddingTop: 5 }}
                onSelect={month => onMonthSelect(month)}
              />
            </View>
          </View>
          <View style={{ marginRight: 8, flexShrink: 0 }}>
            <AiCategorizeButton />
          </View>
        </View>
        <CashFlowSummary startMonth={startMonth} />
      </View>
    );
  },
);

BudgetPageHeader.displayName = 'BudgetPageHeader';
