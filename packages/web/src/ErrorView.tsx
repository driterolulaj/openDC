// SPDX-License-Identifier: AGPL-3.0-only
import { Alert, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { errorBody } from '@opendc/shared/api';
import { ApiFailure } from './api.ts';

/**
 * Shows a server error in the user's language: message and fix come from the shared error catalogue. Accepts
 * an ApiFailure or a raw error body (e.g. a failed job's error).
 */
export function ErrorView({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const raw = errorBody.safeParse(error);
  const body = error instanceof ApiFailure ? error.body : raw.success ? raw.data : null;
  const message = body
    ? t(`errors:${body.code}.message`, { ...body.params, defaultValue: body.message })
    : error instanceof Error
      ? error.message
      : String(error);
  const fix = body ? t(`errors:${body.code}.fix`, { ...body.params, defaultValue: body.fix }) : '';
  return (
    <Alert color="red" title={t('error.title')} role="alert">
      <Text size="sm">{message}</Text>
      {fix ? (
        <Text size="sm" mt="xs">
          {t('error.fix', { fix })}
        </Text>
      ) : null}
    </Alert>
  );
}
