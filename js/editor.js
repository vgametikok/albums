// Редактор альбома: медиа, главы, обложка, видимость (включая «друзьям кроме…»).
import { sb, currentUser, isAuthed } from './sb.js';
import { CATEGORIES } from './config.js';
import { el, $, clear, mountShell, signUrls, toast, showLogin, icon, emptyState, dur } from './ui.js';
import { uploadMedia } from './upload.js';

const app = $('#app');
let albumId = new URLSearchParams(location.search).get('id');
let album = null;          // строка albums
let items = [];            // album_media + вложенный media
let chapters = [];         // album_chapters
let friends = [];          // для «кроме»
let excluded = new Set();  // username'ы исключённых
let saving = false;

(async function main() {
  await mountShell('home');
  if (!isAuthed()) {
    app.appendChild(emptyState('Sign in to create albums', 'Albums are tied to your account.',
      el('button', { class: 'btn btn-primary', onclick: () => showLogin('Sign in to create albums') }, 'Sign in')));
    return;
  }

  const mf = await sb.rpc('my_friends');
  friends = mf.data?.friends || [];

  if (albumId) {
    const [a, ch, im] = await Promise.all([
      sb.from('albums').select('*').eq('id', albumId).single(),
      sb.from('album_chapters').select('*').eq('album_id', albumId).order('position'),
      sb.from('album_media').select('id,chapter_id,position,caption,media:media_id(*)').eq('album_id', albumId).order('position'),
    ]);
    if (a.error || !a.data) { app.appendChild(emptyState('Album not found', 'It may have been deleted.')); return; }
    album = a.data; chapters = ch.data || []; items = im.data || [];
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
    icon('back', 16, { sw: 2 }), albumId ? 'Back to album' : 'Back to feed'));

  app.appendChild(el('h1', {
    style: 'font-size:34px;font-weight:800;letter-spacing:-.03em;margin:6px 0 28px',
    text: albumId ? 'Edit album' : 'New album',
  }));

  const cols = el('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:40px;align-items:start' });
  const left = el('div', {});
  const right = el('div', { class: 'sticky' });
  cols.append(left, right);
  app.appendChild(cols);

  /* ---- основное ---- */
  left.appendChild(el('div', { class: 'form-row' },
    el('label', { class: 'label', for: 'f-title', text: 'Title' }),
    el('input', { class: 'input', id: 'f-title', maxlength: '120', placeholder: 'Two Weeks in Lisbon', value: album?.title || '' })));

  left.appendChild(el('div', { class: 'form-row' },
    el('label', { class: 'label', for: 'f-desc', text: 'Description' }),
    el('textarea', { class: 'textarea', id: 'f-desc', maxlength: '2000', placeholder: 'What is this album about?' }, album?.description || '')));

  const catSel = el('select', { class: 'select', id: 'f-cat' },
    el('option', { value: '' }, '—'),
    ...CATEGORIES.map(c => el('option', { value: c, selected: album?.category === c ? 'selected' : null }, c)));
  left.appendChild(el('div', { class: 'form-row' }, el('label', { class: 'label', text: 'Category' }), catSel));

  /* ---- медиа ---- */
  left.appendChild(el('div', { class: 'section-head', style: 'margin:36px 0 16px' },
    el('h2', { text: 'Media' }),
    el('span', { class: 'muted', style: 'font-size:14.5px', text: 'Photos, videos and voice notes' })));

  const fileInput = el('input', {
    type: 'file', multiple: 'multiple', class: 'hide',
    accept: 'image/*,video/*,audio/*',
    onchange: (e) => { addFiles([...e.currentTarget.files]); e.currentTarget.value = ''; },
  });
  const drop = el('div', {
    class: 'drop',
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); },
  }, el('div', { style: 'font-size:17px;font-weight:600', text: 'Drop files here or click to choose' }),
     el('div', { style: 'font-size:14.5px;margin-top:6px', text: 'JPG/PNG/WebP · MP4/WebM · MP3/M4A' }));
  left.append(fileInput, drop);

  const mlist = el('div', { class: 'mlist', id: 'mlist' });
  left.appendChild(mlist);
  drawMedia(mlist);

  /* ---- главы ---- */
  left.appendChild(el('div', { class: 'section-head', style: 'margin:40px 0 16px' },
    el('h2', { text: 'Chapters' }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: addChapter }, 'Add chapter')));
  const clist = el('div', { id: 'clist' });
  left.appendChild(clist);
  drawChapters(clist);

  /* ---- сайдбар: видимость + действия ---- */
  right.appendChild(visibilityBox());
  right.appendChild(actionsBox());
}

