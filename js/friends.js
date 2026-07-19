// Друзья: входящие заявки, отправленные, список друзей, поиск людей.
import { sb, isAuthed } from './sb.js';
import { el, $, clear, mountShell, avatarImg, toast, showLogin, emptyState, t } from './ui.js';

const app = $('#app');

(async function main() {
  await mountShell('friends');
  if (!isAuthed()) {
    app.appendChild(emptyState(t('friends_signin_title'), t('friends_signin_text'),
      el('button', { class: 'btn btn-primary', onclick: () => showLogin(t('signin_to_friend')) }, t('sign_in'))));
    return;
  }
  document.title = t('friends_title') + ' — Albums';
  render();
})();

async function render() {
  clear(app);
  app.appendChild(el('h1', { style: 'font-size:34px;font-weight:800;letter-spacing:-.03em;margin:6px 0 24px', text: t('friends_title') }));

  /* ---- поиск людей ---- */
  const results = el('div', { class: 'stack', style: 'margin-bottom:12px' });
  const q = el('input', {
    class: 'input', placeholder: t('find_people_ph'),
    oninput: (e) => { clearTimeout(q._t); q._t = setTimeout(() => search(e.currentTarget.value.trim()), 300); },
  });
  app.append(el('div', { class: 'form-row', style: 'max-width:520px' }, q, results));

  async function search(text) {
    clear(results);
    if (text.length < 2) return;
    const { data } = await sb.rpc('search_all', { p_q: text });
    const people = data?.people || [];
    if (!people.length) { results.appendChild(el('div', { class: 'muted', style: 'font-size:14.5px', text: t('nobody_found') })); return; }
    people.forEach(p => results.appendChild(personRow(p, [
      el('button', {
        class: 'mini', onclick: async (e) => {
          const r = await sb.rpc('friend_request', { p_username: p.username });
          if (r.error) { toast(r.error.message); return; }
          e.currentTarget.textContent = r.data?.state === 'friends' ? t('friends_yes') : t('sent_short');
          e.currentTarget.disabled = true;
          load();
        },
      }, t('add_friend')),
    ])));
  }

  const box = el('div', {});
  app.appendChild(box);
  load();

  async function load() {
    const { data, error } = await sb.rpc('my_friends');
    if (error) { clear(box).appendChild(emptyState(t('friends_load_error'), error.message)); return; }
    clear(box);
    section(t('requests_to_you'), data.incoming || [], (p) => [
      el('button', {
        class: 'btn btn-primary btn-sm', onclick: async () => {
          const r = await sb.rpc('friend_respond', { p_username: p.username, p_accept: true });
          if (r.error) toast(r.error.message); else { toast(t('now_friends')); load(); }
        },
      }, t('accept')),
      el('button', {
        class: 'mini', onclick: async () => {
          const r = await sb.rpc('friend_respond', { p_username: p.username, p_accept: false });
          if (r.error) toast(r.error.message); else load();
        },
      }, t('decline')),
    ]);
    section(t('sent_section'), data.sent || [], (p) => [
      el('button', {
        class: 'mini', onclick: async () => {
          const r = await sb.rpc('friend_remove', { p_username: p.username });
          if (r.error) toast(r.error.message); else load();
        },
      }, t('cancel')),
    ]);
    section(t('your_friends'), data.friends || [], (p) => [
      el('button', {
        class: 'mini danger', onclick: async () => {
          if (!confirm(t('remove_friend_q', { name: p.name || p.username }))) return;
          const r = await sb.rpc('friend_remove', { p_username: p.username });
          if (r.error) toast(r.error.message); else load();
        },
      }, t('remove')),
    ]);

    if (!(data.friends || []).length && !(data.incoming || []).length && !(data.sent || []).length) {
      box.appendChild(emptyState(t('no_friends_title'), t('no_friends_text')));
    }

    function section(title, list, actions) {
      if (!list.length) return;
      box.append(el('div', { class: 'section-head', style: 'margin:32px 0 14px' },
        el('h2', { style: 'font-size:20px', text: `${title} · ${list.length}` })));
      const stack = el('div', { class: 'stack', style: 'max-width:620px' });
      list.forEach(p => stack.appendChild(personRow(p, actions(p))));
      box.appendChild(stack);
    }
  }
}

function personRow(p, actions) {
  return el('div', { class: 'side-card', style: 'display:flex;align-items:center;gap:14px' },
    el('a', { href: `profile.html?u=${encodeURIComponent(p.username)}` }, avatarImg(p.avatar, p.name, 48)),
    el('div', { style: 'flex:1;min-width:0' },
      el('a', { href: `profile.html?u=${encodeURIComponent(p.username)}`, style: 'font-size:16.5px;font-weight:700', text: p.name || p.username }),
      el('div', { class: 'card-sub', text: '@' + p.username })),
    el('div', { class: 'rowx' }, ...actions));
}
