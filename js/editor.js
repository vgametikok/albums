// Редактор альбома: медиа, главы, обложка, видимость (включая «друзьям кроме…»).
import { sb, currentUser, isAuthed } from './sb.js';
import { CATEGORIES } from './config.js';
import { el, $, clear, mountShell, signUrls, toast, showLogin, icon, emptyState, dur, avatarImg, t, thumbEl } from './ui.js';
import { uploadMedia, backfillPoster } from './upload.js';

const app = $('#app');
let albumId = new URLSearchParams(location.search).get('id');
let album = null;          // строка albums
let items = [];            // album_media + вложенный media
let chapters = [];         // album_chapters
let friends = [];          // для «кроме»
let excluded = new Set();  // username'ы исключённых
let saving = false;
let busy = 0;              // файлов в обработке/загрузке прямо сейчас
let collaborators = [];    // соавторы альбома
let isOwner = true;        // владелец или соавтор (у соавтора прав меньше)

(async function main() {
  await mountShell('home');
  if (!isAuthed()) {
    app.appendChild(emptyState(t('editor_signin_title'), t('editor_signin_text'),
      el('button', { class: 'btn btn-primary', onclick: () => showLogin(t('editor_signin_title')) }, t('sign_in'))));
    return;
  }

  document.title = (albumId ? t('edit_album') : t('new_album_title')) + ' — Albums';
  const mf = await sb.rpc('my_friends');
  friends = mf.data?.friends || [];

  if (albumId) {
    const [a, ch, im] = await Promise.all([
      sb.from('albums').select('*').eq('id', albumId).single(),
      sb.from('album_chapters').select('*').eq('album_id', albumId).order('position'),
      sb.from('album_media').select('id,chapter_id,position,caption,is_private,media:media_id(*)').eq('album_id', albumId).order('position'),
    ]);
    if (a.error || !a.data) { app.appendChild(emptyState(t('album_not_found'), t('album_not_found_text'))); return; }
    album = a.data; chapters = ch.data || []; items = im.data || [];
    isOwner = album.author_id === currentUser().id;
    const co = await sb.from('album_collaborators')
      .select('user_id,profiles:user_id(username,display_name,avatar_url)')
      .eq('album_id', albumId);
    collaborators = (co.data || []).map(r => r.profiles).filter(Boolean);
    const ex = await sb.from('album_exceptions').select('user_id').eq('album_id', albumId);
    if (ex.data?.length) {
      const ids = ex.data.map(r => r.user_id);
      const p = await sb.from('profiles').select('id,username').in('id', ids);
      (p.data || []).forEach(r => excluded.add(r.username));
    }
  }
  render();
})();

async function ensureAlbum() {
  if (albumId) return albumId;
  const { data, error } = await sb.from('albums').insert({
    author_id: currentUser().id,
    title: ($('#f-title')?.value || '').trim() || 'Untitled album',
    visibility: currentVisibility().base,
  }).select().single();
  if (error) throw error;
  album = data; albumId = data.id;
  history.replaceState(null, '', `editor.html?id=${albumId}`);
  return albumId;
}

function currentVisibility() {
  const v = document.querySelector('input[name=vis]:checked')?.value || album?.visibility || 'private';
  if (v === 'friends_except') return { base: 'friends', except: true };
  return { base: v, except: false };
}

