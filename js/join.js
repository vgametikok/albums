// Страница дозагрузки в событийный альбом: перешёл по ссылке — добавил свои фото.
//
// Намеренно проще редактора: гость не правит альбом, не видит чужих приватных
// файлов и не может удалить чужое. Всё, что он делает, — кладёт своё и видит,
// что уже положил.
import { sb, isAuthed, currentUser } from './sb.js';
import {
  el, $, clear, mountShell, signUrls, toast, showLogin, emptyState, icon, t, thumbEl, dur, avatarImg,
} from './ui.js';
import { uploadMedia } from './upload.js';

const app = $('#app');
const token = new URLSearchParams(location.search).get('t');

let info = null;      // ответ album_invite_peek
let mine = [];        // мои файлы в этом альбоме
let busy = 0;

(async function main() {
  await mountShell('home');
  document.title = t('join_title') + ' — Albums';

  if (!token) { app.appendChild(emptyState(t('join_bad_link'), t('join_bad_link_text'))); return; }

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
    app.appendChild(el('div', { class: 'side-card', style: 'margin-top:24px;max-width:520px' },
      el('p', { style: 'margin:0 0 16px;font-size:16.5px;line-height:1.6', text: t('join_signin_text') }),
      el('button', {
        class: 'btn btn-primary', style: 'width:100%',
        onclick: () => showLogin(t('join_signin_reason')),
      }, t('sign_in'))));
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

  panel.append(fileInput, drop, status, listHost);
  loadMine();

  async function loadMine() {
    const { data } = await sb.from('album_media')
      .select('id,position,media:media_id(id,kind,storage_path,thumb_path,duration_seconds,owner_id)')
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
    for (const f of files) {
      busy++;
      status.classList.remove('hide');
      status.textContent = t('join_uploading', { name: f.name });
      try {
        const media = await uploadMedia(f, (stage, p) => {
          const pct = (stage === 'transcoding' && p) ? ` ${Math.round(p * 100)}%` : '';
          status.textContent = `${f.name} — ${t('stage_' + (stage === 'converting' ? 'heic' : stage === 'transcoding' ? 'video' : stage))}${pct}`;
        });
        const pos = Date.now() % 100000;
        const { error } = await sb.from('album_media')
          .insert({ album_id: info.album_id, media_id: media.id, position: pos });
        if (error) throw error;
      } catch (err) {
        toast(err.message || t('upload_failed'));
      }
      busy--;
    }
    status.classList.add('hide');
    loadMine();
  }
}
