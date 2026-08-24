// Покупка через PayPal: одна логика на страницу цен и на лендинг события.
//
// Порядок: залогинен — сразу создаём заказ/подписку и уходим на оплату; гость —
// сначала окно с объяснением, зачем нужен аккаунт, и только по согласию вход.
// Флаг намерения в localStorage переживает уход на страницу входа: по
// возвращении оплата продолжается сама, повторно нажимать кнопку не нужно.
import { sb, signIn } from './sb.js';
import { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT } from './config.js';
import { t } from './i18n.js';
import { telegramButton } from './ui.js';

/**
 * Навесить покупку на кнопки. ids — все кнопки одной покупки на странице
 * (у лендинга их три), route — маршрут edge-функции, flag — ключ намерения.
 */
export function wireCheckout(ids, route, flag) {
  const btns = ids.map(id => document.getElementById(id)).filter(Boolean);
  if (!btns.length) return;
  btns.forEach(btn => btn.addEventListener('click', () => start(btns, btn, route, flag, false)));

  // Вернулись со страницы входа именно ради этой покупки — продолжаем.
  if (localStorage.getItem(flag) === '1') {
    localStorage.removeItem(flag);
    start(btns, btns[0], route, flag, true);
  }
}

async function start(btns, btn, route, flag, fromLogin) {
  btns.forEach(b => { b.disabled = true; });
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      if (fromLogin) { btns.forEach(b => { b.disabled = false; }); return; }
      // Флаг ставим ДО показа окна: кнопка Telegram — чужой iframe, её нажатие
      // нам не видно, и человек уедет со страницы без нашего ведома. Отказ и
      // сбой флаг убирают, поэтому случайной оплаты потом не будет.
      localStorage.setItem(flag, '1');
      const choice = await askSignIn();
      btns.forEach(b => { b.disabled = false; });
      if (choice !== 'google') { localStorage.removeItem(flag); return; }
      try { await signIn(); } catch (_) { localStorage.removeItem(flag); alert(t('signin_failed')); }
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
    if (resp.ok && out.url) { location.href = out.url; return; }   // страница оплаты PayPal
    alert(t('pro_start_error'));
  } catch (_) {
    alert(t('pro_start_error'));
  }
  btns.forEach(b => { b.disabled = false; });
}

/**
 * Окно «сначала войдите». Способы те же, что и во всём приложении: Google и
 * Telegram. Своя разметка, а не общий showLogin из ui.js — страницы покупки
 * намеренно живут без base.css и без общей шапки, и общий модал приехал бы
 * туда без стилей. Виджет Telegram переиспользуется как есть: своей вёрстки
 * у него нет, Telegram рисует собственный iframe.
 *
 * Промис отдаёт 'google' или 'cancel'. Telegram уводит со страницы сам.
 */
export function askSignIn() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish('cancel'); };

    const title = document.createElement('h2');
    title.textContent = t('welcome_title');

    const lead = document.createElement('p');
    lead.textContent = t('buy_signin');

    const google = document.createElement('button');
    google.className = 'btn';
    google.type = 'button';
    google.textContent = t('continue_google');
    google.onclick = () => finish('google');

    const cancel = document.createElement('button');
    cancel.className = 'btn ghost';
    cancel.type = 'button';
    cancel.textContent = t('not_now');
    cancel.onclick = () => finish('cancel');

    const card = document.createElement('div');
    card.className = 'auth-card';
    card.append(title, lead, google);
    if (TELEGRAM_BOT) card.appendChild(telegramButton());
    card.appendChild(cancel);

    const wrap = document.createElement('div');
    wrap.className = 'auth-wrap';
    wrap.onclick = (e) => { if (e.target === wrap) finish('cancel'); };
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey);
    google.focus();
  });
}
