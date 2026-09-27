// Paddle.js v2: загрузка по требованию и открытие overlay-checkout.
//
// Скрипт тянем только в момент первой покупки (или заранее, когда страница
// простаивает) — остальным посетителям чужой код не нужен. Среда, токен и id
// цен — только из js/paddle-config.js.
//
// Выдача покупки НЕ здесь: её делает вебхук paddle-webhook по подписанному
// событию Paddle. Здесь — только UX: открыть оплату и после checkout.completed
// увести на страницу «спасибо», которая сама дожидается кредита / Pro.
import { PADDLE, PADDLE_ENABLED } from './paddle-config.js';
import { currentLang } from './i18n.js';

export { PADDLE_ENABLED };
export const paddlePrice = (key) => PADDLE.prices?.[key] || '';

const SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';
// Языки сайта -> языки Paddle Checkout. Вьетнамского у Paddle нет — тогда
// locale не передаём, и checkout берёт язык браузера.
const LOCALES = { en: 'en', ru: 'ru', fr: 'fr', es: 'es', de: 'de', ja: 'ja', ko: 'ko', 'zh-CN': 'zh-Hans' };

let loading = null;
let current = null;   // колбэки открытого сейчас checkout

function onEvent(ev) {
  const cb = current;
  if (!cb || !ev?.name) return;
  if (ev.name === 'checkout.loaded') cb.onLoaded?.(ev.data);
  else if (ev.name === 'checkout.completed') cb.onCompleted?.(ev.data);
  else if (ev.name === 'checkout.closed') { current = null; cb.onClosed?.(ev.data); }
  else if (ev.name === 'checkout.error') cb.onError?.(ev.data);
}

/** Загрузить и инициализировать Paddle.js (один раз на страницу). */
export function loadPaddle() {
  if (!PADDLE_ENABLED) return Promise.reject(new Error('paddle disabled'));
  return (loading ||= new Promise((resolve, reject) => {
    const init = () => {
      try {
        const P = window.Paddle;
        if (!P) throw new Error('Paddle.js missing');
        if (PADDLE.env === 'sandbox') P.Environment.set('sandbox');
        P.Initialize({
          token: PADDLE.token,
          eventCallback: onEvent,
          checkout: { settings: { displayMode: 'overlay', variant: 'one-page', theme: 'light' } },
        });
        resolve(P);
      } catch (e) { reject(e); }
    };
    if (window.Paddle) return init();
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = init;
    s.onerror = () => { loading = null; reject(new Error('Paddle.js failed to load')); };
    document.head.appendChild(s);
  }));
}

/**
 * Открыть overlay-оплату одной цены.
 *   priceId, email?, customData, callbacks { onLoaded, onCompleted, onClosed, onError }
 */
export async function openPaddle({ priceId, email, customData, ...callbacks }) {
  if (!priceId) throw new Error('no price id');
  const P = await loadPaddle();
  const locale = LOCALES[currentLang()];
  current = callbacks;
  P.Checkout.open({
    items: [{ priceId, quantity: 1 }],
    ...(email ? { customer: { email } } : {}),
    customData,
    settings: { displayMode: 'overlay', variant: 'one-page', ...(locale ? { locale } : {}) },
  });
}

/** Закрыть overlay (после успешной оплаты — перед уходом на «спасибо»). */
export function closePaddle() {
  try { window.Paddle?.Checkout?.close(); } catch (_) { /* уже закрыт */ }
}
