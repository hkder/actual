import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { SvgClose } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/connection';

import { useSheetValue } from '@desktop-client/hooks/useSheetValue';
import { pushModal } from '@desktop-client/modals/modalsSlice';
import { uncategorizedTransactions } from '@desktop-client/queries';
import { useDispatch } from '@desktop-client/redux';
import * as bindings from '@desktop-client/spreadsheet/bindings';

type CategorizationStatus =
  | { type: 'idle' }
  | { type: 'loading' }
  | {
      type: 'done';
      categorized: number;
      assignedToUncategorized: number;
    }
  | { type: 'error'; message: string };

export function AiCategorizeBanner() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const count: number | null = useSheetValue(bindings.uncategorizedCount());
  const [status, setStatus] = useState<CategorizationStatus>({ type: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || (count === null && status.type === 'idle')) {
    return null;
  }

  if (count !== null && count <= 0 && status.type === 'idle') {
    return null;
  }

  async function handleCategorize() {
    // Check if API key is configured
    const keyCheck = await send('secret-check', 'anthropic_api_key');
    const keyMissing =
      !keyCheck ||
      (typeof keyCheck === 'object' && 'error' in keyCheck && keyCheck.error);

    if (keyMissing) {
      dispatch(
        pushModal({
          modal: {
            name: 'ai-config',
            options: {
              onSuccess: () => {
                void handleCategorize();
              },
            },
          },
        }),
      );
      return;
    }

    setStatus({ type: 'loading' });

    try {
      // Fetch uncategorized transaction IDs
      const query = uncategorizedTransactions().select('id');
      const { data: transactions } = await send('query', query.serialize());

      if (!transactions || transactions.length === 0) {
        setStatus({ type: 'idle' });
        return;
      }

      const transactionIds = transactions.map((tx: { id: string }) => tx.id);

      const result = await send('ai-categorize-transactions', {
        transactionIds,
      });

      if (result && 'error' in result && result.error === 'missing-api-key') {
        dispatch(
          pushModal({
            modal: {
              name: 'ai-config',
              options: {
                onSuccess: () => {
                  void handleCategorize();
                },
              },
            },
          }),
        );
        setStatus({ type: 'idle' });
        return;
      }

      if (result && 'categorized' in result) {
        setStatus({
          type: 'done',
          categorized: result.categorized,
          assignedToUncategorized:
            (result as { assignedToUncategorized?: number })
              .assignedToUncategorized ?? 0,
        });
      }
    } catch {
      setStatus({
        type: 'error',
        message: t('AI categorization failed. Check your API key.'),
      });
    }
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '6px 12px',
        backgroundColor: theme.tableHeaderBackground,
        borderBottom: `1px solid ${theme.tableBorder}`,
        flexShrink: 0,
      }}
    >
      {status.type === 'idle' && count !== null && count > 0 && (
        <>
          <span style={{ color: theme.errorText, fontWeight: 600 }}>
            <Trans count={count}>{{ count }} uncategorized transactions</Trans>
          </span>
          <Button variant="primary" onPress={() => void handleCategorize()}>
            <Trans>Run AI Categorize</Trans>
          </Button>
        </>
      )}

      {status.type === 'loading' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <AnimatedLoading style={{ width: 16, height: 16 }} />
          <span>
            <Trans>Categorizing transactions...</Trans>
          </span>
        </View>
      )}

      {status.type === 'done' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>
            {status.assignedToUncategorized > 0 ? (
              <Trans
                values={{
                  categorized: status.categorized,
                  uncategorized: status.assignedToUncategorized,
                }}
              >
                {
                  'Categorized {{ categorized }}, {{ uncategorized }} assigned to Uncategorized'
                }
              </Trans>
            ) : (
              <Trans values={{ categorized: status.categorized }}>
                {'Categorized {{ categorized }} transactions'}
              </Trans>
            )}
          </span>
          <Button
            variant="bare"
            aria-label={t('Close')}
            onPress={() => {
              setStatus({ type: 'idle' });
              setDismissed(true);
            }}
          >
            <SvgClose style={{ width: 12, height: 12 }} />
          </Button>
        </View>
      )}

      {status.type === 'error' && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ color: theme.errorText }}>{status.message}</span>
          <Button
            variant="bare"
            aria-label={t('Close')}
            onPress={() => {
              setStatus({ type: 'idle' });
              setDismissed(true);
            }}
          >
            <SvgClose style={{ width: 12, height: 12 }} />
          </Button>
        </View>
      )}
    </View>
  );
}
