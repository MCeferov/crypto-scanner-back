import type { Locale, MessageTree } from './types.js';
import { messages as az } from './locales/az.js';
import { messages as tr } from './locales/tr.js';
import { messages as ru } from './locales/ru.js';
import { messages as en } from './locales/en.js';
import { LOCALE_LABELS, SUPPORTED_LOCALES } from './types.js';

export * from './types.js';

const catalogs: Record<Locale, MessageTree> = { az, tr, ru, en };

export function getMessages(locale: Locale): MessageTree {
  return catalogs[locale] ?? catalogs.en;
}

export function isValidLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

export function getLocaleMeta() {
  return SUPPORTED_LOCALES.map(code => ({ code, label: LOCALE_LABELS[code] }));
}

function resolve(obj: MessageTree, path: string): string | undefined {
  const parts = path.split('.');
  let cur: string | MessageTree = obj;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export function createTranslator(locale: Locale): TranslateFn {
  const tree = getMessages(locale);
  return (key, params) => {
    let text = resolve(tree, key) ?? resolve(catalogs.en, key) ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  };
}

export const DEFAULT_LOCALE: Locale = 'az';
