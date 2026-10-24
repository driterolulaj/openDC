// SPDX-License-Identifier: AGPL-3.0-only
import { SegmentedControl } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { setLang } from './i18n.ts';

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <SegmentedControl
      size="xs"
      aria-label={t('app.language')}
      value={i18n.language.startsWith('de') ? 'de' : 'en'}
      onChange={(v) => setLang(v)}
      data={[
        { value: 'en', label: t('app.lang-en') },
        { value: 'de', label: t('app.lang-de') },
      ]}
    />
  );
}
