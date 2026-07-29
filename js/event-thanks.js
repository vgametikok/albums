// Страница возврата после оплаты события. PayPal добавляет ?token=<order_id>.
// Захватываем платёж через edge-функцию capture-order (она же выдаёт кредит),
// показываем итог. Захват идемпотентен + дублируется вебхуком, так что даже
// сбой здесь не теряет оплату.
import { sb } from './sb.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const show = (s) => document.querySelectorAll('[data-state]').forEach(n => { n.hidden = n.dataset.state !== s; });

(async function () {
  const orderId = new URLSearchParams(location.search).get('token');
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
