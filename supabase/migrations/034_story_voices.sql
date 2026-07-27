-- =====================================================================
-- 034: голосовые к кадрам и галереям, тексты-блоки, сборная история,
--      статистика прослушиваний (STORY-PLAN.md).
--
--  1. Голосовая заметка прикрепляется к кадру (album_media.voice_media_id)
--     или к галерее (album_galleries.voice_media_id). Галерея — группа кадров
--     одного альбома (album_media.gallery_id), в story-виде — карусель.
--  2. Текстовые блоки (album_texts) живут в ОДНОЙ последовательности позиций
--     с album_media; порядок целиком раздаёт album_story_reorder.
--  3. Источник истории — albums.story_mode: null = авто (голосовые, если
--     есть; иначе рассказ-нарратив из 012), 'narration' | 'voices' — выбор
--     автора. Обе конфигурации хранятся одновременно.
--  4. Прослушивания истории — событие kind='listen' в stat_events (021):
--     клиент шлёт после 5 секунд реального воспроизведения; авторские и
--     повторные (60 с, залогиненные) не считаются. Только числа, без IP.
--
-- ВНИМАНИЕ ПРО ЯДРО (правило PLAN.md — источник тела ровно один):
--   can_view_media  — переезжает сюда из 027 (добавлены ветки голосовых);
--                     ...и сразу дальше: с 035 источник — 035_story_hardening;
--   get_album       — переезжает сюда из 027 (+voice/gallery/texts/story_mode);
--                     ...и сразу дальше: с 035 источник — 035_story_hardening;
--   mod_open_album  — переезжает сюда из 023 (модератор видит всё новое);
--   user_album_story_pref, feed_recommended — переезжают сюда из 033
--     («история» = рассказ ИЛИ голосовые);
--   stats_summary   — переезжает сюда из 021 (+listens).
-- Всё остальное ядро (can_view_album из 028, ленты, narration_* из 012,
-- album_media_reorder из 027, stat_track/stat_dwell из 021) НЕ трогается.
--
-- Совместимость: только новые nullable-колонки и новые ключи в выдачах,
-- сигнатуры не меняются — старый фронт с этой базой работает.
-- =====================================================================

-- ---------------------------------------------------------------- схема

alter table public.albums add column if not exists story_mode text;
do $$ begin
  alter table public.albums add constraint albums_story_mode_chk
    check (story_mode is null or story_mode in ('narration','voices'));
exception when duplicate_object then null; end $$;

create table if not exists public.album_galleries (
  id             uuid primary key default gen_random_uuid(),
  album_id       uuid not null references public.albums(id) on delete cascade,
  voice_media_id uuid references public.media(id) on delete set null,
  created_at     timestamptz not null default now()
);

alter table public.album_media add column if not exists voice_media_id uuid
  references public.media(id) on delete set null;
alter table public.album_media add column if not exists gallery_id uuid
  references public.album_galleries(id) on delete set null;

