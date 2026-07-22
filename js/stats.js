// Сбор статистики: показы карточек в ленте, посещения альбома, удержание,
// переходы по кнопкам профиля.
//
// Гоча supabase-js: запрос уходит на сервер только когда у построителя вызван
// then/await. Голый `sb.rpc(...)` не отправляет НИЧЕГО — именно так просмотры
// альбомов не считались вообще. Поэтому все вызовы здесь идут через fire().
//
// Персональных данных не собираем: IP не передаём и не храним, страну берём из
// часового пояса браузера, язык — из настроек браузера.
import { sb } from './sb.js';

/* ---------------- страна и язык ---------------- */

// Последний сегмент часового пояса -> код страны. Хватает на все населённые
// зоны; чего нет в списке — уточняем по региону из языка браузера.
const ZONES = (
  'London:GB,Dublin:IE,Lisbon:PT,Madrid:ES,Paris:FR,Brussels:BE,Amsterdam:NL,Luxembourg:LU,' +
  'Berlin:DE,Busingen:DE,Zurich:CH,Vienna:AT,Prague:CZ,Bratislava:SK,Budapest:HU,Warsaw:PL,' +
  'Rome:IT,Malta:MT,Ljubljana:SI,Zagreb:HR,Sarajevo:BA,Belgrade:RS,Skopje:MK,Podgorica:ME,' +
  'Tirane:AL,Athens:GR,Sofia:BG,Bucharest:RO,Chisinau:MD,Kiev:UA,Kyiv:UA,Uzhgorod:UA,' +
  'Zaporozhye:UA,Minsk:BY,Vilnius:LT,Riga:LV,Tallinn:EE,Helsinki:FI,Stockholm:SE,Oslo:NO,' +
  'Copenhagen:DK,Reykjavik:IS,Andorra:AD,Monaco:MC,Gibraltar:GI,San_Marino:SM,Vatican:VA,' +
  'Isle_of_Man:IM,Jersey:JE,Guernsey:GG,Mariehamn:AX,Belfast:GB,' +
  'Moscow:RU,Kaliningrad:RU,Samara:RU,Volgograd:RU,Saratov:RU,Astrakhan:RU,Ulyanovsk:RU,' +
  'Kirov:RU,Yekaterinburg:RU,Omsk:RU,Novosibirsk:RU,Barnaul:RU,Tomsk:RU,Novokuznetsk:RU,' +
  'Krasnoyarsk:RU,Irkutsk:RU,Chita:RU,Yakutsk:RU,Khandyga:RU,Vladivostok:RU,Ust-Nera:RU,' +
  'Magadan:RU,Sakhalin:RU,Srednekolymsk:RU,Kamchatka:RU,Anadyr:RU,' +
  'Istanbul:TR,Nicosia:CY,Famagusta:CY,Jerusalem:IL,Tel_Aviv:IL,Beirut:LB,Damascus:SY,' +
  'Amman:JO,Baghdad:IQ,Kuwait:KW,Riyadh:SA,Qatar:QA,Bahrain:BH,Dubai:AE,Muscat:OM,Aden:YE,' +
  'Tehran:IR,Baku:AZ,Tbilisi:GE,Yerevan:AM,Almaty:KZ,Aqtau:KZ,Aqtobe:KZ,Atyrau:KZ,Oral:KZ,' +
  'Qostanay:KZ,Qyzylorda:KZ,Bishkek:KG,Dushanbe:TJ,Ashgabat:TM,Tashkent:UZ,Samarkand:UZ,' +
  'Kabul:AF,Karachi:PK,Kolkata:IN,Calcutta:IN,Colombo:LK,Kathmandu:NP,Thimphu:BT,Dhaka:BD,' +
  'Yangon:MM,Bangkok:TH,Vientiane:LA,Phnom_Penh:KH,Ho_Chi_Minh:VN,Saigon:VN,Jakarta:ID,' +
  'Pontianak:ID,Makassar:ID,Jayapura:ID,Kuala_Lumpur:MY,Kuching:MY,Singapore:SG,Brunei:BN,' +
  'Manila:PH,Hong_Kong:HK,Macau:MO,Taipei:TW,Shanghai:CN,Urumqi:CN,Chongqing:CN,Harbin:CN,' +
  'Seoul:KR,Pyongyang:KP,Tokyo:JP,Ulaanbaatar:MN,Hovd:MN,Choibalsan:MN,' +
  'New_York:US,Chicago:US,Denver:US,Los_Angeles:US,Phoenix:US,Anchorage:US,Detroit:US,' +
  'Indianapolis:US,Boise:US,Juneau:US,Honolulu:US,Adak:US,Menominee:US,Louisville:US,' +
  'Toronto:CA,Vancouver:CA,Edmonton:CA,Winnipeg:CA,Halifax:CA,St_Johns:CA,Regina:CA,' +
  'Montreal:CA,Whitehorse:CA,Yellowknife:CA,Iqaluit:CA,' +
  'Mexico_City:MX,Tijuana:MX,Monterrey:MX,Cancun:MX,Merida:MX,Chihuahua:MX,Mazatlan:MX,' +
  'Guatemala:GT,Belize:BZ,El_Salvador:SV,Tegucigalpa:HN,Managua:NI,Costa_Rica:CR,Panama:PA,' +
  'Havana:CU,Jamaica:JM,Port-au-Prince:HT,Santo_Domingo:DO,Puerto_Rico:PR,Nassau:BS,' +
  'Barbados:BB,Port_of_Spain:TT,Curacao:CW,Aruba:AW,' +
  'Bogota:CO,Caracas:VE,Lima:PE,La_Paz:BO,Santiago:CL,Buenos_Aires:AR,Cordoba:AR,Mendoza:AR,' +
  'Salta:AR,Tucuman:AR,Montevideo:UY,Asuncion:PY,Sao_Paulo:BR,Bahia:BR,Fortaleza:BR,' +
  'Manaus:BR,Recife:BR,Belem:BR,Cuiaba:BR,Campo_Grande:BR,Guayaquil:EC,Paramaribo:SR,' +
  'Guyana:GY,Cayenne:GF,' +
  'Cairo:EG,Algiers:DZ,Tunis:TN,Casablanca:MA,El_Aaiun:EH,Tripoli:LY,Khartoum:SD,Juba:SS,' +
  'Lagos:NG,Accra:GH,Abidjan:CI,Dakar:SN,Bamako:ML,Ouagadougou:BF,Niamey:NE,Conakry:GN,' +
  'Freetown:SL,Monrovia:LR,Lome:TG,Porto-Novo:BJ,Bissau:GW,Banjul:GM,Nouakchott:MR,' +
  'Douala:CM,Bangui:CF,Ndjamena:TD,Libreville:GA,Brazzaville:CG,Kinshasa:CD,Lubumbashi:CD,' +
  'Luanda:AO,Nairobi:KE,Kampala:UG,Dar_es_Salaam:TZ,Kigali:RW,Bujumbura:BI,Addis_Ababa:ET,' +
  'Asmara:ER,Djibouti:DJ,Mogadishu:SO,Lusaka:ZM,Harare:ZW,Maputo:MZ,Blantyre:MW,' +
  'Gaborone:BW,Windhoek:NA,Johannesburg:ZA,Maseru:LS,Mbabane:SZ,Antananarivo:MG,' +
  'Port_Louis:MU,Mahe:SC,Moroni:KM,' +
  'Sydney:AU,Melbourne:AU,Brisbane:AU,Perth:AU,Adelaide:AU,Darwin:AU,Hobart:AU,Lindeman:AU,' +
  'Auckland:NZ,Chatham:NZ,Fiji:FJ,Port_Moresby:PG,Guadalcanal:SB,Efate:VU,Noumea:NC,' +
  'Tahiti:PF,Guam:GU,Saipan:MP,Apia:WS,Tongatapu:TO'
).split(',').reduce((m, pair) => { const [k, v] = pair.split(':'); m[k] = v; return m; }, {});

