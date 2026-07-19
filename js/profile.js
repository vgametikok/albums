// Профиль: шапка, дружба, редактирование своего профиля, сетка альбомов.
import { sb, currentProfile, isAuthed, signOut } from './sb.js';
import { CATEGORIES } from './config.js';
import {
  el, $, clear, mountShell, signUrls, albumCard, avatarImg, fmtCount, icon,
  toast, needAuth, emptyState, modal, skeletonGrid, composition, t, catLabel,
} from './ui.js';
import { uploadAvatar } from './upload.js';

const app = $('#app');
let username = new URLSearchParams(location.search).get('u');
let data = null, category = null;

(async function main() {
  await mountShell('profile');
  if (!username) {
    const me = currentProfile();
    if (!me) { app.appendChild(emptyState(t('no_profile'), t('no_profile_text'))); return; }
    username = me.username;
    history.replaceState(null, '', `profile.html?u=${encodeURIComponent(username)}`);
  }
  app.appendChild(skeletonGrid(4));
  const res = await sb.rpc('get_profile', { p_username: username });
  clear(app);
  if (res.error || !res.data?.profile) {
    app.appendChild(emptyState(t('profile_not_found'), t('profile_not_found_text', { u: username })));
    return;
  }
  data = res.data;
  render();
})();

async function render() {
  const p = data.profile;
  document.title = `${p.name || p.username} — Albums`;
  clear(app);

  /* ---- шапка ---- */
  const actions = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  if (data.is_me) {
    actions.append(
      el('button', { class: 'btn btn-ghost btn-sm', onclick: editProfile }, t('edit_profile')),
      el('a', { class: 'btn btn-ghost btn-sm', href: 'friends.html' }, t('nav_friends')),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => signOut() }, t('sign_out')));
  } else {
    actions.appendChild(friendButton());
  }

  app.appendChild(el('div', { class: 'prof-head' },
    avatarImg(p.avatar, p.name, 132),
    el('div', { style: 'min-width:0;flex:1' },
      el('div', { class: 'prof-row' }, el('h1', { text: p.name || p.username }), actions),
      el('div', { class: 'prof-handle', text: `@${p.username} · ${p.location ? p.location + ' · ' : ''}${t('joined', { year: new Date(p.created_at).getFullYear() })}` }),
      p.bio ? el('div', { class: 'prof-bio', text: p.bio }) : null,
      el('div', { class: 'prof-stats' },
        el('div', {}, el('b', { text: fmtCount(data.albums_count) }), ' ', el('span', { text: t('stat_albums') })),
        el('div', {}, el('b', { text: fmtCount(data.friends_count) }), ' ', el('span', { text: t('stat_friends') }))))));

  /* ---- закреплённый ---- */
  const albums = data.albums || [];
  const pinned = albums.find(a => a.is_pinned && a.published_at);
  const paths = albums.flatMap(a => [a.cover_path, a.thumb1, a.thumb2]);
  const urls = await signUrls(paths);

  if (pinned) {
    const cover = urls[pinned.cover_path] || urls[pinned.thumb1];
    const hero = el('a', { class: 'album-hero', style: 'display:block;height:340px', href: `album.html?id=${pinned.id}` });
    if (cover) hero.appendChild(el('img', { src: cover, alt: pinned.title }));
    hero.appendChild(el('div', { class: 'hero-card' },
      el('div', { class: 'hero-inner' },
        el('div', { class: 'hero-title', text: pinned.title }),
        el('div', { class: 'pill', text: composition(pinned) }),
        el('div', { style: 'font-size:18px;font-weight:700;margin-top:15px', text: t('watch') }))));
    app.append(
      el('div', { style: 'margin-top:32px' },
        el('div', { class: 'kicker kicker-muted', style: 'display:flex;align-items:center;gap:8px;margin-bottom:14px' },
          icon('pin', 14, { stroke: '#9B978F', sw: 2 }), t('pinned_album')),
        hero));
  }

  /* ---- сетка ---- */
  const chips = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' });
  const grid = el('div', { class: 'grid' });
  const draw = () => {
    clear(chips);
    const used = [...new Set(albums.map(a => a.category).filter(Boolean))];
    [null, ...used].forEach(c => chips.appendChild(el('button', {
      class: 'chip btn-sm' + (category === c ? ' on' : ''),
      style: 'height:44px;padding:0 21px;font-size:15.5px',
      onclick: () => { category = c; draw(); },
    }, catLabel(c))));

    clear(grid);
    const list = albums.filter(a => !category || a.category === category);
    if (!list.length) {
      grid.appendChild(emptyState(data.is_me ? t('no_albums_title') : t('nothing_to_show'),
        data.is_me ? t('no_albums_text') : t('no_visible_albums'),
        data.is_me ? el('a', { class: 'btn btn-primary', href: 'editor.html' }, t('new_album_title')) : null));
      return;
    }
    list.forEach(a => {
      const card = albumCard({
        ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
      }, urls, { hideAuthor: true });
      if (data.is_me) {
        card.appendChild(el('div', { style: 'margin-top:8px;display:flex;gap:8px' },
          el('a', { class: 'mini', href: `editor.html?id=${a.id}`, style: 'display:inline-flex;align-items:center' }, t('edit')),
          el('button', {
            class: 'mini', onclick: async () => {
              const next = !a.is_pinned;
              await sb.from('albums').update({ is_pinned: false }).eq('author_id', data.profile.id);
              if (next) await sb.from('albums').update({ is_pinned: true }).eq('id', a.id);
              location.reload();
            },
          }, a.is_pinned ? t('unpin') : t('pin'))));
      }
      grid.appendChild(card);
    });
  };
  draw();

  app.append(el('div', { class: 'section-head' }, el('h2', { text: t('all_albums') }), chips), grid);

  if (data.is_me) renderShared(app);
}

