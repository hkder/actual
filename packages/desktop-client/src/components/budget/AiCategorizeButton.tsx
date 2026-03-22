import { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import { SvgFlashlight } from '@actual-app/components/icons/v1';
import { Popover } from '@actual-app/components/popover';
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

export function AiCategorizeButton() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const count: number | null = useSheetValue(bindings.uncategorizedCount());
  const [status, setStatus] = useState<CategorizationStatus>({ type: 'idle' });
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  async function handleCategorize() {
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

  const showBadge = count !== null && count > 0;

  return (
    <View style={{ position: 'relative' }}>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('AI Categorize')}
        onPress={() => setIsOpen(!isOpen)}
        style={{
          padding: 4,
          color: showBadge ? theme.errorText : theme.pageTextLight,
        }}
      >
        <SvgFlashlight width={15} height={15} />
        {showBadge && (
          <View
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              minWidth: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: theme.errorText,
              color: 'white',
              fontSize: 9,
              fontWeight: 700,
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 3px',
              lineHeight: '14px',
            }}
          >
            {count > 99 ? '99+' : count}
          </View>
        )}
      </Button>

      <Popover
        triggerRef={triggerRef}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        style={{ padding: 12, width: 240 }}
      >
        <View style={{ gap: 8 }}>
          {status.type === 'idle' && (
            <>
              {showBadge ? (
                <View
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: theme.errorText,
                  }}
                >
                  <Trans count={count}>
                    {{ count }} uncategorized transactions
                  </Trans>
                </View>
              ) : (
                <View style={{ fontSize: 13, color: theme.pageTextSubdued }}>
                  <Trans>All transactions categorized</Trans>
                </View>
              )}
              {showBadge && (
                <Button
                  variant="primary"
                  onPress={() => void handleCategorize()}
                >
                  <Trans>Run AI Categorize</Trans>
                </Button>
              )}
            </>
          )}

          {status.type === 'loading' && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <AnimatedLoading style={{ width: 16, height: 16 }} />
              <Trans>Categorizing...</Trans>
            </View>
          )}

          {status.type === 'done' && (
            <View style={{ gap: 6 }}>
              <View style={{ fontSize: 13, fontWeight: 600 }}>
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
              </View>
              <Button
                variant="bare"
                onPress={() => {
                  setStatus({ type: 'idle' });
                }}
              >
                <Trans>Done</Trans>
              </Button>
            </View>
          )}

          {status.type === 'error' && (
            <View style={{ gap: 6 }}>
              <View style={{ fontSize: 13, color: theme.errorText }}>
                {status.message}
              </View>
              <Button
                variant="bare"
                onPress={() => {
                  setStatus({ type: 'idle' });
                }}
              >
                <Trans>Dismiss</Trans>
              </Button>
            </View>
          )}
        </View>
      </Popover>
    </View>
  );
}
