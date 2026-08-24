// Лендинг событийного альбома: объясняет продукт и ведёт в оплату.
//
// Логика покупки та же, что на странице цен (create-order в paypal-webhook,
// вход перед оплатой, продолжение по флагу после возврата) — вынесена в общий
// js/checkout.js, чтобы обе страницы не расходились.
//
// Плюс то, чего на странице цен нет: если у человека уже есть оплаченный
// событийный альбом, наверху появляется выбор — открыть свой или купить ещё.
import { initI18n, t } from './i18n.js';
import { sb } from './sb.js';
import { wireCheckout } from './checkout.js';

(async function main() {
  await initI18n();
  document.title = t('ea_title');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    // В строках «что стоит знать» первое предложение выделено жирным, поэтому
    // ключ приходит с разметкой <b>…</b> — только эти четыре, и они наши.
    const v = t(n.dataset.i18n);
    if (n.tagName === 'LI' && v.includes('<b>')) n.innerHTML = v;
    else n.textContent = v;
  });

  wireCheckout(['cta-top', 'cta-price', 'cta-final'], 'create-order', 'event_after_login');
  drawQr();
  showOwned();
})();

/** Уже оплаченное: показываем выбор, а не гоним покупать второй раз. */
async function showOwned() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const [{ data: credits }, { data: mine }] = await Promise.all([
    sb.rpc('my_event_credits'),
    sb.rpc('my_event_albums'),
  ]);
  if (!(Number(credits) > 0) && !(mine || []).length) return;
  document.getElementById('owned')?.classList.add('on');
}

/**
 * Картинка QR на табличке. Настоящий код тут не нужен и был бы вреден: это
 * иллюстрация, а не ссылка на чей-то альбом. Узор детерминированный, чтобы
 * страница не мерцала разным при каждой загрузке.
 */
function drawQr() {
  const c = document.getElementById('qr');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const N = 25, s = c.width / N;
  let seed = 20260824;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const eye = (x, y) => (x < 7 && y < 7) || (x > N - 8 && y < 7) || (x < 7 && y > N - 8);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#1c1a17';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (eye(x, y)) continue;
      if (rnd() > 0.52) ctx.fillRect(x * s, y * s, s, s);
    }
  }
  [[0, 0], [N - 7, 0], [0, N - 7]].forEach(([x, y]) => {
    ctx.fillStyle = '#1c1a17'; ctx.fillRect(x * s, y * s, 7 * s, 7 * s);
    ctx.fillStyle = '#fff';    ctx.fillRect((x + 1) * s, (y + 1) * s, 5 * s, 5 * s);
    ctx.fillStyle = '#1c1a17'; ctx.fillRect((x + 2) * s, (y + 2) * s, 3 * s, 3 * s);
  });
}
