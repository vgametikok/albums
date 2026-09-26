// Лендинг событийного альбома (/events/, раньше event-album.html): объясняет
// продукт и ведёт в оплату. Страница лежит в подпапке, поэтому все адреса в
// её HTML — от корня сайта (/js/…, /pricing), а импорты здесь — относительные.
//
// Логика покупки та же, что на странице цен (create-order в paypal-webhook,
// вход перед оплатой, продолжение по флагу после возврата) — вынесена в общий
// js/checkout.js, чтобы обе страницы не расходились. Тарифов три (small /
// medium / large); верхняя и нижняя кнопки ведут к их выбору (#buy).
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

  // alt у иллюстраций — тоже из словаря
  document.querySelectorAll('[data-i18n-alt]').forEach(n => { n.alt = t(n.dataset.i18nAlt); });

  // Подписи тарифов: «до {n} гостей», «{n} GB» — числа из разметки.
  document.querySelectorAll('[data-i18n-n]').forEach(n => {
    n.textContent = t(n.dataset.i18nN, { n: n.dataset.n });
  });

  wireTiers();
  showOwned();
})();

/**
 * Три тарифа — три кнопки одной покупки. На сервер уходит только название
 * тарифа: цену заказа ставит edge-функция. Её ответ (tier + amount) сверяем с
 * тем, что человек видел на карточке, и только тогда уводим на PayPal. Старая
 * версия функции тариф не понимает и всегда выставляет $39.99 без эха — для
 * small это верно, для medium/large уводить на такую оплату нельзя.
 */
const TIERS = { small: '39.99', medium: '69.99', large: '129.99' };

function wireTiers() {
  const ids = Object.keys(TIERS).map(k => 'cta-' + k);
  wireCheckout(ids, 'create-order', 'event_after_login', {
    payload: (btn) => ({ tier: btn.dataset.tier }),
    flagValue: (p) => p.tier,
    fromFlag: (v) => (TIERS[v] ? document.getElementById('cta-' + v) : null),
    verify: (out, p) => {
      if (out.tier === undefined && out.amount === undefined) return p.tier === 'small';
      return out.tier === p.tier && String(out.amount) === TIERS[p.tier];
    },
    unavailable: 'ea_tier_unavailable',
  });
}

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
