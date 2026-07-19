// Локализация. Словари лежат по одному файлу на язык и грузятся по требованию,
// поэтому пользователь скачивает только свой.
//
// Множественные числа — через Intl.PluralRules: у русского one/few/many, у
// французского и испанского свои правила, у азиатских языков форм нет вовсе.
// Значение в словаре может быть строкой или объектом вида {one, few, many, other}.
//
// Даты и числа не переводим вручную: Intl.RelativeTimeFormat и NumberFormat
// сами дают «3 дня назад», «3 days ago», «3日前» и 24K / 2.4万.

import EN from './i18n/en.js';

export const LANGS = {
  en: 'English',
  ru: 'Русский',
  vi: 'Tiếng Việt',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'zh-CN': '简体中文',
  ko: '한국어',
  ja: '日本語',
};

const STORAGE_KEY = 'albums.lang';
let lang = 'en';
let dict = EN;
let pr = new Intl.PluralRules('en');

/** Выбор пользователя, иначе язык браузера, иначе английский. */
function detect() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && LANGS[saved]) return saved;
  for (const raw of (navigator.languages || [navigator.language || 'en'])) {
    const l = String(raw);
    if (LANGS[l]) return l;
    const base = l.split('-')[0].toLowerCase();
    if (base === 'zh') return 'zh-CN';
    const hit = Object.keys(LANGS).find(k => k.split('-')[0] === base);
    if (hit) return hit;
  }
  return 'en';
}

let _init = null;
export function initI18n() { return (_init ||= doInit()); }

async function doInit() {
  lang = detect();
  if (lang !== 'en') {
    try {
      const mod = await import(`./i18n/${lang}.js`);
      dict = { ...EN, ...(mod.default || {}) };   // недостающие ключи падают в английский
    } catch (_) {
      lang = 'en'; dict = EN;
    }
  }
  pr = new Intl.PluralRules(lang);
  document.documentElement.lang = lang;
  return lang;
}

export function currentLang() { return lang; }

export function setLang(l) {
  if (!LANGS[l] || l === lang) return;
  localStorage.setItem(STORAGE_KEY, l);
  location.reload();
}

/**
 * t('key') · t('key', {name}) · t('n_photos', {count: 3})
 * Подстановки вида {name}. Для count выбирается форма по правилам языка.
 */
export function t(key, params) {
  let v = dict[key];
  if (v === undefined) v = EN[key];
  if (v === undefined) return key;

  if (typeof v === 'object') {
    const cat = params && typeof params.count === 'number' ? pr.select(params.count) : 'other';
    v = v[cat] ?? v.other ?? v.one ?? key;
  }
  if (!params) return v;
  return String(v).replace(/\{(\w+)\}/g, (m, k) => {
    if (params[k] === undefined) return m;
    // форму слова выбираем по точному числу, а показываем компактно: 24K, 2.4万
    if (k === 'count' && typeof params[k] === 'number') return fmtNumber(params[k]);
    return params[k];
  });
}

/* ---------------- форматирование ---------------- */

export function fmtNumber(n) {
  try {
    return new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0);
  } catch (_) {
    return String(Number(n) || 0);
  }
}

const UNITS = [
  ['year', 31536000], ['month', 2592000], ['week', 604800],
  ['day', 86400], ['hour', 3600], ['minute', 60],
];

export function fmtTimeAgo(iso) {
  if (!iso) return t('draft');
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    for (const [unit, size] of UNITS) {
      if (Math.abs(sec) >= size) return rtf.format(-Math.round(sec / size), unit);
    }
    return rtf.format(0, 'second');
  } catch (_) {
    return new Date(iso).toLocaleDateString(lang);
  }
}

export function fmtMonthYear(iso) {
  if (!iso) return t('draft');
  try {
    return new Date(iso).toLocaleDateString(lang, { month: 'long', year: 'numeric' });
  } catch (_) {
    return new Date(iso).getFullYear();
  }
}

/** «8 фото · 1 видео · 2 аудио» — с правильными формами в каждом языке. */
export function composition(a) {
  const parts = [];
  if (a.photos_count) parts.push(t('n_photos', { count: a.photos_count }));
  if (a.videos_count) parts.push(t('n_videos', { count: a.videos_count }));
  if (a.audio_count) parts.push(t('n_audio', { count: a.audio_count }));
  return parts.join(' · ') || t('empty_album');
}

/** Категории хранятся в базе по-английски, переводим только показ. */
export function catLabel(c) {
  return c ? t('cat_' + c) : t('all');
}
