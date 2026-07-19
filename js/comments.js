// Блок комментариев (общий для альбомов и постов): ветки в один уровень.
import { sb, currentUser, currentProfile } from './sb.js';
import { el, clear, avatarImg, timeAgo, toast, needAuth, icon } from './ui.js';

export function mountComments(host, subjectType, subjectId, opts = {}) {
  const list = el('div', {});
  const box = el('section', { class: 'comments' },
    el('h3', { text: 'Comments' }), buildForm(), list);
  clear(host).appendChild(box);
  load();

  function buildForm(parentId = null, onDone = null) {
    const me = currentProfile();
    const ta = el('textarea', {
      placeholder: parentId ? 'Write a reply…' : 'Add a comment…', maxlength: '2000',
      oninput: (e) => { e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px'; },
    });
    const send = el('button', { class: 'btn btn-primary btn-sm', onclick: submit }, parentId ? 'Reply' : 'Post');
    const form = el('div', { class: 'cform' },
      avatarImg(me?.avatar_url, me?.display_name, 44), ta,
      el('div', { class: 'stack' }, send,
        parentId ? el('button', { class: 'mini', onclick: () => onDone && onDone() }, 'Cancel') : null));

    async function submit() {
      if (!needAuth('Sign in to comment')) return;
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      const { error } = await sb.from('comments').insert({
        subject_type: subjectType, subject_id: subjectId,
        author_id: currentUser().id, parent_id: parentId, body,
      });
      send.disabled = false;
      if (error) { toast(error.message || 'Could not post'); return; }
      ta.value = ''; ta.style.height = 'auto';
      if (onDone) onDone();
      load();
      opts.onChange && opts.onChange();
    }
    return form;
  }

  async function load() {
    const { data, error } = await sb.from('comments')
      .select('id,body,created_at,parent_id,author_id,author:profiles!comments_author_id_fkey(username,display_name,avatar_url)')
      .eq('subject_type', subjectType).eq('subject_id', subjectId)
      .order('created_at', { ascending: true });
    if (error) { clear(list).appendChild(el('div', { class: 'muted', text: 'Comments unavailable' })); return; }

    const roots = (data || []).filter(c => !c.parent_id);
    const kids = new Map();
    (data || []).filter(c => c.parent_id).forEach(c => {
      if (!kids.has(c.parent_id)) kids.set(c.parent_id, []);
      kids.get(c.parent_id).push(c);
    });

    clear(list);
    if (!roots.length) {
      list.appendChild(el('div', { class: 'muted', style: 'padding:8px 0', text: 'No comments yet — be the first.' }));
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
    if (!isReply) {
      actions.appendChild(el('button', {
        onclick: (e) => {
          if (!needAuth('Sign in to reply')) return;
          const btn = e.currentTarget;
          if (btn._open) { btn._open.remove(); btn._open = null; return; }
          const f = buildForm(c.id, () => { btn._open?.remove(); btn._open = null; });
          f.style.marginLeft = '56px';
          btn._open = f;
          node.after(f);
        },
      }, 'Reply'));
    }
    if (canDelete) {
      actions.appendChild(el('button', {
        onclick: async () => {
          const { error } = await sb.from('comments').delete().eq('id', c.id);
          if (error) { toast('Could not delete'); return; }
          load(); opts.onChange && opts.onChange();
        },
      }, 'Delete'));
    }

    const node = el('div', { class: 'comment' + (isReply ? ' reply' : '') },
      el('a', { href: `profile.html?u=${encodeURIComponent(a.username || '')}`, style: 'flex-shrink:0' },
        avatarImg(a.avatar_url, a.display_name, isReply ? 36 : 44)),
      el('div', { class: 'c-body' },
        el('div', { class: 'c-head' },
          el('a', { class: 'c-name', href: `profile.html?u=${encodeURIComponent(a.username || '')}`, text: a.display_name || a.username || 'Someone' }),
          el('span', { class: 'c-time', text: timeAgo(c.created_at) })),
        el('div', { class: 'c-text', text: c.body }),
        actions));
    return node;
  }

  return { reload: load };
}
