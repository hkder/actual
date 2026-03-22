import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';

import { send } from 'loot-core/platform/client/connection';
import { getSecretsError } from 'loot-core/shared/errors';

import { Error } from '@desktop-client/components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '@desktop-client/components/common/Modal';
import { FormField, FormLabel } from '@desktop-client/components/forms';
import type { Modal as ModalType } from '@desktop-client/modals/modalsSlice';

type AiConfigModalProps = Extract<ModalType, { name: 'ai-config' }>['options'];

export function AiConfigModal({ onSuccess }: AiConfigModalProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [isValid, setIsValid] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(t('An Anthropic API key is required.'));

  const onSubmit = async (close: () => void) => {
    if (!apiKey.trim()) {
      setIsValid(false);
      return;
    }

    setIsLoading(true);
    const result =
      (await send('secret-set', {
        name: 'anthropic_api_key',
        value: apiKey.trim(),
      })) || {};

    if ('error' in result && result.error) {
      setIsValid(false);
      setError(
        getSecretsError(
          result.error as string,
          'reason' in result ? (result.reason as string) : '',
        ),
      );
    } else {
      onSuccess();
      close();
    }
    setIsLoading(false);
  };

  return (
    <Modal name="ai-config" containerProps={{ style: { width: 340 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Configure AI Auto-Categorization')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            <Text>
              <Trans>
                Enter your Anthropic API key to enable AI-powered transaction
                categorization. Transactions will be categorized using Claude
                Haiku — a fast, low-cost model.
              </Trans>
            </Text>

            <FormField>
              <FormLabel
                title={t('Anthropic API Key:')}
                htmlFor="anthropic-key-field"
              />
              <Input
                id="anthropic-key-field"
                type="password"
                value={apiKey}
                placeholder="sk-ant-..."
                onChangeValue={value => {
                  setApiKey(value);
                  setIsValid(true);
                }}
              />
            </FormField>

            {!isValid && <Error>{error}</Error>}
          </View>

          <ModalButtons>
            <ButtonWithLoading
              variant="primary"
              autoFocus
              isLoading={isLoading}
              onPress={() => {
                void onSubmit(() => state.close());
              }}
            >
              <Trans>Save</Trans>
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
