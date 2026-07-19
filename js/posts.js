// Инста-лента: пост = фото/видео или карусель; композер + комментарии в модалке.
import { sb, currentUser, isAuthed } from './sb.js';
import { LIMITS } from './config.js';
import {
  el, $, clear, mountShell, signUrls, avatarImg, timeAgo, fmtCount, icon,
  toast, needAuth, emptyState, modal,
} from './ui.js';
import { uploadMedia, kindOf } from './upload.js';
import { mountComments } from './comments.js';

const app = $('#app');
const PAGE = 8;
let offset = 0, loading = false, done = false, col = null;

(async function main() {
  await mountShell('posts');
  const head = el('div', { class: 'section-head', style: 'margin:8px 0 22px' },
    el('h2', { style: 'font-size:30px', text: 'Posts' }),
    el('button', { class: 'btn btn-primary btn-sm', onclick: openComposer }, icon('plus', 16, { sw: 2.4 }), 'New post'));
  col = el('div', { class: 'posts-col' });
  const sentinel = el('div', { style: 'height:1px' });
  clear(app).append(el('div', { class: 'posts-col' }, head), col, sentinel);

  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) load(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  addEventListener('scroll', () => {
    if (innerHeight + scrollY > document.body.offsetHeight - 800) load();
  }, { passive: true });
  load();
})();

async function load() {
  if (loading || done) return;
  loading = true;
  const { data, error } = await sb.rpc('feed_posts', { p_limit: PAGE, p_offset: offset });
  loading = false;
  if (error) { toast(error.message || 'Could not load posts'); return; }
  const rows = data || [];
  if (rows.length < PAGE) done = true;
  if (!rows.length && !offset) {
    col.appendChild(emptyState('No posts yet', 'Share a photo, a video, or a carousel of both.',
      el('button', { class: 'btn btn-primary', onclick: openComposer }, 'Create a post')));
    return;
  }
  const paths = [];
  rows.forEach(p => (p.slides || []).forEach(s => paths.push(s.path, s.thumb)));
  const urls = await signUrls(paths);
  rows.forEach(p => col.appendChild(postCard(p, urls)));
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
  if (slides.length > 1) {
    slides.forEach((_, i) => dots.appendChild(el('i', { class: i === 0 ? 'on' : '' })));
    const go = (d) => {
      stage.querySelectorAll('video').forEach(v => v.pause());
      idx = (idx + d + slides.length) % slides.length;
      [...stage.children].forEach((n, i) => n.classList.toggle('on', i === idx));
      [...dots.children].forEach((n, i) => n.classList.toggle('on', i === idx));
    };
    stage.append(
      el('button', { class: 'car-nav prev', onclick: () => go(-1) }, icon('chevL', 18, { stroke: '#141414', sw: 2 })),
      el('button', { class: 'car-nav next', onclick: () => go(1) }, icon('chevR', 18, { stroke: '#141414', sw: 2 })),
      dots);
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
      if (!needAuth('Sign in to like posts')) return;
      const uid = currentUser().id;
      liked = !liked; likes += liked ? 1 : -1; paintLike();
      const q = liked
        ? sb.from('likes').insert({ subject_type: 'post', subject_id: p.id, user_id: uid })
        : sb.from('likes').delete().eq('subject_type', 'post').eq('subject_id', p.id).eq('user_id', uid);
      const { error } = await q;
      if (error) { liked = !liked; likes += liked ? 1 : -1; paintLike(); toast('Could not update like'); }
    },
  }, likeIcon, likeCount);
  paintLike();

  const commentBtn = el('button', { onclick: () => openComments(p) },
    icon('comment', 20), el('span', { text: fmtCount(p.comments_count) }));

  const card = el('article', { class: 'post' },
    el('div', { class: 'post-head' },
      el('a', { href: `profile.html?u=${encodeURIComponent(p.author_username)}` },
        avatarImg(p.author_avatar, p.author_name, 40)),
      el('div', { style: 'min-width:0' },
        el('a', { class: 'post-name', href: `profile.html?u=${encodeURIComponent(p.author_username)}`, text: p.author_name || p.author_username }),
        el('div', { class: 'post-time', text: timeAgo(p.created_at) }))),
    stage,
    el('div', { class: 'post-actions' }, likeBtn, commentBtn),
    p.caption ? el('div', { class: 'post-caption', text: p.caption }) : null);
  return card;
}

