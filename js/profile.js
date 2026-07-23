// Профиль: шапка, дружба, редактирование своего профиля, сетка альбомов.
import { sb, currentProfile, isAuthed, signOut } from './sb.js';
import { CATEGORIES } from './config.js';
import {
  el, $, clear, mountShell, signUrls, albumCard, avatarImg, fmtCount, icon,
  toast, needAuth, emptyState, modal, skeletonGrid, composition, t, catLabel, moreButton,
} from './ui.js';
import { uploadAvatar } from './upload.js';
import { trackButton } from './stats.js';

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
      el('a', { class: 'btn btn-ghost btn-sm', href: 'stats.html' }, t('st_title')),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: editButtons }, t('pb_title')),
      el('a', { class: 'btn btn-ghost btn-sm', href: 'friends.html' }, t('nav_friends')),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => signOut() }, t('sign_out')));
    mountEventEntry(actions);
  } else {
    actions.append(friendButton(), followButton(), moreButton('profile', p.id, p.username));
  }

  app.appendChild(el('div', { class: 'prof-head' },
    avatarImg(p.avatar, p.name, 132),
    el('div', { style: 'min-width:0;flex:1' },
      el('div', { class: 'prof-row' }, el('h1', { text: p.name || p.username }), actions),
      el('div', { class: 'prof-handle', text: `@${p.username} · ${p.location ? p.location + ' · ' : ''}${t('joined', { year: new Date(p.created_at).getFullYear() })}` }),
      p.bio ? el('div', { class: 'prof-bio', text: p.bio }) : null,
      el('div', { class: 'prof-stats' },
        el('div', {}, el('b', { text: fmtCount(data.albums_count) }), ' ', el('span', { text: t('stat_albums') })),
        el('div', {}, el('b', { text: fmtCount(data.friends_count) }), ' ', el('span', { text: t('stat_friends') })),
        el('div', {}, el('b', { text: fmtCount(data.followers_count) }), ' ', el('span', { text: t('stat_followers') })),
        el('div', {}, el('b', { text: fmtCount(data.following_count) }), ' ', el('span', { text: t('stat_following') }))))));

  /* ---- кнопки-ссылки (тариф Pro) ---- */
  const btnRow = el('div', { class: 'rowx', style: 'margin-top:14px' });
  app.appendChild(btnRow);
  renderButtons(btnRow);

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
  // Статусы проверки нужны только на своём профиле: чужие альбомы, не прошедшие
  // модерацию, сюда и не приходят.
  let status = {};
  if (data.is_me) {
    const { data: st } = await sb.rpc('my_album_status');
    status = st || {};
  }
  const statusOf = (a) => status[a.id]?.status || 'approved';
  const isLive = (a) => !!a.published_at && statusOf(a) === 'approved';

  const chips = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' });
  const grid = el('div', { class: 'grid' });
  const draftHead = el('div', { class: 'section-head' },
    el('h2', { text: t('drafts_title') }),
    el('span', { class: 'muted', style: 'font-size:14.5px', text: t('drafts_hint') }));
  const draftGrid = el('div', { class: 'grid' });

  const makeCard = (a) => {
    const card = albumCard({
      ...a, cover_path: a.cover_path, thumb1_path: a.thumb1, thumb2_path: a.thumb2,
    }, urls, { hideAuthor: true });
    if (!data.is_me) return card;

    const s = statusOf(a);
    const mark = !a.published_at ? [t('draft'), '#8F8B84']
      : s === 'pending' ? [t('review_pending'), '#E8552B']
      : s === 'rejected' ? [t('review_rejected'), '#c0392b'] : null;
    if (mark) {
      card.insertBefore(el('div', {
        style: `display:inline-block;margin-bottom:6px;padding:3px 10px;border-radius:99px;font-size:12.5px;
                font-weight:700;color:#fff;background:${mark[1]}`,
        text: mark[0],
      }), card.firstChild);
      if (s === 'rejected' && status[a.id]?.note) {
        card.appendChild(el('div', { class: 'muted', style: 'font-size:13px;margin-top:6px', text: status[a.id].note }));
      }
    }

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
    return card;
  };

  const draw = () => {
    clear(chips);
    const used = [...new Set(albums.map(a => a.category).filter(Boolean))];
    [null, ...used].forEach(c => chips.appendChild(el('button', {
      class: 'chip btn-sm' + (category === c ? ' on' : ''),
      style: 'height:44px;padding:0 21px;font-size:15.5px',
      onclick: () => { category = c; draw(); },
    }, catLabel(c))));

    clear(grid); clear(draftGrid);
    const list = albums.filter(a => !category || a.category === category);
    const live = data.is_me ? list.filter(isLive) : list;
    const drafts = data.is_me ? list.filter(a => !isLive(a)) : [];

    if (!live.length && !drafts.length) {
      grid.appendChild(emptyState(data.is_me ? t('no_albums_title') : t('nothing_to_show'),
        data.is_me ? t('no_albums_text') : t('no_visible_albums'),
        data.is_me ? el('a', { class: 'btn btn-primary', href: 'editor.html' }, t('new_album_title')) : null));
    } else {
      live.forEach(a => grid.appendChild(makeCard(a)));
      drafts.forEach(a => draftGrid.appendChild(makeCard(a)));
    }
    draftHead.style.display = drafts.length ? '' : 'none';
    draftGrid.style.display = drafts.length ? '' : 'none';
  };
  draw();

  app.append(el('div', { class: 'section-head' }, el('h2', { text: t('all_albums') }), chips), grid,
    draftHead, draftGrid);

  if (data.is_me) renderShared(app);
}

