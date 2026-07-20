// Инста-лента: пост = фото/видео или карусель; композер + комментарии в модалке.
import { sb, currentUser, isAuthed } from './sb.js';
import { LIMITS } from './config.js';
import {
  el, $, clear, mountShell, signUrls, avatarImg, timeAgo, fmtCount, icon,
  toast, needAuth, emptyState, modal, t, thumbEl,
} from './ui.js';
import { uploadMedia, kindOf } from './upload.js';
import { mountComments } from './comments.js';

const app = $('#app');
const PAGE = 8;
let offset = 0, loading = false, done = false, col = null;

let feed = null, sentinel = null;

(async function main() {
  await mountShell('posts');
  document.title = t('posts_title') + ' — Albums';
  // помечаем страницу — на мобильном шапка прячется, лента идёт на весь экран
  document.body.classList.add('posts-page');

  const head = el('div', { class: 'posts-topbar' },
    el('h2', { text: t('posts_title') }),
    el('button', { class: 'btn btn-primary btn-sm', onclick: openComposer }, icon('plus', 16, { sw: 2.4 }), t('new_post')));

  feed = el('div', { class: 'posts-feed' });
  col = feed;                       // карточки кладём прямо в ленту-скроллер
  sentinel = el('div', { class: 'posts-sentinel' });
  feed.appendChild(sentinel);

  // плавающая кнопка «новый пост» — только на мобильном (CSS)
  const fab = el('button', { class: 'posts-fab', 'aria-label': t('new_post'), onclick: openComposer },
    icon('plus', 24, { sw: 2.6, stroke: '#fff' }));

  clear(app).append(head, feed, fab);

  // бесконечная подгрузка: и по окну (десктоп), и по контейнеру ленты (мобильный снап)
  const near = (el, px) => el.scrollHeight - el.scrollTop - el.clientHeight < px;
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) load(); }, { rootMargin: '800px' });
  io.observe(sentinel);
  addEventListener('scroll', () => {
    if (innerHeight + scrollY > document.body.offsetHeight - 800) load();
  }, { passive: true });
  feed.addEventListener('scroll', () => { if (near(feed, 1200)) load(); }, { passive: true });

  load();
})();

async function load() {
  if (loading || done) return;
  loading = true;
  const { data, error } = await sb.rpc('feed_posts', { p_limit: PAGE, p_offset: offset });
  loading = false;
  if (error) { toast(error.message || t('feed_error')); return; }
  const rows = data || [];
  if (rows.length < PAGE) done = true;
  if (!rows.length && !offset) {
    feed.insertBefore(emptyState(t('posts_empty_title'), t('posts_empty_text'),
      el('button', { class: 'btn btn-primary', onclick: openComposer }, t('create_post'))), sentinel);
    return;
  }
  const paths = [];
  rows.forEach(p => (p.slides || []).forEach(s => paths.push(s.path, s.thumb)));
  const urls = await signUrls(paths);
  rows.forEach(p => feed.insertBefore(postCard(p, urls), sentinel));
  offset += rows.length;
}