/* ---------------------------------------------------------------- render */
function render() {
  clear(app);
  app.appendChild(el('a', { class: 'back', href: albumId ? `album.html?id=${albumId}` : 'index.html' },
    icon('back', 16, { sw: 2 }), albumId ? t('back_to_album') : t('back_to_feed')));

  app.appendChild(el('h1', {
    style: 'font-size:34px;font-weight:800;letter-spacing:-.03em;margin:6px 0 28px',
    text: albumId ? t('edit_album') : t('new_album_title'),
  }));

  const cols = el('div', { class: 'editor-cols' });
  const left = el('div', {});
  const right = el('div', { class: 'sticky' });
  cols.append(left, right);
  app.appendChild(cols);

  /* ---- основное ---- */
  left.appendChild(el('div', { class: 'form-row' },
    el('label', { class: 'label', for: 'f-title', text: t('f_title') }),
    el('input', { class: 'input', id: 'f-title', maxlength: '120', placeholder: t('f_title_ph'), value: album?.title || '' })));

  left.appendChild(el('div', { class: 'form-row' },
    el('label', { class: 'label', for: 'f-desc', text: t('f_desc') }),
    el('textarea', { class: 'textarea', id: 'f-desc', maxlength: '2000', placeholder: t('f_desc_ph') }, album?.description || '')));

  const catSel = el('select', { class: 'select', id: 'f-cat' },
    el('option', { value: '' }, '—'),
    ...CATEGORIES.map(c => el('option', { value: c, selected: album?.category === c ? 'selected' : null }, t('cat_' + c))));
  left.appendChild(el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_category') }), catSel));

  /* ---- медиа ---- */
  left.appendChild(el('div', { class: 'section-head', style: 'margin:36px 0 16px' },
    el('h2', { text: t('media_section') }),
    el('span', { class: 'muted', style: 'font-size:14.5px', text: t('media_hint') })));

  const fileInput = el('input', {
    type: 'file', multiple: 'multiple', class: 'hide',
    accept: 'image/*,.heic,.heif,video/*,audio/*',
    onchange: (e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; },
  });
  const drop = el('div', {
    class: 'drop',
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
  }, el('div', { style: 'font-size:17px;font-weight:600', text: t('drop_hint') }),
     el('div', { style: 'font-size:14.5px;margin-top:6px', text: t('drop_formats') }));
  left.append(fileInput, drop);

  const mlist = el('div', { class: 'mlist', id: 'mlist' });
  left.appendChild(mlist);
  drawMedia(mlist);

  /* ---- главы ---- */
  left.appendChild(el('div', { class: 'section-head', style: 'margin:40px 0 16px' },
    el('h2', { text: t('chapters') }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: addChapter }, t('add_chapter'))));
  const clist = el('div', { id: 'clist' });
  left.appendChild(clist);
  drawChapters(clist);

  /* ---- сайдбар: видимость + соавторы + действия ---- */
  if (isOwner) right.appendChild(visibilityBox());
  else right.appendChild(el('div', { class: 'side-card' },
    el('div', { class: 'label', text: t('collab_note_title') }),
    el('div', { class: 'muted', style: 'font-size:14.5px;line-height:1.5;margin-top:6px',
      text: t('collab_note_text') })));
  right.appendChild(collaboratorsBox());
  if (isOwner) right.appendChild(inviteBox());
  right.appendChild(actionsBox());
}

/* ---------------------------------------------------------------- ссылка на дозагрузку */
/**
 * Событийный альбом: одна ссылка в общий чат, гости дозаливают свои фото.
 * Токен показывается ровно один раз — в базе лежит только его хэш.
 */
