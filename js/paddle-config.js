// Paddle Billing — ЕДИНСТВЕННОЕ место настройки на фронте.
//
// Переключение sandbox -> live: поменять PADDLE_ENV на 'live' и заполнить блок
// live (client-side token live_… и id живых цен pri_…). Всё здесь публично по
// дизайну: client-side token даёт только открыть checkout. Секрет вебхука и
// API-ключ живут в секретах edge-функции paddle-webhook, не здесь.
//
// Сервер (supabase/functions/paddle-webhook, таблица PRICES) держит ту же
// карту цен и доверяет ТОЛЬКО ей — поменяли id здесь, поменяйте и там.
//
// Пустой token у выбранной среды = Paddle выключен: кнопки идут в PayPal, как
// раньше. В sandbox Paddle видят только тестировщики (см. PADDLE_ENABLED).
export const PADDLE_ENV = 'sandbox';   // 'sandbox' | 'live'

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
    token: '',
    prices: { small: '', medium: '', large: '', pro: '' },
  },
};

export const PADDLE = { env: PADDLE_ENV, ...ENVS[PADDLE_ENV] };

/**
 * Кому показывать Paddle.
 *   live    — всем (если есть token).
 *   sandbox — НЕ обычным посетителям: тестовой картой 4242… любой получил бы
 *             альбом/Pro бесплатно. Только на localhost или по ссылке
 *             ?paddle=sandbox — метка держится в sessionStorage до закрытия
 *             вкладки (переживает вход через Google); ?paddle=off снимает.
 *             Остальным — прежний поток PayPal, будто Paddle нет.
 * (Сервер в sandbox дополнительно выдаёт покупку только почтам из
 * PADDLE_SANDBOX_ALLOW_EMAILS.)
 */
function sandboxOptIn() {
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
    const q = new URLSearchParams(location.search).get('paddle');
    if (q === 'sandbox') sessionStorage.setItem('paddle_sandbox', '1');
    else if (q === 'off') sessionStorage.removeItem('paddle_sandbox');
    return sessionStorage.getItem('paddle_sandbox') === '1';
  } catch (_) {
    return false;
  }
}

export const PADDLE_ENABLED = !!PADDLE.token && (PADDLE_ENV === 'live' || sandboxOptIn());