function postCard(p, urls) {
  const slides = p.slides || [];
  let idx = 0;

  const stage = el('div', { class: 'carousel' });
  slides.forEach((s, i) => {
    const cell = el('div', { class: 'slide' + (i === 0 ? ' on' : '') });
    if (s.kind === 'video') {
      const v = el('video', { controls: 'controls', preload: 'metadata', playsinline: 'playsinline' });
      if (urls[s.thumb]) v.poster = urls[s.thumb];
      if (urls[s.path]) v.src = urls[s.path];
      cell.appendChild(v);
    } else {
      const img = el('img', { alt: '', loading: 'lazy' });
      if (urls[s.path] || urls[s.thumb]) img.src = urls[s.path] || urls[s.thumb];
      cell.appendChild(img);
    }
    stage.appendChild(cell);
  });

  const dots = el('div', { class: 'dots' });
  const go = (d) => {
    stage.querySelectorAll('video').forEach(v => v.pause());
    idx = (idx + d + slides.length) % slides.length;
    [...stage.querySelectorAll('.slide')].forEach((n, i) => n.classList.toggle('on', i === idx));
    [...dots.children].forEach((n, i) => n.classList.toggle('on', i === idx));
  };
  if (slides.length > 1) {
    slides.forEach((_, i) => dots.appendChild(el('i', { class: i === 0 ? 'on' : '' })));
    stage.append(
      el('button', { class: 'car-nav prev', onclick: () => go(-1) }, icon('chevL', 18, { stroke: '#141414', sw: 2 })),
      el('button', { class: 'car-nav next', onclick: () => go(1) }, icon('chevR', 18, { stroke: '#141414', sw: 2 })),
      dots);

    // на телефоне карусель листается горизонтальным свайпом (кнопки скрыты)
    let sx = 0, sy = 0;
    stage.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      // только явно горизонтальный жест — вертикальный отдаём снап-скроллу ленты
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  let liked = !!p.liked, likes = p.likes_count || 0;
  const likeCount = el('span', { text: fmtCount(likes) });
  const likeIcon = el('span', {});
  const paintLike = () => {
    clear(likeIcon).appendChild(icon('heart', 20, { fill: liked ? '#E8552B' : 'none', stroke: liked ? '#E8552B' : '#141414' }));
    likeCount.textContent = fmtCount(likes);
  };
  const likeBtn = el('button', {
    onclick: async () => {
      if (!needAuth(t('signin_to_like'))) return;
      const uid = currentUser().id;
      liked = !liked; likes += liked ? 1 : -1; paintLike();
      const q = liked
        ? sb.from('likes').insert({ subject_type: 'post', subject_id: p.id, user_id: uid })
        : sb.from('likes').delete().eq('subject_type', 'post').eq('subject_id', p.id).eq('user_id', uid);
      const { error } = await q;
      if (error) { liked = !liked; likes += liked ? 1 : -1; paintLike(); toast(t('like_error')); }
    },
  }, likeIcon, likeCount);
  paintLike();

  const commentBtn = el('button', { onclick: () => openComments(p) },
    icon('comment', 20), el('span', { text: fmtCount(p.comments_count) }));

  const card = el('article', { class: 'post' },
    el('div', { class: 'post-head' },
      el('a', { href: `profile.html?u=${encodeURIComponent(p.author_username)}` },
        avatarImg(p.author_avatar, p.author_name, 38)),
      el('div', { style: 'min-width:0' },
        el('a', { class: 'post-name', href: `profile.html?u=${encodeURIComponent(p.author_username)}`, text: p.author_name || p.author_username }),
        el('div', { class: 'post-time', text: timeAgo(p.created_at) }))),
    stage,
    el('div', { class: 'post-actions' }, likeBtn, commentBtn),
    p.caption ? el('div', { class: 'post-caption', text: p.caption }) : null);

  // Автоплей текущего видео, когда пост занимает экран (как в инстаграме). Только
  // в мобильном снап-режиме; на десктопе видео с обычными controls.
  if (window.matchMedia('(max-width:720px)').matches) {
    const io = new IntersectionObserver((es) => {
      es.forEach(e => {
        const v = stage.querySelector('.slide.on video') || stage.querySelector('video');
        if (!v) return;
        if (e.isIntersecting && e.intersectionRatio > 0.7) {
          v.muted = true; v.loop = true; v.play().catch(() => {});
        } else { v.pause(); }
      });
    }, { threshold: [0, 0.7, 1] });
    io.observe(card);
  }
  return card;
}

function openComments(p) {
  modal((box) => {
    box.appendChild(el('h2', { text: t('comments_title') }));
    const host = el('div', {});
    box.appendChild(host);
    mountComments(host, 'post', p.id, { isOwner: p.is_author });
  }, { wide: true });
}

/* ---------------------------------------------------------------- композер */
function openComposer() {
  if (!needAuth(t('signin_to_post'))) return;
  const picked = [];          // media-строки в порядке выбора = порядок слайдов
  const thumbUrls = {};       // media.id -> url превью

  modal((box, close) => {
    box.appendChild(el('h2', { text: t('new_post') }));
    box.appendChild(el('p', { text: t('composer_hint', { n: LIMITS.slides }) }));

    /* --- вкладки: загрузить новое / взять из медиатеки --- */
    const tabs = el('div', { class: 'tabs' });
    const paneUpload = el('div', {});
    const paneLib = el('div', { class: 'hide' });
    const setTab = (which) => {
      [...tabs.children].forEach(b => b.classList.toggle('on', b.dataset.tab === which));
      paneUpload.classList.toggle('hide', which !== 'upload');
      paneLib.classList.toggle('hide', which !== 'lib');
      if (which === 'lib') loadLibrary();
    };
    [['upload', t('tab_upload')], ['lib', t('tab_library')]].forEach(([k, label]) => {
      tabs.appendChild(el('button', { 'data-tab': k, onclick: () => setTab(k) }, label));
    });

    const input = el('input', {
      type: 'file', multiple: 'multiple', class: 'hide', accept: 'image/*,.heic,.heif,video/*',
      onchange: (e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; },
    });
    const drop = el('div', { class: 'drop', style: 'padding:26px', onclick: () => input.click() },
      el('div', { style: 'font-weight:600', text: t('choose_files') }));
    paneUpload.append(input, drop);

    const libGrid = el('div', { class: 'lib-grid' });
    const libHint = el('div', { class: 'muted', style: 'font-size:14px;padding:8px 2px', text: t('loading') });
    paneLib.append(libHint, libGrid);

    const strip = el('div', { class: 'picked-strip' });
    const caption = el('textarea', { class: 'textarea', placeholder: t('caption_ph'), maxlength: '2200' });
    const vis = el('select', { class: 'select' },
      el('option', { value: 'public' }, t('vis_public')),
      el('option', { value: 'friends' }, t('friends_only')),
      el('option', { value: 'private' }, t('only_me')));
    const publish = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:18px', onclick: submit }, t('share'));

    box.append(tabs, paneUpload, paneLib, strip,
      el('div', { class: 'form-row', style: 'margin-top:16px' }, el('label', { class: 'label', text: t('caption') }), caption),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: t('who_can_see') }), vis),
      publish,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, t('cancel')));
    setTab('upload');

    /* --- выбранные слайды --- */
    function renderStrip() {
      clear(strip);
      picked.forEach((m, i) => {
        const cell = el('div', { class: 'p' });
        const src = thumbUrls[m.id];
        const node = thumbEl(m.thumb_path || m.storage_path, src, m.thumb_path ? null : m.kind);
        if (node) cell.appendChild(node);
        cell.append(
          el('div', { class: 'n', text: String(i + 1) }),
          el('button', {
            class: 'x', onclick: () => {
              const k = picked.findIndex(x => x.id === m.id);
              if (k >= 0) picked.splice(k, 1);
              renderStrip(); markLibrary();
            },
          }, '×'));
        strip.appendChild(cell);
      });
    }

    async function addMedia(media) {
      if (picked.some(x => x.id === media.id)) return;
      if (picked.length >= LIMITS.slides) { toast(t('max_slides', { n: LIMITS.slides })); return; }
      if (!thumbUrls[media.id]) {
        const u = await signUrls([media.thumb_path, media.storage_path]);
        thumbUrls[media.id] = u[media.thumb_path] || u[media.storage_path];
      }
      picked.push(media);
      renderStrip(); markLibrary();
    }

    async function addFiles(files) {
      for (const f of files) {
        if (picked.length >= LIMITS.slides) { toast(t('max_slides', { n: LIMITS.slides })); break; }
        const k = kindOf(f);
        if (k !== 'photo' && k !== 'video') { toast(t('photos_videos_only')); continue; }
        const ph = el('div', {
          class: 'skel',
          style: 'width:76px;height:76px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#6E6A63;text-align:center',
        }, '…');
        strip.appendChild(ph);
        try {
          const media = await uploadMedia(f, (stage, p) => {
            ph.textContent = stage === 'converting' ? 'HEIC…'
              : stage === 'transcoding' ? `MP4 ${Math.round((p || 0) * 100)}%`
              : stage === 'uploading' ? '↑' : '…';
          });
          ph.remove();
          libLoaded = false;              // медиатека устарела
          await addMedia(media);
        } catch (err) {
          ph.remove();
          toast(err.message || t('upload_failed'));
        }
      }
    }

    /* --- медиатека --- */
    let libItems = [], libLoaded = false;
    async function loadLibrary() {
      if (libLoaded) { markLibrary(); return; }
      libHint.textContent = t('loading');
      const { data, error } = await sb.rpc('my_media', { p_limit: 120, p_offset: 0 });
      if (error) { libHint.textContent = t('lib_error'); return; }
      libItems = (data || []).filter(m => m.kind !== 'audio');
      if (!libItems.length) {
        libHint.textContent = t('lib_empty');
        clear(libGrid);
        return;
      }
      libHint.textContent = t('lib_hint');
      const urls = await signUrls(libItems.flatMap(m => [m.thumb_path, m.storage_path]));
      clear(libGrid);
      libItems.forEach(m => {
        const src = urls[m.thumb_path] || urls[m.storage_path];
        const cell = el('div', { class: 'lib-cell', 'data-id': m.id, onclick: () => toggle(m) });
        const node = thumbEl(m.thumb_path || m.storage_path, src, m.thumb_path ? null : m.kind);
        if (node) cell.appendChild(node);
        if (m.kind === 'video') cell.appendChild(el('div', { class: 'tag', text: t('video_tag') }));
        libGrid.appendChild(cell);
      });
      libLoaded = true;
      markLibrary();
    }

    function toggle(m) {
      const i = picked.findIndex(x => x.id === m.id);
      if (i >= 0) { picked.splice(i, 1); renderStrip(); markLibrary(); }
      else addMedia(m);
    }

    function markLibrary() {
      libGrid.querySelectorAll('.lib-cell').forEach(cell => {
        const idx = picked.findIndex(x => x.id === cell.dataset.id);
        cell.classList.toggle('on', idx >= 0);
        const old = cell.querySelector('.num');
        if (old) old.remove();
        if (idx >= 0) cell.appendChild(el('div', { class: 'num', text: String(idx + 1) }));
      });
    }

    async function submit() {
      if (!picked.length) { toast(t('add_one_file')); return; }
      publish.disabled = true;
      clear(publish).appendChild(el('span', { class: 'spinner' }));
      try {
        const { data: post, error } = await sb.from('posts').insert({
          author_id: currentUser().id,
          caption: caption.value.trim() || null,
          visibility: vis.value,
        }).select().single();
        if (error) throw error;
        const rows = picked.map((m, i) => ({ post_id: post.id, position: i, media_id: m.id }));
        const r = await sb.from('post_media').insert(rows);
        if (r.error) throw r.error;
        close();
        toast(t('posted'));
        offset = 0; done = false; clear(col); load();
      } catch (err) {
        toast(err.message || t('post_error'));
        publish.disabled = false;
        clear(publish).appendChild(document.createTextNode(t('share')));
      }
    }
  }, { wide: true });
}