function inviteBox() {
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'label', text: t('invite_title') }),
    el('div', { class: 'muted', style: 'font-size:14px;line-height:1.5;margin-top:6px', text: t('invite_hint') }));

  const out = el('div', { style: 'margin-top:12px' });

  const make = el('button', {
    class: 'btn btn-ghost btn-sm', style: 'width:100%;margin-top:12px',
    onclick: async () => {
      make.disabled = true;
      try {
        await ensureAlbum();
        const { data, error } = await sb.rpc('album_invite_create', { p_album: albumId, p_days: 30, p_max_uses: null });
        if (error) throw error;
        const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}join.html?t=${data.token}`;
        clear(out).append(
          el('input', { class: 'input', style: 'font-size:13px;height:38px', readonly: 'readonly', value: url,
            onclick: (e) => e.currentTarget.select() }),
          el('div', { class: 'rowx', style: 'margin-top:8px' },
            el('button', {
              class: 'mini', onclick: async () => {
                try { await navigator.clipboard.writeText(url); toast(t('link_copied')); }
                catch (_) { toast(url); }
              },
            }, t('copy_link'))),
          el('div', { class: 'muted', style: 'font-size:13px;margin-top:8px;line-height:1.4', text: t('invite_once') }));
      } catch (err) {
        toast(err.message || t('save_error'));
      }
      make.disabled = false;
    },
  }, icon('link', 16, { sw: 2 }), t('invite_create'));

  box.append(make, out, el('div', {
    class: 'muted', style: 'font-size:13px;margin-top:10px;line-height:1.4', text: t('invite_revoke_note'),
  }));
  return box;
}

/* ---------------------------------------------------------------- соавторы */
function collaboratorsBox() {
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' },
    el('div', { class: 'label', text: t('collaborators') }));
  const list = el('div', { class: 'stack', style: 'margin-top:10px' });

  const draw = () => {
    clear(list);
    if (!collaborators.length) {
      list.appendChild(el('div', { class: 'muted', style: 'font-size:14px',
        text: t('collab_empty') }));
    }
    collaborators.forEach(c => {
      const row = el('div', { style: 'display:flex;gap:10px;align-items:center' },
        avatarImg(c.avatar_url, c.display_name, 32),
        el('div', { style: 'flex:1;min-width:0;font-size:15px', text: c.display_name || c.username }));
      if (isOwner) {
        row.appendChild(el('button', {
          class: 'mini danger', onclick: async () => {
            const r = await sb.rpc('album_collaborator_remove', { p_album: albumId, p_username: c.username });
            if (r.error) { toast(r.error.message); return; }
            collaborators = collaborators.filter(x => x.username !== c.username);
            draw();
          },
        }, t('remove')));
      }
      list.appendChild(row);
    });
  };
  draw();
  box.appendChild(list);

  if (isOwner) {
    const pick = el('select', { class: 'select', style: 'height:40px;font-size:14.5px;margin-top:12px' },
      el('option', { value: '' }, t('add_friend_opt')));
    friends.forEach(f => {
      if (collaborators.some(c => c.username === f.username)) return;
      pick.appendChild(el('option', { value: f.username }, f.name || f.username));
    });
    pick.onchange = async (e) => {
      const u = e.currentTarget.value;
      e.currentTarget.value = '';
      if (!u) return;
      try {
        await ensureAlbum();
        const r = await sb.rpc('album_collaborator_add', { p_album: albumId, p_username: u });
        if (r.error) throw r.error;
        const f = friends.find(x => x.username === u);
        collaborators.push({ username: u, display_name: f?.name || u, avatar_url: f?.avatar });
        draw();
        toast(t('collab_added'));
      } catch (err) {
        toast(err.message || t('collab_add_error'));
      }
    };
    box.append(pick, el('div', {
      class: 'muted', style: 'font-size:13px;margin-top:8px;line-height:1.4',
      text: friends.length ? t('collab_only_friend')
                           : t('collab_need_friends'),
    }));
  }
  return box;
}

/* ---------------------------------------------------------------- медиа */
const STAGE_TEXT = {
  get converting() { return t('stage_heic'); },
  get transcoding() { return t('stage_video'); },
  get processing() { return t('stage_processing'); },
  get uploading() { return t('stage_uploading'); },
};

async function addFiles(files) {
  if (!files.length) return;
  const host = $('#mlist');
  for (const f of files) {
    const status = el('div', { class: 'muted', text: `${f.name} — ${t('queued')}` });
    const row = el('div', { class: 'mitem' },
      el('div', { class: 'skel', style: 'width:88px;height:66px;border-radius:10px' }),
      el('div', { class: 'grow' }, status));
    host.appendChild(row);
    busy++; refreshBusy();
    try {
      await ensureAlbum();
      const media = await uploadMedia(f, (stage, p) => {
        const pct = (stage === 'transcoding' && p) ? ` ${Math.round(p * 100)}%` : '';
        status.textContent = `${f.name} — ${STAGE_TEXT[stage] || stage}${pct}`;
      });
      const pos = items.length ? Math.max(...items.map(i => i.position)) + 1 : 0;
      const { data, error } = await sb.from('album_media')
        .insert({ album_id: albumId, media_id: media.id, position: pos })
        .select('id,chapter_id,position,caption').single();
      if (error) throw error;
      items.push({ ...data, media });
      if (!album.cover_media_id && media.kind === 'photo') {
        await sb.from('albums').update({ cover_media_id: media.id }).eq('id', albumId);
        album.cover_media_id = media.id;
      }
    } catch (err) {
      toast(err.message || `Failed: ${f.name}`);
    }
    busy--; refreshBusy();
    row.remove();
    drawMedia(host);
  }
}

/** Пока что-то конвертируется/грузится — альбом остаётся черновиком, публикация заблокирована. */
function refreshBusy() {
  const note = $('#busy-note');
  document.querySelectorAll('[data-needs-ready]').forEach(b => { b.disabled = busy > 0; });
  if (!note) return;
  note.textContent = busy > 0
    ? `В обработке: ${busy} — публикация станет доступна, когда закончится`
    : '';
  note.classList.toggle('hide', busy === 0);
}

/** Разово досоздаём отсутствующие постеры видео — по одному, чтобы не грузить сеть. */
let posterQueueRunning = false;
async function fillMissingPosters(host) {
  if (posterQueueRunning) return;
  const pending = items.filter(i => i.media?.kind === 'video' && !i.media.thumb_path);
  if (!pending.length) return;
  posterQueueRunning = true;
  for (const it of pending) {
    try {
      if (await backfillPoster(it.media)) drawMedia(host);
    } catch (_) { /* не критично: превью останется кадром из <video> */ }
  }
  posterQueueRunning = false;
}

async function drawMedia(host) {
  clear(host);
  fillMissingPosters(host);
  if (!items.length) {
    host.appendChild(el('div', { class: 'muted', style: 'padding:14px 2px', text: t('no_media') }));
    return;
  }
  items.sort((a, b) => a.position - b.position);
  const urls = await signUrls(items.map(i => i.media?.thumb_path || i.media?.storage_path));

  items.forEach((it, idx) => {
    const m = it.media || {};
    const src = urls[m.thumb_path] || urls[m.storage_path];
    const th = el('div', { class: 'mthumb', style: 'display:flex;align-items:center;justify-content:center;overflow:hidden' });
    if (m.kind === 'audio') {
      th.appendChild(el('div', { style: 'font-size:12px;font-weight:700;color:#8F8B84', text: dur(m.duration_seconds) || 'AUDIO' }));
    } else {
      const node = thumbEl(m.thumb_path || m.storage_path, src, m.thumb_path ? null : m.kind);
      if (node) { node.style.width = '100%'; node.style.height = '100%'; node.style.objectFit = 'cover'; th.appendChild(node); }
    }

    const chapSel = el('select', { class: 'mini', style: 'min-width:150px', onchange: async (e) => {
      const v = e.currentTarget.value || null;
      it.chapter_id = v;
      await sb.from('album_media').update({ chapter_id: v }).eq('id', it.id);
    } },
      el('option', { value: '' }, t('no_chapter_opt')),
      ...chapters.map(c => el('option', {
        value: c.id, selected: it.chapter_id === c.id ? 'selected' : null,
      }, c.label || c.title || t('chapters'))));

    const cap = el('input', {
      class: 'input', style: 'height:36px;padding:0 12px;font-size:14px;border-radius:10px',
      placeholder: m.kind === 'audio' ? t('voice_ph') : t('cap_ph'), maxlength: '500', value: it.caption || '',
      onchange: async (e) => {
        it.caption = e.currentTarget.value;
        await sb.from('album_media').update({ caption: it.caption }).eq('id', it.id);
      },
    });

    const row = el('div', { class: 'row' }, chapSel,
      el('button', { class: 'mini', onclick: () => move(idx, -1), disabled: idx === 0 ? 'disabled' : null }, '↑'),
      el('button', { class: 'mini', onclick: () => move(idx, 1), disabled: idx === items.length - 1 ? 'disabled' : null }, '↓'),
      m.kind === 'photo' ? el('button', {
        class: 'mini' + (album?.cover_media_id === m.id ? ' on' : ''),
        style: album?.cover_media_id === m.id ? 'border-color:var(--accent);color:var(--accent)' : null,
        onclick: async () => {
          await sb.from('albums').update({ cover_media_id: m.id }).eq('id', albumId);
          album.cover_media_id = m.id; drawMedia(host); toast(t('changes_saved'));
        },
      }, album?.cover_media_id === m.id ? t('cover_set') : t('set_cover')) : null,
      el('button', {
        class: 'mini',
        style: it.is_private ? 'border-color:var(--accent);color:var(--accent)' : null,
        title: t('private_hint'),
        onclick: async (e) => {
          const next = !it.is_private;
          const { error } = await sb.from('album_media').update({ is_private: next }).eq('id', it.id);
          if (error) { toast(error.message); return; }
          it.is_private = next;
          drawMedia(host);
          toast(next ? t('private_on') : t('private_off'));
        },
      }, it.is_private ? t('is_private') : t('make_private')),
      el('button', {
        class: 'mini danger', onclick: async () => {
          await sb.from('album_media').delete().eq('id', it.id);
          items = items.filter(x => x.id !== it.id);
          drawMedia(host);
        },
      }, t('remove')));

    host.appendChild(el('div', { class: 'mitem' }, th, el('div', { class: 'grow' }, cap, row)));
  });

  async function move(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const a = items[idx], b = items[j];
    const pa = a.position, pb = b.position;
    a.position = pb; b.position = pa;
    await Promise.all([
      sb.from('album_media').update({ position: a.position }).eq('id', a.id),
      sb.from('album_media').update({ position: b.position }).eq('id', b.id),
    ]);
    drawMedia(host);
  }
}

/* ---------------------------------------------------------------- главы */
async function addChapter() {
  await ensureAlbum();
  const pos = chapters.length ? Math.max(...chapters.map(c => c.position)) + 1 : 0;
  const { data, error } = await sb.from('album_chapters')
    .insert({ album_id: albumId, position: pos, label: `DAY ${pos + 1}`, title: '' })
    .select().single();
  if (error) { toast(error.message); return; }
  chapters.push(data);
  drawChapters($('#clist'));
  drawMedia($('#mlist'));
}

function drawChapters(host) {
  clear(host);
  if (!chapters.length) {
    host.appendChild(el('div', { class: 'muted', style: 'padding:4px 2px', text: t('no_chapters') }));
    return;
  }
  chapters.sort((a, b) => a.position - b.position);
  chapters.forEach(c => {
    const save = async (patch) => { Object.assign(c, patch); await sb.from('album_chapters').update(patch).eq('id', c.id); };
    host.appendChild(el('div', { class: 'chapter-edit' },
      el('div', { class: 'row', style: 'display:flex;gap:10px;margin-bottom:10px' },
        el('input', {
          class: 'input', style: 'height:40px;max-width:180px;font-size:14px', placeholder: t('chapter_label_ph'),
          maxlength: '40', value: c.label || '', onchange: (e) => save({ label: e.currentTarget.value }),
        }),
        el('input', {
          class: 'input', style: 'height:40px;font-size:15px', placeholder: t('chapter_title_ph'), maxlength: '120',
          value: c.title || '', onchange: (e) => save({ title: e.currentTarget.value }),
        }),
        el('button', {
          class: 'mini danger', onclick: async () => {
            await sb.from('album_chapters').delete().eq('id', c.id);
            chapters = chapters.filter(x => x.id !== c.id);
            items.forEach(i => { if (i.chapter_id === c.id) i.chapter_id = null; });
            drawChapters(host); drawMedia($('#mlist'));
          },
        }, t('delete'))),
      el('textarea', {
        class: 'textarea', style: 'min-height:70px;font-size:15px', placeholder: t('chapter_body_ph'),
        maxlength: '4000', onchange: (e) => save({ body: e.currentTarget.value }),
      }, c.body || '')));
  });
}

/* ---------------------------------------------------------------- видимость */
function visibilityBox() {
  const box = el('div', { class: 'side-card' }, el('div', { class: 'label', text: t('who_can_see') }));
  const initial = album
    ? (album.visibility === 'friends' && excluded.size ? 'friends_except' : album.visibility)
    : 'private';

  const exceptBox = el('div', {
    style: 'margin-top:10px;padding-left:6px;max-height:220px;overflow:auto',
    class: initial === 'friends_except' ? '' : 'hide',
  });
  const drawExcept = () => {
    clear(exceptBox);
    if (!friends.length) {
      exceptBox.appendChild(el('div', { class: 'muted', style: 'font-size:14px', text: t('no_friends_yet') }));
      return;
    }
    exceptBox.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px;margin-bottom:8px', text: t('except_hint') }));
    friends.forEach(f => {
      const cb = el('input', {
        type: 'checkbox', checked: excluded.has(f.username) ? 'checked' : null,
        onchange: (e) => { e.currentTarget.checked ? excluded.add(f.username) : excluded.delete(f.username); },
      });
      exceptBox.appendChild(el('label', { style: 'display:flex;gap:10px;align-items:center;padding:5px 0;font-size:15px' },
        cb, f.name || f.username));
    });
  };
  drawExcept();

  const opts = [
    ['public', t('vis_public'), t('vis_public_d')],
    ['friends', t('vis_friends'), t('vis_friends_d')],
    ['friends_except', t('vis_except'), t('vis_except_d')],
    ['private', t('vis_private'), t('vis_private_d')],
  ];
  const wrap = el('div', { class: 'vis-opts', style: 'margin-top:10px' });
  opts.forEach(([val, title, sub]) => {
    const input = el('input', {
      type: 'radio', name: 'vis', value: val, checked: initial === val ? 'checked' : null,
      onchange: () => {
        wrap.querySelectorAll('.vis-opt').forEach(n => n.classList.toggle('on', n.contains(input) && input.checked));
        exceptBox.classList.toggle('hide', val !== 'friends_except');
      },
    });
    wrap.appendChild(el('label', { class: 'vis-opt' + (initial === val ? ' on' : '') },
      input, el('div', {}, el('b', { text: title }), el('span', { text: sub }))));
  });

  box.append(wrap, exceptBox);
  return box;
}

/* ---------------------------------------------------------------- действия */
function actionsBox() {
  const box = el('div', { class: 'side-card', style: 'margin-top:18px' });
  const status = el('div', { class: 'muted', style: 'font-size:14px;margin-bottom:12px' });
  const setStatus = () => {
    status.textContent = !albumId ? t('not_saved')
      : album?.published_at ? t('status_published') : t('status_draft');
  };
  setStatus();

  const publishBtn = el('button', { class: 'btn btn-primary', style: 'width:100%', 'data-needs-ready': '1' },
    !isOwner || album?.published_at ? t('save_changes') : t('publish'));
  const draftBtn = el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px' }, t('save_draft'));
  const busyNote = el('div', {
    id: 'busy-note', class: 'muted hide',
    style: 'font-size:13.5px;margin-top:10px;line-height:1.4',
  });

  publishBtn.onclick = () => save(isOwner, publishBtn);   // соавтор публиковать не может
  draftBtn.onclick = () => save(false, draftBtn);

  box.append(status, publishBtn, draftBtn, busyNote);

  if (albumId && isOwner) {
    if (album?.published_at) {
      box.appendChild(el('button', {
        class: 'mini', style: 'width:100%;margin-top:10px;height:40px',
        onclick: async () => {
          await sb.from('albums').update({ published_at: null }).eq('id', albumId);
          album.published_at = null; setStatus(); toast(t('moved_to_drafts'));
        },
      }, t('unpublish')));
    }
    box.appendChild(el('button', {
      class: 'mini danger', style: 'width:100%;margin-top:10px;height:40px',
      onclick: async () => {
        if (!confirm(t('delete_album_confirm'))) return;
        const { error } = await sb.from('albums').delete().eq('id', albumId);
        if (error) { toast(error.message); return; }
        location.href = 'index.html';
      },
    }, t('delete_album')));
  }
  return box;
}

async function save(publish, btn) {
  if (saving) return;
  if (publish && busy > 0) { toast(t('wait_processing')); return; }
  const title = ($('#f-title').value || '').trim();
  if (!title) { toast(t('need_title')); $('#f-title').focus(); return; }
  saving = true;
  const label = btn.textContent;
  clear(btn).appendChild(el('span', { class: 'spinner' }));

  try {
    await ensureAlbum();
    const vis = currentVisibility();
    const patch = {
      title,
      description: ($('#f-desc').value || '').trim() || null,
      category: $('#f-cat').value || null,
    };
    // видимость и публикацию трогает только владелец — иначе сработает защита в БД
    if (isOwner) {
      patch.visibility = vis.base;
      if (publish && !album.published_at) patch.published_at = new Date().toISOString();
    }
    const { error } = await sb.from('albums').update(patch).eq('id', albumId);
    if (error) throw error;
    Object.assign(album, patch);

    if (!isOwner) { toast(t('changes_saved')); return; }

    // исключения актуальны только для friends + «кроме»
    await sb.from('album_exceptions').delete().eq('album_id', albumId);
    if (vis.base === 'friends' && vis.except && excluded.size) {
      const names = [...excluded];
      const { data: profs } = await sb.from('profiles').select('id,username').in('username', names);
      const rows = (profs || []).map(p => ({ album_id: albumId, user_id: p.id }));
      if (rows.length) await sb.from('album_exceptions').insert(rows);
    }

    toast(publish ? t('album_published') : t('draft_saved'));
    if (publish) { location.href = `album.html?id=${albumId}`; return; }
  } catch (err) {
    toast(err.message || t('save_error'));
  } finally {
    saving = false;
    clear(btn).appendChild(document.createTextNode(label));
  }
}
