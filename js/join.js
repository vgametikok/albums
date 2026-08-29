// Страница дозагрузки в событийный альбом: перешёл по ссылке — добавил свои фото.
//
// Намеренно проще редактора: гость не правит альбом, не видит чужих приватных
// файлов и не может удалить чужое. Всё, что он делает, — кладёт своё и видит,
// что уже положил.
//
// Входить не обязательно: «Продолжить без входа» создаёт анонимную сессию,
// файлы ложатся в альбом без подписи. После загрузки предлагаем войти — тогда
// файлы можно забрать себе (guest_claim_start/finish) и, по желанию, подписать.
// Зарегистрированный участник сам выбирает, как подписывать: своим именем или
// анонимно (album_media.anon).
import { sb, isAuthed, isGuest, currentUser, signInAnonymously, signIn, isNetworkError } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, toast, showLogin, emptyState, icon, t, thumbEl, dur, avatarImg,
  modal,
} from './ui.js';
import { uploadMedia } from './upload.js';

const app = $('#app');
const token = new URLSearchParams(location.search).get('t');

const CLAIM_KEY = 'albumsClaim';        // {code, pub, ts, album} — переезд гостевых файлов после входа
const AS_ANON_KEY = 'joinAsAnon';       // выбор подписи зарегистрированного участника
const SAT_HIDE_KEY = 'albumsSatHide';   // sessionStorage: гость закрыл карточку «сохраните себе»

let info = null;      // ответ album_invite_peek
let mine = [];        // мои файлы в этом альбоме
let busy = 0;
let satAlbumId = null; // альбом-спутник вызывающего (ответ event_satellite_sync)

(async function main() {
  // focused: гость пришёл по QR за одним делом — загрузить фото. Нижняя
  // панель ему только мешает (см. mountShell).
  await mountShell('home', { focused: true });
  document.title = t('join_title') + ' — Albums';

  if (!token) { app.appendChild(emptyState(t('join_bad_link'), t('join_bad_link_text'))); return; }

  await finishClaimIfAny();

  const { data, error } = await sb.rpc('album_invite_peek', { p_token: token });
  // Сеть и «плохая ссылка» — разные беды, и раньше обе показывались как
  // «ссылка недействительна». Человек шёл выяснять у хозяина события, что
  // тот прислал, хотя на деле до сервера просто не дошёл запрос.
  if (error && isNetworkError(error)) {
    app.appendChild(emptyState(t('net_error_title'), t('net_error_text'),
      el('button', { class: 'btn btn-primary', onclick: () => location.reload() },
        t('net_error_retry'))));
    return;
  }
  if (error || !data?.ok) {
    const reason = {
      revoked: t('join_revoked'), expired: t('join_expired'),
      used_up: t('join_used_up'), not_found: t('join_bad_link_text'),
    }[data?.reason] || t('join_bad_link_text');
    app.appendChild(emptyState(t('join_unavailable'), reason));
    return;
  }
  info = data;
  render();
})();

/**
 * Человек загрузил как гость, а теперь вернулся уже с настоящим аккаунтом:
 * предъявляем код и забираем файлы себе. Код одноразовый, попытка — тоже:
 * при ошибке ключ выбрасываем, чтобы не дёргать RPC на каждом заходе.
 */
async function finishClaimIfAny() {
  if (!isAuthed() || isGuest()) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CLAIM_KEY) || 'null'); } catch (_) { /* мусор */ }
  localStorage.removeItem(CLAIM_KEY);
  if (!saved?.code || (Date.now() - (saved.ts || 0)) > 7 * 86400e3) return;
  const { data, error } = await sb.rpc('guest_claim_finish', {
    p_code: saved.code, p_public: !!saved.pub,
  });
  if (error) { toast(t('claim_failed')); return; }
  if (data?.moved > 0) {
    // Файлы теперь его — выполняем обещание карточки: тот же кадр появляется
    // и в СОБСТВЕННОМ альбоме человека (спека internal/GUEST-LOOP-PLAN.md).
    await syncSatellite(saved.album);
    toast(satAlbumId ? t('sat_claim_done') : t('claim_done'));
  }
}

/** Доносит мои файлы события в мой альбом-спутник. Молча: это фон, не действие. */
async function syncSatellite(albumId) {
  if (!albumId) return;
  const { data, error } = await sb.rpc('event_satellite_sync', { p_event: albumId });
  if (!error && data?.album_id) satAlbumId = data.album_id;
}

