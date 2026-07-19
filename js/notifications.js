// Уведомления: колокольчик в шапке и выпадающий список.
//
// Приватность решается на стороне базы: в строке уведомления нет текстов, а
// notif_list перепроверяет право видеть объект и удаляет то, что стало недоступно.
// Поэтому счётчик и список могут разойтись — после каждого запроса списка
// синхронизируем бейдж возвращённым значением, а не своим.
import { sb, isAuthed } from './sb.js';
import { el, clear, icon, avatarImg, timeAgo, t, toast } from './ui.js';

const POLL_MS = 60000;

export function notifButton() {
  const badge = el('span', { class: 'notif-badge hide' });
  const btn = el('button', {
    class: 'btn-icon notif-btn', 'aria-label': t('notifications'),
    onclick: (e) => { e.stopPropagation(); togglePanel(btn, badge); },
  }, icon('bell', 22), badge);

  const setCount = (n) => {
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hide', !n);
  };

  refreshCount(setCount);
  setInterval(() => refreshCount(setCount), POLL_MS);
  btn._setCount = setCount;
  return btn;
}

async function refreshCount(setCount) {
  if (!isAuthed() || document.hidden) return;
  const { data, error } = await sb.rpc('notif_unread_count');
  if (!error) setCount(Number(data) || 0);
}

let panel = null;
function closePanel() {
  panel?.remove();
  panel = null;
  document.removeEventListener('click', onOutside);
}
function onOutside(e) {
  if (panel && !panel.contains(e.target)) closePanel();
}

async function togglePanel(btn, badge) {
  if (panel) { closePanel(); return; }

  panel = el('div', { class: 'notif-panel' },
    el('div', { class: 'notif-head' },
      el('b', { text: t('notifications') }),
      el('button', {
        class: 'mini', onclick: async () => {
          const { data } = await sb.rpc('notif_mark_read', { p_id: null });
          btn._setCount(Number(data?.unread) || 0);
          load();
        },
      }, t('mark_all_read'))),
    el('div', { class: 'notif-list' }, el('div', { class: 'muted', style: 'padding:16px', text: t('loading') })));

  document.body.appendChild(panel);
  positionPanel(btn);
  setTimeout(() => document.addEventListener('click', onOutside), 0);
  load();

  async function load() {
    const list = panel?.querySelector('.notif-list');
    if (!list) return;
    const { data, error } = await sb.rpc('notif_list', { p_limit: 30, p_offset: 0 });
    if (!panel) return;
    if (error) { clear(list).appendChild(el('div', { class: 'muted', style: 'padding:16px', text: t('feed_error') })); return; }

    // Список уже отфильтрован по праву видеть — берём счётчик оттуда же,
    // иначе бейдж покажет 3, а внутри будет пусто.
    btn._setCount(Number(data?.unread) || 0);

    const items = data?.items || [];
    clear(list);
    if (!items.length) {
      list.appendChild(el('div', { class: 'muted', style: 'padding:24px 16px;text-align:center', text: t('notif_empty') }));
      return;
    }
    items.forEach(n => list.appendChild(row(n, btn)));
  }
}

function positionPanel(btn) {
  if (!panel) return;
  const r = btn.getBoundingClientRect();
  if (window.innerWidth <= 720) return;              // на телефоне панель на всю ширину снизу
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.right = `${Math.round(window.innerWidth - r.right)}px`;
}

/**
 * Имя показываем отдельной строкой, а не внутри фразы. Иначе «Аня и ещё 3
 * прокомментировал» — глагол не согласуется ни по роду, ни по числу, и та же
 * беда во всех языках с согласованием. Фразы построены без глагола-сказуемого.
 */
function actorLine(n) {
  const who = n.actor?.name || n.actor?.username || t('someone');
  return who + (n.actor_count > 1 ? t('and_others', { count: n.actor_count - 1 }) : '');
}

function textFor(n) {
  const title = n.album_title ? ` «${n.album_title}»` : '';
  const key = {
    friend_request: 'notif_friend_request',
    friend_accepted: 'notif_friend_accepted',
    new_follower: 'notif_new_follower',
    comment_album: 'notif_comment_album',
    comment_post: 'notif_comment_post',
    comment_reply: 'notif_comment_reply',
    collab_added: 'notif_collab_added',
    album_upload: 'notif_album_upload',
    post_coauthor: 'notif_post_coauthor',
    moderation_action: 'notif_moderation',
  }[n.type] || 'notif_generic';
  return t(key, { title });
}

function hrefFor(n) {
  if (n.subject_type === 'album') return `album.html?id=${n.subject_id}`;
  if (n.subject_type === 'post') return `posts.html#post-${n.subject_id}`;
  if (n.subject_type === 'profile' && n.actor?.username) {
    return `profile.html?u=${encodeURIComponent(n.actor.username)}`;
  }
  return null;
}

function row(n, btn) {
  const href = hrefFor(n);
  const node = el(href ? 'a' : 'div', {
    class: 'notif-item' + (n.read ? '' : ' unread'),
    ...(href ? { href } : {}),
    onclick: async () => {
      if (!n.read) {
        const { data } = await sb.rpc('notif_mark_read', { p_id: n.id });
        btn._setCount(Number(data?.unread) || 0);
      }
    },
  },
    avatarImg(n.actor?.avatar, n.actor?.name, 38),
    el('div', { style: 'min-width:0;flex:1' },
      n.actor ? el('div', { class: 'notif-who', text: actorLine(n) }) : null,
      el('div', { class: 'notif-text', text: textFor(n) }),
      el('div', { class: 'notif-time', text: timeAgo(n.created_at) })),
    n.read ? null : el('i', { class: 'notif-dot' }));
  return node;
}
