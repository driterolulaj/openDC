// SPDX-License-Identifier: AGPL-3.0-only
/** User templates: default attributes (with placeholders), target OU, groups and account flags. */
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { empty, userTemplates, type UserTemplate } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { useSession } from '../../session.tsx';
import { ObjectPicker } from '../../components/directory.tsx';
import { OuPickerModal } from './OuPicker.tsx';

const FIELDS = [
  'mail',
  'userPrincipalName',
  'title',
  'department',
  'company',
  'office',
  'description',
  'homeDirectory',
  'homeDrive',
  'profilePath',
  'scriptPath',
  'loginShell',
  'unixHomeDirectory',
] as const;
const objectIdentity = z.object({ guid: z.string(), dn: z.string() }).loose();

function Editor({ tpl, onClose }: { tpl: UserTemplate | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const editing = tpl && tpl !== 'new' ? tpl : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [parent, setParent] = useState<{ guid: string; dn: string } | null>(
    editing?.parent ? { guid: editing.parent, dn: editing.parentDn ?? editing.parent } : null,
  );
  const [defaults, setDefaults] = useState<Record<string, string>>({ ...(editing?.defaults ?? {}) } as Record<
    string,
    string
  >);
  const [groups, setGroups] = useState<{ guid: string; name: string }[]>(editing?.groups ?? []);
  const [mustChange, setMustChange] = useState(editing?.mustChangePassword ?? true);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [picking, setPicking] = useState(false);
  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const body = {
        name,
        description: description || null,
        parent: parent?.guid ?? null,
        defaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)),
        groups: groups.map((g) => g.guid),
        mustChangePassword: mustChange,
        enabled,
      };
      if (editing) await api(`/directory/templates/${editing.id}`, { method: 'PUT', body, schema: empty });
      else await api('/directory/templates', { method: 'POST', body, schema: z.object({ id: z.string() }) });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    },
  });
  return (
    <Modal opened={tpl !== null} onClose={onClose} title={t(editing ? 'tpl.edit' : 'tpl.new')} size="lg">
      <Stack>
        {save.error ? <ErrorView error={save.error} /> : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('tpl.name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <TextInput
            label={t('rbac.description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </SimpleGrid>
        <Group>
          <Text size="sm">{t('imp.target')}:</Text>
          <Text size="sm" ff="monospace">
            {parent?.dn ?? t('imp.target-default')}
          </Text>
          <Button size="xs" variant="light" onClick={() => setPicking(true)}>
            {t('imp.choose')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t('tpl.placeholders')}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {FIELDS.map((f) => (
            <TextInput
              key={f}
              label={t(`dir.f-${f}`)}
              value={defaults[f] ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setDefaults((d) => ({ ...d, [f]: v }));
              }}
            />
          ))}
        </SimpleGrid>
        <ObjectPicker
          label={t('dir.f-groups')}
          types="group"
          exclude={groups.map((g) => g.guid)}
          onPick={(g) => setGroups((x) => [...x, { guid: g.guid, name: g.name }])}
        />
        <Group gap={4}>
          {groups.map((g) => (
            <Badge
              key={g.guid}
              variant="light"
              rightSection={
                <CloseButton
                  size="xs"
                  aria-label={t('dir.remove-x', { name: g.name })}
                  onClick={() => setGroups((x) => x.filter((y) => y.guid !== g.guid))}
                />
              }
            >
              {g.name}
            </Badge>
          ))}
        </Group>
        <Group>
          <Checkbox
            label={t('dir.f-mustChange')}
            checked={mustChange}
            onChange={(e) => setMustChange(e.currentTarget.checked)}
          />
          <Checkbox
            label={t('dir.f-enabled')}
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
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
      <OuPickerModal
        opened={picking}
        onClose={() => setPicking(false)}
        onPick={(guid) => {
          setPicking(false);
          void api(`/directory/objects/${guid}`, { schema: objectIdentity }).then((o) =>
            setParent({ guid: o.guid, dn: o.dn }),
          );
        }}
      />
    </Modal>
  );
}

export default function Templates() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['templates'],
    queryFn: () => api('/directory/templates', { schema: userTemplates }),
  });
  const [edit, setEdit] = useState<UserTemplate | 'new' | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api(`/directory/templates/${id}`, { method: 'DELETE', schema: empty }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
  const canWrite = has('domain.templates.manage');
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('tpl.title')}</Title>
        <Button disabled={!canWrite} onClick={() => setEdit('new')}>
          {t('tpl.new')}
        </Button>
      </Group>
      {del.error ? <ErrorView error={del.error} /> : null}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('tpl.name')}</Table.Th>
            <Table.Th>{t('imp.target')}</Table.Th>
            <Table.Th>{t('dir.f-groups')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {q.data.templates.map((x) => (
            <Table.Tr key={x.id}>
              <Table.Td>{x.name}</Table.Td>
              <Table.Td>
                <Text size="xs" ff="monospace">
                  {x.parentDn ?? t('imp.target-default')}
                </Text>
              </Table.Td>
              <Table.Td>{x.groups.map((g) => g.name).join(', ')}</Table.Td>
              <Table.Td w={1}>
                <Group gap={4} wrap="nowrap">
                  <Button size="xs" variant="subtle" disabled={!canWrite} onClick={() => setEdit(x)}>
                    {t('rbac.edit')}
                  </Button>
                  <Button size="xs" variant="subtle" color="red" disabled={!canWrite} onClick={() => del.mutate(x.id)}>
                    {t('dir.delete')}
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {edit !== null ? <Editor tpl={edit} onClose={() => setEdit(null)} /> : null}
    </Stack>
  );
}
