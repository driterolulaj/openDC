// SPDX-License-Identifier: AGPL-3.0-only
/** Building blocks of the directory pages: OU tree, object picker, typed confirmation, one-time secrets. */
import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  NavLink,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listResponse, treeResponse, type Container, type ListItem } from '@opendc/shared/api';
import { api } from '../api.ts';

export const TYPE_COLORS: Record<string, string> = {
  user: 'blue',
  group: 'grape',
  computer: 'teal',
  contact: 'cyan',
  ou: 'orange',
  container: 'gray',
  other: 'gray',
};

export function TypeBadge({ type }: { type: string }) {
  const { t } = useTranslation();
  return (
    <Badge color={TYPE_COLORS[type] ?? 'gray'} variant="light" size="sm">
      {t(`dir.type-${type}`)}
    </Badge>
  );
}

export function ProtectedBadge() {
  const { t } = useTranslation();
  return (
    <Badge color="red" variant="outline" size="sm" title={t('dir.protected-hint')}>
      {t('dir.protected')}
    </Badge>
  );
}

function TreeNode({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: Container;
  selected: string | null;
  onSelect: (c: Container) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['tree', node.guid],
    queryFn: () => api(`/directory/tree?base=${node.guid}`, { schema: treeResponse }),
    enabled: open && node.hasChildren,
  });
  return (
    <NavLink
      label={node.name}
      active={selected === node.guid}
      opened={open}
      onClick={() => onSelect(node)}
      onChange={setOpen}
      childrenOffset={12}
      {...(depth === 0 ? {} : { pl: 4 })}
      {...(node.hasChildren ? {} : { rightSection: <span /> })}
    >
      {node.hasChildren
        ? q.data?.items.map((c) => (
            <TreeNode key={c.guid} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} />
          ))
        : null}
    </NavLink>
  );
}

/** Lazy OU/container tree below the domain head. */
export function OuTree({
  selected,
  onSelect,
  rootLabel,
  rootGuid,
}: {
  selected: string | null;
  onSelect: (c: Container | null) => void;
  rootLabel: string;
  rootGuid: string;
}) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['tree', 'root'], queryFn: () => api('/directory/tree', { schema: treeResponse }) });
  return (
    <Stack gap={0} component="section" aria-label={t('dir.tree')}>
      <NavLink
        label={rootLabel}
        active={selected === null || selected === rootGuid}
        onClick={() => onSelect(null)}
        fw={600}
      />
      {q.isPending ? <Loader size="xs" aria-label={t('app.loading')} /> : null}
      {q.data?.items.map((c) => (
        <TreeNode key={c.guid} node={c} selected={selected} onSelect={onSelect} depth={0} />
      ))}
    </Stack>
  );
}

/** Searchable picker for directory objects (users, groups, ...). */
export function ObjectPicker({
  label,
  types,
  onPick,
  exclude = [],
}: {
  label: string;
  types: string;
  onPick: (item: ListItem) => void;
  exclude?: string[];
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['picker', types, search],
    queryFn: () =>
      api(`/directory/objects?types=${types}&q=${encodeURIComponent(search)}&limit=20`, { schema: listResponse }),
    enabled: search.trim().length >= 2,
  });
  const items = (q.data?.items ?? []).filter((i) => !exclude.includes(i.guid));
  return (
    <Select
      label={label}
      placeholder={t('dir.picker-placeholder')}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      nothingFoundMessage={search.trim().length >= 2 ? t('dir.nothing-found') : t('dir.type-more')}
      data={items.map((i) => ({ value: i.guid, label: `${i.displayName ?? i.name}${i.sam ? ` (${i.sam})` : ''}` }))}
      value={null}
      onChange={(v) => {
        const item = items.find((i) => i.guid === v);
        if (item) {
          onPick(item);
          setSearch('');
        }
      }}
      filter={({ options }) => options}
    />
  );
}

/** Modal that asks to type a phrase before a dangerous or tier-0 action. */
export function TypedConfirm({
  opened,
  title,
  body,
  phrase,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
}: {
  opened: boolean;
  title: string;
  body: ReactNode;
  phrase: string;
  confirmLabel: string;
  onConfirm: (typed: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  return (
    <Modal
      opened={opened}
      onClose={() => {
        setTyped('');
        onClose();
      }}
      title={title}
    >
      <Stack>
        <Alert color="red">{body}</Alert>
        <TextInput
          label={t('dir.confirm-type', { phrase })}
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          autoComplete="off"
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('dir.cancel')}
          </Button>
          <Button
            color="red"
            loading={busy ?? false}
            disabled={typed.trim().toLowerCase() !== phrase.toLowerCase()}
            onClick={() => {
              onConfirm(typed.trim());
              setTyped('');
            }}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Shows a generated password once, with a copy button. */
export function SecretOnce({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal opened={secret !== null} onClose={onClose} title={t('dir.generated-title')}>
      <Stack>
        <Text size="sm">{t('dir.generated-help')}</Text>
        <Group gap="xs" wrap="nowrap">
          <Code fz="lg" style={{ flex: 1 }}>
            {secret}
          </Code>
          <CopyButton value={secret ?? ''}>
            {({ copied, copy }) => (
              <ActionIcon variant="light" onClick={copy} aria-label={t('dir.copy')} title={t('dir.copy')}>
                {copied ? '✓' : '⧉'}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('dir.done')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
