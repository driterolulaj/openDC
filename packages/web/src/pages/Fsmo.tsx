// SPDX-License-Identifier: AGPL-3.0-only
/** FSMO roles: holders, transfer to this DC, seizure (typed role names), functional level raise. */
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import type { DomainInfo } from '@opendc/shared/api';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';

const ROLES = ['schema', 'naming', 'pdc', 'rid', 'infrastructure', 'domaindns', 'forestdns'] as const;
const LEVELS = ['2008_R2', '2012', '2012_R2', '2016'] as const;
const fsmoResponse = z.object({ roles: z.array(z.object({ role: z.string(), ownerServer: z.string().nullable() })) });
const levelResponse = z.object({ forest: z.string().nullable(), domain: z.string().nullable() });

const phrase = (roles: string[]): string => [...roles].sort().join(' ');

export function FsmoCard({ info }: { info: DomainInfo }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | 'transfer' | 'seize' | 'level'>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [typed, setTyped] = useState('');
  const [level, setLevel] = useState<string | null>(null);
  const done = async (): Promise<void> => {
    setMode(null);
    setTyped('');
    setRoles([]);
    await qc.invalidateQueries({ queryKey: ['domain-info'] });
  };
  const fsmo = useMutation({
    mutationFn: () =>
      api(`/domain/fsmo/${mode === 'seize' ? 'seize' : 'transfer'}`, {
        method: 'POST',
        body: { roles, force, confirm: typed },
        schema: fsmoResponse,
      }),
    onSuccess: done,
  });
  const raise = useMutation({
    mutationFn: () =>
      api('/domain/level', {
        method: 'POST',
        body: { domain: level, forest: level, confirm: typed },
        schema: levelResponse,
      }),
    onSuccess: done,
  });
  const canManage = has('domain.fsmo.manage');
  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Title order={3} size="h5">
          {t('domain.fsmo')}
        </Title>
        <Group>
          <Button size="xs" variant="default" disabled={!canManage} onClick={() => setMode('transfer')}>
            {t('domain.fsmo-transfer')}
          </Button>
          <Button size="xs" color="red" variant="light" disabled={!canManage} onClick={() => setMode('seize')}>
            {t('domain.fsmo-seize')}
          </Button>
          <Button size="xs" variant="default" disabled={!has('domain.level.raise')} onClick={() => setMode('level')}>
            {t('domain.level-raise')}
          </Button>
        </Group>
      </Group>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('domain.fsmo-role')}</Table.Th>
            <Table.Th>{t('domain.fsmo-owner')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {info.fsmo.map((r) => (
            <Table.Tr key={r.role}>
              <Table.Td>{t(`domain.role-${r.role}`)}</Table.Td>
              <Table.Td>{r.owner ?? '—'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal
        opened={mode === 'transfer' || mode === 'seize'}
        onClose={() => setMode(null)}
        title={t(mode === 'seize' ? 'domain.fsmo-seize' : 'domain.fsmo-transfer')}
      >
        <Stack>
          {fsmo.error ? <ErrorView error={fsmo.error} /> : null}
          <Alert color={mode === 'seize' ? 'red' : 'orange'}>
            {t(mode === 'seize' ? 'domain.fsmo-seize-warning' : 'domain.fsmo-transfer-help')}
          </Alert>
          <Checkbox.Group label={t('domain.fsmo-roles')} value={roles} onChange={setRoles}>
            <Stack gap={4} mt="xs">
              {ROLES.map((r) => (
                <Checkbox key={r} value={r} label={`${t(`domain.role-${r}`)} (${r})`} />
              ))}
            </Stack>
          </Checkbox.Group>
          {mode === 'seize' ? (
            <Checkbox
              label={t('domain.fsmo-force')}
              checked={force}
              onChange={(e) => setForce(e.currentTarget.checked)}
            />
          ) : null}
          {roles.length ? (
            <TextInput
              label={t('domain.fsmo-confirm', { phrase: phrase(roles) })}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              autoComplete="off"
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMode(null)}>
              {t('dir.cancel')}
            </Button>
            <Button
              {...(mode === 'seize' ? { color: 'red' } : {})}
              loading={fsmo.isPending}
              disabled={
                !roles.length ||
                phrase(
                  typed
                    .trim()
                    .toLowerCase()
                    .split(/[\s,]+/)
                    .filter(Boolean),
                ) !== phrase(roles)
              }
              onClick={() => fsmo.mutate()}
            >
              {t(mode === 'seize' ? 'domain.fsmo-seize' : 'domain.fsmo-transfer')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={mode === 'level'} onClose={() => setMode(null)} title={t('domain.level-raise')}>
        <Stack>
          {raise.error ? <ErrorView error={raise.error} /> : null}
          <Alert color="red">{t('domain.level-warning')}</Alert>
          <Text size="sm">{t('domain.level-current', { level: info.domainLevel ?? '—' })}</Text>
          <Select label={t('domain.level-target')} data={[...LEVELS]} value={level} onChange={setLevel} />
          {level ? (
            <TextInput
              label={t('domain.level-confirm', { level })}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              autoComplete="off"
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setMode(null)}>
              {t('dir.cancel')}
            </Button>
            <Button
              color="red"
              loading={raise.isPending}
              disabled={!level || typed.trim() !== level}
              onClick={() => raise.mutate()}
            >
              {t('domain.level-raise')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}
