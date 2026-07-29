// Локализация страницы цен + кнопки «в оплату» для Pro (подписка) и события
// (разовый заказ). Английский текст лежит в разметке; после initI18n подставляем
// перевод во все data-i18n. Клиент Supabase нужен для сессии и вызова edge-функции
// paypal-webhook — CSP страницы под это расширен.
import { initI18n, t } from './i18n.js';
import { sb, signIn } from './sb.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

(async function main() {
  await initI18n();
  document.title = t('pr_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    n.textContent = t(n.dataset.i18n);
  });

  wire('pro-cta', 'create-subscription', 'pro_after_login');
  wire('event-cta', 'create-order', 'event_after_login');
})();

// Навешиваем клик и, если вернулись после входа именно ради этой покупки
// (флаг в localStorage), сразу продолжаем.
function wire(id, route, flag) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', () => startCheckout(btn, route, flag, false));
  if (localStorage.getItem(flag) === '1') {
    localStorage.removeItem(flag);
    startCheckout(btn, route, flag, true);
  }
}

// Залогинен — создаём заказ/подписку и уходим на оплату PayPal; гость — сперва
// вход (после возврата продолжим по флагу). fromLogin гасит зацикливание входа.
async function startCheckout(btn, route, flag, fromLogin) {
  btn.disabled = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      if (fromLogin) { btn.disabled = false; return; }
      localStorage.setItem(flag, '1');
      await signIn();
      return;
    }
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/paypal-webhook/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token,
      },
      body: '{}',
    });
    const out = await resp.json().catch(() => ({}));
    if (resp.ok && out.url) { location.href = out.url; return; }  // страница оплаты PayPal
    alert(t('pro_start_error'));
  } catch (_) {
    alert(t('pro_start_error'));
  }
  btn.disabled = false;
}