/* ---------------- кнопки-ссылки ---------------- */

/**
 * Кнопки владельца профиля: прямые ссылки на его ресурсы. Возвращаются сервером
 * только для тарифа Pro. Переход считается статистикой: запрос уходит из живой
 * страницы, а сама ссылка открывается в новой вкладке — поэтому событие успевает
 * записаться и всплывающие окна не блокируются.
 */
async function renderButtons(host) {
  const { data: list, error } = await sb.rpc('profile_buttons_get', { p_username: username });
  if (error || !Array.isArray(list) || !list.length) return;
  list.forEach(b => host.appendChild(el('a', {
    class: 'btn btn-ghost btn-sm', href: b.url, target: '_blank', rel: 'noopener noreferrer nofollow',
    onclick: () => trackButton(b.id),
  }, icon('link', 16, { sw: 2 }), b.label)));
}

/** Редактор кнопок. Не Pro — показываем, что это даёт, и ведём на тариф. */
function editButtons() {
  modal(async (box, close) => {
    box.appendChild(el('h2', { text: t('pb_title') }));
    const { data: st } = await sb.rpc('my_settings');
    if (!st || st.plan !== 'pro') {
      box.append(
        el('p', { class: 'muted', text: t('pb_pro_only') }),
        el('a', { class: 'btn btn-primary', style: 'width:100%;margin-top:8px', href: 'pricing.html' }, t('st_see_pro')),
        el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
      return;
    }

    const { data: cur } = await sb.rpc('profile_buttons_get', { p_username: username });
    const rows = el('div', { class: 'stack' });
    const addRow = (b = {}) => {
      if (rows.children.length >= 6) return;
      const label = el('input', { class: 'input', maxlength: '40', placeholder: t('pb_label'), value: b.label || '' });
      const url = el('input', { class: 'input', maxlength: '500', placeholder: 'https://', value: b.url || '' });
      const row = el('div', { class: 'stack', style: 'gap:8px;border-bottom:1px solid #F0EEE9;padding-bottom:12px' },
        label, url,
        el('button', { class: 'mini danger', style: 'align-self:flex-start', onclick: () => row.remove() }, t('remove')));
      row._get = () => ({ label: label.value.trim(), url: url.value.trim() });
      rows.appendChild(row);
    };
    (Array.isArray(cur) ? cur : []).forEach(addRow);
    if (!rows.children.length) addRow();

    const save = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:8px' }, t('save'));
    save.onclick = async () => {
      save.disabled = true;
      const items = [...rows.children].map(r => r._get()).filter(x => x.label && x.url);
      const { error } = await sb.rpc('profile_buttons_set', { p_items: items });
      if (error) { toast(error.message); save.disabled = false; return; }
      close(); location.reload();
    };

    box.append(
      el('p', { class: 'muted', style: 'margin-top:0', text: t('pb_hint') }),
      rows,
      el('button', { class: 'mini', style: 'margin-top:10px', onclick: () => addRow() }, t('pb_add')),
      save,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
  });
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

/* ---------------- подписка ---------------- */
/**
 * Подписка отдельно от дружбы: односторонняя, влияет только на ленту.
 * Доступ к контенту «для друзей» она НЕ даёт — это разные вещи, и подпись
 * под кнопкой об этом говорит прямо, чтобы человек не путался.
 */
function followButton() {
  let on = !!data.is_following;
  const btn = el('button', { class: 'btn btn-sm' });
  const paint = () => {
    clear(btn);
    btn.className = on ? 'btn btn-ghost btn-sm' : 'btn btn-ghost btn-sm';
    btn.title = t('follow_hint');
    btn.appendChild(document.createTextNode(on ? t('following') : t('follow')));
  };
  btn.onclick = async () => {
    if (!needAuth(t('signin_to_friend'))) return;
    btn.disabled = true;
    const rpc = on ? 'unfollow_user' : 'follow_user';
    const { error } = await sb.rpc(rpc, { p_username: username });
    btn.disabled = false;
    if (error) { toast(error.message || t('update_error')); return; }
    on = !on; paint();
  };
  paint();
  return btn;
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

/* ---------------- вход в общий альбом события ---------------- */
/**
 * Кнопка появляется только у тех, кому событие уже выдано (после оплаты) или
 * кто его уже проводил. Остальным её показывать незачем — на витрине цен и так
 * рассказано, что это. Проверка асинхронная: профиль не должен её ждать.
 */
async function mountEventEntry(actions) {
  const [{ data: credits }, { data: mine }] = await Promise.all([
    sb.rpc('my_event_credits'),
    sb.rpc('my_event_albums'),
  ]);
  const n = Number(credits) || 0;
  const has = (mine || []).length > 0;
  if (!n && !has) return;

  const label = n > 0 ? t('ev_cta_create') : t('ev_cta_manage');
  const btn = el('a', { class: 'btn btn-primary btn-sm', href: 'event.html' }, label);
  if (n > 0) btn.appendChild(el('span', { class: 'ev-badge', text: String(n) }));
  actions.insertBefore(btn, actions.firstChild);
}

/* ---------------- редактирование профиля ---------------- */
function editProfile() {
  const p = data.profile;
  modal(async (box, close) => {
    box.appendChild(el('h2', { text: t('edit_profile') }));
    const name = el('input', { class: 'input', maxlength: '60', value: p.name || '' });
    const bio = el('textarea', { class: 'textarea', maxlength: '300' }, p.bio || '');
    const loc = el('input', { class: 'input', maxlength: '80', value: p.location || '' });

    // Год рождения и пол — необязательные, только для обезличенной статистики
    // авторов. Google при обычном входе этих данных не отдаёт.
    const { data: st } = await sb.rpc('my_settings');
    const year = el('input', {
      class: 'input', type: 'number', min: '1900', max: '2018', placeholder: '1990',
      value: st?.birth_year || '',
    });
    const gender = el('select', { class: 'select' },
      ...[['', t('st_unknown')], ['female', t('st_female')], ['male', t('st_male')], ['other', t('st_other')]]
        .map(([v, label]) => el('option', { value: v, selected: (st?.gender || '') === v ? 'selected' : null }, label)));

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
      await sb.rpc('profile_set_demographics', {
        p_birth_year: parseInt(year.value, 10) || null,
        p_gender: gender.value || null,
      });
      close(); location.reload();
    };

    box.append(
      el('div', { class: 'rowx', style: 'margin-bottom:18px' }, avaPreview, avaInput,
        el('button', { class: 'mini', onclick: () => avaInput.click() }, t('change_photo'))),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_name') }), name),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_bio') }), bio),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_location') }), loc),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_birth_year') }), year),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('f_gender') }), gender),
      el('div', { class: 'muted', style: 'font-size:13px;margin:-6px 0 14px', text: t('f_demo_hint') }),
      save,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
  });
}
