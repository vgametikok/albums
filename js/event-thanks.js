// Страница возврата после оплаты события. PayPal добавляет ?token=<order_id>;
// после Paddle приходим с ?paddle=<transaction_id> (см. waitPaddle ниже).
// Захватываем платёж через edge-функцию capture-order (она же выдаёт кредит),
// показываем итог. Захват идемпотентен + дублируется вебхуком, так что даже
// сбой здесь не теряет оплату.
import { sb } from './sb.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { initI18n, t } from './i18n.js';

const show = (s) => document.querySelectorAll('[data-state]').forEach(n => { n.hidden = n.dataset.state !== s; });


// Надписи на своём языке: сюда человек попадает сразу после оплаты, и
// английский экран в этот момент читается как сбой.
await initI18n();
document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });

/**
 * Возврат после Paddle (?paddle=<txn>): захватывать нечего — кредит выдаёт
 * вебхук paddle-webhook. Ждём, пока кредитов станет больше, чем было до оплаты
 * (запомнено в sessionStorage перед открытием окна); не дождались — «почти готово».
 */
async function waitPaddle(session) {
  const before = Number(sessionStorage.getItem('paddle_credits_before') ?? 0) || 0;
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const { data } = await sb.rpc('my_event_credits');
    if (Number(data) > before) {
      sessionStorage.removeItem('paddle_credits_before');
      show('ok');
      return;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  show('pending');
}

(async function () {
  const params = new URLSearchParams(location.search);
  if (params.get('paddle')) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { show('manual'); return; }
    return waitPaddle(session);
  }
  const orderId = params.get('token');
  const { data: { session } } = await sb.auth.getSession();
  if (!orderId || !session) { show('manual'); return; }
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/paypal-webhook/capture-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ order_id: orderId }),
    });
    const out = await resp.json().catch(() => ({}));
    show(resp.ok && out.ok ? 'ok' : 'pending');
  } catch (_) {
    show('pending');
  }
})();
