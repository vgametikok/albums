// Лендинг событийного альбома (/events/, раньше event-album.html): объясняет
// продукт и ведёт в оплату. Страница лежит в подпапке, поэтому все адреса в
// её HTML — от корня сайта (/js/…, /pricing), а импорты здесь — относительные.
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
