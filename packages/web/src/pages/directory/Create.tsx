// SPDX-License-Identifier: AGPL-3.0-only
/** Create dialogs: user, group, contact, OU. */
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Modal,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  TextInput,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { createdResponse, userTemplates, type ListItem } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { ObjectPicker, SecretOnce } from '../../components/directory.tsx';

interface Props {
  opened: boolean;
  onClose: () => void;
  parent: string | null;
}

const clean = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));

function useCreate(path: string, onDone: (guid: string, generated: string | null) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api(path, { method: 'POST', body, schema: createdResponse }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['objects'] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
      onDone(r.guid, r.generatedPassword);
    },
  });
}

export function CreateUser({ opened, onClose, parent }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [f, setF] = useState({ givenName: '', sn: '', displayName: '', sam: '', mail: '', title: '', department: '' });
  const [samTouched, setSamTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [groups, setGroups] = useState<ListItem[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const tpls = useQuery({
    queryKey: ['templates'],
    queryFn: () => api('/directory/templates', { schema: userTemplates }),
    enabled: opened,
  });
  const [secret, setSecret] = useState<{ guid: string; pw: string } | null>(null);
  const create = useCreate('/directory/users', (guid, generated) => {
    if (generated) setSecret({ guid, pw: generated });
    else {
      onClose();
      void navigate(`/directory/${guid}`);
    }
  });
  const upd = (k: keyof typeof f, v: string): void => {
    setF((x) => {
      const next = { ...x, [k]: v };
      if (!samTouched && (k === 'givenName' || k === 'sn'))
        next.sam = `${next.givenName}${next.sn ? `.${next.sn}` : ''}`
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9._-]/g, '')
          .slice(0, 20);
      return next;
    });
  };
  return (
    <>
      <Modal opened={opened && !secret} onClose={onClose} title={t('dir.create-user')} size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              clean({
                ...f,
                // a template brings its own OU unless one is selected in the tree
                ...(parent && !templateId ? { parent } : {}),
                ...(templateId ? { templateId } : {}),
                password: password || undefined,
                mustChangePassword: mustChange,
                enabled,
                groups: groups.map((g) => g.guid),
              }),
            );
          }}
        >
          <Stack>
            {create.error ? <ErrorView error={create.error} /> : null}
            {tpls.data?.templates.length ? (
              <Select
                label={t('dir.f-template')}
                clearable
                data={tpls.data.templates.map((x) => ({ value: x.id, label: x.name }))}
                value={templateId}
                onChange={setTemplateId}
              />
            ) : null}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label={t('dir.f-givenName')}
                value={f.givenName}
                onChange={(e) => upd('givenName', e.currentTarget.value)}
                data-autofocus
              />
              <TextInput label={t('dir.f-sn')} value={f.sn} onChange={(e) => upd('sn', e.currentTarget.value)} />
              <TextInput
                label={t('dir.f-sam')}
                required
                maxLength={20}
                value={f.sam}
                onChange={(e) => {
                  setSamTouched(true);
                  upd('sam', e.currentTarget.value);
                }}
              />
              <TextInput
                label={t('dir.f-displayName')}
                placeholder={[f.givenName, f.sn].filter(Boolean).join(' ')}
                value={f.displayName}
                onChange={(e) => upd('displayName', e.currentTarget.value)}
              />
              <TextInput
                label={t('dir.f-mail')}
                type="email"
                value={f.mail}
                onChange={(e) => upd('mail', e.currentTarget.value)}
              />
              <TextInput
                label={t('dir.f-title')}
                value={f.title}
                onChange={(e) => upd('title', e.currentTarget.value)}
              />
              <TextInput
                label={t('dir.f-department')}
                value={f.department}
                onChange={(e) => upd('department', e.currentTarget.value)}
              />
              <PasswordInput
                label={t('dir.f-password')}
                description={t('dir.f-password-hint')}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
            </SimpleGrid>
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
            <ObjectPicker
              label={t('dir.f-groups')}
              types="group"
              exclude={groups.map((g) => g.guid)}
              onPick={(g) => setGroups((x) => [...x, g])}
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
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t('dir.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending} disabled={!f.sam}>
                {t('dir.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      <SecretOnce
        secret={secret?.pw ?? null}
        onClose={() => {
          const guid = secret?.guid;
          setSecret(null);
          onClose();
          if (guid) void navigate(`/directory/${guid}`);
        }}
      />
    </>
  );
}

export function CreateGroup({ opened, onClose, parent }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('global');
  const [kind, setKind] = useState('security');
  const create = useCreate('/directory/groups', (guid) => {
    onClose();
    void navigate(`/directory/${guid}`);
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('dir.create-group')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(clean({ name, description, scope, kind, ...(parent ? { parent } : {}) }));
        }}
      >
        <Stack>
          {create.error ? <ErrorView error={create.error} /> : null}
          <TextInput
            label={t('dir.f-name')}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
          <TextInput
            label={t('dir.f-description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Select
            label={t('dir.f-scope')}
            value={scope}
            onChange={(v) => setScope(v ?? 'global')}
            data={['global', 'domainLocal', 'universal'].map((x) => ({ value: x, label: t(`dir.scope-${x}`) }))}
          />
          <Select
            label={t('dir.f-kind')}
            value={kind}
            onChange={(v) => setKind(v ?? 'security')}
            data={['security', 'distribution'].map((x) => ({ value: x, label: t(`dir.kind-${x}`) }))}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('dir.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name}>
              {t('dir.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function CreateContact({ opened, onClose, parent }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [f, setF] = useState({ cn: '', givenName: '', sn: '', mail: '', telephoneNumber: '', company: '' });
  const create = useCreate('/directory/contacts', (guid) => {
    onClose();
    void navigate(`/directory/${guid}`);
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('dir.create-contact')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(clean({ ...f, ...(parent ? { parent } : {}) }));
        }}
      >
        <Stack>
          {create.error ? <ErrorView error={create.error} /> : null}
          {(['cn', 'givenName', 'sn', 'mail', 'telephoneNumber', 'company'] as const).map((k) => (
            <TextInput
              key={k}
              label={t(`dir.f-${k}`)}
              required={k === 'cn'}
              value={f[k]}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setF((x) => ({ ...x, [k]: v }));
              }}
            />
          ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('dir.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!f.cn}>
              {t('dir.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function CreateOu({ opened, onClose, parent }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreate('/directory/ous', () => {
    setName('');
    setDescription('');
    onClose();
  });
  return (
    <Modal opened={opened} onClose={onClose} title={t('dir.create-ou')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(clean({ name, description, ...(parent ? { parent } : {}) }));
        }}
      >
        <Stack>
          {create.error ? <ErrorView error={create.error} /> : null}
          <TextInput
            label={t('dir.f-name')}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
          <TextInput
            label={t('dir.f-description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('dir.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name}>
              {t('dir.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
