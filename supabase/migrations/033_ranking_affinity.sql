-- 033: ранжирование постов + сигнал «что нравится» (~20%) в обеих лентах.
--
-- Что делает:
--  1) user_album_story_pref / user_post_vid_pref — предпочтение пользователя по
--     ТИПУ контента (альбом с аудио-историей или без; пост с видео или только
--     фото), выведенное из того, что он лайкал/сохранял/смотрел за 90 дней.
--  2) feed_recommended (альбомы) — добавляет к скору два слагаемых «вкуса»:
--     любимые авторы (подписки) и совпадение по типу (аудио-история). Категория
--     учитывалась и раньше. Ядро видимости не трогаем — функции только читают.
--  3) feed_posts_recommended — НОВАЯ ранжированная лента постов по той же
--     философии, что у альбомов (голый Postgres, взвешенная сумма сигналов).
--     У постов нет просмотров, сохранений и категории, поэтому «вкус» = любимые
--     авторы + тип (фото/видео); свежесть держим доминирующей — лента постов
--     эфемерна, свежак не должен тонуть под старой популярной каруселью.
--
-- Механика «20%»: мягкий вес в общей формуле (не жёсткая квота) — единообразно с
-- тем, как уже сделана «любимая категория до 70%». Слагаемые вкуса в сумме дают
-- заметную долю выдачи (у альбомов авторы+категория+тип, у постов авторы+тип).
--
-- Аноним / новый пользователь: сигналов нет, follows пуст, pref = NULL → лента
-- корректно вырождается в популярность + свежесть + случайность.

-- ------------------------------------------------ предпочтение по типу контента

/**
 * Доля альбомов С аудио-историей среди тех, с которыми пользователь
 * взаимодействовал (лайк / сейв / просмотр) за 90 дней. NULL — сигналов нет.
 */
create or replace function public.user_album_story_pref(p_user uuid)
returns double precision language sql stable security definer set search_path = public as $$
  with eng as (
    select a.id, exists(select 1 from album_narrations n where n.album_id = a.id) as has_story
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
 * Доля постов С видео среди тех, что пользователь лайкал за 90 дней.
 * NULL — сигналов нет. (У постов нет просмотров/сейвов, поэтому сигнал — лайки.)
 */
create or replace function public.user_post_vid_pref(p_user uuid)
returns double precision language sql stable security definer set search_path = public as $$
  with liked as (
    select p.id,
      exists(select 1 from post_media pm join media m on m.id = pm.media_id
             where pm.post_id = p.id and m.kind = 'video') as has_video
    from posts p
    where p.id in (
      select subject_id from likes
        where subject_type = 'post' and user_id = p_user and created_at > now() - interval '90 days'
    )
  )
  select case when count(*) = 0 then null
              else sum(case when has_video then 1 else 0 end)::double precision / count(*) end
  from liked;
$$;

-- ------------------------------------------------ альбомы: + любимые авторы и тип
--
-- Пересоздаём feed_recommended из 029 с ДВУМЯ новыми слагаемыми. Всё остальное
-- (сигнатура, вывод с is_event, врезки-латералки) — без изменений.

drop function if exists public.feed_recommended(text, int, int);
create function public.feed_recommended(
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
      + 0.10 * case when exists(select 1 from album_narrations n where n.album_id = v.id)
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

-- ------------------------------------------------ посты: ранжированная лента
--
-- Сигнатура вывода 1:1 совпадает с feed_posts — фронт рендерит те же карточки,
-- меняется только порядок. feed_posts (хронология) остаётся в базе как запас/
-- будущая вкладка «Свежее».
--
-- Веса (сумма ≈ 1, важны относительные величины):
--   0.34 свежесть  — доминирует: посты эфемерны, свежак держим наверху
--   0.22 популярность (лайки×3 + комменты×2; просмотров у постов нет)
--   0.22 любимые авторы (подписки)          ┐ «вкус» ≈ 0.32 бюджета → ≥20% ленты
--   0.10 тип контента (фото/видео, вкус)    ┘
--   0.08 сид-случайность (лёгкое перемешивание, стабильна на сессию)
--   0.04 стартовый буст самым свежим (первые 12 ч)

create or replace function public.feed_posts_recommended(
  p_seed text default 'seed', p_limit int default 12, p_offset int default 0)
returns table (
  id uuid, caption text, created_at timestamptz,
  author_username text, author_name text, author_avatar text,
  coauthor_username text, coauthor_name text,
  likes_count int, comments_count int, liked boolean, slides jsonb)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  vp as (select user_post_vid_pref((select uid from me)) as pref),
  vis as (
    select p.* from posts p
    where p.hidden_at is null and can_view_post(p.id, (select uid from me))
  ),
  scored as (
    select v.*,
      exists(select 1 from post_media pm join media m on m.id = pm.media_id
             where pm.post_id = v.id and m.kind = 'video') as has_video
    from vis v
  )
  select s.id, s.caption, s.created_at,
         pr.username, pr.display_name, pr.avatar_url,
         co.username, co.display_name,
         s.likes_count, s.comments_count,
         exists(select 1 from likes l where l.subject_type = 'post' and l.subject_id = s.id
                  and l.user_id = (select uid from me)),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
             'width', m.width, 'height', m.height) order by pm.position)
           from post_media pm join media m on m.id = pm.media_id
           where pm.post_id = s.id), '[]'::jsonb)
  from scored s
  join profiles pr on pr.id = s.author_id
  left join profiles co on co.id = s.coauthor_id
  order by
      0.34 * exp(- extract(epoch from (now() - s.created_at)) / (5 * 86400))
    + 0.22 * least(1.0, ln(1 + s.likes_count * 3 + s.comments_count * 2)::double precision / ln(100))
    + 0.22 * case when exists(select 1 from follows f
                              where f.follower_id = (select uid from me) and f.following_id = s.author_id)
                  then 1 else 0 end
    + 0.10 * case when s.has_video then coalesce((select pref from vp), 0.5)
                  else 1 - coalesce((select pref from vp), 0.5) end
    + 0.08 * ((('x0' || substr(md5(s.id::text || p_seed), 1, 7))::bit(32)::int)::double precision / 268435455.0)
    + 0.04 * case when s.created_at > now() - interval '12 hours' then 1 else 0 end
    desc
  limit greatest(1, least(p_limit, 40)) offset greatest(0, p_offset);
$$;

-- ------------------------------------------------ гранты

grant execute on function
  public.user_album_story_pref(uuid),
  public.user_post_vid_pref(uuid),
  public.feed_recommended(text, int, int),
  public.feed_posts_recommended(text, int, int)
to anon, authenticated;
