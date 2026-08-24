// Страница возврата после оплаты подписки Pro.
//
// Тариф включает вебхук PayPal (paypal_apply_sub), и происходит это не мгновенно:
// у первой боевой покупки между созданием подписки и включением Pro прошло 42
// секунды. Раньше страница просто писала «активируем, обновите страницу» и на
// этом заканчивалась — человек уходил в профиль, видел старый тариф и решал,
// что оплата не сработала. Теперь страница сама ждёт и показывает результат.
//
// Опрашиваем свою же строку профиля: plan виден владельцу по обычной политике
// чтения, отдельная RPC не нужна.
import { sb } from './sb.js';

const DEADLINE = 120000;   // столько ждём активации, дальше показываем «ещё идёт»
const STEP = 2500;

const show = (s) => document.querySelectorAll('[data-state]').forEach(n => { n.hidden = n.dataset.state !== s; });

(async function () {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { show('manual'); return; }

  const started = Date.now();
  while (Date.now() - started < DEADLINE) {
    const { data } = await sb.from('profiles')
      .select('plan, plan_until').eq('id', session.user.id).maybeSingle();

    if (data?.plan === 'pro') {
      const until = document.getElementById('until');
      if (until && data.plan_until) {
        // Дата в языке браузера: страница живёт вне общей локализации.
        until.textContent = new Date(data.plan_until).toLocaleDateString();
        until.parentElement.hidden = false;
      }
      show('ok');
      return;
    }
    await new Promise(r => setTimeout(r, STEP));
  }
  show('pending');
})();