/* ---------------- совместные альбомы (где я соавтор) ---------------- */
async function renderShared(host) {
  const { data, error } = await sb.rpc('my_shared_albums');
  const list = error ? [] : (data || []);
  if (!list.length) return;

  const urls = await signUrls(list.flatMap(a => [a.cover_path, a.thumb1, a.thumb2]));
  const grid = el('div', { class: 'grid' });
  list.forEach(a => {
    const card = albumCard({
      ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
    }, urls, { hideAuthor: true });
    card.appendChild(el('div', { style: 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      el('span', { class: 'card-stat', text: t('owner_label', { name: a.owner_name || a.owner_username }) }),
      el('a', { class: 'mini', href: `editor.html?id=${a.id}`, style: 'display:inline-flex;align-items:center' }, t('edit'))));
    grid.appendChild(card);
  });

  host.append(
    el('div', { class: 'section-head' },
      el('h2', { text: t('shared_albums') }),
      el('span', { class: 'muted', style: 'font-size:14.5px', text: t('you_are_collaborator') })),
    grid);
}

/* ---------------- дружба ---------------- */
function friendButton() {
  const state = { v: data.friend_state };
  const btn = el('button', { class: 'btn btn-sm' });
  const paint = () => {
    clear(btn);
    const map = {
      none: [t('add_friend'), 'btn btn-primary btn-sm'],
      sent: [t('request_sent'), 'btn btn-ghost btn-sm'],
      incoming: [t('accept_request'), 'btn btn-primary btn-sm'],
      friends: [t('friends_yes'), 'btn btn-ghost btn-sm'],
      anon: [t('add_friend'), 'btn btn-primary btn-sm'],
      self: ['', 'hide'],
    };
    const [label, cls] = map[state.v] || map.none;
    btn.className = cls;
    btn.appendChild(document.createTextNode(label));
  };
  btn.onclick = async () => {
    if (!needAuth(t('signin_to_friend'))) return;
    btn.disabled = true;
    try {
      let r;
      if (state.v === 'incoming') r = await sb.rpc('friend_respond', { p_username: username, p_accept: true });
      else if (state.v === 'friends' || state.v === 'sent') {
        if (!confirm(state.v === 'friends' ? t('remove_friend_confirm') : t('cancel_request_confirm'))) { btn.disabled = false; return; }
        r = await sb.rpc('friend_remove', { p_username: username });
      } else r = await sb.rpc('friend_request', { p_username: username });
      if (r.error) throw r.error;
      state.v = r.data?.state || 'none';
      paint();
      toast(state.v === 'friends' ? t('now_friends') : state.v === 'sent' ? t('request_sent') : t('updated'));
    } catch (e) {
      toast(e.message || t('update_error'));
    }
    btn.disabled = false;
  };
  paint();
  return btn;
}

/* ---------------- редактирование профиля ---------------- */
function editProfile() {
  const p = data.profile;
  modal((box, close) => {
    box.appendChild(el('h2', { text: t('edit_profile') }));
    const name = el('input', { class: 'input', maxlength: '60', value: p.name || '' });
    const bio = el('textarea', { class: 'textarea', maxlength: '300' }, p.bio || '');
    const loc = el('input', { class: 'input', maxlength: '80', value: p.location || '' });

    const avaPreview = avatarImg(p.avatar, p.name, 72);
    let newAvatar = null;
    const avaInput = el('input', {
      type: 'file', accept: 'image/*', class: 'hide',
      onchange: async (e) => {
        const f = e.currentTarget.files[0]; if (!f) return;
        try { newAvatar = await uploadAvatar(f, 'avatar'); avaPreview.src = newAvatar; }
        catch (err) { toast(err.message || t('upload_failed')); }
      },
    });

    const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:8px' }, t('save'));
    save.onclick = async () => {
      save.disabled = true;
      const patch = {
        display_name: name.value.trim() || null,
        bio: bio.value.trim() || null,
        location: loc.value.trim() || null,
      };
      if (newAvatar) patch.avatar_url = newAvatar;
      const { error } = await sb.from('profiles').update(patch).eq('id', p.id);
      if (error) { toast(error.message); save.disabled = false; return; }
      close(); location.reload();
    };

    box.append(
      el('div', { class: 'rowx', style: 'margin-bottom:18px' }, avaPreview, avaInput,
        el('button', { class: 'mini', onclick: () => avaInput.click() }, t('change_photo'))),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_name') }), name),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_bio') }), bio),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_location') }), loc),
      save,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
  });
}
