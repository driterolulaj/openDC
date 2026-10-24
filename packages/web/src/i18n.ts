// SPDX-License-Identifier: AGPL-3.0-only
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { errorResources } from '@opendc/shared/errors';
import { moduleI18n } from './generated/modules.ts';
import en from './locales/en.json';
import de from './locales/de.json';

export const LANGS = ['en', 'de'] as const;
export type Lang = (typeof LANGS)[number];
const STORAGE_KEY = 'opendc.lang';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'de') return saved;
  } catch {
    // storage may be unavailable
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

const errors = errorResources();

void i18next.use(initReactI18next).init({
  lng: initialLang(),
  fallbackLng: 'en',
  defaultNS: 'web',
  interpolation: { escapeValue: false },
  resources: {
    en: { web: en, errors: errors.en, ...moduleI18n.en },
    de: { web: de, errors: errors.de, ...moduleI18n.de },
  },
});

export function setLang(lang: Lang): void {
  void i18next.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export default i18next;