function openComments(p) {
  modal((box) => {
    box.appendChild(el('h2', { text: 'Comments' }));
    const host = el('div', {});
    box.appendChild(host);
    mountComments(host, 'post', p.id, { isOwner: p.is_author });
  }, { wide: true });
}

/* ---------------------------------------------------------------- композер */
function openComposer() {
  if (!needAuth('Sign in to post')) return;
  const picked = [];   // {media, url}

  modal((box, close) => {
    box.appendChild(el('h2', { text: 'New post' }));
    box.appendChild(el('p', { text: 'Pick up to 10 photos or videos — they become one carousel.' }));

    const strip = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px' });
    const input = el('input', {
      type: 'file', multiple: 'multiple', class: 'hide', accept: 'image/*,.heic,.heif,video/*',
      onchange: (e) => { add([...e.currentTarget.files]); e.currentTarget.value = ''; },
    });
    const drop = el('div', { class: 'drop', style: 'padding:26px', onclick: () => input.click() },
      el('div', { style: 'font-weight:600', text: 'Choose photos or videos' }));

    const caption = el('textarea', { class: 'textarea', placeholder: 'Write a caption…', maxlength: '2200' });
    const vis = el('select', { class: 'select' },
      el('option', { value: 'public' }, 'Public'),
      el('option', { value: 'friends' }, 'Friends only'),
      el('option', { value: 'private' }, 'Only me'));

    const publish = el('button', { class: 'btn btn-primary', style: 'width:100%;margin-top:18px', onclick: submit }, 'Share');

    box.append(input, drop, strip,
      el('div', { class: 'form-row', style: 'margin-top:16px' }, el('label', { class: 'label', text: 'Caption' }), caption),
      el('div', { class: 'form-row' }, el('label', { class: 'label', text: 'Who can see it' }), vis),
      publish,
      el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px', onclick: close }, 'Cancel'));

    async function add(files) {
      for (const f of files) {
        if (picked.length >= LIMITS.slides) { toast('Maximum 10 slides'); break; }
        const k = kindOf(f);
        if (k !== 'photo' && k !== 'video') { toast('Photos and videos only'); continue; }
        const ph = el('div', {
          class: 'skel',
          style: 'width:76px;height:76px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#6E6A63;text-align:center',
        }, '…');
        strip.appendChild(ph);
        try {
          const media = await uploadMedia(f, (stage) => {
            ph.textContent = stage === 'converting' ? 'HEIC…' : stage === 'uploading' ? '↑' : '…';
          });
          const urls = await signUrls([media.thumb_path, media.storage_path]);
          picked.push({ media });
          ph.remove();
          const src = urls[media.thumb_path] || urls[media.storage_path];
          const cell = el('div', { style: 'position:relative;width:76px;height:76px;border-radius:12px;overflow:hidden;background:var(--ph)' });
          if (src) cell.appendChild(el('img', { src, alt: '', style: 'width:100%;height:100%;object-fit:cover' }));
          cell.appendChild(el('button', {
            style: 'position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:999px;border:none;background:rgba(0,0,0,.6);color:#fff;cursor:pointer;font-size:13px;line-height:1',
            onclick: () => {
              const i = picked.findIndex(x => x.media.id === media.id);
              if (i >= 0) picked.splice(i, 1);
              cell.remove();
            },
          }, '×'));
          strip.appendChild(cell);
        } catch (err) {
          ph.remove();
          toast(err.message || 'Upload failed');
        }
      }
    }

    async function submit() {
      if (!picked.length) { toast('Add at least one photo or video'); return; }
      publish.disabled = true;
      clear(publish).appendChild(el('span', { class: 'spinner' }));
      try {
        const { data: post, error } = await sb.from('posts').insert({
          author_id: currentUser().id,
          caption: caption.value.trim() || null,
          visibility: vis.value,
        }).select().single();
        if (error) throw error;
        const rows = picked.map((p, i) => ({ post_id: post.id, position: i, media_id: p.media.id }));
        const r = await sb.from('post_media').insert(rows);
        if (r.error) throw r.error;
        close();
        toast('Posted');
        offset = 0; done = false; clear(col); load();
      } catch (err) {
        toast(err.message || 'Could not post');
        publish.disabled = false;
        clear(publish).appendChild(document.createTextNode('Share'));
      }
    }
  }, { wide: true });
}
