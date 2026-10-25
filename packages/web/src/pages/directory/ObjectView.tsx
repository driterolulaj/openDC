// SPDX-License-Identifier: AGPL-3.0-only
/** One directory object: attributes (editable per permission), account actions, membership, history. */
import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  PasswordInput,
  Checkbox,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import {
  directoryObject,
  empty,
  membersResponse,
  objectHistory,
  passwordResponse,
  createdResponse,
  type DirectoryObject,
  type ObjectRef,
} from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { useSession } from '../../session.tsx';
import { ObjectPicker, ProtectedBadge, SecretOnce, TypeBadge, TypedConfirm } from '../../components/directory.tsx';
import { OuPickerModal } from './OuPicker.tsx';
import { EffectivePolicies } from '../Policies.tsx';

const USER_GENERAL = [
  'givenName',
  'sn',
  'initials',
  'displayName',
  'description',
  'mail',
  'telephoneNumber',
  'mobile',
] as const;
const USER_ORG = [
  'title',
  'department',
  'company',
  'office',
  'employeeId',
  'streetAddress',
  'city',
  'postalCode',
  'country',
] as const;
const USER_PROFILE = [
  'homeDirectory',
  'homeDrive',
  'profilePath',
  'scriptPath',
  'loginShell',
  'unixHomeDirectory',
] as const;
const CONTACT_FIELDS = [
  'givenName',
  'sn',
  'displayName',
  'description',
  'mail',
  'telephoneNumber',
  'mobile',
  'company',
  'title',
  'department',
] as const;

type Draft = Record<string, string>;

function fmtDate(iso: string | null, lang: string): string {
  return iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';
}

function RefList({ refs }: { refs: ObjectRef[] }) {
  const { t } = useTranslation();
  if (!refs.length) return <Text c="dimmed">{t('dir.none')}</Text>;
  return (
    <Stack gap={4}>
      {refs.map((r) => (
        <Group key={r.dn} gap={6}>
          <TypeBadge type={r.type} />
          {r.guid ? (
            <Anchor component={Link} to={`/directory/${r.guid}`}>
              {r.name}
            </Anchor>
          ) : (
            <Text>{r.name}</Text>
          )}
        </Group>
      ))}
    </Stack>
  );
}

function Fields({
  names,
  draft,
  setDraft,
  readOnly,
}: {
  names: readonly string[];
  draft: Draft;
  setDraft: (d: Draft) => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {names.map((n) => (
        <TextInput
          key={n}
          label={t(`dir.f-${n}`)}
          value={draft[n] ?? ''}
          readOnly={readOnly}
          onChange={(e) => setDraft({ ...draft, [n]: e.currentTarget.value })}
        />
      ))}
    </SimpleGrid>
  );
}

