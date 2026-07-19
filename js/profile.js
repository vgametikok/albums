// Профиль: шапка, дружба, редактирование своего профиля, сетка альбомов.
import { sb, currentProfile, isAuthed, signOut } from './sb.js';
import { CATEGORIES } from './config.js';
import {
  el, $, clear, mountShell, signUrls, albumCard, avatarImg, fmtCount, icon,
  toast, needAuth, emptyState, modal, skeletonGrid, composition,
} from './ui.js';
import { uploadAvatar } from './upload.js';

const app = $('#app');
let username = new URLSearchParams(location.search).get('u');
let data = null, category = null;

(async function main() {
  await mountShell('profile');
  if (!username) {
    const me = currentProfile();
    if (!me) { app.appendChild(emptyState('No profile', 'Open a profile from the feed, or sign in.')); return; }
    username = me.username;
    history.replaceState(null, '', `profile.html?u=${encodeURIComponent(username)}`);
  }
  app.appendChild(skeletonGrid(4));
  const res = await sb.rpc('get_profile', { p_username: username });
  clear(app);
  if (res.error || !res.data?.profile) {
    app.appendChild(emptyState('Profile not found', `No user @${username}.`));
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
      el('button', { class: 'btn btn-ghost btn-sm', onclick: editProfile }, 'Edit profile'),
      el('a', { class: 'btn btn-ghost btn-sm', href: 'friends.html' }, 'Friends'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => signOut() }, 'Sign out'));
  } else {
    actions.appendChild(friendButton());
  }

  app.appendChild(el('div', { class: 'prof-head' },
    avatarImg(p.avatar, p.name, 132),
    el('div', { style: 'min-width:0;flex:1' },
      el('div', { class: 'prof-row' }, el('h1', { text: p.name || p.username }), actions),
      el('div', { class: 'prof-handle', text: `@${p.username} · ${p.location ? p.location + ' · ' : ''}Joined ${new Date(p.created_at).getFullYear()}` }),
      p.bio ? el('div', { class: 'prof-bio', text: p.bio }) : null,
      el('div', { class: 'prof-stats' },
        el('div', {}, el('b', { text: fmtCount(data.albums_count) }), ' ', el('span', { text: 'Albums' })),
        el('div', {}, el('b', { text: fmtCount(data.friends_count) }), ' ', el('span', { text: 'Friends' }))))));

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
        el('div', { style: 'font-size:18px;font-weight:700;margin-top:15px', text: 'Watch' }))));
    app.append(
      el('div', { style: 'margin-top:32px' },
        el('div', { class: 'kicker kicker-muted', style: 'display:flex;align-items:center;gap:8px;margin-bottom:14px' },
          icon('pin', 14, { stroke: '#9B978F', sw: 2 }), 'PINNED ALBUM'),
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
    }, c || 'All')));

    clear(grid);
    const list = albums.filter(a => !category || a.category === category);
    if (!list.length) {
      grid.appendChild(emptyState(data.is_me ? 'No albums yet' : 'Nothing to show',
        data.is_me ? 'Create your first album — it can stay private.' : 'This user has no albums visible to you.',
        data.is_me ? el('a', { class: 'btn btn-primary', href: 'editor.html' }, 'New album') : null));
      return;
    }
    list.forEach(a => {
      const card = albumCard({
        ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
      }, urls, { hideAuthor: true });
      if (data.is_me) {
        card.appendChild(el('div', { style: 'margin-top:8px;display:flex;gap:8px' },
          el('a', { class: 'mini', href: `editor.html?id=${a.id}`, style: 'display:inline-flex;align-items:center' }, 'Edit'),
          el('button', {
            class: 'mini', onclick: async () => {
              const next = !a.is_pinned;
              await sb.from('albums').update({ is_pinned: false }).eq('author_id', data.profile.id);
              if (next) await sb.from('albums').update({ is_pinned: true }).eq('id', a.id);
              location.reload();
            },
          }, a.is_pinned ? 'Unpin' : 'Pin')));
      }
      grid.appendChild(card);
    });
  };
  draw();

  app.append(el('div', { class: 'section-head' }, el('h2', { text: 'All albums' }), chips), grid);
}

/* ---------------- дружба ---------------- */
function friendButton() {
  const state = { v: data.friend_state };
  const btn = el('button', { class: 'btn btn-sm' });
  const paint = () => {
    clear(btn);
    const map = {
      none: ['Add friend', 'btn btn-primary btn-sm'],
      sent: ['Request sent', 'btn btn-ghost btn-sm'],
      incoming: ['Accept request', 'btn btn-primary btn-sm'],
      friends: ['Friends ✓', 'btn btn-ghost btn-sm'],
      anon: ['Add friend', 'btn btn-primary btn-sm'],
      self: ['', 'hide'],
    };
    const [label, cls] = map[state.v] || map.none;
    btn.className = cls;
    btn.appendChild(document.createTextNode(label));
  };
  btn.onclick = async () => {
    if (!needAuth('Sign in to add friends')) return;
    btn.disabled = true;
    try {
      let r;
      if (state.v === 'incoming') r = await sb.rpc('friend_respond', { p_username: username, p_accept: true });
      else if (state.v === 'friends' || state.v === 'sent') {
        if (!confirm(state.v === 'friends' ? 'Remove from friends?' : 'Cancel the request?')) { btn.disabled = false; return; }
        r = await sb.rpc('friend_remove', { p_username: username });
      } else r = await sb.rpc('friend_request', { p_username: username });
      if (r.error) throw r.error;
      state.v = r.data?.state || 'none';
      paint();
      toast(state.v === 'friends' ? 'You are friends now' : state.v === 'sent' ? 'Request sent' : 'Updated');
    } catch (e) {
      toast(e.message || 'Could not update');
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
    box.appendChild(el('h2', { text: 'Edit profile' }));
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
        catch (err) { toast(err.message || 'Upload failed'); }
      },
    });

    const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:8px' }, 'Save');
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
        el('button', { class: 'mini', onclick: () => avaInput.click() }, 'Change photo')),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: 'Name' }), name),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: 'Bio' }), bio),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: 'Location' }), loc),
      save,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, 'Cancel'));
  });
}
