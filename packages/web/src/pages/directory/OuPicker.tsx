// SPDX-License-Identifier: AGPL-3.0-only
/** Modal to pick a target OU/container (move). */
import { useState } from 'react';
import { Button, Group, Modal, ScrollArea, Stack } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { domainInfo } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { OuTree } from '../../components/directory.tsx';

export function OuPickerModal({
  opened,
  onClose,
  onPick,
  busy,
  title,
}: {
  opened: boolean;
  onClose: () => void;
  onPick: (guid: string) => void;
  busy?: boolean;
  /** default: "Move to" */
  title?: string;
}) {
  const { t } = useTranslation();
  const info = useQuery({ queryKey: ['domain-info'], queryFn: () => api('/directory/info', { schema: domainInfo }) });
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={onClose} title={title ?? t('dir.move-title')}>
      <Stack>
        <ScrollArea h={360}>
          {info.data ? (
            <OuTree
              selected={selected}
              rootLabel={info.data.domain}
              rootGuid={info.data.headGuid}
              onSelect={(c) => setSelected(c?.guid ?? info.data.headGuid)}
            />
          ) : null}
        </ScrollArea>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button
            loading={busy ?? false}
            disabled={!selected}
            onClick={() => (selected ? onPick(selected) : undefined)}
          >
            {t('dir.move')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
