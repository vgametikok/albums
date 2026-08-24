-- =====================================================================
-- 048: пустые альбомы не попадают на главную.
--
-- Опубликованный альбом без единого видимого кадра (только аудио, всё
-- скрыто или вовсе ничего) рисовался на главной серой карточкой «empty».
-- В профиле автора такой альбом остаётся — это его полка и его черновая
-- работа, — но витрина не должна предлагать смотреть то, в чём нечего
-- смотреть.
--
-- Правило одно на все три выдачи главной: в альбоме есть хотя бы один
-- НЕ-аудио файл, не скрытый от посторонних. Условие дословно повторяет
-- lateral-подзапрос t1, которым карточка выбирает превью: «карточка была
-- бы пустой» и «альбом отфильтрован» — одно и то же условие, разойтись
-- они не могут. Календарь намеренно не тронут: там человек видит и свои
-- приватные альбомы по датам, это полка, а не витрина.
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь целиком переписываются feed_albums,
-- feed_recommended и trending_albums. С этого момента единственный
-- источник их полного тела — ЭТА миграция (правило из PLAN.md; прежние
-- тела были в 025/033).
-- =====================================================================

create or replace function public.feed_albums(
  p_seed text default 'seed', p_category text default null,
  p_limit int default 24, p_offset int default 0)
returns table(id uuid, title text, category text, description text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz, is_event boolean)
language sql stable security definer set search_path = public as $$
  with vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'
      and can_view_album(a.id, auth.uid())
      and (p_category is null or a.category = p_category)
      -- витрина: есть что показать (см. шапку миграции 048)
      and exists (select 1 from album_media am join media m on m.id = am.media_id
                  where am.album_id = a.id and m.kind <> 'audio' and not am.is_private)
  )
  select v.id, v.title, v.category, v.description,
         p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         v.photos_count, v.videos_count, v.audio_count,
         v.likes_count, v.comments_count, v.views_count, v.published_at, v.is_event
  from vis v
  join profiles p on p.id = v.author_id
  left join media cm on cm.id = v.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by
    0.5 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
  + 0.3 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
  + 0.2 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
    desc
  limit greatest(1, least(p_limit, 60)) offset greatest(0, p_offset);
$$;

create or replace function public.feed_recommended(
  p_seed text default 'seed', p_limit int default 24, p_offset int default 0)
returns table(id uuid, title text, category text, description text,
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
      -- витрина: есть что показать (см. шапку миграции 048)
      and exists (select 1 from album_media am join media m on m.id = am.media_id
                  where am.album_id = a.id and m.kind <> 'audio' and not am.is_private)
  ),
  scored as (
    select v.*,
      ( 0.35 * ((('x0' || substr(md5(v.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
      + 0.25 * least(1.0, ln(1 + v.likes_count * 3 + v.views_count)::double precision / ln(1000))
      + 0.15 * exp(- extract(epoch from (now() - v.published_at)) / (14 * 86400))
      + 0.15 * coalesce((select least(1.0, aq.score * 4) from author_quality aq where aq.author_id = v.author_id), 0)
      + 0.05 * case when v.published_at > now() - interval '3 days' then 1 else 0 end
      + 0.35 * coalesce((select w.weight from weights w where w.category = v.category), 0)
      -- плюс: любимые авторы (подписки)
      + 0.25 * case when exists(select 1 from follows f
                                where f.follower_id = (select uid from me) and f.following_id = v.author_id)
                    then 1 else 0 end
      -- плюс: есть ли озвучка — сопоставляем со склонностью к аудио-историям
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

create or replace function public.trending_albums(p_period text default 'week', p_limit int default 24)
returns table(id uuid, title text, category text,
  author_username text, author_name text, author_avatar text,
  cover_path text, thumb1_path text, thumb1_kind media_kind,
  thumb2_path text, thumb2_kind media_kind,
  photos_count int, videos_count int, audio_count int,
  likes_count int, comments_count int, views_count int,
  published_at timestamptz, heat double precision, is_event boolean)
language sql stable security definer set search_path = public as $$
  with win as (
    select case when p_period = 'month' then interval '30 days' else interval '7 days' end as w
  ),
  vis as (
    select a.* from albums a
    where a.published_at is not null and a.hidden_at is null
      and a.visibility <> 'private'
      and can_view_album(a.id, auth.uid())
      -- витрина: есть что показать (см. шапку миграции 048)
      and exists (select 1 from album_media am join media m on m.id = am.media_id
                  where am.album_id = a.id and m.kind <> 'audio' and not am.is_private)
  ),
  heat as (
    select v.id,
      ( coalesce((select count(*) from likes l where l.subject_type='album' and l.subject_id=v.id
                    and l.created_at > now() - (select w from win)), 0) * 3
      + coalesce((select count(*) from saves s where s.album_id=v.id
                    and s.created_at > now() - (select w from win)), 0) * 4
      + coalesce((select count(*) from comments c where c.subject_type='album' and c.subject_id=v.id
                    and c.created_at > now() - (select w from win) and c.hidden_at is null), 0) * 2
      + coalesce((select count(*) from album_views av where av.album_id=v.id
                    and av.day > (now() - (select w from win))::date), 0) * 1
      )::double precision as heat
    from vis v
  )
  select v.id, v.title, v.category, p.username, p.display_name, p.avatar_url,
         coalesce(cm.thumb_path, cm.storage_path, t1.path),
         t1.path, t1.kind, t2.path, t2.kind,
         v.photos_count, v.videos_count, v.audio_count,
         v.likes_count, v.comments_count, v.views_count, v.published_at, h.heat, v.is_event
  from vis v
  join heat h on h.id = v.id and h.heat > 0
  join profiles p on p.id = v.author_id
  left join media cm on cm.id = v.cover_media_id
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 0) t1 on true
  left join lateral (
    select coalesce(m.thumb_path, m.storage_path) as path, m.kind from album_media am
    join media m on m.id = am.media_id
    where am.album_id = v.id and m.kind <> 'audio' and not am.is_private
      and (v.cover_media_id is null or m.id <> v.cover_media_id)
    order by am.position limit 1 offset 1) t2 on true
  order by h.heat desc, v.published_at desc
  limit greatest(1, least(p_limit, 60));
$$;
