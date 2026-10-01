// Локализация страницы цен + кнопка «в оплату» для Pro (подписка): Paddle
// overlay основным способом, PayPal — запасным (js/checkout.js).
// Английский текст лежит в разметке; после initI18n подставляем перевод во все
// data-i18n. Клиент Supabase нужен для сессии и вызова edge-функции
// paypal-webhook — CSP страницы под это расширен.
//
// Событийный альбом отсюда больше не покупается: его кнопка ведёт на лендинг
// (/events/, раньше event-album.html), где продукт сначала объясняют. Сама покупка живёт в
// общем js/checkout.js — одна логика на обе страницы.
import { initI18n, t } from './i18n.js';
import { wireCheckout } from './checkout.js';
import { loadPaddle, initRetain } from './paddle.js';

(async function main() {
  await initI18n();
  document.title = t('pr_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    n.textContent = t(n.dataset.i18n);
  });

  // Эта страница — «Default payment link» в кабинете Paddle: ссылки на оплату
  // из писем Paddle ведут сюда с ?_ptxn=txn_…, и Paddle.js сам открывает окно.
  if (new URLSearchParams(location.search).has('_ptxn')) loadPaddle().catch(() => {});
  // Paddle Retain для уже плативших (только live и только при известном ctm_…).
  else initRetain();

  // Paddle — основной способ (overlay), PayPal — ссылка под кнопкой.
  wireCheckout(['pro-cta'], 'create-subscription', 'pro_after_login', {
    paddle: () => ({ price: 'pro', customData: { kind: 'pro' } }),
    paddleSuccess: () => '/pro-thanks.html?via=paddle',
  });
})();
