export type Locale = 'az' | 'tr' | 'ru' | 'en';

export const SUPPORTED_LOCALES: Locale[] = ['az', 'tr', 'ru', 'en'];

export const LOCALE_LABELS: Record<Locale, string> = {
  az: 'Azərbaycan',
  tr: 'Türkçe',
  ru: 'Русский',
  en: 'English',
};

export type MessageTree = { [key: string]: string | MessageTree };
