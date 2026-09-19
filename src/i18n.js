import { cfg } from './config.js';

// Описания инструментов читает модель, а не человек: на англоязычной задаче
// русские описания находятся хуже. Язык выбирается один раз при старте.

function detect() {
  if (cfg.lang === 'ru' || cfg.lang === 'en') return cfg.lang;
  const env = `${process.env.LC_ALL || ''}${process.env.LANG || ''}`.toLowerCase();
  // В контейнере LANG обычно C.UTF-8 и о языке задачи не говорит ничего — тогда русский.
  return env.startsWith('en') ? 'en' : 'ru';
}

export const LANG = detect();

/** pick({ru: '…', en: '…'}) — строка на выбранном языке. */
export const pick = (pair) => (typeof pair === 'string' ? pair : (pair[LANG] ?? pair.ru));