create table if not exists public.album_texts (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references public.albums(id) on delete cascade,
  chapter_id uuid references public.album_chapters(id) on delete set null,
  position   int not null default 0 check (position >= 0),
  body       text not null check (length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index if not exists album_media_voice_idx    on public.album_media(voice_media_id) where voice_media_id is not null;
create index if not exists album_media_gallery_idx  on public.album_media(gallery_id) where gallery_id is not null;
create index if not exists album_galleries_album_idx on public.album_galleries(album_id);
create index if not exists album_galleries_voice_idx on public.album_galleries(voice_media_id) where voice_media_id is not null;
create index if not exists album_texts_album_idx    on public.album_texts(album_id, position);

alter table public.album_galleries enable row level security;
alter table public.album_texts     enable row level security;

-- Чтение — тем, кому виден альбом; запись — только через DEFINER-RPC ниже
-- (политик записи нет намеренно: валидация владения файлами живёт в RPC).
drop policy if exists galleries_read on public.album_galleries;
create policy galleries_read on public.album_galleries for select
  using (can_view_album(album_id, auth.uid()));
drop policy if exists texts_read on public.album_texts;
create policy texts_read on public.album_texts for select
  using (can_view_album(album_id, auth.uid()));

grant select on public.album_galleries, public.album_texts to anon, authenticated;

-- Прослушивания — новый вид события в существующем логе статистики.
-- Имя constraint проверено в проде: stat_events_kind_check.
alter table public.stat_events drop constraint if exists stat_events_kind_check;
alter table public.stat_events add constraint stat_events_kind_check
  check (kind in ('impression','view','button','listen'));

-- ---------------------------------------------------------------- ядро: can_view_media

/**
 * Полное тело. Источник — эта миграция (прежний — 027). Отличия от 027 —
 * ровно две новые группы веток в конце:
 *   — голосовая КАДРА видима тому, кому видим сам кадр (три ветки повторяют
 *     ветки кадра: открытый / friends / скрытый);
 *   — голосовая ГАЛЕРЕИ видима владельцу альбома и редактору всегда, а
 *     зрителю — когда альбом видим и в галерее есть видимый ему кадр.
 */
create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- владелец файла (гость события всегда видит то, что залил сам)
    exists (select 1 from media where id = m_id and owner_id = viewer)
    -- открытый файл в видимом альбоме
    or exists (select 1 from album_media am
               where am.media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- файл «только для друзей автора» внутри видимого альбома
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- скрытый файл: только владелец альбома и РЕДАКТОР. Гость события — нет.
    or exists (select 1 from album_media am
               where am.media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- обложка видимого альбома
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer))
    -- слайд видимого поста
    or exists (select 1 from post_media pm
               where pm.media_id = m_id and can_view_post(pm.post_id, viewer))
    -- аудио-рассказ виден тем же, кому виден альбом
    or exists (select 1 from album_narrations n
               where n.media_id = m_id and can_view_album(n.album_id, viewer))
    -- голосовая открытого кадра — тем, кому виден альбом
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- голосовая friends-кадра — друзьям автора (и самому автору)
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.voice_media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- голосовая скрытого кадра — только владельцу альбома и редактору
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- голосовая галереи
    or exists (select 1 from album_galleries g
               where g.voice_media_id = m_id
                 and (exists (select 1 from albums a where a.id = g.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = g.album_id and c.user_id = viewer and c.role = 'editor')
                      or (can_view_album(g.album_id, viewer)
                          and exists (select 1 from album_media am join albums a2 on a2.id = am.album_id
                                      where am.gallery_id = g.id
                                        and (not am.is_private
                                             or (am.visibility = 'friends'
                                                 and are_friends(a2.author_id, viewer)))))));
$$;

-- ---------------------------------------------------------------- ядро: get_album

/**
 * Полное тело. Источник — эта миграция (прежний — 027). Отличия от 027:
 *   — album: + story_mode;
 *   — у каждого файла: + voice_path, voice_duration, gallery_id;
 *   — новые ключи: has_voices, galleries (только с видимыми зрителю кадрами),
 *     texts (плоский список текстовых блоков).
 * Прежние ключи и фильтры не менялись.
 */
create or replace function public.get_album(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_id, auth.uid()) then null else (
    select jsonb_build_object(
      'album', jsonb_build_object(
        'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
        'date_from', a.date_from, 'date_to', a.date_to, 'date_precision', a.date_precision,
        'is_event', a.is_event, 'event_hold_guest', a.event_hold_guest,
        'event_greeting', a.event_greeting, 'cover_media_id', a.cover_media_id,
        'moderation_status', a.moderation_status, 'story_mode', a.story_mode,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
        'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id),
        'cover_thumb', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id)),
      'author', jsonb_build_object('username', p.username, 'name', p.display_name, 'avatar', p.avatar_url),
      'is_author', a.author_id = auth.uid(),
      'can_edit', can_edit_album(a.id),
      'can_contribute', can_contribute_album(a.id),
      'has_narration', exists (select 1 from album_narrations n where n.album_id = a.id),
      'has_voices', (exists (select 1 from album_media am where am.album_id = a.id and am.voice_media_id is not null)
                     or exists (select 1 from album_galleries g where g.album_id = a.id and g.voice_media_id is not null)),
      'collaborators', coalesce((
        select jsonb_agg(jsonb_build_object('username', cp.username, 'name', cp.display_name,
                                            'avatar', cp.avatar_url, 'role', c.role))
        from album_collaborators c join profiles cp on cp.id = c.user_id
        where c.album_id = a.id), '[]'::jsonb),
      'liked', exists (select 1 from likes l where l.subject_type='album' and l.subject_id=a.id and l.user_id=auth.uid()),
      'saved', exists (select 1 from saves s where s.album_id=a.id and s.user_id=auth.uid()),
      'galleries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.id,
          'voice_path', (select vm.storage_path from media vm where vm.id = g.voice_media_id),
          'voice_duration', (select vm.duration_seconds from media vm where vm.id = g.voice_media_id)))
        from album_galleries g
        where g.album_id = a.id
          and exists (select 1 from album_media am2
                      where am2.gallery_id = g.id
                        and (not am2.is_private
                             or can_edit_album(a.id)
                             or (am2.visibility = 'friends' and are_friends(a.author_id, auth.uid()))))), '[]'::jsonb),
      'texts', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'chapter_id', x.chapter_id,
                                            'position', x.position, 'body', x.body) order by x.position)
        from album_texts x where x.album_id = a.id), '[]'::jsonb),
      'chapters', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
          'media', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
              'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
              'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
              'is_private', am.is_private, 'visibility', am.visibility,
              'gallery_id', am.gallery_id,
              'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
              'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
              'mine', m.owner_id = auth.uid(),
              'by', case when can_edit_album(a.id)
                         then (select jsonb_build_object('username', up.username, 'name', up.display_name,
                                                         'avatar', up.avatar_url)
                               from profiles up where up.id = m.owner_id) end) order by am.position)
            from album_media am join media m on m.id = am.media_id
            where am.chapter_id = c.id
              and (not am.is_private
                   or can_edit_album(a.id)
                   or m.owner_id = auth.uid()
                   or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
        ) order by c.position)
        from album_chapters c where c.album_id = a.id), '[]'::jsonb),
      'loose', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
          'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
          'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
          'is_private', am.is_private, 'visibility', am.visibility,
          'gallery_id', am.gallery_id,
          'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
          'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
          'mine', m.owner_id = auth.uid(),
          'by', case when can_edit_album(a.id)
                     then (select jsonb_build_object('username', up.username, 'name', up.display_name,
                                                     'avatar', up.avatar_url)
                           from profiles up where up.id = m.owner_id) end) order by am.position)
        from album_media am join media m on m.id = am.media_id
        where am.album_id = a.id and am.chapter_id is null
          and (not am.is_private
               or can_edit_album(a.id)
               or m.owner_id = auth.uid()
               or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))), '[]'::jsonb)
    )
    from albums a join profiles p on p.id = a.author_id where a.id = p_id
  ) end;