async function render() {
  clear(app);

  const urls = (info.cover_path || info.cover_full)
    ? await signUrls([info.cover_full, info.cover_path]) : {};
  const cover = urls[info.cover_full] || urls[info.cover_path];

  const hero = el('div', { class: 'join-hero' });
  if (cover) hero.appendChild(el('img', { src: cover, alt: info.title }));
  hero.appendChild(el('div', { class: 'join-hero-body' },
    el('div', { class: 'kicker', text: t('join_kicker') }),
    el('h1', { class: 'join-title', text: info.title }),
    el('div', { class: 'join-owner', text: t('join_by', { name: info.owner_name || info.owner_username }) })));
  app.appendChild(hero);

  // Слово автора: зачем гость здесь и что от него нужно. Автор мог ничего не
  // написать — тогда объясняем сами, иначе страница выглядит как пустая форма.
  const greet = (info.greeting || '').trim();
  app.appendChild(el('div', { class: 'join-greet' },
    el('div', { class: 'join-greet-by' },
      avatarImg(info.owner_avatar, info.owner_name, 28),
      el('span', { text: greet ? (info.owner_name || info.owner_username) : 'Albums' })),
    el('div', { text: greet || t('join_default_greeting') })));

  if (!isAuthed()) {
    const guestBtn = el('button', { class: 'btn btn-primary', style: 'width:100%' }, t('join_guest_btn'));
    guestBtn.onclick = async () => {
      guestBtn.disabled = true;
      try { await signInAnonymously(); location.reload(); }
      catch (err) { toast(err.message || t('signin_failed')); guestBtn.disabled = false; }
    };
    app.appendChild(el('div', { class: 'side-card', style: 'margin-top:24px;max-width:520px' },
      el('p', { style: 'margin:0 0 16px;font-size:16.5px;line-height:1.6', text: t('join_choice_text') }),
      guestBtn,
      el('div', { class: 'muted', style: 'font-size:13.5px;line-height:1.5;margin:8px 0 14px', text: t('join_guest_hint') }),
      el('button', {
        class: 'btn btn-ghost', style: 'width:100%',
        onclick: () => showLogin(t('join_signin_reason')),
      }, t('sign_in')),
      el('div', { class: 'muted', style: 'font-size:13.5px;line-height:1.5;margin-top:8px', text: t('join_signin_hint') })));
    return;
  }

  // вход есть — принимаем приглашение (идемпотентно) и открываем загрузку
  const acc = await sb.rpc('album_invite_accept', { p_token: token });
  if (acc.error) {
    app.appendChild(emptyState(t('join_unavailable'), acc.error.message));
    return;
  }

  const panel = el('div', { style: 'max-width:720px;margin-top:24px' });
  app.appendChild(panel);

  // Как подписывать файлы. Гость выбора не имеет: без аккаунта подпись ставить
  // не на кого — только анонимно (до переноса после входа).
  let asAnon = isGuest() ? true : localStorage.getItem(AS_ANON_KEY) === '1';

  if (isGuest()) {
    panel.appendChild(el('div', { class: 'side-card', style: 'margin-bottom:18px' },
      el('div', { style: 'font-size:15px;line-height:1.55', text: t('join_guest_banner') }),
      el('button', {
        class: 'btn btn-ghost btn-sm', style: 'margin-top:10px',
        onclick: () => openClaimModal(),
      }, t('sign_in'))));
  } else {
    const wrap = el('div', { class: 'vis-opts', style: 'margin-bottom:18px' });
    [[false, t('join_as_public'), t('join_as_public_d')], [true, t('join_as_anon'), t('join_as_anon_d')]]
      .forEach(([val, ttl, sub]) => {
        const input = el('input', {
          type: 'radio', name: 'joinas', checked: val === asAnon ? 'checked' : null,
          onchange: () => {
            asAnon = val;
            localStorage.setItem(AS_ANON_KEY, val ? '1' : '0');
            wrap.querySelectorAll('.vis-opt').forEach(n => n.classList.toggle('on', n.contains(input)));
          },
        });
        wrap.appendChild(el('label', { class: 'vis-opt' + (val === asAnon ? ' on' : '') },
          input, el('div', {}, el('b', { text: ttl }), el('span', { text: sub }))));
      });
    panel.append(
      el('div', { class: 'label', style: 'margin-bottom:8px', text: t('join_as_label') }),
      wrap);
  }

  const fileInput = el('input', {
    type: 'file', multiple: 'multiple', class: 'hide', accept: 'image/*,.heic,.heif,video/*',
    onchange: (e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; },
  });
  const drop = el('div', {
    class: 'drop',
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
  },
    el('div', { style: 'font-size:17px;font-weight:600', text: t('join_drop') }),
    el('div', { style: 'font-size:14.5px;margin-top:6px', text: t('join_drop_hint') }));

  const status = el('div', { class: 'muted hide', style: 'margin-top:12px;font-size:14.5px' });
  const listHost = el('div', { style: 'margin-top:24px' });

  // После удачной пачки зона загрузки сменяется на «готово»: человек у стола
  // с QR-кодом должен понять, что дело сделано и страницу можно закрывать.
  const done = el('div', { class: 'side-card hide', style: 'text-align:center' },
    el('div', { style: 'font-size:19px;font-weight:700', text: t('join_done_title') }),
    el('div', { class: 'muted', style: 'font-size:14.5px;margin-top:6px', text: t('join_done_text') }),
    el('button', {
      class: 'btn btn-primary', style: 'margin-top:14px',
      onclick: () => { done.classList.add('hide'); drop.classList.remove('hide'); },
    }, t('join_add_more')));

  // Сюда после загрузки встаёт либо карточка «сохраните и себе» (гостю),
  // либо ссылка на собственный альбом-спутник (вошедшему).
  const saveHost = el('div');

  panel.append(fileInput, drop, done, saveHost, status, listHost);
  loadMine();

  async function loadMine() {
    const { data } = await sb.from('album_media')
      .select('id,position,is_private,visibility,media:media_id(id,kind,storage_path,thumb_path,duration_seconds,owner_id)')
      .eq('album_id', info.album_id)
      .order('position');
    mine = (data || []).filter(r => r.media?.owner_id === currentUser().id);
    drawMine();
  }

  async function drawMine() {
    clear(listHost);
    listHost.appendChild(el('div', { class: 'section-head', style: 'margin:0 0 14px' },
      el('h2', { style: 'font-size:20px', text: t('join_yours') }),
      el('span', { class: 'muted', style: 'font-size:14.5px', text: t('join_yours_count', { count: mine.length }) })));

    if (!mine.length) {
      listHost.appendChild(el('div', { class: 'muted', text: t('join_nothing_yet') }));
      return;
    }
    const u = await signUrls(mine.flatMap(r => [r.media.thumb_path, r.media.storage_path]));
    const grid = el('div', { class: 'lib-grid' });
    mine.forEach(r => {
      const m = r.media;
      const cell = el('div', { class: 'lib-cell' });
      const node = thumbEl(m.thumb_path || m.storage_path, u[m.thumb_path] || u[m.storage_path],
        m.thumb_path ? null : m.kind);
      if (node) cell.appendChild(node);
      if (m.kind === 'video') cell.appendChild(el('div', { class: 'tag', text: dur(m.duration_seconds) || t('video_tag') }));
      // Придержанный файл: автор альбома (или модератор) ещё не показал его
      // остальным. Загрузившему честно говорим, что кадр пока ждёт одобрения.
      if (r.is_private) {
        cell.appendChild(el('div', {
          class: 'tag', style: 'bottom:auto;top:5px;background:rgba(201,162,39,.92)',
          text: t('join_on_review'),
        }));
      }
      cell.appendChild(el('button', {
        class: 'lib-remove', 'aria-label': t('remove'),
        onclick: async () => {
          if (!confirm(t('join_remove_confirm'))) return;
          const { error } = await sb.from('album_media').delete().eq('id', r.id);
          if (error) { toast(error.message); return; }
          loadMine();
        },
      }, '×'));
      grid.appendChild(cell);
    });
    listHost.appendChild(grid);
  }

  async function addFiles(files) {
    if (!files.length) return;
    let ok = 0;
    // Хвост общей последовательности альбома: редактор держит позиции плотными
    // (0..n), гостевые файлы продолжают их. Один запрос до пачки, дальше
    // локальный инкремент. Если политика чтения не отдала чужих строк —
    // отталкиваемся от максимума среди своих.
    const { data: tail } = await sb.from('album_media')
      .select('position').eq('album_id', info.album_id)
      .order('position', { ascending: false }).limit(1);
    let pos = (tail?.[0]?.position ?? Math.max(-1, ...mine.map(r => r.position))) + 1;
    for (const f of files) {
      busy++;
      status.classList.remove('hide');
      status.textContent = t('join_uploading', { name: f.name });
      try {
        const media = await uploadMedia(f, (stage, p) => {
          const pct = (stage === 'transcoding' && p) ? ` ${Math.round(p * 100)}%` : '';
          status.textContent = `${f.name} — ${t('stage_' + (stage === 'converting' ? 'heic' : stage === 'transcoding' ? 'video' : stage))}${pct}`;
        });
        const { error } = await sb.from('album_media')
          .insert({ album_id: info.album_id, media_id: media.id, position: pos++, anon: asAnon });
        if (error) throw error;
        ok++;
      } catch (err) {
        toast(err.message || t('upload_failed'));
      }
      busy--;
    }
    status.classList.add('hide');
    loadMine();
    if (ok > 0 && busy === 0) {
      drop.classList.add('hide');
      done.classList.remove('hide');
      if (isGuest()) {
        // Ненавязчиво, карточкой, а не модалкой: загрузка уже удалась, вход —
        // предложение выгоды («сохраните и себе»), а не условие.
        if (!sessionStorage.getItem(SAT_HIDE_KEY)) showSaveCard();
      } else {
        // Вошедший участник: фото сразу доносятся в его альбом-спутник.
        syncSatellite(info.album_id).then(showSatLink);
      }
    }
  }

  /** Ссылка на собственный альбом с этого события — доказательство обещания. */
  function showSatLink() {
    if (!satAlbumId) return;
    clear(saveHost);
    saveHost.appendChild(el('div', { class: 'side-card', style: 'margin-top:14px;text-align:center' },
      el('div', { class: 'muted', style: 'font-size:14.5px', text: t('sat_saved') }),
      el('a', {
        class: 'btn btn-ghost btn-sm', style: 'margin-top:8px',
        href: `album.html?id=${satAlbumId}`,
      }, t('sat_open'))));
  }

  /**
   * Карточка гостю после загрузки: «войдите — эти фото сохранятся и у вас».
   * Подпись именем — по умолчанию; «остаться анонимным» — галочка. Код
   * переноса просим ДО входа: после редиректа гостевой сессии уже не будет.
   */
  function showSaveCard() {
    clear(saveHost);
    const anonCb = el('input', { type: 'checkbox' });
    const googleBtn = el('button', { class: 'btn btn-primary', style: 'width:100%' },
      t('continue_google'));
    const otherBtn = el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:8px' },
      t('sat_banner_other'));
    const start = async (btn, go) => {
      btn.disabled = true;
      const { data, error } = await sb.rpc('guest_claim_start');
      if (error || !data?.code) { toast(error?.message || t('claim_failed')); btn.disabled = false; return; }
      localStorage.setItem(CLAIM_KEY, JSON.stringify({
        code: data.code, pub: !anonCb.checked, ts: Date.now(), album: info.album_id,
      }));
      go();
    };
    googleBtn.onclick = () => start(googleBtn, () =>
      signIn().catch(err => { toast(err.message || t('signin_failed')); googleBtn.disabled = false; }));
    otherBtn.onclick = () => start(otherBtn, () => showLogin(t('claim_signin_reason')));

    const card = el('div', { class: 'side-card', style: 'margin-top:14px;position:relative' },
      el('button', {
        class: 'btn-icon', 'aria-label': t('not_now'),
        style: 'position:absolute;top:10px;right:10px',
        onclick: () => { sessionStorage.setItem(SAT_HIDE_KEY, '1'); card.remove(); },
      }, '×'),
      el('div', { style: 'font-size:17px;font-weight:700', text: t('sat_banner_title') }),
      el('div', { class: 'muted', style: 'font-size:14.5px;line-height:1.55;margin:6px 0 14px', text: t('sat_banner_text') }),
      googleBtn, otherBtn,
      el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:14px;margin-top:12px;cursor:pointer' },
        anonCb, el('span', { class: 'muted', text: t('sat_banner_anon') })));
    saveHost.appendChild(card);
  }

  /**
   * Предложение входа гостю из верхнего баннера (уже загружал раньше).
   * Та же семантика, что в карточке после загрузки: подпись именем — по
   * умолчанию, «остаться анонимным» — галочка. Код переноса просим ДО входа:
   * после редиректа гостевой сессии уже не будет.
   */
  function openClaimModal() {
    modal((box, close) => {
      const anonCb = el('input', { type: 'checkbox' });
      const start = async (btn, go) => {
        btn.disabled = true;
        const { data, error } = await sb.rpc('guest_claim_start');
        if (error || !data?.code) { toast(error?.message || t('claim_failed')); btn.disabled = false; return; }
        localStorage.setItem(CLAIM_KEY, JSON.stringify({
          code: data.code, pub: !anonCb.checked, ts: Date.now(), album: info.album_id,
        }));
        close();
        go();
      };
      const googleBtn = el('button', { class: 'btn btn-primary', style: 'width:100%' },
        t('continue_google'));
      googleBtn.onclick = () => start(googleBtn, () =>
        signIn().catch(err => toast(err.message || t('signin_failed'))));
      const otherBtn = el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px' },
        t('sat_banner_other'));
      otherBtn.onclick = () => start(otherBtn, () => showLogin(t('claim_signin_reason')));

      box.append(
        el('h2', { text: t('claim_title_idle') }),
        el('p', { text: t('sat_banner_text') }),
        googleBtn, otherBtn,
        el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:14px;margin-top:12px;cursor:pointer' },
          anonCb, el('span', { class: 'muted', text: t('sat_banner_anon') })),
        // Именно «не сейчас», а не «остаться анонимом»: рядом стоит галочка
        // про анонимность В АЛЬБОМЕ, и два почти одинаковых слова про разное
        // читались бы как одно и то же.
        el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close },
          t('not_now')));
    });
  }
}
