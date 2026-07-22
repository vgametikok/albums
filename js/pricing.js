// Локализация статичной страницы цен: в разметке лежит английский текст,
// после initI18n подставляем перевод во все узлы с data-i18n. Страница
// нарочно не тянет ui.js/sb.js — ей не нужны ни Supabase, ни шапка.
import { initI18n, t } from './i18n.js';

(async function main() {
  await initI18n();
  document.title = t('pr_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    n.textContent = t(n.dataset.i18n);
  });
})();
