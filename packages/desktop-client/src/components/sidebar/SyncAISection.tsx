import { useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { Trans } from 'react-i18next';

import { SvgArrowsSynchronize } from '@actual-app/components/icons/v2';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { useSyncAccountsMutation } from '@desktop-client/accounts/mutations';

type Status = 'idle' | 'running' | 'done' | 'error';

export function SyncAISection() {
  const syncAccounts = useSyncAccountsMutation();
  const [syncStatus, setSyncStatus] = useState<Status>('idle');

  async function handleSync() {
    if (syncStatus === 'running') return;
    setSyncStatus('running');
    try {
      await syncAccounts.mutateAsync({ id: undefined });
      setSyncStatus('done');
    } catch {
      setSyncStatus('error');
    } finally {
      setTimeout(() => setSyncStatus('idle'), 3000);
    }
  }

  return (
    <View
      style={{
        borderTop: `1px solid ${theme.sidebarItemBackgroundHover}`,
        padding: '8px 0 4px',
        flexShrink: 0,
      }}
    >
      <ActionButton
        Icon={SvgArrowsSynchronize}
        label={
          syncStatus === 'running' ? (
            <Trans>Syncing...</Trans>
          ) : syncStatus === 'done' ? (
            <Trans>Synced!</Trans>
          ) : syncStatus === 'error' ? (
            <Trans>Sync failed</Trans>
          ) : (
            <Trans>Sync SimpleFin</Trans>
          )
        }
        onClick={handleSync}
        active={syncStatus === 'running'}
        success={syncStatus === 'done'}
        error={syncStatus === 'error'}
      />
    </View>
  );
}

type ActionButtonProps = {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: ReactNode;
  onClick: () => void;
  active?: boolean;
  success?: boolean;
  error?: boolean;
};

function ActionButton({
  Icon,
  label,
  onClick,
  active,
  success,
  error: isError,
}: ActionButtonProps) {
  const color = isError
    ? theme.errorText
    : success
      ? '#4caf50'
      : theme.sidebarItemText;

  return (
    <View
      role="button"
      onClick={onClick}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 28,
        paddingLeft: 14,
        paddingRight: 14,
        cursor: active ? 'default' : 'pointer',
        color,
        opacity: active ? 0.7 : 1,
        ':hover': {
          backgroundColor: active
            ? undefined
            : theme.sidebarItemBackgroundHover,
        },
        transition: 'color 0.2s',
      }}
    >
      <Icon
        width={12}
        height={12}
        style={{
          flexShrink: 0,
          animation: active ? 'spin 1s linear infinite' : undefined,
        }}
      />
      <View
        style={{
          marginLeft: 8,
          fontSize: 12,
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </View>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </View>
  );
}
