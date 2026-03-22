// @ts-strict-ignore
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/connection';
import { integerToCurrency } from 'loot-core/shared/util';

import { CategoryAutocomplete } from '@desktop-client/components/autocomplete/CategoryAutocomplete';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
  ModalTitle,
} from '@desktop-client/components/common/Modal';
import type { Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type AiCategorizeReviewModalProps = Extract<
  ModalType,
  { name: 'ai-categorize-review' }
>['options'];

const BATCH_SIZE = 5;

export function AiCategorizeReviewModal({
  transactions,
  onReviewed,
}: AiCategorizeReviewModalProps) {
  const { t } = useTranslation();

  const [page, setPage] = useState(0);
  // map from transaction id → chosen category id
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const totalPages = Math.ceil(transactions.length / BATCH_SIZE);
  const batch = transactions.slice(page * BATCH_SIZE, (page + 1) * BATCH_SIZE);
  const isLastPage = page === totalPages - 1;

  function setSelection(txId: string, categoryId: string) {
    setSelections(prev => ({ ...prev, [txId]: categoryId }));
  }

  async function applyBatch(close: () => void) {
    const updates = batch
      .filter(tx => selections[tx.id])
      .map(tx => ({ id: tx.id, category: selections[tx.id] }));

    setApplying(true);
    if (updates.length > 0) {
      await send('transactions-batch-update', { updated: updates });
    }
    setApplying(false);

    if (isLastPage) {
      onReviewed();
      close();
    } else {
      setPage(p => p + 1);
    }
  }

  return (
    <Modal
      name="ai-categorize-review"
      containerProps={{ style: { width: 560 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <ModalTitle
                title={t('Review Uncategorized Transactions')}
                shrinkOnOverflow
              />
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />

          <Text
            style={{
              fontSize: 13,
              color: theme.tableTextLight,
              marginBottom: 8,
            }}
          >
            <Trans>
              AI couldn't confidently categorize these. Pick a category for each
              or skip — batch {page + 1} of {totalPages}:
            </Trans>
          </Text>

          <View style={{ gap: 8 }}>
            {batch.map(tx => {
              const isIncome = tx.amount > 0;
              const amountDisplay = integerToCurrency(Math.abs(tx.amount));
              return (
                <View
                  key={tx.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    backgroundColor: theme.tableRowBackgroundHighlight,
                    borderRadius: 6,
                    padding: '8px 12px',
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text
                      style={{ fontWeight: 600, fontSize: 13 }}
                      title={tx.payee}
                    >
                      {tx.payee}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <Text
                        style={{
                          color: isIncome
                            ? theme.noticeTextDark
                            : theme.errorText,
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                      >
                        {isIncome ? '+' : '-'}
                        {amountDisplay}
                      </Text>
                      {tx.notes && (
                        <Text
                          style={{ color: theme.tableTextLight, fontSize: 12 }}
                          title={tx.notes}
                        >
                          {tx.notes.length > 30
                            ? tx.notes.slice(0, 30) + '…'
                            : tx.notes}
                        </Text>
                      )}
                    </View>
                  </View>

                  <View style={{ width: 200, flexShrink: 0 }}>
                    <CategoryAutocomplete
                      value={selections[tx.id] ?? null}
                      onSelect={id => setSelection(tx.id, id)}
                      showSplitOption={false}
                    />
                  </View>
                </View>
              );
            })}
          </View>

          <ModalButtons style={{ marginTop: 14 }}>
            <Button
              variant="bare"
              onPress={() => {
                if (isLastPage) {
                  onReviewed();
                  state.close();
                } else {
                  setPage(p => p + 1);
                }
              }}
              style={{ marginRight: 'auto' }}
            >
              {isLastPage ? (
                <Trans>Skip all & close</Trans>
              ) : (
                <Trans>Skip batch</Trans>
              )}
            </Button>
            <Button
              variant="primary"
              isDisabled={applying}
              onPress={() => void applyBatch(state.close)}
            >
              {isLastPage ? (
                <Trans>Apply & close</Trans>
              ) : (
                <Trans>Apply & next</Trans>
              )}
            </Button>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
