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
import { sb, ready, currentUser } from './sb.js';

export { PADDLE_ENABLED };
export const paddlePrice = (key) => PADDLE.prices?.[key] || '';

const SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';
// Языки сайта -> языки Paddle Checkout. Вьетнамского у Paddle нет — тогда
// locale не передаём, и checkout берёт язык браузера.
const LOCALES = { en: 'en', ru: 'ru', fr: 'fr', es: 'es', de: 'de', ja: 'ja', ko: 'ko', 'zh-CN': 'zh-Hans' };

let loading = null;
let current = null;   // колбэки открытого сейчас checkout

// ── Paddle Retain: pwCustomer ───────────────────────────────────────────────
// Retain (спасение неудачных списаний, сценарии отмены) узнаёт человека
// только по Paddle ID покупателя (ctm_…). Его пишет вебхук paddle-webhook в
// paddle_customers (миграция 056) после первой оплаты; вошедшему он отдаётся
// RPC my_paddle_customer(p_env). Не знаем id (гость, ещё не платил, 056 не
// применена) — pwCustomer: {} (так велит Paddle). Retain работает только в
// live; в sandbox Paddle.js параметр принимает, но Retain не грузит.
const CTM_RE = /^ctm_[a-z0-9]{26}$/;
const CTM_TTL_MISS = 10 * 60 * 1000;   // «нет id» перепроверяем раз в 10 минут
let ctmPromise = null;

/** Paddle ID покупателя для вошедшего пользователя или '' (никогда не бросает). */
export function paddleCustomerId() {
  return (ctmPromise ||= (async () => {
    try {
      await ready();
      const uid = currentUser()?.id;
      if (!uid || currentUser()?.is_anonymous) return '';
      const key = `paddle_ctm:${PADDLE.env}:${uid}`;
      try {
        const c = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (c && (c.id || Date.now() - c.at < CTM_TTL_MISS)) return c.id || '';
      } catch (_) { /* нет кэша */ }
      const { data, error } = await sb.rpc('my_paddle_customer', { p_env: PADDLE.env });
      if (error) return '';                      // до миграции 056 функции нет — просто без Retain
      const id = CTM_RE.test(String(data || '')) ? String(data) : '';
      try { sessionStorage.setItem(key, JSON.stringify({ id, at: Date.now() })); } catch (_) { /* приватный режим */ }
      return id;
    } catch (_) {
      return '';
    }
  })());
}

/** Объект pwCustomer для Paddle.Initialize: { id } только когда id известен. */
async function pwCustomer() {
  const id = await Promise.race([paddleCustomerId(), new Promise(r => setTimeout(() => r(''), 1500))]);
  return id ? { id } : {};
}

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
    const init = async () => {
      try {
        const P = window.Paddle;
        if (!P) throw new Error('Paddle.js missing');
        // Среда — только из paddle-config.js. В live Environment.set не зовём:
        // Paddle.js по умолчанию работает с живым аккаунтом.
        if (PADDLE.env === 'sandbox') P.Environment.set('sandbox');
        P.Initialize({
          token: PADDLE.token,
          pwCustomer: await pwCustomer(),
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

/**
 * Retain для тех, кто уже платил через Paddle: грузим Paddle.js в простое
 * страницы, чтобы Retain мог показать напоминание о неудачном списании или
 * сценарий отмены. Только live и только при известном ctm_… — остальным
 * посетителям чужой скрипт по-прежнему не грузится. В sandbox — ничего.
 * Зовётся на страницах, чей CSP пускает *.paddle.com и *.profitwell.com
 * (Retain грузит public.profitwell.com/js/profitwell.js): pricing.html и
 * /events/. Чтобы Retain работал на всём сайте, расширить CSP остальных страниц.
 */
export function initRetain() {
  if (PADDLE.env !== 'live' || !PADDLE_ENABLED) return;
  const go = () => paddleCustomerId().then(id => { if (id) loadPaddle().catch(() => {}); });
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 2000);
}

/** Закрыть overlay (после успешной оплаты — перед уходом на «спасибо»). */
export function closePaddle() {
  try { window.Paddle?.Checkout?.close(); } catch (_) { /* уже закрыт */ }
}
