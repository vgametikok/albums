// Paddle Billing — ЕДИНСТВЕННОЕ место настройки на фронте.
//
// Обе среды настроены и живут рядом; какая из них работает у посетителя,
// решает resolveEnv() ниже:
//   ?paddle=live     — живой аккаунт (тест боевой оплаты до одобрения Paddle);
//   ?paddle=sandbox  — песочница (тестовая карта 4242…);
//   ?paddle=off      — снять метку.
// Метка держится в sessionStorage до закрытия вкладки (переживает вход через
// Google). Без метки работает DEFAULT_ENV.
//
// ПОСЛЕ ОДОБРЕНИЯ PADDLE (домен + верификация аккаунта) — ОДНА СТРОКА:
//   export const DEFAULT_ENV = 'live';
// Пока null, обычные посетители Paddle не видят вовсе: кнопки ведут в PayPal.
//
// Всё здесь публично по дизайну: client-side token даёт только открыть
// checkout. Секреты вебхуков и API-ключи — в секретах edge-функции
// paddle-webhook. Сервер (supabase/functions/paddle-webhook, таблица PRICES)
// держит ту же карту цен по средам и доверяет ТОЛЬКО ей.
// Paddle.Environment.set('sandbox') зовётся только в sandbox (js/paddle.js).
export const DEFAULT_ENV = null;   // null (Paddle скрыт) | 'live' | 'sandbox'

const ENVS = {
  sandbox: {
    token: 'test_89aa7d0de190703f7aabad1674e',
    prices: {
      small:  'pri_01m3gnwsayjfzvgq7hed8zwxp3',   // Event Album — Small,  $39.99 one-time
      medium: 'pri_01m3gnwsnp6pqcceja5wd0zdvt',   // Event Album — Medium, $69.99 one-time
      large:  'pri_01m3gnwt653y0fyj0gqwxaf64m',   // Event Album — Large,  $129.99 one-time
      pro:    'pri_01m3gnwtebq6mfe1fybbcy4hqr',   // Albums Pro, $9.99 / month
    },
  },
  live: {
    token: 'live_09969b3ce80eb3541a8608101c9',
    prices: {
      small:  'pri_01m3tf9j4sanm5rcxx38h4dvj7',   // pro_01m3tf9j232fh6gvyvd06mdd2e  Event Album — Small,  $39.99
      medium: 'pri_01m3tf9jbpehws199xd225gwww',   // pro_01m3tf9j9753n0j7txnwah3wt6  Event Album — Medium, $69.99
      large:  'pri_01m3tf9jk0p2d5mmwgj0my8hmg',   // pro_01m3tf9jg3tfv16xwxtbabjr09  Event Album — Large,  $129.99
      pro:    'pri_01m3tf9jtgj1ne0rzqm3bgxbp3',   // pro_01m3tf9jqny7sdf3azwsajxvhk  Albums Pro, $9.99 / month
    },
  },
};

const KEY = 'paddle_env';

/** Среда для этого посетителя: метка из URL/вкладки, иначе DEFAULT_ENV. null — Paddle выключен. */
export function resolveEnv(loc = globalThis.location, store = globalThis.sessionStorage) {
  try {
    const q = new URLSearchParams(loc?.search || '').get('paddle');
    if (q === 'live' || q === 'sandbox') store.setItem(KEY, q);
    else if (q === 'off') store.removeItem(KEY);
    const s = store.getItem(KEY);
    if (s === 'live' || s === 'sandbox') return s;
    if (store.getItem('paddle_sandbox') === '1') return 'sandbox';   // метка прежней версии
    // Ссылка из письма Paddle (?_ptxn=txn_… на «Default payment link», страница
    // цен) — это уже покупатель живого аккаунта: открываем ему live, даже пока
    // Paddle скрыт от остальных. Песочнице нужна явная метка ?paddle=sandbox.
    if (!DEFAULT_ENV && new URLSearchParams(loc?.search || '').has('_ptxn')) return 'live';
  } catch (_) { /* нет sessionStorage — только DEFAULT_ENV */ }
  return DEFAULT_ENV === 'live' || DEFAULT_ENV === 'sandbox' ? DEFAULT_ENV : null;
}

/** Среда настроена целиком: token нужного вида и все четыре id цен. */
export function configured(c, env) {
  const prefix = env === 'live' ? 'live_' : 'test_';
  return !!c && typeof c.token === 'string' && c.token.startsWith(prefix)
    && ['small', 'medium', 'large', 'pro'].every(k => /^pri_[a-z0-9]{26}$/.test(c.prices?.[k] || ''));
}

export const PADDLE_ENV = resolveEnv();   // 'live' | 'sandbox' | null
export const PADDLE = PADDLE_ENV ? { env: PADDLE_ENV, ...ENVS[PADDLE_ENV] } : { env: null, token: '', prices: {} };
export const PADDLE_ENABLED = !!PADDLE_ENV && configured(PADDLE, PADDLE_ENV);
export { ENVS as PADDLE_ENVS };