$$;

-- ---------------------------------------------------------------- ядро: mod_open_album

/**
 * Полное тело. Источник — эта миграция (прежний — 023). Отличия от 023:
 * album.story_mode, у файлов voice_path/voice_duration/gallery_id, плюс
 * texts и galleries без фильтров — модератор обязан видеть и слышать всё,
 * что уедет на сайт. Только сервисный ключ (edge-функция mod-api).
 */
create or replace function public.mod_open_album(p_id uuid, p_login text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'album', jsonb_build_object(
      'id', a.id, 'title', a.title, 'description', a.description, 'category', a.category,
      'visibility', a.visibility, 'published_at', a.published_at, 'created_at', a.created_at,
      'date_from', a.date_from, 'date_to', a.date_to,
      'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
      'likes_count', a.likes_count, 'comments_count', a.comments_count, 'views_count', a.views_count,
      'moderation_status', a.moderation_status, 'story_mode', a.story_mode,
      'cover_path', (select m.storage_path from media m where m.id = a.cover_media_id)),
    'author', jsonb_build_object(
      'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
      'banned', p.banned_at is not null,
      'albums_total', (select count(*) from albums x where x.author_id = a.author_id),
      'joined', p.created_at),
    'collaborators', coalesce((
      select jsonb_agg(jsonb_build_object('username', cp.username, 'role', c.role))
      from album_collaborators c join profiles cp on cp.id = c.user_id
      where c.album_id = a.id), '[]'::jsonb),
    'narration', (
      select jsonb_build_object('path', m.storage_path, 'duration', n.duration, 'id', m.id)
      from album_narrations n join media m on m.id = n.media_id where n.album_id = a.id),
    'galleries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id,
        'voice_path', (select vm.storage_path from media vm where vm.id = g.voice_media_id),
        'voice_duration', (select vm.duration_seconds from media vm where vm.id = g.voice_media_id)))
      from album_galleries g where g.album_id = a.id), '[]'::jsonb),
    'texts', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'chapter_id', x.chapter_id,
                                          'position', x.position, 'body', x.body) order by x.position)
      from album_texts x where x.album_id = a.id), '[]'::jsonb),
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'label', c.label, 'title', c.title, 'body', c.body, 'position', c.position,
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
            'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
            'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
            'is_private', am.is_private,
            'gallery_id', am.gallery_id,
            'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
            'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
            'owner', (select username from profiles op where op.id = m.owner_id)) order by am.position)
          from album_media am join media m on m.id = am.media_id
          where am.chapter_id = c.id), '[]'::jsonb)
      ) order by c.position)
      from album_chapters c where c.album_id = a.id), '[]'::jsonb),
    'loose', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'am_id', am.id, 'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
        'width', m.width, 'height', m.height, 'duration', m.duration_seconds,
        'captured_at', m.captured_at, 'caption', am.caption, 'position', am.position,
        'is_private', am.is_private,
        'gallery_id', am.gallery_id,
        'voice_path', (select vm.storage_path from media vm where vm.id = am.voice_media_id),
        'voice_duration', (select vm.duration_seconds from media vm where vm.id = am.voice_media_id),
        'owner', (select username from profiles op where op.id = m.owner_id)) order by am.position)
      from album_media am join media m on m.id = am.media_id
      where am.album_id = a.id and am.chapter_id is null), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'body', cm.body, 'author', cp.username, 'created_at', cm.created_at,
        'hidden', cm.hidden_at is not null) order by cm.created_at)
      from comments cm join profiles cp on cp.id = cm.author_id
      where cm.subject_type = 'album' and cm.subject_id = a.id), '[]'::jsonb)
  )
  from albums a join profiles p on p.id = a.author_id
  where a.id = p_id;
