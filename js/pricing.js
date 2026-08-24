// Локализация страницы цен + кнопка «в оплату» для Pro (подписка).
// Английский текст лежит в разметке; после initI18n подставляем перевод во все
// data-i18n. Клиент Supabase нужен для сессии и вызова edge-функции
// paypal-webhook — CSP страницы под это расширен.
//
// Событийный альбом отсюда больше не покупается: его кнопка ведёт на лендинг
// (event-album.html), где продукт сначала объясняют. Сама покупка живёт в
// общем js/checkout.js — одна логика на обе страницы.
import { initI18n, t } from './i18n.js';
import { wireCheckout } from './checkout.js';

(async function main() {
  await initI18n();
  document.title = t('pr_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    n.textContent = t(n.dataset.i18n);
  });

  wireCheckout(['pro-cta'], 'create-subscription', 'pro_after_login');
})();
