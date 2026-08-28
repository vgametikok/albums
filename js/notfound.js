// Страница 404. Своего состояния у неё нет — нужен только перевод надписей:
// человек, попавший сюда по устаревшей ссылке, должен прочитать объяснение на
// своём языке, а не на английском.
import { initI18n, t } from './i18n.js';

(async function main() {
  await initI18n();
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
})();
