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
import { sb, isAuthed, isGuest, currentUser, signInAnonymously } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, toast, showLogin, emptyState, icon, t, thumbEl, dur, avatarImg,
  modal,
} from './ui.js';
import { uploadMedia } from './upload.js';

const app = $('#app');
const token = new URLSearchParams(location.search).get('t');

const CLAIM_KEY = 'albumsClaim';        // {code, pub, ts} — переезд гостевых файлов после входа
const AS_ANON_KEY = 'joinAsAnon';       // выбор подписи зарегистрированного участника

let info = null;      // ответ album_invite_peek
let mine = [];        // мои файлы в этом альбоме
let busy = 0;

(async function main() {
  await mountShell('home');
  document.title = t('join_title') + ' — Albums';

  if (!token) { app.appendChild(emptyState(t('join_bad_link'), t('join_bad_link_text'))); return; }

  await finishClaimIfAny();

  const { data, error } = await sb.rpc('album_invite_peek', { p_token: token });
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
  if (data?.moved > 0) toast(t('claim_done'));
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
        onclick: () => openClaimModal(false),
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

  panel.append(fileInput, drop, done, status, listHost);
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
          class: 'tag', style: 'bottom:auto;top:5px;background:rgba(232,85,43,.92)',
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
      // Гость только что положил файлы — самое время предложить забрать их себе.
      if (isGuest()) openClaimModal(true);
    }
  }

  /**
   * Предложение входа гостю. justUploaded меняет только заголовок и текст:
   * из баннера — «войдите», после загрузки — «фото загружены, подпишите их».
   * Код переноса просим ДО входа: после редиректа гостевой сессии уже не будет.
   */
  function openClaimModal(justUploaded) {
    modal((box, close) => {
      const startClaim = async (pub, btn) => {
        btn.disabled = true;
        const { data, error } = await sb.rpc('guest_claim_start');
        if (error || !data?.code) { toast(error?.message || t('claim_failed')); btn.disabled = false; return; }
        localStorage.setItem(CLAIM_KEY, JSON.stringify({ code: data.code, pub, ts: Date.now() }));
        close();
        showLogin(t('claim_signin_reason'));
      };
      const pubBtn = el('button', { class: 'btn btn-primary', style: 'width:100%' }, t('claim_signin_public'));
      pubBtn.onclick = () => startClaim(true, pubBtn);
      const anonBtn = el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px' }, t('claim_signin_anon'));
      anonBtn.onclick = () => startClaim(false, anonBtn);

      box.append(
        el('h2', { text: justUploaded ? t('claim_title') : t('claim_title_idle') }),
        el('p', { text: t('claim_text') }),
        pubBtn, anonBtn,
        el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close },
          t('claim_stay_anon')));
    });
  }
}