$$;

-- ---------------------------------------------------------------- ядро: вкус к историям

/**
 * Полное тело. Источник — эта миграция (прежний — 033). Единственное отличие:
 * «альбом с историей» = есть рассказ ИЛИ есть голосовые (кадров или галерей).
 */
create or replace function public.user_album_story_pref(p_user uuid)
returns double precision language sql stable security definer set search_path = public as $$
  with eng as (
    select a.id,
           (exists(select 1 from album_narrations n where n.album_id = a.id)
            or exists(select 1 from album_media am where am.album_id = a.id and am.voice_media_id is not null)
            or exists(select 1 from album_galleries g where g.album_id = a.id and g.voice_media_id is not null)) as has_story
    from albums a
    where a.id in (
      select subject_id from likes
        where subject_type = 'album' and user_id = p_user and created_at > now() - interval '90 days'
      union
      select album_id from saves
        where user_id = p_user and created_at > now() - interval '90 days'
      union
      select album_id from album_views
        where viewer_id = p_user and day > (now() - interval '90 days')::date
    )
  )
  select case when count(*) = 0 then null
              else sum(case when has_story then 1 else 0 end)::double precision / count(*) end
  from eng;
$$;

/**
 * Полное тело. Источник — эта миграция (прежний — 033). Единственное отличие:
 * слагаемое вкуса «тип контента» узнаёт историю и по голосовым, не только по
 * рассказу. Всё остальное (веса, сигнатура, латералки) — без изменений.
 */
create or replace function public.feed_recommended(
  p_seed text default 'seed', p_limit int default 24, p_offset int default 0)
