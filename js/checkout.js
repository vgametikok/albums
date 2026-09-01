// Покупка: одна логика на страницу цен и на лендинг события.
//
// ВРЕМЕННО вместо оплаты — заявка. PayPal у владельца не работает, поэтому
// кнопки не уводят на оплату, а открывают форму «свяжитесь со мной»: имя,
// страна, язык общения и контакт. Заявка уходит владельцу в Telegram
// (RPC purchase_request_create, миграция 051). Цены на страницах прежние.
//
// Вход для заявки НЕ требуется: просить аккаунт ради «перезвоните мне» —
// терять клиента на ровном месте. Если человек всё же вошёл, RPC сама
// запишет автора. Отсюда же исчез флаг намерения в localStorage: возвращаться
// с чужой страницы входа больше некуда.
//
// Когда оплата починится: вернуть вызов paypal-webhook/{route} в start()
// и снять пометку про заявку с текстов (ключи req_*).
import { sb, signIn } from './sb.js';
import { TELEGRAM_BOT } from './config.js';
import { t } from './i18n.js';
import { telegramButton } from './ui.js';

/**
 * Навесить покупку на кнопки. ids — все кнопки одной покупки на странице
 * (у лендинга их три), route — маршрут edge-функции (сейчас не используется,
 * останется для возврата оплаты), flag — прежний ключ намерения.
 */
export function wireCheckout(ids, route, flag) {
  const btns = ids.map(id => document.getElementById(id)).filter(Boolean);
  if (!btns.length) return;
  const plan = route === 'create-subscription' ? 'pro' : 'event';
  btns.forEach(btn => btn.addEventListener('click', () => openRequestForm(plan)));

  // Хвост прежнего потока: кто-то мог уйти на вход ради оплаты до этой правки.
  // Флаг просто убираем, чтобы он не всплыл через полгода.
  localStorage.removeItem(flag);
}

const FIELDS = [
  ['name', 'req_name', 'text', 120],
  ['country', 'req_country', 'text', 80],
  ['lang', 'req_lang', 'text', 80],
  ['contact', 'req_contact', 'text', 200],
];

/**
 * Форма заявки. Своя разметка и свои инлайновые стили, а не общий modal() из
 * ui.js: страницы покупки намеренно живут без base.css, и общий модал приехал
 * бы туда голым. Значения цветов — через var() с запасным значением, чтобы
 * форма выглядела одинаково и на страницах с базовой темой, и без неё.
 */
export function openRequestForm(plan) {
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') close('cancel'); };

    const card = document.createElement('div');
    card.className = 'auth-card';
    card.style.cssText = 'max-width:420px;text-align:left';

    const h = document.createElement('h2');
    h.textContent = t('req_title');
    h.style.textAlign = 'center';

    const price = document.createElement('p');
    price.textContent = t(plan === 'pro' ? 'req_plan_pro' : 'req_plan_event');
    price.style.cssText = 'text-align:center;font-weight:700;color:var(--accent,#C9A227);margin:0 0 6px';

    const lead = document.createElement('p');
    lead.textContent = t('req_lead');
    lead.style.textAlign = 'center';

    const err = document.createElement('p');
    err.style.cssText = 'color:#B3452F;font-size:14px;margin:0 0 10px;display:none';

    const inputs = {};
    const form = document.createElement('form');
    for (const [key, label, type, max] of FIELDS) {
      const lab = document.createElement('label');
      lab.textContent = t(label);
      lab.style.cssText = 'display:block;font-size:13.5px;font-weight:600;margin:0 0 4px';
      const inp = document.createElement('input');
      inp.type = type;
      inp.maxLength = max;
      inp.required = true;
      inp.style.cssText = 'width:100%;height:44px;padding:0 14px;margin:0 0 12px;'
        + 'border:1.5px solid var(--line,#E4DCCE);border-radius:12px;font-size:15px;'
        + 'background:#fff;color:var(--ink,#2B2620);box-sizing:border-box';
      inp.onfocus = () => { inp.style.borderColor = 'var(--accent,#C9A227)'; };
      inp.onblur = () => { inp.style.borderColor = 'var(--line,#E4DCCE)'; };
      inputs[key] = inp;
      form.append(lab, inp);
    }

    const send = document.createElement('button');
    send.className = 'btn';
    send.type = 'submit';
    send.textContent = t('req_send');
    send.style.width = '100%';

    const cancel = document.createElement('button');
    cancel.className = 'btn ghost';
    cancel.type = 'button';
    cancel.textContent = t('not_now');
    cancel.style.width = '100%';
    cancel.onclick = () => close('cancel');

    form.onsubmit = async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      send.disabled = true;
      const { data, error } = await sb.rpc('purchase_request_create', {
        p_plan: plan,
        p_name: inputs.name.value,
        p_country: inputs.country.value,
        p_lang: inputs.lang.value,
        p_contact: inputs.contact.value,
      });
      if (error || !data?.ok) {
        // Текст отказа приходит из базы уже человеческим — показываем как есть.
        err.textContent = error?.message || t('req_error');
        err.style.display = 'block';
        send.disabled = false;
        return;
      }
      card.replaceChildren();
      const okTitle = document.createElement('h2');
      okTitle.textContent = t('req_sent_title');
      okTitle.style.textAlign = 'center';
      const okText = document.createElement('p');
      okText.textContent = t('req_sent_text');
      okText.style.textAlign = 'center';
      const okBtn = document.createElement('button');
      okBtn.className = 'btn';
      okBtn.type = 'button';
      okBtn.style.width = '100%';
      okBtn.textContent = t('req_close');
      okBtn.onclick = () => close('sent');
      card.append(okTitle, okText, okBtn);
      okBtn.focus();
    };

    form.append(err, send, cancel);
    card.append(h, price, lead, form);

    const wrap = document.createElement('div');
    wrap.className = 'auth-wrap';
    wrap.onclick = (e) => { if (e.target === wrap) close('cancel'); };
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey);
    inputs.name.focus();
  });
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