/* ---------------------------------------------------------------- медиа */
async function addFiles(files) {
  if (!files.length) return;
  const host = $('#mlist');
  for (const f of files) {
    const row = el('div', { class: 'mitem' },
      el('div', { class: 'skel', style: 'width:88px;height:66px;border-radius:10px' }),
      el('div', { class: 'grow' }, el('div', { class: 'muted', text: `Uploading ${f.name}…` })));
    host.appendChild(row);
    try {
      await ensureAlbum();
      const media = await uploadMedia(f);
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
    row.remove();
    drawMedia(host);
  }
}

async function drawMedia(host) {
  clear(host);
  if (!items.length) {
    host.appendChild(el('div', { class: 'muted', style: 'padding:14px 2px', text: 'No media yet.' }));
    return;
  }
  items.sort((a, b) => a.position - b.position);
  const urls = await signUrls(items.map(i => i.media?.thumb_path || i.media?.storage_path));

  items.forEach((it, idx) => {
    const m = it.media || {};
    const src = urls[m.thumb_path] || urls[m.storage_path];
    const th = el('div', { class: 'mthumb', style: 'display:flex;align-items:center;justify-content:center;overflow:hidden' });
    if (m.kind === 'audio') th.appendChild(el('div', { style: 'font-size:12px;font-weight:700;color:#8F8B84', text: dur(m.duration_seconds) || 'AUDIO' }));
    else if (src) th.appendChild(el('img', { src, alt: '', style: 'width:100%;height:100%;object-fit:cover' }));

    const chapSel = el('select', { class: 'mini', style: 'min-width:150px', onchange: async (e) => {
      const v = e.currentTarget.value || null;
      it.chapter_id = v;
      await sb.from('album_media').update({ chapter_id: v }).eq('id', it.id);
    } },
      el('option', { value: '' }, 'No chapter'),
      ...chapters.map(c => el('option', {
        value: c.id, selected: it.chapter_id === c.id ? 'selected' : null,
      }, c.label || c.title || 'Chapter')));

    const cap = el('input', {
      class: 'input', style: 'height:36px;padding:0 12px;font-size:14px;border-radius:10px',
      placeholder: m.kind === 'audio' ? 'Voice note title' : 'Caption', maxlength: '500', value: it.caption || '',
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
          album.cover_media_id = m.id; drawMedia(host); toast('Cover updated');
        },
      }, album?.cover_media_id === m.id ? 'Cover ✓' : 'Set cover') : null,
      el('button', {
        class: 'mini danger', onclick: async () => {
          await sb.from('album_media').delete().eq('id', it.id);
          items = items.filter(x => x.id !== it.id);
          drawMedia(host);
        },
      }, 'Remove'));

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
    host.appendChild(el('div', { class: 'muted', style: 'padding:4px 2px', text: 'No chapters — media will show as one flow.' }));
    return;
  }
  chapters.sort((a, b) => a.position - b.position);
  chapters.forEach(c => {
    const save = async (patch) => { Object.assign(c, patch); await sb.from('album_chapters').update(patch).eq('id', c.id); };
    host.appendChild(el('div', { class: 'chapter-edit' },
      el('div', { class: 'row', style: 'display:flex;gap:10px;margin-bottom:10px' },
        el('input', {
          class: 'input', style: 'height:40px;max-width:180px;font-size:14px', placeholder: 'DAY 1–3',
          maxlength: '40', value: c.label || '', onchange: (e) => save({ label: e.currentTarget.value }),
        }),
        el('input', {
          class: 'input', style: 'height:40px;font-size:15px', placeholder: 'Chapter title', maxlength: '120',
          value: c.title || '', onchange: (e) => save({ title: e.currentTarget.value }),
        }),
        el('button', {
          class: 'mini danger', onclick: async () => {
            await sb.from('album_chapters').delete().eq('id', c.id);
            chapters = chapters.filter(x => x.id !== c.id);
            items.forEach(i => { if (i.chapter_id === c.id) i.chapter_id = null; });
            drawChapters(host); drawMedia($('#mlist'));
          },
        }, 'Delete')),
      el('textarea', {
        class: 'textarea', style: 'min-height:70px;font-size:15px', placeholder: 'Text of this chapter…',
        maxlength: '4000', onchange: (e) => save({ body: e.currentTarget.value }),
      }, c.body || '')));
  });
}

