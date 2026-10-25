// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Policies (ROADMAP Phase 3): typed settings linked to OUs, containers or the domain, with enforced links and
 * priorities, and the effective-policy view for one object (also shown on the object page).
 */
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
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { effectivePolicy, policyList, type PolicyInput, type PolicyType, type PolicyView } from '@opendc/shared/api';
import type { PasswordSettings } from '@opendc/shared/domain';
import { z } from 'zod';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { ObjectPicker } from '../components/directory.tsx';
import { OuPickerModal } from './directory/OuPicker.tsx';
import { PASSWORD_DEFAULTS, SettingsForm } from './PasswordPolicies.tsx';

type Link = { targetGuid: string; enforced: boolean; enabled: boolean; dn: string | null };

/** Registry settings as editable text: one `key = JSON value` per line. */
const toText = (s: Record<string, unknown>): string =>
  Object.entries(s)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join('\n');
function fromText(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('=');
    if (i < 1) throw new Error(line);
    const v = line.slice(i + 1).trim();
    try {
      out[line.slice(0, i).trim()] = JSON.parse(v) as unknown;
    } catch {
      out[line.slice(0, i).trim()] = v;
    }
  }
  return out;
}

function Editor({ policy, type, onClose }: { policy: PolicyView | null; type: PolicyType; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(policy?.name ?? '');
  const [description, setDescription] = useState(policy?.description ?? '');
  const [priority, setPriority] = useState<number>(policy?.priority ?? 100);
  const [links, setLinks] = useState<Link[]>(policy?.links ?? []);
  const [groups, setGroups] = useState<{ guid: string; name: string }[]>(
    (policy?.filter?.groupGuids ?? []).map((g) => ({ guid: g, name: g })),
  );
  const [password, setPassword] = useState<PasswordSettings>(
    type === 'password' && policy ? (policy.settings as PasswordSettings) : PASSWORD_DEFAULTS,
  );
  const [registry, setRegistry] = useState(type === 'registry' && policy ? toText(policy.settings) : '');
  const [picking, setPicking] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      let settings: Record<string, unknown> = password;
      if (type === 'registry') {
        try {
          settings = fromText(registry);
          setParseError(null);
        } catch (e) {
          setParseError((e as Error).message);
          throw e;
        }
      }
      const body = {
        type,
        name,
        description: description || null,
        priority,
        links: links.map(({ targetGuid, enforced, enabled }) => ({ targetGuid, enforced, enabled })),
        ...(groups.length ? { filter: { groupGuids: groups.map((g) => g.guid) } } : {}),
        settings,
      } as PolicyInput;
      if (policy) await api(`/policies/${policy.id}`, { method: 'PUT', body, schema: z.object({}) });
      else await api('/policies', { method: 'POST', body, schema: z.object({ id: z.string() }) });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['policies'] });
      onClose();
    },
  });

  return (
    <Modal opened onClose={onClose} title={t(policy ? 'pol.edit' : 'pol.new')} size="xl">
      <Stack>
        {save.error && !parseError ? <ErrorView error={save.error} /> : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('pol.name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <NumberInput
            label={t('pol.priority')}
            description={t('pol.priority-hint')}
            min={0}
            max={999}
            value={priority}
            onChange={(v) => setPriority(Number(v) || 0)}
          />
        </SimpleGrid>
        <TextInput
          label={t('pol.description')}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Title order={4}>{t('pol.settings')}</Title>
        {type === 'password' ? (
          <SettingsForm value={password} onChange={setPassword} readOnly={false} />
        ) : (
          <Textarea
            label={t('pol.registry-settings')}
            description={t('pol.registry-format')}
            autosize
            minRows={4}
            ff="monospace"
            value={registry}
            error={parseError ? t('pol.registry-invalid', { line: parseError }) : null}
            onChange={(e) => setRegistry(e.currentTarget.value)}
          />
        )}
        <Group justify="space-between">
          <Title order={4}>{t('pol.links')}</Title>
          <Button size="xs" variant="default" onClick={() => setPicking(true)}>
            {t('pol.add-link')}
          </Button>
        </Group>
        {links.length ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('pol.link-target')}</Table.Th>
                <Table.Th>{t('pol.enforced')}</Table.Th>
                <Table.Th>{t('pol.enabled')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {links.map((l, i) => (
                <Table.Tr key={l.targetGuid}>
                  <Table.Td ff="monospace" fz="xs">
                    {l.dn ?? l.targetGuid}
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      aria-label={t('pol.enforced')}
                      checked={l.enforced}
                      onChange={(e) => {
                        const v = e.currentTarget.checked;
                        setLinks((x) => x.map((y, j) => (j === i ? { ...y, enforced: v } : y)));
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      aria-label={t('pol.enabled')}
                      checked={l.enabled}
                      onChange={(e) => {
                        const v = e.currentTarget.checked;
                        setLinks((x) => x.map((y, j) => (j === i ? { ...y, enabled: v } : y)));
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <CloseButton
                      aria-label={t('pol.remove-link')}
                      onClick={() => setLinks((x) => x.filter((_, j) => j !== i))}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">{t('pol.no-links')}</Text>
        )}
        <ObjectPicker
          label={t('pol.filter-groups')}
          types="group"
          exclude={groups.map((g) => g.guid)}
          onPick={(g) => setGroups((x) => [...x, { guid: g.guid, name: g.name }])}
        />
        {groups.length ? (
          <Group gap={4}>
            {groups.map((g) => (
              <Badge
                key={g.guid}
                variant="light"
                rightSection={
                  <CloseButton
                    size="xs"
                    aria-label={t('pol.remove-group', { name: g.name })}
                    onClick={() => setGroups((x) => x.filter((y) => y.guid !== g.guid))}
                  />
                }
              >
                {g.name}
              </Badge>
            ))}
          </Group>
        ) : null}
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
        title={t('pol.add-link')}
        onClose={() => setPicking(false)}
        onPick={(guid) => {
          setPicking(false);
          if (!links.some((l) => l.targetGuid === guid))
            setLinks((x) => [...x, { targetGuid: guid, enforced: false, enabled: true, dn: null }]);
        }}
      />
    </Modal>
  );
}

function PolicyTable({ type }: { type: PolicyType }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const canManage = has('policies.policy.manage');
  const [edit, setEdit] = useState<PolicyView | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['policies', type],
    queryFn: () => api(`/policies?type=${type}`, { schema: policyList }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/policies/${id}`, { method: 'DELETE', schema: z.object({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['policies'] }),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed">{t(`pol.${type}-hint`)}</Text>
        <Button size="xs" disabled={!canManage} onClick={() => setEdit('new')}>
          {t('pol.new')}
        </Button>
      </Group>
      {del.error ? <ErrorView error={del.error} /> : null}
      {q.data.policies.length === 0 ? (
        <Text>{t('pol.empty')}</Text>
      ) : (
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('pol.name')}</Table.Th>
              <Table.Th>{t('pol.priority')}</Table.Th>
              <Table.Th>{t('pol.links')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.policies.map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>
                  <Text fw={500}>{p.name}</Text>
                  {p.description ? (
                    <Text size="xs" c="dimmed">
                      {p.description}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>{p.priority}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {p.links.map((l) => (
                      <Badge
                        key={l.targetGuid}
                        variant={l.enforced ? 'filled' : 'light'}
                        color={l.enabled ? 'blue' : 'gray'}
                        title={l.enforced ? t('pol.enforced') : undefined}
                      >
                        {(l.dn ?? l.targetGuid).split(',')[0]}
                        {l.enforced ? ' ⚑' : ''}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    <Button size="xs" variant="subtle" disabled={!canManage} onClick={() => setEdit(p)}>
                      {t('rbac.edit')}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      disabled={!canManage}
                      loading={del.isPending && del.variables === p.id}
                      onClick={() => del.mutate(p.id)}
                    >
                      {t('dir.delete')}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {edit ? <Editor policy={edit === 'new' ? null : edit} type={type} onClose={() => setEdit(null)} /> : null}
    </Stack>
  );
}

/** Which policies apply to an object, winner first, and where each setting comes from. */
export function EffectivePolicies({ guid }: { guid: string }) {
  const { t } = useTranslation();
  const [type, setType] = useState<PolicyType>('password');
  const q = useQuery({
    queryKey: ['effective-policy', guid, type],
    queryFn: () => api(`/policies/effective?target=${guid}&type=${type}`, { schema: effectivePolicy }),
  });
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title order={3}>{t('pol.effective')}</Title>
          <SegmentedControl
            aria-label={t('pol.type')}
            value={type}
            onChange={(v) => setType(v)}
            data={[
              { value: 'password', label: t('pol.password') },
              { value: 'registry', label: t('pol.registry') },
            ]}
          />
        </Group>
        {q.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
        {q.isError ? <ErrorView error={q.error} /> : null}
        {q.data ? (
          q.data.applicable.length === 0 ? (
            <Text c="dimmed">{t(type === 'password' ? 'pol.effective-none-password' : 'pol.effective-none')}</Text>
          ) : (
            <>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('pol.setting')}</Table.Th>
                    <Table.Th>{t('pol.value')}</Table.Th>
                    <Table.Th>{t('pol.source')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {Object.entries(q.data.settings).map(([k, s]) => (
                    <Table.Tr key={k}>
                      <Table.Td ff="monospace">{type === 'password' ? t(`pwp.${k}`, { defaultValue: k }) : k}</Table.Td>
                      <Table.Td ff="monospace">{JSON.stringify(s.value)}</Table.Td>
                      <Table.Td>
                        {s.policyName}{' '}
                        <Text span size="xs" c="dimmed">
                          ({s.levelDn.split(',')[0]})
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Text size="sm" fw={500}>
                {t('pol.order')}
              </Text>
              <Stack gap={2}>
                {q.data.applicable.map((a, i) => (
                  <Text key={a.id} size="sm">
                    {i + 1}. {a.name} · {a.level.dn.split(',')[0]} · {t('pol.priority')} {a.priority}
                    {a.enforced ? ` · ${t('pol.enforced')}` : ''}
                  </Text>
                ))}
              </Stack>
            </>
          )
        ) : null}
      </Stack>
    </Card>
  );
}

export default function Policies() {
  const { t } = useTranslation();
  const { has } = useSession();
  if (!has('policies.policy.read')) return <Text>{t('error.forbidden')}</Text>;
  return (
    <Stack>
      <Title order={2}>{t('pol.title')}</Title>
      <Text c="dimmed">{t('pol.intro')}</Text>
      <Tabs defaultValue="password">
        <Tabs.List>
          <Tabs.Tab value="password">{t('pol.password')}</Tabs.Tab>
          <Tabs.Tab value="registry">{t('pol.registry')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="password" pt="md">
          <PolicyTable type="password" />
        </Tabs.Panel>
        <Tabs.Panel value="registry" pt="md">
          <PolicyTable type="registry" />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
