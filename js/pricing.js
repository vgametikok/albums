// Локализация статичной страницы цен + кнопка «Get Pro» прямо в оплату.
// Английский текст лежит в разметке; после initI18n подставляем перевод во
// все узлы с data-i18n. Клиент Supabase нужен только для сессии и вызова
// edge-функции create-subscription — CSP страницы под это расширен.
import { initI18n, t } from './i18n.js';
import { sb, signIn } from './sb.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

(async function main() {
  await initI18n();
  document.title = t('pr_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    n.textContent = t(n.dataset.i18n);
  });

  const proBtn = document.getElementById('pro-cta');
  if (proBtn) {
    proBtn.addEventListener('click', () => startPro(proBtn, false));
    // Вернулись после входа, начатого ради Pro — продолжаем сразу.
    if (localStorage.getItem('pro_after_login') === '1') {
      localStorage.removeItem('pro_after_login');
      startPro(proBtn, true);
    }
  }
})();

// Залогинен — создаём подписку и уходим на оплату PayPal; гость — сперва вход
// (после возврата продолжим по флагу). fromLogin защищает от зацикливания входа.
async function startPro(btn, fromLogin) {
  btn.disabled = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      if (fromLogin) { btn.disabled = false; return; }
      localStorage.setItem('pro_after_login', '1');
      await signIn();
      return;
    }
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/paypal-webhook/create-subscription`, {
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