function Members({
  guid,
  protectedGroup,
  canEdit,
  phrase,
}: {
  guid: string;
  protectedGroup: boolean;
  canEdit: boolean;
  phrase: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['members', guid],
    queryFn: () => api(`/directory/groups/${guid}/members`, { schema: membersResponse }),
  });
  const [pending, setPending] = useState<{ add: string[]; remove: string[] } | null>(null);
  const change = useMutation({
    mutationFn: (b: { add: string[]; remove: string[]; confirm?: string }) =>
      api(`/directory/groups/${guid}/members`, { method: 'POST', body: b, schema: membersResponse }),
    onSuccess: async () => {
      setPending(null);
      await qc.invalidateQueries({ queryKey: ['members', guid] });
      await qc.invalidateQueries({ queryKey: ['object', guid] });
    },
  });
  const run = (b: { add: string[]; remove: string[] }): void => {
    if (protectedGroup) setPending(b);
    else change.mutate(b);
  };
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  return (
    <Stack>
      {change.error ? <ErrorView error={change.error} /> : null}
      {canEdit ? (
        <ObjectPicker
          label={t('dir.add-member')}
          types="user,group,computer,contact"
          exclude={q.data.members.map((m) => m.guid)}
          onPick={(i) => run({ add: [i.guid], remove: [] })}
        />
      ) : null}
      <Table>
        <Table.Tbody>
          {q.data.members.map((m) => (
            <Table.Tr key={m.guid}>
              <Table.Td>
                <TypeBadge type={m.type} />
              </Table.Td>
              <Table.Td>
                <Anchor component={Link} to={`/directory/${m.guid}`}>
                  {m.name}
                </Anchor>
              </Table.Td>
              <Table.Td w={1}>
                {canEdit ? (
                  <Button size="xs" variant="subtle" color="red" onClick={() => run({ add: [], remove: [m.guid] })}>
                    {t('dir.remove')}
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <TypedConfirm
        opened={pending !== null}
        title={t('dir.tier0-title')}
        body={t('dir.tier0-members')}
        phrase={phrase}
        confirmLabel={t('dir.apply')}
        busy={change.isPending}
        onClose={() => setPending(null)}
        onConfirm={(confirm) => pending && change.mutate({ ...pending, confirm })}
      />
    </Stack>
  );
}

function History({ guid }: { guid: string }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({
    queryKey: ['history', guid],
    queryFn: () => api(`/directory/objects/${guid}/history`, { schema: objectHistory }),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  if (!q.data.entries.length) return <Text c="dimmed">{t('audit.empty')}</Text>;
  return (
    <Table striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t('audit.time')}</Table.Th>
          <Table.Th>{t('audit.actor')}</Table.Th>
          <Table.Th>{t('audit.action')}</Table.Th>
          <Table.Th>{t('dir.before')}</Table.Th>
          <Table.Th>{t('dir.after')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {q.data.entries.map((e) => (
          <Table.Tr key={`${e.originNodeId}:${String(e.seq)}`}>
            <Table.Td>{fmtDate(e.ts, i18n.language)}</Table.Td>
            <Table.Td>{e.actor}</Table.Td>
            <Table.Td ff="monospace">{e.action}</Table.Td>
            <Table.Td ff="monospace" fz="xs">
              {e.before === null ? '' : JSON.stringify(e.before)}
            </Table.Td>
            <Table.Td ff="monospace" fz="xs">
              {e.after === null ? '' : JSON.stringify(e.after)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function draftOf(o: DirectoryObject, names: readonly string[]): Draft {
  const rec = o as unknown as Record<string, unknown>;
  return Object.fromEntries(
    names.map((n) => [n, typeof rec[n] === 'string' || typeof rec[n] === 'number' ? String(rec[n]) : '']),
  );
}

export default function ObjectView() {
  const { guid = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['object', guid],
    queryFn: () => api(`/directory/objects/${guid}`, { schema: directoryObject }),
  });
  const [draft, setDraft] = useState<Draft>({});
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<null | { label: string; run: (confirm: string) => void }>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const o = q.data;
  const editNames: readonly string[] =
    o?.type === 'user'
      ? [...USER_GENERAL, ...USER_ORG, ...USER_PROFILE, 'userPrincipalName', 'uidNumber', 'gidNumber']
      : o?.type === 'contact'
        ? CONTACT_FIELDS
        : o?.type === 'group'
          ? ['description', 'mail']
          : o?.type === 'computer'
            ? ['description', 'location']
            : ['description'];
  // the draft follows the object only when another object is shown; saves update it explicitly, so a
  // background refetch never overwrites what the user is typing
  useEffect(() => {
    if (o) setDraft(draftOf(o, editNames));
  }, [o?.guid]);

  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['object', guid] });
    await qc.invalidateQueries({ queryKey: ['history', guid] });
    await qc.invalidateQueries({ queryKey: ['objects'] });
  };
  const save = useMutation({
    mutationFn: (confirm?: string) => {
      if (!o) throw new Error('no object');
      const before = draftOf(o, editNames);
      const body: Record<string, unknown> = { etag: o.etag, ...(confirm ? { confirm } : {}) };
      for (const n of editNames) {
        if ((draft[n] ?? '') === (before[n] ?? '')) continue;
        const v = draft[n] ?? '';
        body[n] = n === 'uidNumber' || n === 'gidNumber' ? (v ? Number(v) : null) : v || null;
      }
      const path = {
        user: 'users',
        group: 'groups',
        computer: 'computers',
        contact: 'contacts',
        ou: 'ous',
        container: 'ous',
      }[o.type];
      return api(`/directory/${path}/${guid}`, { method: 'PATCH', body, schema: directoryObject });
    },
    onSuccess: async (saved) => {
      qc.setQueryData(['object', guid], saved);
      setDraft(draftOf(saved, editNames));
      await qc.invalidateQueries({ queryKey: ['history', guid] });
      await qc.invalidateQueries({ queryKey: ['objects'] });
    },
  });
  const account = useMutation({
    mutationFn: (b: { action: 'enable' | 'disable' | 'unlock'; confirm?: string }) =>
      api(`/directory/users/${guid}/account`, { method: 'POST', body: b, schema: directoryObject }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (recursive: boolean) =>
      api(`/directory/objects/${guid}`, { method: 'DELETE', body: { recursive }, schema: empty }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['objects'] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
      void navigate('/directory');
    },
  });
  const move = useMutation({
    mutationFn: (parent: string) =>
      api(`/directory/objects/${guid}/move`, { method: 'POST', body: { parent }, schema: createdResponse }),
    onSuccess: async () => {
      setMoveOpen(false);
      await refresh();
      await qc.invalidateQueries({ queryKey: ['tree'] });
    },
  });

  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError || !o) return <ErrorView error={q.error} />;

  const perm = {
    user: 'users',
    group: 'groups',
    computer: 'computers',
    contact: 'contacts',
    ou: 'ous',
    container: 'ous',
  }[o.type];
  const canWrite = has(`domain.${perm}.write`);
  const phrase = 'sam' in o ? o.sam : o.name;
  const dirty = editNames.some((n) => (draft[n] ?? '') !== (draftOf(o, editNames)[n] ?? ''));
  const withConfirm = (label: string, run: (confirm?: string) => void): void => {
    if (o.protected) setConfirmFor({ label, run });
    else run();
  };

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Group gap="xs">
            <Title order={2}>{'displayName' in o && o.displayName ? o.displayName : o.name}</Title>
            <TypeBadge type={o.type} />
            {o.protected ? <ProtectedBadge /> : null}
            {o.type === 'user' && !o.enabled ? <Badge color="gray">{t('dir.status-disabled')}</Badge> : null}
            {o.type === 'user' && o.locked ? <Badge color="red">{t('dir.status-locked')}</Badge> : null}
          </Group>
          <Text size="sm" c="dimmed" ff="monospace">
            {o.dn}
          </Text>
        </Stack>
        <Group>
          {o.type === 'user' ? (
            <>
              <Button variant="default" disabled={!has('domain.users.password')} onClick={() => setResetOpen(true)}>
                {t('dir.reset-password')}
              </Button>
              <Menu>
                <Menu.Target>
                  <Button variant="default">{t('dir.actions')}</Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    disabled={!canWrite}
                    onClick={() =>
                      withConfirm(t(o.enabled ? 'dir.disable' : 'dir.enable'), (confirm) =>
                        account.mutate({ action: o.enabled ? 'disable' : 'enable', ...(confirm ? { confirm } : {}) }),
                      )
                    }
                  >
                    {t(o.enabled ? 'dir.disable' : 'dir.enable')}
                  </Menu.Item>
                  <Menu.Item
                    disabled={!o.locked || !has('domain.users.password')}
                    onClick={() =>
                      withConfirm(t('dir.unlock'), (confirm) =>
                        account.mutate({ action: 'unlock', ...(confirm ? { confirm } : {}) }),
                      )
                    }
                  >
                    {t('dir.unlock')}
                  </Menu.Item>
                  <Menu.Item disabled={!canWrite || o.protected} onClick={() => setMoveOpen(true)}>
                    {t('dir.move')}
                  </Menu.Item>
                  <Menu.Item
                    color="red"
                    disabled={!has(`domain.${perm}.delete`) || o.protected}
                    onClick={() => setDeleteOpen(true)}
                  >
                    {t('dir.delete')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </>
          ) : (
            <Menu>
              <Menu.Target>
                <Button variant="default">{t('dir.actions')}</Button>
              </Menu.Target>
              <Menu.Dropdown>
                {o.type !== 'container' ? (
                  <Menu.Item disabled={!canWrite || o.protected} onClick={() => setMoveOpen(true)}>
                    {t('dir.move')}
                  </Menu.Item>
                ) : null}
                <Menu.Item
                  color="red"
                  disabled={o.protected || (o.type === 'container' || o.type === 'ou' ? o.system : false)}
                  onClick={() => setDeleteOpen(true)}
                >
                  {t('dir.delete')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
      {o.protected ? <Alert color="red">{t('dir.protected-banner')}</Alert> : null}
      {(save.error ?? account.error ?? remove.error ?? move.error) ? (
        <ErrorView error={save.error ?? account.error ?? remove.error ?? move.error} />
      ) : null}

      <Tabs defaultValue="general" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="general">{t('dir.tab-general')}</Tabs.Tab>
          {o.type === 'user' ? <Tabs.Tab value="org">{t('dir.tab-org')}</Tabs.Tab> : null}
          {o.type === 'user' ? <Tabs.Tab value="account">{t('dir.tab-account')}</Tabs.Tab> : null}
          {o.type === 'user' ? <Tabs.Tab value="profile">{t('dir.tab-profile')}</Tabs.Tab> : null}
          {o.type === 'group' ? <Tabs.Tab value="members">{t('dir.tab-members')}</Tabs.Tab> : null}
          {'memberOf' in o ? <Tabs.Tab value="memberOf">{t('dir.tab-memberOf')}</Tabs.Tab> : null}
          {(o.type === 'user' || o.type === 'computer') && has('policies.policy.read') ? (
            <Tabs.Tab value="policies">{t('dir.tab-policies')}</Tabs.Tab>
          ) : null}
          {has('core.audit.read') ? <Tabs.Tab value="history">{t('dir.tab-history')}</Tabs.Tab> : null}
        </Tabs.List>

        <Tabs.Panel value="general" pt="md">
          <Stack>
            <Fields
              names={
                o.type === 'user'
                  ? USER_GENERAL
                  : o.type === 'contact'
                    ? CONTACT_FIELDS
                    : o.type === 'group'
                      ? ['description', 'mail']
                      : o.type === 'computer'
                        ? ['description', 'location']
                        : ['description']
              }
              draft={draft}
              setDraft={setDraft}
              readOnly={!canWrite}
            />
            {o.type === 'group' ? (
              <Table>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-sam')}</Table.Th>
                    <Table.Td>{o.sam}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-scope')}</Table.Th>
                    <Table.Td>{t(`dir.scope-${o.scope}`)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-kind')}</Table.Th>
                    <Table.Td>{t(`dir.kind-${o.kind}`)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-gidNumber')}</Table.Th>
                    <Table.Td>{o.gidNumber ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-memberCount')}</Table.Th>
                    <Table.Td>{o.memberCount}</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            ) : null}
            {o.type === 'computer' ? (
              <Table>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-dnsHostName')}</Table.Th>
                    <Table.Td>{o.dnsHostName ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-os')}</Table.Th>
                    <Table.Td>
                      {[o.operatingSystem, o.operatingSystemVersion].filter(Boolean).join(' ') || '—'}
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-lastLogon')}</Table.Th>
                    <Table.Td>{fmtDate(o.lastLogon, i18n.language)}</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            ) : null}
            {o.type === 'ou' ? (
              <Button component={Link} to={`/directory?base=${o.guid}&type=all`} variant="light" w="fit-content">
                {t('dir.show-contents')}
              </Button>
            ) : null}
            {canWrite ? (
              <Group>
                <Button
                  disabled={!dirty}
                  loading={save.isPending}
                  onClick={() => withConfirm(t('dir.save'), (confirm) => save.mutate(confirm))}
                >
                  {t('dir.save')}
                </Button>
                <Button variant="default" disabled={!dirty} onClick={() => setDraft(draftOf(o, editNames))}>
                  {t('dir.discard')}
                </Button>
              </Group>
            ) : null}
          </Stack>
        </Tabs.Panel>

        {o.type === 'user' ? (
          <>
            <Tabs.Panel value="org" pt="md">
              <Stack>
                <Fields names={USER_ORG} draft={draft} setDraft={setDraft} readOnly={!canWrite} />
                {o.manager ? (
                  <Text size="sm">
                    {t('dir.f-manager')}:{' '}
                    <Anchor component={Link} to={`/directory/${o.manager.guid}`}>
                      {o.manager.name}
                    </Anchor>
                  </Text>
                ) : null}
                {canWrite ? (
                  <Button
                    w="fit-content"
                    disabled={!dirty}
                    loading={save.isPending}
                    onClick={() => withConfirm(t('dir.save'), (confirm) => save.mutate(confirm))}
                  >
                    {t('dir.save')}
                  </Button>
                ) : null}
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="account" pt="md">
              <Table>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-sam')}</Table.Th>
                    <Table.Td>{o.sam}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-userPrincipalName')}</Table.Th>
                    <Table.Td>{o.userPrincipalName ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-sid')}</Table.Th>
                    <Table.Td ff="monospace">{o.sid}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-enabled')}</Table.Th>
                    <Table.Td>{t(o.enabled ? 'yes' : 'no')}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-accountExpires')}</Table.Th>
                    <Table.Td>{fmtDate(o.accountExpires, i18n.language)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-passwordLastSet')}</Table.Th>
                    <Table.Td>{fmtDate(o.passwordLastSet, i18n.language)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-mustChange')}</Table.Th>
                    <Table.Td>{t(o.mustChangePassword ? 'yes' : 'no')}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-passwordNeverExpires')}</Table.Th>
                    <Table.Td>{t(o.passwordNeverExpires ? 'yes' : 'no')}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-lastLogon')}</Table.Th>
                    <Table.Td>{fmtDate(o.lastLogon, i18n.language)}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-badPasswordCount')}</Table.Th>
                    <Table.Td>{o.badPasswordCount}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-primaryGroup')}</Table.Th>
                    <Table.Td>{o.primaryGroup?.name ?? '—'}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Th>{t('dir.f-whenCreated')}</Table.Th>
                    <Table.Td>{fmtDate(o.whenCreated, i18n.language)}</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Tabs.Panel>
            <Tabs.Panel value="profile" pt="md">
              <Stack>
                <Fields
                  names={[...USER_PROFILE, 'uidNumber', 'gidNumber']}
                  draft={draft}
                  setDraft={setDraft}
                  readOnly={!canWrite}
                />
                {canWrite ? (
                  <Button
                    w="fit-content"
                    disabled={!dirty}
                    loading={save.isPending}
                    onClick={() => withConfirm(t('dir.save'), (confirm) => save.mutate(confirm))}
                  >
                    {t('dir.save')}
                  </Button>
                ) : null}
              </Stack>
            </Tabs.Panel>
          </>
        ) : null}
        {o.type === 'group' ? (
          <Tabs.Panel value="members" pt="md">
            <Members
              guid={o.guid}
              protectedGroup={o.protected}
              canEdit={has('domain.groups.members')}
              phrase={phrase}
            />
          </Tabs.Panel>
        ) : null}
        {'memberOf' in o ? (
          <Tabs.Panel value="memberOf" pt="md">
            <RefList refs={o.memberOf} />
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel value="policies" pt="md">
          <EffectivePolicies guid={o.guid} />
        </Tabs.Panel>
        <Tabs.Panel value="history" pt="md">
          <History guid={o.guid} />
        </Tabs.Panel>
      </Tabs>

      {o.type === 'user' ? (
        <ResetPassword
          opened={resetOpen}
          onClose={() => setResetOpen(false)}
          guid={o.guid}
          protectedUser={o.protected}
          phrase={phrase}
          onDone={async (pw) => {
            setResetOpen(false);
            setSecret(pw);
            await refresh();
          }}
        />
      ) : null}
      <SecretOnce secret={secret} onClose={() => setSecret(null)} />
      <TypedConfirm
        opened={confirmFor !== null}
        title={t('dir.tier0-title')}
        body={t('dir.tier0-body', { action: confirmFor?.label ?? '' })}
        phrase={phrase}
        confirmLabel={confirmFor?.label ?? ''}
        onClose={() => setConfirmFor(null)}
        onConfirm={(c) => {
          confirmFor?.run(c);
          setConfirmFor(null);
        }}
      />
      <TypedConfirm
        opened={deleteOpen}
        title={t('dir.delete-title')}
        body={t(o.type === 'ou' ? 'dir.delete-ou-body' : 'dir.delete-body', { name: o.name })}
        phrase={o.name}
        confirmLabel={t('dir.delete')}
        busy={remove.isPending}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate(o.type === 'ou')}
      />
      <OuPickerModal
        opened={moveOpen}
        onClose={() => setMoveOpen(false)}
        onPick={(g) => move.mutate(g)}
        busy={move.isPending}
      />
    </Stack>
  );
}

function ResetPassword({
  opened,
  onClose,
  guid,
  protectedUser,
  phrase,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  guid: string;
  protectedUser: boolean;
  phrase: string;
  onDone: (generated: string | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () =>
      api(`/directory/users/${guid}/password`, {
        method: 'POST',
        body: {
          ...(password ? { password } : {}),
          mustChangePassword: mustChange,
          unlock: true,
          ...(protectedUser ? { confirm } : {}),
        },
        schema: passwordResponse,
      }),
    onSuccess: async (r) => {
      setPassword('');
      setConfirm('');
      await onDone(r.generatedPassword);
    },
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('dir.reset-password')}>
      <Stack>
        {reset.error ? <ErrorView error={reset.error} /> : null}
        <PasswordInput
          label={t('dir.f-password')}
          description={t('dir.f-password-hint')}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          data-autofocus
        />
        <Checkbox
          label={t('dir.f-mustChange')}
          checked={mustChange}
          onChange={(e) => setMustChange(e.currentTarget.checked)}
        />
        {protectedUser ? (
          <>
            <Alert color="red">{t('dir.tier0-body', { action: t('dir.reset-password') })}</Alert>
            <TextInput
              label={t('dir.confirm-type', { phrase })}
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              autoComplete="off"
            />
          </>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button
            {...(protectedUser ? { color: 'red' } : {})}
            loading={reset.isPending}
            disabled={protectedUser && confirm.trim().toLowerCase() !== phrase.toLowerCase()}
            onClick={() => reset.mutate()}
          >
            {t('dir.reset-password')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
