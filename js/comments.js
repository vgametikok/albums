// Блок комментариев (общий для альбомов и постов): ветки в один уровень.
// Лайки (059): счётчик и флаг «лайкнул автор» лежат в самой строке comments,
// свои лайки — в comment_likes. opts.creator = { name, avatar } — автор альбома
// или поста: его аватар с сердечком рисуется у лайкнутого им комментария.
import { sb, currentUser, currentProfile } from './sb.js';
import { el, clear, avatarImg, timeAgo, toast, needAuth, icon, t, fmtCount } from './ui.js';

const C_COLS = 'id,body,created_at,parent_id,author_id,author:profiles!comments_author_id_fkey(username,display_name,avatar_url,plan)';

export function mountComments(host, subjectType, subjectId, opts = {}) {
  const list = el('div', {});
  let mine = new Set();      // id комментариев, которые лайкнул я
  const box = el('section', { class: 'comments' },
    el('h3', { text: t('comments_title') }), buildForm(), list);
  clear(host).appendChild(box);
  load();

  function buildForm(parentId = null, onDone = null) {
    const me = currentProfile();
    const ta = el('textarea', {
      placeholder: parentId ? t('reply_ph') : t('comment_ph'), maxlength: '2000',
      oninput: (e) => { e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; },
    });
    const send = el('button', { class: 'btn btn-primary btn-sm', onclick: submit }, parentId ? t('reply_btn') : t('post_btn'));
    const form = el('div', { class: 'cform' },
      avatarImg(me?.avatar_url, me?.display_name, 44), ta,
      el('div', { class: 'stack' }, send,
        parentId ? el('button', { class: 'mini', onclick: () => onDone && onDone() }, t('cancel')) : null));

    async function submit() {
      if (!needAuth(t('signin_to_comment'))) return;
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      const { error } = await sb.from('comments').insert({
        subject_type: subjectType, subject_id: subjectId,
        author_id: currentUser().id, parent_id: parentId, body,
      });
      send.disabled = false;
      if (error) { toast(error.message || t('comment_post_error')); return; }
      ta.value = ''; ta.style.height = 'auto';
      if (onDone) onDone();
      load();
      opts.onChange && opts.onChange();
    }
    return form;
  }

  async function load() {
    const query = (cols) => sb.from('comments').select(cols)
      .eq('subject_type', subjectType).eq('subject_id', subjectId)
      .order('created_at', { ascending: true });
    let { data, error } = await query(C_COLS + ',likes_count,creator_heart');
    // база ещё без 059 — комментарии без лайков, но не пустой блок
    if (error) ({ data, error } = await query(C_COLS));
    if (error) { clear(list).appendChild(el('div', { class: 'muted', text: t('comments_unavailable') })); return; }

    mine = new Set();
    const me = currentUser();
    if (me && data?.length && data[0].likes_count !== undefined) {
      const r = await sb.from('comment_likes').select('comment_id')
        .eq('user_id', me.id).in('comment_id', data.map(c => c.id));
      (r.data || []).forEach(x => mine.add(x.comment_id));
    }

    const roots = (data || []).filter(c => !c.parent_id);
    const kids = new Map();
    (data || []).filter(c => c.parent_id).forEach(c => {
      if (!kids.has(c.parent_id)) kids.set(c.parent_id, []);
      kids.get(c.parent_id).push(c);
    });

    clear(list);
    if (!roots.length) {
      list.appendChild(el('div', { class: 'muted', style: 'padding:8px 0', text: t('no_comments') }));
      return;
    }
    for (const c of roots) {
      list.appendChild(row(c, false));
      for (const k of (kids.get(c.id) || [])) list.appendChild(row(k, true));
    }
  }

  function row(c, isReply) {
    const me = currentUser();
    const a = c.author || {};
    const canDelete = me && (c.author_id === me.id || opts.isOwner);

    const actions = el('div', { class: 'c-actions' });
    if (c.likes_count !== undefined) actions.appendChild(likeBox(c));
    if (!isReply) {
      actions.appendChild(el('button', {
        onclick: (e) => {
          if (!needAuth(t('signin_to_reply'))) return;
          const btn = e.currentTarget;
          if (btn._open) { btn._open.remove(); btn._open = null; return; }
          const f = buildForm(c.id, () => { btn._open?.remove(); btn._open = null; });
          f.style.marginLeft = '56px';
          btn._open = f;
          node.after(f);
        },
      }, t('reply_btn')));
    }
    if (canDelete) {
      actions.appendChild(el('button', {
        onclick: async () => {
          const { error } = await sb.from('comments').delete().eq('id', c.id);
          if (error) { toast(t('comment_delete_error')); return; }
          load(); opts.onChange && opts.onChange();
        },
      }, t('delete')));
    }

    const node = el('div', { class: 'comment' + (isReply ? ' reply' : '') },
      el('a', { href: `profile.html?u=${encodeURIComponent(a.username || '')}`, style: 'flex-shrink:0' },
        avatarImg(a.avatar_url, a.display_name, isReply ? 36 : 44, a.plan === 'pro')),
      el('div', { class: 'c-body' },
        el('div', { class: 'c-head' },
          el('a', { class: 'c-name', href: `profile.html?u=${encodeURIComponent(a.username || '')}`, text: a.display_name || a.username || 'Someone' }),
          el('span', { class: 'c-time', text: timeAgo(c.created_at) })),
        el('div', { class: 'c-text', text: c.body }),
        actions));
    return node;
  }

  /** ♥ + счётчик; если лайкнул автор альбома/поста — его аватар с сердечком. */
  function likeBox(c) {
    const wrap = el('span', { class: 'c-likes' });
    const draw = () => {
      clear(wrap);
      const on = mine.has(c.id);
      wrap.appendChild(el('button', {
        class: 'c-like' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
        title: on ? t('c_unlike') : t('c_like'), 'aria-label': on ? t('c_unlike') : t('c_like'),
        onclick: toggle,
      }, icon('heart', 16, { fill: on ? 'currentColor' : 'none', sw: 2 }),
         c.likes_count ? el('span', { text: fmtCount(c.likes_count) }) : null));
      if (c.creator_heart) {
        const who = opts.creator?.name || '';
        wrap.appendChild(el('span', { class: 'c-hearted', title: t('c_hearted', { name: who }), 'aria-label': t('c_hearted', { name: who }) },
          avatarImg(opts.creator?.avatar, who, 20),
          el('span', { class: 'c-hearted-h' }, icon('heart', 10, { fill: 'currentColor', stroke: 'currentColor', sw: 1 }))));
      }
    };
    let busy = false;
    async function toggle() {
      if (!needAuth(t('signin_to_like'))) return;
      if (busy) return;
      busy = true;
      const me = currentUser();
      const on = mine.has(c.id);
      // сразу на экране; откатываем, если база не согласилась
      const was = { n: c.likes_count, h: c.creator_heart };
      if (on) mine.delete(c.id); else mine.add(c.id);
      c.likes_count = Math.max(0, (c.likes_count || 0) + (on ? -1 : 1));
      if (opts.isOwner) c.creator_heart = !on;
      draw();
      const { error } = on
        ? await sb.from('comment_likes').delete().eq('comment_id', c.id).eq('user_id', me.id)
        : await sb.from('comment_likes').insert({ comment_id: c.id, user_id: me.id });
      busy = false;
      if (error && error.code !== '23505') {
        if (on) mine.add(c.id); else mine.delete(c.id);
        c.likes_count = was.n; c.creator_heart = was.h;
        draw();
        toast(t('c_like_error'));
      }
    }
    draw();
    return wrap;
  }

  return { reload: load };
}
