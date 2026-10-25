// SPDX-License-Identifier: AGPL-3.0-only
/** Password policies: the domain default and fine-grained policies (PSOs) for users and groups. */
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  Loader,
  Modal,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { passwordPolicies, type PasswordSettings, type Pso } from '@opendc/shared/domain';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { ObjectPicker } from '../components/directory.tsx';

const NUMBERS = [
  'minLength',
  'historyLength',
  'minAgeDays',
  'maxAgeDays',
  'lockoutThreshold',
  'lockoutDurationMinutes',
  'lockoutWindowMinutes',
] as const;

function SettingsForm({
  value,
  onChange,
  readOnly,
}: {
  value: PasswordSettings;
  onChange: (v: PasswordSettings) => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Stack>
      <Switch
        label={t('pwp.complexity')}
        description={t('pwp.complexity-hint')}
        checked={value.complexity}
        disabled={readOnly}
        onChange={(e) => onChange({ ...value, complexity: e.currentTarget.checked })}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {NUMBERS.map((k) => (
          <NumberInput
            key={k}
            label={t(`pwp.${k}`)}
            description={t(`pwp.${k}-hint`, { defaultValue: '' })}
            min={0}
            readOnly={readOnly}
            value={value[k]}
            onChange={(v) => onChange({ ...value, [k]: typeof v === 'number' ? v : Number(v) || 0 })}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

const EMPTY: PasswordSettings = {
  complexity: true,
  minLength: 12,
  historyLength: 24,
  minAgeDays: 1,
  maxAgeDays: 0,
  lockoutThreshold: 10,
  lockoutDurationMinutes: 15,
  lockoutWindowMinutes: 15,
};

function PsoEditor({ pso, onClose }: { pso: Pso | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editing = pso && pso !== 'new' ? pso : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [precedence, setPrecedence] = useState<number>(editing?.precedence ?? 10);
  const [settings, setSettings] = useState<PasswordSettings>(editing?.settings ?? EMPTY);
  const [targets, setTargets] = useState<{ guid: string; name: string }[]>(editing?.appliesTo ?? []);
  const save = useMutation({
    mutationFn: () =>
      api('/domain/password-policies', {
        method: 'PUT',
        body: { kind: 'pso', name, precedence, settings, appliesTo: targets.map((x) => x.guid) },
        schema: passwordPolicies,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['password-policies'] });
      onClose();
    },
  });
  return (
    <Modal opened={pso !== null} onClose={onClose} title={t(editing ? 'pwp.edit-pso' : 'pwp.new-pso')} size="lg">
      <Stack>
        {save.error ? <ErrorView error={save.error} /> : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('pwp.name')}
            required
            readOnly={!!editing}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <NumberInput
            label={t('pwp.precedence')}
            description={t('pwp.precedence-hint')}
            min={1}
            value={precedence}
            onChange={(v) => setPrecedence(Number(v) || 1)}
          />
        </SimpleGrid>
        <SettingsForm value={settings} onChange={setSettings} readOnly={false} />
        <ObjectPicker
          label={t('pwp.applies-to')}
          types="user,group"
          exclude={targets.map((x) => x.guid)}
          onPick={(i) => setTargets((x) => [...x, { guid: i.guid, name: i.name }])}
        />
        <Group gap={4}>
          {targets.map((x) => (
            <Badge
              key={x.guid}
              variant="light"
              rightSection={
                <CloseButton
                  size="xs"
                  aria-label={t('dir.remove-x', { name: x.name })}
                  onClick={() => setTargets((y) => y.filter((z) => z.guid !== x.guid))}
                />
              }
            >
              {x.name}
            </Badge>
          ))}
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button loading={save.isPending} disabled={!name} onClick={() => save.mutate()}>
            {t('dir.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default function PasswordPolicies() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['password-policies'],
    queryFn: () => api('/domain/password-policies', { schema: passwordPolicies }),
  });
  const [draft, setDraft] = useState<PasswordSettings | null>(null);
  const [edit, setEdit] = useState<Pso | 'new' | null>(null);
  const canWrite = has('domain.passwordPolicy.write');
  const saveDefault = useMutation({
    mutationFn: (settings: PasswordSettings) =>
      api('/domain/password-policies', {
        method: 'PUT',
        body: { kind: 'default', settings },
        schema: passwordPolicies,
      }),
    onSuccess: async (r) => {
      qc.setQueryData(['password-policies'], r);
      setDraft(null);
    },
  });
  const del = useMutation({
    mutationFn: (name: string) =>
      api('/domain/password-policies', { method: 'PUT', body: { kind: 'psoDelete', name }, schema: passwordPolicies }),
    onSuccess: (r) => qc.setQueryData(['password-policies'], r),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const current = draft ?? q.data.default;
  return (
    <Stack>
      <Title order={2}>{t('pwp.title')}</Title>
      {(saveDefault.error ?? del.error) ? <ErrorView error={saveDefault.error ?? del.error} /> : null}
      <Card withBorder>
        <Title order={3} size="h5" mb="xs">
          {t('pwp.default')}
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          {t('pwp.default-hint')}
        </Text>
        <SettingsForm value={current} onChange={setDraft} readOnly={!canWrite} />
        {canWrite ? (
          <Group mt="md">
            <Button
              disabled={!draft}
              loading={saveDefault.isPending}
              onClick={() => draft && saveDefault.mutate(draft)}
            >
              {t('dir.save')}
            </Button>
            <Button variant="default" disabled={!draft} onClick={() => setDraft(null)}>
              {t('dir.discard')}
            </Button>
          </Group>
        ) : null}
      </Card>
      <Card withBorder>
        <Group justify="space-between" mb="xs">
          <Title order={3} size="h5">
            {t('pwp.psos')}
          </Title>
          <Button size="xs" disabled={!canWrite} onClick={() => setEdit('new')}>
            {t('pwp.new-pso')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          {t('pwp.psos-hint')}
        </Text>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('pwp.name')}</Table.Th>
              <Table.Th>{t('pwp.precedence')}</Table.Th>
              <Table.Th>{t('pwp.minLength')}</Table.Th>
              <Table.Th>{t('pwp.applies-to')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.psos.map((p) => (
              <Table.Tr key={p.guid}>
                <Table.Td>{p.name}</Table.Td>
                <Table.Td>{p.precedence}</Table.Td>
                <Table.Td>{p.settings.minLength}</Table.Td>
                <Table.Td>{p.appliesTo.map((a) => a.name).join(', ')}</Table.Td>
                <Table.Td w={1}>
                  <Group gap={4} wrap="nowrap">
                    <Button size="xs" variant="subtle" disabled={!canWrite} onClick={() => setEdit(p)}>
                      {t('rbac.edit')}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      disabled={!canWrite}
                      onClick={() => del.mutate(p.name)}
                    >
                      {t('dir.delete')}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      {edit !== null ? <PsoEditor pso={edit} onClose={() => setEdit(null)} /> : null}
    </Stack>
  );
}