let _country = null;
/** Код страны зрителя: часовой пояс, а если зона незнакомая — регион языка. */
export function country() {
  if (_country !== null) return _country;
  let cc = '';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    cc = ZONES[tz.split('/').pop()] || '';
  } catch (_) { /* без часового пояса просто идём дальше */ }
  if (!cc) {
    const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(navigator.language || '');
    if (m) cc = m[1].toUpperCase();
  }
  _country = cc || null;
  return _country;
}

/** Язык интерфейса зрителя, две буквы. */
export function lang() {
  return (navigator.language || '').slice(0, 2).toLowerCase() || null;
}

/** Откуда пришли на альбом — по адресу предыдущей страницы. */
export function source() {
  const r = document.referrer || '';
  if (!r) return 'direct';
  try {
    const u = new URL(r);
    if (u.origin !== location.origin) return 'external';
    const p = u.pathname.split('/').pop() || 'index.html';
    if (u.searchParams.get('q')) return 'search';
    if (p === '' || p === 'index.html') return 'feed';
    if (p === 'posts.html') return 'posts';
    if (p === 'profile.html') return 'profile';
    if (p === 'calendar.html') return 'calendar';
    if (p === 'join.html') return 'invite';
    if (p === 'album.html') return 'album';
  } catch (_) { /* кривой referrer — считаем прямым заходом */ }
  return 'direct';
}

