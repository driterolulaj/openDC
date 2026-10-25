// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Your account: authenticator (second factor) enrolment and removal, API tokens; plus the enrolment page shown
 * right after login when a tier-0 role requires a second factor, and the re-authentication modal.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Center,
  Code,
  CopyButton,
  Group,
  List,
  Loader,
  Modal,
  NumberInput,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiTokenCreated, apiTokens, empty, totpBegin, totpConfirmed, totpStatus } from '@opendc/shared/api';
import { api, setReauthHandler } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { LanguageSwitch } from '../LanguageSwitch.tsx';

function OneTimeSecret({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  return (
    <Group gap="xs" wrap="nowrap">
      <Code fz="md" style={{ flex: 1, wordBreak: 'break-all' }} aria-label={label}>
        {value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Button size="xs" variant="light" onClick={copy}>
            {copied ? t('dir.copied') : t('dir.copy')}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

/** Authenticator enrolment: secret (and otpauth URI) -> first code -> recovery codes. */
function TotpEnrol({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const begin = useMutation({ mutationFn: () => api('/session/totp/begin', { method: 'POST', schema: totpBegin }) });
  const confirm = useMutation({
    mutationFn: () => api('/session/totp/confirm', { method: 'POST', body: { code }, schema: totpConfirmed }),
  });
  if (confirm.data) {
    return (
      <Stack>
        <Alert color="green">{t('acc.totp-done')}</Alert>
        <Text size="sm">{t('acc.recovery-help')}</Text>
        <List>
          {confirm.data.recoveryCodes.map((c) => (
            <List.Item key={c}>
              <Code>{c}</Code>
            </List.Item>
          ))}
        </List>
        <Button w="fit-content" onClick={onDone}>
          {t('dir.done')}
        </Button>
      </Stack>
    );
  }
  return (
    <Stack>
      {(begin.error ?? confirm.error) ? <ErrorView error={begin.error ?? confirm.error} /> : null}
      {!begin.data ? (
        <Button w="fit-content" loading={begin.isPending} onClick={() => begin.mutate()}>
          {t('acc.totp-start')}
        </Button>
      ) : (
        <>
          <Text size="sm">{t('acc.totp-secret-help')}</Text>
          <OneTimeSecret value={begin.data.secret} label={t('acc.totp-secret')} />
          <Text size="xs" c="dimmed">
            {t('acc.totp-uri')}
          </Text>
          <OneTimeSecret value={begin.data.uri} label={t('acc.totp-uri')} />
          <TextInput
            label={t('acc.totp-code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))}
          />
          <Button
            w="fit-content"
            disabled={code.length !== 6}
            loading={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            {t('acc.totp-confirm')}
          </Button>
        </>
      )}
    </Stack>
  );
}

/** Shown instead of the console while a tier-0 user has no second factor yet. */
export function MfaSetupPage() {
  const { t } = useTranslation();
  const { refresh } = useSession();
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w={560} component="main">
        <Stack>
          <Group justify="space-between">
            <Title order={1} size="h3">
              {t('acc.mfa-title')}
            </Title>
            <LanguageSwitch />
          </Group>
          <Text size="sm">{t('acc.mfa-help')}</Text>
          <TotpEnrol onDone={() => void refresh()} />
        </Stack>
      </Paper>
    </Center>
  );
}

/** Asks for the password (and code) when a tier-0 action needs a fresh sign-in; registered globally. */
export function ReauthModal() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const status = useQuery({ queryKey: ['totp-status'], queryFn: () => api('/session/totp', { schema: totpStatus }) });
  useEffect(() => {
    setReauthHandler(() => new Promise<boolean>((resolve) => setPending(() => resolve)));
    return () => setReauthHandler(null);
  }, []);
  const reauth = useMutation({
    mutationFn: () =>
      api('/session/reauth', { method: 'POST', body: { password, ...(totp ? { totp } : {}) }, schema: empty }),
    onSuccess: () => {
      pending?.(true);
      setPending(null);
      setPassword('');
      setTotp('');
    },
    onError: (e) => {
      if (e instanceof Error && 'body' in e && (e as { body: { code: string } }).body.code === 'auth.totp-required')
        setNeedCode(true);
    },
  });
  const close = (): void => {
    pending?.(false);
    setPending(null);
    setPassword('');
    setTotp('');
  };
  return (
    <Modal opened={pending !== null} onClose={close} title={t('acc.reauth-title')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          reauth.mutate();
        }}
      >
        <Stack>
          <Text size="sm">{t('acc.reauth-help')}</Text>
          {reauth.error ? <ErrorView error={reauth.error} /> : null}
          <PasswordInput
            label={t('login.password')}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            data-autofocus
          />
          {needCode || status.data?.enrolled ? (
            <TextInput
              label={t('acc.totp-code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.currentTarget.value.trim())}
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('dir.cancel')}
            </Button>
            <Button type="submit" loading={reauth.isPending} disabled={!password}>
              {t('acc.reauth-submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default function Account() {
  const { t } = useTranslation();
  const { session } = useSession();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['totp-status'], queryFn: () => api('/session/totp', { schema: totpStatus }) });
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api('/session/tokens', { schema: apiTokens }) });
  const [enrolling, setEnrolling] = useState(false);
  const [removeCode, setRemoveCode] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(90);
  const remove = useMutation({
    mutationFn: () => api('/session/totp', { method: 'DELETE', body: { code: removeCode }, schema: empty }),
    onSuccess: async () => {
      setRemoveCode('');
      await qc.invalidateQueries({ queryKey: ['totp-status'] });
    },
  });
  const create = useMutation({
    mutationFn: () => api('/session/tokens', { method: 'POST', body: { name, days }, schema: apiTokenCreated }),
    onSuccess: async () => {
      setName('');
      await qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/session/tokens/${id}`, { method: 'DELETE', schema: empty }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
  return (
    <Stack>
      <Title order={2}>{t('acc.title', { name: session?.user.displayName ?? session?.user.username ?? '' })}</Title>
      <Card withBorder>
        <Title order={3} size="h5" mb="xs">
          {t('acc.totp')}
        </Title>
        {status.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
        {status.data?.enrolled ? (
          <Stack>
            <Alert color="green">{t('acc.totp-on')}</Alert>
            {remove.error ? <ErrorView error={remove.error} /> : null}
            <Group align="flex-end">
              <TextInput
                label={t('acc.totp-code')}
                value={removeCode}
                onChange={(e) => setRemoveCode(e.currentTarget.value.trim())}
              />
              <Button
                color="red"
                variant="light"
                disabled={!removeCode}
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t('acc.totp-remove')}
              </Button>
            </Group>
          </Stack>
        ) : status.data ? (
          <Stack>
            <Text size="sm">{t(status.data.required ? 'acc.totp-required' : 'acc.totp-off')}</Text>
            {enrolling ? (
              <TotpEnrol
                onDone={() => {
                  setEnrolling(false);
                  void qc.invalidateQueries({ queryKey: ['totp-status'] });
                }}
              />
            ) : (
              <Button w="fit-content" onClick={() => setEnrolling(true)}>
                {t('acc.totp-start')}
              </Button>
            )}
          </Stack>
        ) : null}
      </Card>
      <Card withBorder>
        <Title order={3} size="h5" mb="xs">
          {t('acc.tokens')}
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          {t('acc.tokens-help')}
        </Text>
        {(create.error ?? revoke.error) ? <ErrorView error={create.error ?? revoke.error} /> : null}
        {create.data ? (
          <Alert color="green" mb="sm" title={t('acc.token-created')}>
            <OneTimeSecret value={create.data.token} label={t('acc.token')} />
          </Alert>
        ) : null}
        <Group align="flex-end" mb="sm">
          <TextInput label={t('acc.token-name')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <NumberInput
            label={t('acc.token-days')}
            min={1}
            max={365}
            w={120}
            value={days}
            onChange={(v) => setDays(Number(v) || 90)}
          />
          <Button disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>
            {t('acc.token-create')}
          </Button>
        </Group>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('acc.token-name')}</Table.Th>
              <Table.Th>{t('acc.token-expires')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(tokens.data?.tokens ?? []).map((x) => (
              <Table.Tr key={x.id}>
                <Table.Td>{x.name}</Table.Td>
                <Table.Td>{new Date(x.expiresAt).toLocaleDateString()}</Table.Td>
                <Table.Td w={1}>
                  <Button size="xs" variant="subtle" color="red" onClick={() => revoke.mutate(x.id)}>
                    {t('acc.token-revoke')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