returns table (
  id uuid, title text, category text, description text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz, is_event boolean)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  weights as (
    select category, weight from user_category_weights((select uid from me))
  ),
  sp as (select user_album_story_pref((select uid from me)) as pref),
  vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'
      and can_view_album(a.id, (select uid from me))
  ),
  scored as (
    select v.*,
      ( 0.35 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
      + 0.25 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
      + 0.15 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
      + 0.15 * coalesce((select least(1.0, aq.score * 4) from author_quality aq where aq.author_id = v.author_id), 0)
      + 0.05 * case when v.published_at > now() - interval '3 days' then 1 else 0 end
      + 0.35 * coalesce((select w.weight from weights w where w.category = v.category), 0)
      -- вкус: любимые авторы (подписки)
      + 0.25 * case when exists(select 1 from follows f
                                where f.follower_id = (select uid from me) and f.following_id = v.author_id)
                    then 1 else 0 end
      -- вкус: тип контента — совпадение с предпочтением по аудио-истории
      + 0.10 * case when (exists(select 1 from album_narrations n where n.album_id = v.id)
                          or exists(select 1 from album_media am where am.album_id = v.id and am.voice_media_id is not null)
                          or exists(select 1 from album_galleries g where g.album_id = v.id and g.voice_media_id is not null))
                    then coalesce((select pref from sp), 0.5)
                    else 1 - coalesce((select pref from sp), 0.5) end
      ) as score
    from vis v
  )
  select s.id, s.title, s.category, s.description,
         p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         s.photos_count, s.videos_count, s.audio_count,
         s.likes_count, s.comments_count, s.views_count, s.published_at, s.is_event
  from scored s
  join profiles p on p.id = s.author_id
  left join media cm on cm.id = s.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = s.id and m.kind <> 'audio' and not am.is_private
      and (s.cover_media_id is null or m.id <> s.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = s.id and m.kind <> 'audio' and not am.is_private
      and (s.cover_media_id is null or m.id <> s.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by s.score desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

-- ---------------------------------------------------------------- ядро: stats_summary

/**
 * Полное тело. Источник — эта миграция (прежний — 021). Отличия: totals.listens
 * и listens у каждого альбома в разбивке. Остальные цифры не менялись.
 */
create or replace function public.stats_summary(p_album uuid default null, p_days int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  win as (select greatest(1, least(coalesce(p_days, 30), 365)) as d),
  mine as (
    select a.id, a.title, a.likes_count, a.comments_count, a.published_at, a.visibility::text as visibility
    from albums a, me
    where a.author_id = me.uid and (p_album is null or a.id = p_album)
  ),
  ev as (
    select e.* from stat_events e
    join mine m on m.id = e.album_id
    where e.created_at > now() - (select d from win) * interval '1 day'
  ),
  days as (
    select generate_series(current_date - ((select d from win) - 1), current_date, interval '1 day')::date as day
  )
  select jsonb_build_object(
    'plan', (select plan from profiles p, me where p.id = me.uid),
    'days', (select d from win),
    'totals', jsonb_build_object(
      'impressions', (select count(*) from ev where kind = 'impression'),
      'views',       (select count(*) from ev where kind = 'view'),
      'listens',     (select count(*) from ev where kind = 'listen'),
      'viewers',     (select count(distinct coalesce(actor_id::text, id::text)) from ev where kind = 'view'),
      'known_viewers', (select count(distinct actor_id) from ev where kind = 'view' and actor_id is not null),
      'avg_dwell_ms', (select coalesce(round(avg(dwell_ms)), 0) from ev where kind = 'view' and dwell_ms > 0),
      'likes',       (select coalesce(sum(likes_count), 0) from mine),
      'comments',    (select coalesce(sum(comments_count), 0) from mine),
      'albums',      (select count(*) from mine)),
    'by_day', (select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
        select jsonb_build_object(
          'day', d.day,
          'views', count(*) filter (where e.kind = 'view'),
          'impressions', count(*) filter (where e.kind = 'impression')) as x
        from days d left join ev e on e.day = d.day
        group by d.day) s),
    'geo', (select coalesce(jsonb_agg(x order by (x->>'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('code', coalesce(country, '??'), 'n', count(*)) as x
        from ev where kind = 'view' group by country order by count(*) desc limit 12) s),
    'age', (select coalesce(jsonb_agg(x order by x->>'bucket'), '[]'::jsonb) from (
        select jsonb_build_object('bucket', b, 'n', count(*)) as x from (
          select case
            when p.birth_year is null then 'unknown'
            when date_part('year', now()) - p.birth_year < 18 then '13-17'
            when date_part('year', now()) - p.birth_year < 25 then '18-24'
            when date_part('year', now()) - p.birth_year < 35 then '25-34'
            when date_part('year', now()) - p.birth_year < 45 then '35-44'
            when date_part('year', now()) - p.birth_year < 55 then '45-54'
            else '55+' end as b
          from ev e left join profiles p on p.id = e.actor_id
          where e.kind = 'view') q
        group by b) s),
    'gender', (select coalesce(jsonb_agg(x order by x->>'bucket'), '[]'::jsonb) from (
        select jsonb_build_object('bucket', coalesce(p.gender, 'unknown'), 'n', count(*)) as x
        from ev e left join profiles p on p.id = e.actor_id
        where e.kind = 'view' group by coalesce(p.gender, 'unknown')) s),
    'sources', (select coalesce(jsonb_agg(x order by (x->>'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('source', coalesce(source, 'direct'), 'n', count(*)) as x
        from ev where kind = 'view' group by source) s),
    'dwell', (select coalesce(jsonb_agg(x order by x->>'ord'), '[]'::jsonb) from (
        select jsonb_build_object('ord', o, 'bucket', b, 'n', count(*)) as x from (
          select case
            when dwell_ms < 10000  then 1 when dwell_ms < 30000  then 2
            when dwell_ms < 60000  then 3 when dwell_ms < 180000 then 4 else 5 end as o,
            case
            when dwell_ms < 10000  then '0-10s' when dwell_ms < 30000  then '10-30s'
            when dwell_ms < 60000  then '30-60s' when dwell_ms < 180000 then '1-3m' else '3m+' end as b
          from ev where kind = 'view') q
        group by o, b) s),
    'albums', (select coalesce(jsonb_agg(x order by (x->>'views')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', m.id, 'title', m.title, 'visibility', m.visibility,
          'published', m.published_at is not null,
          'likes', m.likes_count, 'comments', m.comments_count,
          'impressions', count(*) filter (where e.kind = 'impression'),
          'views', count(*) filter (where e.kind = 'view'),
          'listens', count(*) filter (where e.kind = 'listen'),
          'avg_dwell_ms', coalesce(round(avg(e.dwell_ms) filter (where e.kind = 'view' and e.dwell_ms > 0)), 0)) as x
        from mine m left join ev e on e.album_id = m.id
        group by m.id, m.title, m.visibility, m.published_at, m.likes_count, m.comments_count) s),
    'buttons', (select coalesce(jsonb_agg(x order by (x->>'clicks')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url,
          'clicks', (select count(*) from stat_events se
                     where se.button_id = b.id
                       and se.created_at > now() - (select d from win) * interval '1 day')) as x
        from profile_buttons b, me where b.owner_id = me.uid) s)
  );
$$;

-- ---------------------------------------------------------------- RPC: голосовые

/**
 * Удаляет строку media голосовой, если она больше нигде не используется.
 * Только свой файл и только kind=audio — вызывается из RPC ниже после
 * открепления, чтобы перезаписи не копили сироты в библиотеке и квоте.
 * (Квота R2 чистится лениво в r2_reserve_upload по отсутствию строки media.)
 */
create or replace function public.voice_media_prune(p_media uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_media is null then return; end if;
  delete from media m
   where m.id = p_media
     and m.owner_id = auth.uid()
     and m.kind = 'audio'
     and not exists (select 1 from album_media    where media_id = p_media)
     and not exists (select 1 from album_media    where voice_media_id = p_media)
     and not exists (select 1 from album_galleries where voice_media_id = p_media)
     and not exists (select 1 from album_narrations where media_id = p_media)
     and not exists (select 1 from post_media     where media_id = p_media)
     and not exists (select 1 from albums         where cover_media_id = p_media);
end $$;

/** Прикрепить голосовую к кадру. Только своя запись, кадр — не аудио. */
create or replace function public.album_voice_set(p_am uuid, p_media uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; k media_kind; old_voice uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select am.album_id, m.kind, am.voice_media_id into a_id, k, old_voice
    from album_media am join media m on m.id = am.media_id
   where am.id = p_am;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  if k = 'audio' then raise exception 'Голосовую нельзя прикрепить к аудио'; end if;
  if not exists (select 1 from media where id = p_media and owner_id = me and kind = 'audio') then
    raise exception 'Можно использовать только свою запись';
  end if;
  update album_media set voice_media_id = p_media where id = p_am;
  if old_voice is not null and old_voice <> p_media then perform voice_media_prune(old_voice); end if;
  return jsonb_build_object('ok', true);
end $$;

/** Открепить голосовую от кадра (и убрать файл, если он больше не нужен). */
create or replace function public.album_voice_clear(p_am uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; old_voice uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select am.album_id, am.voice_media_id into a_id, old_voice from album_media am where am.id = p_am;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  update album_media set voice_media_id = null where id = p_am;
  perform voice_media_prune(old_voice);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- RPC: галереи

/**
 * Собрать галерею из 2–30 кадров ОДНОЙ главы этого альбома. Кадры получают
 * последовательные позиции с места первого; чистовой порядок истории затем
 * раздаёт album_story_reorder (редактор вызывает его следом).
 */
create or replace function public.album_gallery_group(p_album uuid, p_am_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); g_id uuid; n int; nch int; base_pos int;
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if p_am_ids is null or coalesce(array_length(p_am_ids, 1), 0) < 2
     or array_length(p_am_ids, 1) > 30 then
    raise exception 'В галерее от 2 до 30 кадров';
  end if;

  select count(*), min(am.position) into n, base_pos
    from album_media am join media m on m.id = am.media_id
   where am.id = any(p_am_ids) and am.album_id = p_album
     and m.kind <> 'audio' and am.gallery_id is null;
  if n <> array_length(p_am_ids, 1) then
    raise exception 'Кадры должны быть из этого альбома, не аудио и не в другой галерее';
  end if;
  select count(distinct coalesce(am.chapter_id::text, '-')) into nch
    from album_media am where am.id = any(p_am_ids);
  if nch > 1 then raise exception 'Галерея живёт внутри одной главы'; end if;

  insert into album_galleries (album_id) values (p_album) returning id into g_id;
  update album_media am set gallery_id = g_id, position = base_pos + x.ord - 1
    from (select unnest(p_am_ids) as id, generate_subscripts(p_am_ids, 1) as ord) x
   where am.id = x.id;
  return jsonb_build_object('id', g_id);
end $$;

/** Разобрать галерею: кадры остаются на местах, голос галереи откр. и чистится. */
create or replace function public.album_gallery_ungroup(p_gallery uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; old_voice uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select album_id, voice_media_id into a_id, old_voice from album_galleries where id = p_gallery;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  update album_media set gallery_id = null where gallery_id = p_gallery;
  delete from album_galleries where id = p_gallery;
  perform voice_media_prune(old_voice);
  return jsonb_build_object('ok', true);
end $$;

/** Голосовая галереи. Только своя запись. */
create or replace function public.album_gallery_voice_set(p_gallery uuid, p_media uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; old_voice uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select album_id, voice_media_id into a_id, old_voice from album_galleries where id = p_gallery;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  if not exists (select 1 from media where id = p_media and owner_id = me and kind = 'audio') then
    raise exception 'Можно использовать только свою запись';
  end if;
  update album_galleries set voice_media_id = p_media where id = p_gallery;
  if old_voice is not null and old_voice <> p_media then perform voice_media_prune(old_voice); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.album_gallery_voice_clear(p_gallery uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; old_voice uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select album_id, voice_media_id into a_id, old_voice from album_galleries where id = p_gallery;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  update album_galleries set voice_media_id = null where id = p_gallery;
  perform voice_media_prune(old_voice);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- RPC: тексты

/** Текстовый блок: вставка (p_id null) или правка. Не больше 200 на альбом. */
create or replace function public.album_text_upsert(
  p_id uuid, p_album uuid, p_chapter uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); b text := btrim(coalesce(p_body, '')); r album_texts;
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if b = '' then raise exception 'Пустой текст'; end if;
  if length(b) > 4000 then raise exception 'Слишком длинный текст'; end if;
  if p_chapter is not null and not exists (
    select 1 from album_chapters where id = p_chapter and album_id = p_album) then
    raise exception 'Глава не из этого альбома';
  end if;

  if p_id is null then
    if (select count(*) from album_texts where album_id = p_album) >= 200 then
      raise exception 'Слишком много текстовых блоков';
    end if;
    insert into album_texts (album_id, chapter_id, position, body)
    values (p_album, p_chapter,
            greatest(coalesce((select max(position) from album_media where album_id = p_album), -1),
                     coalesce((select max(position) from album_texts  where album_id = p_album), -1)) + 1,
            b)
    returning * into r;
  else
    update album_texts set body = b, chapter_id = p_chapter
     where id = p_id and album_id = p_album
    returning * into r;
    if r.id is null then raise exception 'Блок не найден'; end if;
  end if;
  return jsonb_build_object('id', r.id, 'chapter_id', r.chapter_id,
                            'position', r.position, 'body', r.body);
end $$;

create or replace function public.album_text_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select album_id into a_id from album_texts where id = p_id;
  if a_id is null or not can_edit_album(a_id) then raise exception 'Недостаточно прав'; end if;
  delete from album_texts where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- RPC: порядок и режим

/**
 * Порядок истории целиком: [{t:'m'|'x', id}, ...] — медиа и тексты в одной
 * последовательности. Чужие/несуществующие id молча пропускаются (как в
 * narration_cues_set): фильтр по album_id стоит в самих UPDATE.
 */
create or replace function public.album_story_reorder(p_album uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n1 int; n2 int;
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Ожидается массив'; end if;
  if jsonb_array_length(p_items) > 1000 then raise exception 'Слишком много элементов'; end if;

  update album_media am set position = x.ord - 1
    from (select (e->>'id')::uuid as id, t.ord
            from jsonb_array_elements(p_items) with ordinality as t(e, ord)
           where e->>'t' = 'm') x
   where am.id = x.id and am.album_id = p_album;
  get diagnostics n1 = row_count;

  update album_texts tx set position = x.ord - 1
    from (select (e->>'id')::uuid as id, t.ord
            from jsonb_array_elements(p_items) with ordinality as t(e, ord)
           where e->>'t' = 'x') x
   where tx.id = x.id and tx.album_id = p_album;
  get diagnostics n2 = row_count;

  return jsonb_build_object('media', n1, 'texts', n2);
end $$;

/** Источник истории: 'auto' (null) | 'narration' | 'voices'. */
create or replace function public.album_story_mode_set(p_album uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  if not can_edit_album(p_album) then raise exception 'Недостаточно прав'; end if;
  if p_mode not in ('auto', 'narration', 'voices') then raise exception 'bad mode'; end if;
  update albums set story_mode = nullif(p_mode, 'auto') where id = p_album;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- RPC: прослушивания

/**
 * Прослушивание истории ≥5 секунд (порог держит клиент, событие — одно на
 * показ). Автор не считается; залогиненный — не чаще раза в 60 секунд по
 * альбому; гость — простая вставка (тот же принятый компромисс, что у
 * просмотров в stat_track). IP не сохраняется нигде.
 */
create or replace function public.stat_listen(
  p_album uuid, p_country text default null, p_lang text default null)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); own uuid;
begin
  if p_album is null then return; end if;
  select author_id into own from albums where id = p_album;
  if own is null then return; end if;
  if uid is not null and uid = own then return; end if;
  if not can_view_album(p_album, uid) then return; end if;

  if uid is not null and exists (
    select 1 from stat_events e
    where e.album_id = p_album and e.actor_id = uid and e.kind = 'listen'
      and e.created_at > now() - interval '60 seconds')
  then
    return;
  end if;

  insert into stat_events (kind, album_id, owner_id, actor_id, country, lang)
  values ('listen', p_album, own, uid,
          nullif(upper(left(coalesce(p_country, ''), 2)), ''),
          nullif(lower(left(coalesce(p_lang, ''), 5)), ''));
end $$;

-- ---------------------------------------------------------------- гранты
-- Сначала снять то, что Supabase выдал сам (гоча 020), потом выдать точечно.

revoke execute on function public.voice_media_prune(uuid)                from public, anon, authenticated;

revoke execute on function public.album_voice_set(uuid,uuid)             from public, anon, authenticated;
revoke execute on function public.album_voice_clear(uuid)                from public, anon, authenticated;
revoke execute on function public.album_gallery_group(uuid,uuid[])       from public, anon, authenticated;
revoke execute on function public.album_gallery_ungroup(uuid)            from public, anon, authenticated;
revoke execute on function public.album_gallery_voice_set(uuid,uuid)     from public, anon, authenticated;
revoke execute on function public.album_gallery_voice_clear(uuid)        from public, anon, authenticated;
revoke execute on function public.album_text_upsert(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.album_text_delete(uuid)                from public, anon, authenticated;
revoke execute on function public.album_story_reorder(uuid,jsonb)        from public, anon, authenticated;
revoke execute on function public.album_story_mode_set(uuid,text)        from public, anon, authenticated;
revoke execute on function public.stat_listen(uuid,text,text)            from public, anon, authenticated;

grant execute on function
  public.album_voice_set(uuid,uuid),
  public.album_voice_clear(uuid),
  public.album_gallery_group(uuid,uuid[]),
  public.album_gallery_ungroup(uuid),
  public.album_gallery_voice_set(uuid,uuid),
  public.album_gallery_voice_clear(uuid),
  public.album_text_upsert(uuid,uuid,uuid,text),
  public.album_text_delete(uuid),
  public.album_story_reorder(uuid,jsonb),
  public.album_story_mode_set(uuid,text)
to authenticated;

grant execute on function public.stat_listen(uuid,text,text) to anon, authenticated;

-- Переподтверждение прав на переписанное ядро (create or replace сохраняет
-- ACL, но правило проекта — задавать их явно в источнике тела).
grant execute on function public.can_view_media(uuid,uuid), public.get_album(uuid),
  public.user_album_story_pref(uuid), public.feed_recommended(text,int,int)
to anon, authenticated;
grant execute on function public.stats_summary(uuid,int) to authenticated;
revoke execute on function public.mod_open_album(uuid,text) from public, anon, authenticated;
