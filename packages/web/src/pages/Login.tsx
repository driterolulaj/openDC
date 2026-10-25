// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { sessionInfo } from '@opendc/shared/api';
import { api, ApiFailure, setCsrfToken } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { LanguageSwitch } from '../LanguageSwitch.tsx';

export default function Login() {
  const { t } = useTranslation();
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: { preventDefault(): void }): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api('/session', {
        method: 'POST',
        body: { username, password, ...(needCode && totp ? { totp } : {}) },
        schema: sessionInfo,
      });
      setCsrfToken(s.csrfToken);
      setPassword('');
      await refresh();
    } catch (err) {
      // a second factor is needed: keep the password, ask for the code
      if (err instanceof ApiFailure && err.body.code === 'auth.totp-required') {
        setNeedCode(true);
        return;
      }
      setError(err);
      setPassword('');
      setTotp('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={400} component="main">
        <form onSubmit={(e) => void submit(e)} aria-label={t('login.title')}>
          <Stack>
            <div>
              <Title order={1} size="h2">
                {t('app.name')}
              </Title>
              <Text c="dimmed" size="sm">
                {t('app.tagline')}
              </Text>
            </div>
            <Title order={2} size="h4">
              {t('login.title')}
            </Title>
            <Text size="sm">{t('login.subtitle')}</Text>
            {error ? <ErrorView error={error} /> : null}
            <TextInput
              label={t('login.username')}
              description={t('login.username-hint')}
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
            <PasswordInput
              label={t('login.password')}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            {needCode ? (
              <TextInput
                label={t('login.totp')}
                description={t('login.totp-hint')}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={totp}
                onChange={(e) => setTotp(e.currentTarget.value.trim())}
              />
            ) : null}
            <Button type="submit" loading={busy} fullWidth>
              {t('login.submit')}
            </Button>
            <LanguageSwitch />
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