/* ---------------------------------------------------------------- видимость */
function visibilityBox() {
  const box = el('div', { class: 'side-card' }, el('div', { class: 'label', text: 'Who can see it' }));
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
      exceptBox.appendChild(el('div', { class: 'muted', style: 'font-size:14px', text: 'You have no friends yet.' }));
      return;
    }
    exceptBox.appendChild(el('div', { class: 'muted', style: 'font-size:13.5px;margin-bottom:8px', text: 'Tick the friends who should NOT see it:' }));
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
    ['public', 'Public', 'Anyone can find and open it'],
    ['friends', 'Friends', 'Only people you are friends with'],
    ['friends_except', 'Friends, except…', 'Friends minus the people you pick'],
    ['private', 'Only me', 'Nobody else can open it'],
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
    status.textContent = !albumId ? 'Not saved yet'
      : album?.published_at ? 'Published' : 'Draft — only you can see it';
  };
  setStatus();

  const publishBtn = el('button', { class: 'btn btn-primary', style: 'width:100%' },
    album?.published_at ? 'Save changes' : 'Publish');
  const draftBtn = el('button', { class: 'btn btn-ghost', style: 'width:100%;margin-top:10px' }, 'Save draft');

  publishBtn.onclick = () => save(true, publishBtn);
  draftBtn.onclick = () => save(false, draftBtn);

  box.append(status, publishBtn, draftBtn);

  if (albumId) {
    if (album?.published_at) {
      box.appendChild(el('button', {
        class: 'mini', style: 'width:100%;margin-top:10px;height:40px',
        onclick: async () => {
          await sb.from('albums').update({ published_at: null }).eq('id', albumId);
          album.published_at = null; setStatus(); toast('Moved back to drafts');
        },
      }, 'Unpublish'));
    }
    box.appendChild(el('button', {
      class: 'mini danger', style: 'width:100%;margin-top:10px;height:40px',
      onclick: async () => {
        if (!confirm('Delete this album? Media stays in your library.')) return;
        const { error } = await sb.from('albums').delete().eq('id', albumId);
        if (error) { toast(error.message); return; }
        location.href = 'index.html';
      },
    }, 'Delete album'));
  }
  return box;
}

async function save(publish, btn) {
  if (saving) return;
  const title = ($('#f-title').value || '').trim();
  if (!title) { toast('Give the album a title'); $('#f-title').focus(); return; }
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
      visibility: vis.base,
    };
    if (publish && !album.published_at) patch.published_at = new Date().toISOString();
    const { error } = await sb.from('albums').update(patch).eq('id', albumId);
    if (error) throw error;
    Object.assign(album, patch);

    // исключения актуальны только для friends + «кроме»
    await sb.from('album_exceptions').delete().eq('album_id', albumId);
    if (vis.base === 'friends' && vis.except && excluded.size) {
      const names = [...excluded];
      const { data: profs } = await sb.from('profiles').select('id,username').in('username', names);
      const rows = (profs || []).map(p => ({ album_id: albumId, user_id: p.id }));
      if (rows.length) await sb.from('album_exceptions').insert(rows);
    }

    toast(publish ? 'Album published' : 'Draft saved');
    if (publish) { location.href = `album.html?id=${albumId}`; return; }
  } catch (err) {
    toast(err.message || 'Could not save');
  } finally {
    saving = false;
    clear(btn).appendChild(document.createTextNode(label));
  }
}
