// SPDX-License-Identifier: AGPL-3.0-only
/** Console roles and assignments (who may do what, where). */
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { empty, rbacAssignments, rbacPermissions, rbacRoles, type ListItem, type RbacRole } from '@opendc/shared/api';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { ObjectPicker, TypeBadge } from '../components/directory.tsx';
import { OuPickerModal } from './directory/OuPicker.tsx';

const created = z.object({ id: z.string() });

function RoleEditor({ role, onClose }: { role: RbacRole | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const perms = useQuery({
    queryKey: ['rbac-perms'],
    queryFn: () => api('/rbac/permissions', { schema: rbacPermissions }),
  });
  const editing = role && role !== 'new' ? role : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [tier0, setTier0] = useState(editing?.tier0 ?? false);
  const [selected, setSelected] = useState<string[]>(editing ? [...editing.permissions] : ['core.console.access']);
  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const body = { name, description: description || null, permissions: selected, tier0 };
      if (editing) await api(`/rbac/roles/${editing.id}`, { method: 'PUT', body, schema: empty });
      else await api('/rbac/roles', { method: 'POST', body, schema: created });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rbac-roles'] });
      onClose();
    },
  });
  const byModule = new Map<string, NonNullable<typeof perms.data>['permissions']>();
  for (const p of perms.data?.permissions ?? []) byModule.set(p.module, [...(byModule.get(p.module) ?? []), p]);
  return (
    <Modal opened={role !== null} onClose={onClose} title={t(editing ? 'rbac.edit-role' : 'rbac.new-role')} size="xl">
      <Stack>
        {save.error ? <ErrorView error={save.error} /> : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('rbac.role-name')}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <TextInput
            label={t('rbac.description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </SimpleGrid>
        <Switch
          label={t('rbac.tier0')}
          description={t('rbac.tier0-hint')}
          checked={tier0}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setTier0(on);
            if (!on) {
              const t0 = new Set(perms.data?.permissions.filter((p) => p.tier0).map((p) => p.name));
              setSelected((s) => s.filter((p) => !t0.has(p)));
            }
          }}
        />
        {perms.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
        {[...byModule.entries()].map(([mod, list]) => (
          <Checkbox.Group key={mod} label={t(`${mod}:module.title`)} value={selected} onChange={setSelected}>
            <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs" spacing={4}>
              {list.map((p) => (
                <Checkbox
                  key={p.name}
                  value={p.name}
                  disabled={p.tier0 && !tier0}
                  label={
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm">{t(p.title, { defaultValue: p.name })}</Text>
                      {p.tier0 ? (
                        <Badge size="xs" color="red" variant="light">
                          {t('dir.protected')}
                        </Badge>
                      ) : null}
                      <Text size="xs" c="dimmed">
                        {t(`rbac.scope-${p.scope}`)}
                      </Text>
                    </Group>
                  }
                />
              ))}
            </SimpleGrid>
          </Checkbox.Group>
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button loading={save.isPending} disabled={!name || !selected.length} onClick={() => save.mutate()}>
            {t('dir.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function AssignmentEditor({ opened, onClose, roles }: { opened: boolean; onClose: () => void; roles: RbacRole[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState<string | null>(null);
  const [principals, setPrincipals] = useState<ListItem[]>([]);
  const [domainScope, setDomainScope] = useState(false);
  const [ous, setOus] = useState<{ guid: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api('/rbac/assignments', {
        method: 'POST',
        body: {
          roleId,
          principals: principals.map((p) => p.guid),
          scopes: domainScope ? [{ kind: 'domain' }] : ous.map((o) => ({ kind: 'subtree', guid: o.guid })),
        },
        schema: created,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rbac-assignments'] });
      setPrincipals([]);
      setOus([]);
      onClose();
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('rbac.new-assignment')} size="lg">
      <Stack>
        {save.error ? <ErrorView error={save.error} /> : null}
        <Select
          label={t('rbac.role')}
          required
          data={roles.filter((r) => r.id !== 'builtin.domain-admin').map((r) => ({ value: r.id, label: r.name }))}
          value={roleId}
          onChange={setRoleId}
        />
        <ObjectPicker
          label={t('rbac.principals')}
          types="user,group"
          exclude={principals.map((p) => p.guid)}
          onPick={(i) => setPrincipals((x) => [...x, i])}
        />
        <Group gap={4}>
          {principals.map((p) => (
            <Badge
              key={p.guid}
              variant="light"
              rightSection={
                <CloseButton
                  size="xs"
                  aria-label={t('dir.remove-x', { name: p.name })}
                  onClick={() => setPrincipals((x) => x.filter((y) => y.guid !== p.guid))}
                />
              }
            >
              {p.name}
            </Badge>
          ))}
        </Group>
        <Checkbox
          label={t('rbac.whole-domain')}
          checked={domainScope}
          onChange={(e) => setDomainScope(e.currentTarget.checked)}
        />
        {!domainScope ? (
          <Stack gap={4}>
            <Group>
              <Text size="sm" fw={500}>
                {t('rbac.scopes')}
              </Text>
              <Button size="xs" variant="light" onClick={() => setPicking(true)}>
                {t('rbac.add-ou')}
              </Button>
            </Group>
            <Group gap={4}>
              {ous.map((o) => (
                <Badge
                  key={o.guid}
                  variant="light"
                  color="orange"
                  rightSection={
                    <CloseButton
                      size="xs"
                      aria-label={t('dir.remove-x', { name: o.name })}
                      onClick={() => setOus((x) => x.filter((y) => y.guid !== o.guid))}
                    />
                  }
                >
                  {o.name}
                </Badge>
              ))}
            </Group>
          </Stack>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button
            loading={save.isPending}
            disabled={!roleId || !principals.length || (!domainScope && !ous.length)}
            onClick={() => save.mutate()}
          >
            {t('dir.save')}
          </Button>
        </Group>
      </Stack>
      <OuPickerModal
        opened={picking}
        onClose={() => setPicking(false)}
        onPick={(guid) => {
          setPicking(false);
          void api(`/directory/objects/${guid}`, {
            schema: z.object({ guid: z.string(), name: z.string() }).loose(),
          }).then((o) =>
            setOus((x) => (x.some((y) => y.guid === o.guid) ? x : [...x, { guid: o.guid, name: o.name }])),
          );
        }}
      />
    </Modal>
  );
}

export default function Rbac() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['rbac-roles'], queryFn: () => api('/rbac/roles', { schema: rbacRoles }) });
  const assignments = useQuery({
    queryKey: ['rbac-assignments'],
    queryFn: () => api('/rbac/assignments', { schema: rbacAssignments }),
  });
  const [editRole, setEditRole] = useState<RbacRole | 'new' | null>(null);
  const [newAssignment, setNewAssignment] = useState(false);
  const canWrite = has('domain.rbac.write');
  const del = useMutation({
    mutationFn: (p: { kind: 'roles' | 'assignments'; id: string }) =>
      api(`/rbac/${p.kind}/${p.id}`, { method: 'DELETE', schema: empty }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rbac-roles'] });
      await qc.invalidateQueries({ queryKey: ['rbac-assignments'] });
    },
  });
  if (roles.isPending || assignments.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (roles.isError) return <ErrorView error={roles.error} />;
  if (assignments.isError) return <ErrorView error={assignments.error} />;
  return (
    <Stack>
      <Title order={2}>{t('rbac.title')}</Title>
      {del.error ? <ErrorView error={del.error} /> : null}
      <Tabs defaultValue="assignments">
        <Tabs.List>
          <Tabs.Tab value="assignments">{t('rbac.assignments')}</Tabs.Tab>
          <Tabs.Tab value="roles">{t('rbac.roles')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="assignments" pt="md">
          <Stack>
            <Button w="fit-content" disabled={!canWrite} onClick={() => setNewAssignment(true)}>
              {t('rbac.new-assignment')}
            </Button>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('rbac.role')}</Table.Th>
                  <Table.Th>{t('rbac.principals')}</Table.Th>
                  <Table.Th>{t('rbac.scopes')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {assignments.data.assignments.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td>{a.roleName}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {a.principals.map((p) => (
                          <Group key={p.sid} gap={4}>
                            <TypeBadge type={p.type} />
                            <Text size="sm">{p.name}</Text>
                          </Group>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {a.scopes.map((s) => (
                        <Text key={s.kind === 'domain' ? 'domain' : s.guid} size="sm">
                          {s.kind === 'domain' ? t('rbac.whole-domain') : s.dn}
                        </Text>
                      ))}
                    </Table.Td>
                    <Table.Td w={1}>
                      {a.builtin ? (
                        <Badge variant="light">{t('rbac.builtin')}</Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          disabled={!canWrite}
                          onClick={() => del.mutate({ kind: 'assignments', id: a.id })}
                        >
                          {t('dir.remove')}
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="roles" pt="md">
          <Stack>
            <Button w="fit-content" disabled={!canWrite} onClick={() => setEditRole('new')}>
              {t('rbac.new-role')}
            </Button>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('rbac.role-name')}</Table.Th>
                  <Table.Th>{t('rbac.permissions')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {roles.data.roles.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text>{r.name}</Text>
                        {r.tier0 ? (
                          <Badge color="red" variant="light" size="sm">
                            {t('dir.protected')}
                          </Badge>
                        ) : null}
                        {r.builtin ? (
                          <Badge variant="light" size="sm">
                            {t('rbac.builtin')}
                          </Badge>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {r.permissions.join(', ')}
                      </Text>
                    </Table.Td>
                    <Table.Td w={1}>
                      {r.builtin ? null : (
                        <Group gap={4} wrap="nowrap">
                          <Button size="xs" variant="subtle" disabled={!canWrite} onClick={() => setEditRole(r)}>
                            {t('rbac.edit')}
                          </Button>
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            disabled={!canWrite}
                            onClick={() => del.mutate({ kind: 'roles', id: r.id })}
                          >
                            {t('dir.delete')}
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      {editRole !== null ? <RoleEditor role={editRole} onClose={() => setEditRole(null)} /> : null}
      <AssignmentEditor opened={newAssignment} onClose={() => setNewAssignment(false)} roles={roles.data.roles} />
    </Stack>
  );
}