/** Запускает ленивый запрос supabase-js и глушит ошибки: статистика не должна ломать страницу. */
function fire(builder) {
  return builder.then((r) => r, () => ({ data: null, error: true }));
}

/* ---------------- показы карточек ---------------- */

const seen = new Set();
let observer = null;

/**
 * Показ засчитывается, когда карточка была видна хотя бы наполовину и не меньше
 * секунды — иначе быстрая прокрутка мимо накрутила бы показы.
 */
export function observeImpressions(root) {
  if (!('IntersectionObserver' in window)) return;
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const id = e.target.dataset.albumId;
        if (!id) return;
        if (!e.isIntersecting) {
          clearTimeout(e.target._impT);
          return;
        }
        if (seen.has(id)) { observer.unobserve(e.target); return; }
        e.target._impT = setTimeout(() => {
          if (seen.has(id)) return;
          seen.add(id);
          observer.unobserve(e.target);
          fire(sb.rpc('stat_track', {
            p_kind: 'impression', p_album: id, p_source: 'feed',
            p_country: country(), p_lang: lang(),
          }));
        }, 1000);
      });
    }, { threshold: 0.5 });
  }
  root.querySelectorAll('[data-album-id]').forEach((n) => {
    if (!n._impObserved) { n._impObserved = true; observer.observe(n); }
  });
}

/* ---------------- посещение и удержание ---------------- */

let eventId = null;
let activeMs = 0;
let since = 0;
let timer = null;

function accumulate() {
  if (since) { activeMs += Date.now() - since; since = 0; }
}

async function flush() {
  accumulate();
  if (!eventId || activeMs < 1000) return;
  await fire(sb.rpc('stat_dwell', { p_event: eventId, p_ms: Math.round(activeMs) }));
}

/**
 * Посещение альбома. Возвращает id события, дальше сам следит за удержанием:
 * копит время, пока вкладка видима, и отправляет отсечки каждые 15 секунд,
 * при уходе со страницы и при сворачивании. Одной отправкой в конце обойтись
 * нельзя — браузеры не гарантируют событие закрытия вкладки.
 */
export async function trackAlbumView(albumId) {
  const { data } = await fire(sb.rpc('stat_track', {
    p_kind: 'view', p_album: albumId, p_source: source(),
    p_country: country(), p_lang: lang(),
  }));
  eventId = data || null;
  if (!eventId) return null;

  since = document.visibilityState === 'visible' ? Date.now() : 0;
  timer = setInterval(flush, 15000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { since = Date.now(); }
    else { flush(); }
  });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  return eventId;
}

export function stopTracking() {
  clearInterval(timer);
  timer = null;
  flush();
}

/* ---------------- кнопки профиля ---------------- */

/** Переход по кнопке. Ссылка открывается в новой вкладке, страница жива — запрос успевает уйти. */
export function trackButton(buttonId) {
  fire(sb.rpc('stat_button_click', { p_button: buttonId, p_country: country(), p_lang: lang() }));
}
