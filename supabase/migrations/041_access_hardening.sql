-- =====================================================================
-- 041 — закрытие брешей доступа, найденных аудитом 5 августа 2026.
--
-- Общая причина всех правок: can_view_media росла ветками «а ещё это видно
-- вот отсюда», и часть веток стала доверять указателям, которые пишет сам
-- клиент. Указатель на медиа сам по себе доступа давать не должен — нужно,
-- чтобы файл либо принадлежал автору альбома, либо был реально привязан
-- к этому альбому строкой album_media.
--
-- Что здесь:
--   1) can_view_media — ветки «обложка» и «озвучка альбома» с проверкой
--      происхождения файла;
--   2) страж album_narrations — озвучкой можно поставить только СВОЁ аудио
--      (по образцу album_media_guard_t из 035);
--   3) amedia_read — придержанные кадры больше не видны всем зрителям;
--   4) profiles — поколоночный grant вместо табличного: revoke колонок,
--      который пытались сделать в 021, в Postgres не работает;
--   5) mod_recent_fails — функция жила только в проде (hot-fix), из-за чего
--      репозиторий не воспроизводил базу;
--   6) cleanup_anon_users — гость с альбомом или текстом больше не сносится;
--   7) уведомление о новом альбоме на проверку теперь ловит и INSERT
--      (событийный альбом создаётся сразу опубликованным);
--   8) is_author в лентах постов и author_avatar в поиске — поля, которых
--      ждал фронт;
--   9) черновики, ошибочно одобренные бэкфиллом 022, возвращены в очередь.
-- =====================================================================

-- ------------------------------------------------ 1. видимость медиа

/**
 * Кто может видеть файл. Ветки, идущие «по указателю» (обложка альбома,
 * озвучка альбома), требуют, чтобы файл был либо автора альбома, либо
 * привязан к этому же альбому открытым кадром: иначе достаточно вписать
 * чужой uuid обложкой своего черновика, чтобы получить подписанную ссылку.
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
    -- обложка видимого альбома: только если файл автора альбома либо открытый
    -- кадр этого же альбома (автообложка события ставит именно такой)
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer)
                 and (exists (select 1 from media m where m.id = m_id and m.owner_id = al.author_id)
                      or exists (select 1 from album_media am
                                 where am.album_id = al.id and am.media_id = m_id and not am.is_private)))
    -- слайд видимого поста
    or exists (select 1 from post_media pm
               where pm.media_id = m_id and can_view_post(pm.post_id, viewer))
    -- аудио-рассказ виден тем же, кому виден альбом, но только если запись
    -- принадлежит автору альбома (страж ниже держит это и на входе)
    or exists (select 1 from album_narrations n join albums a on a.id = n.album_id
               where n.media_id = m_id and can_view_album(n.album_id, viewer)
                 and exists (select 1 from media m where m.id = m_id and m.owner_id = a.author_id))
    -- голосовая открытого кадра — тем, кому виден альбом
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- голосовая friends-кадра — друзьям автора (и самому автору)
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.voice_media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- голосовая скрытого кадра — только владельцу альбома и редакторам
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
                                      where am.gallery_id = g.id and am.album_id = g.album_id
                                        and (not am.is_private
                                             or (am.visibility = 'friends'
                                                 and are_friends(a2.author_id, viewer)))))));
$$;

-- ------------------------------------------------ 2. страж озвучки альбома

/**
 * Аудио-рассказом альбома можно поставить только СВОЮ запись. Политика
 * narration_all проверяет права на альбом, но не на файл, а RPC narration_set
 * прямой PATCH через PostgREST не перехватывает.
 */
create or replace function public.trg_album_narration_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then r := null;
  end;
  if coalesce(r, 'service_role') = 'service_role' then return new; end if;

  if new.media_id is not null
     and (tg_op = 'INSERT' or new.media_id is distinct from old.media_id)
     and not exists (select 1 from media m
                     where m.id = new.media_id and m.owner_id = auth.uid()
                       and m.kind = 'audio') then
    raise exception 'Можно использовать только свою запись';
  end if;
  return new;
end $$;

drop trigger if exists album_narration_guard_t on public.album_narrations;
create trigger album_narration_guard_t before insert or update on public.album_narrations
  for each row execute function public.trg_album_narration_guard();

revoke execute on function public.trg_album_narration_guard() from public, anon, authenticated;

-- ------------------------------------------------ 3. придержанные кадры

-- Зритель альбома читал ВСЕ строки album_media, включая придержанные
-- гостевые и скрытые модератором: подписи и сам факт скрытого кадра утекали
-- (файлы при этом защищены can_view_media). Условие повторяет её логику.
drop policy if exists amedia_read on album_media;
create policy amedia_read on album_media for select using (
  can_view_album(album_id, auth.uid())
  and (
    not is_private
    or can_edit_album(album_id)
    or exists (select 1 from media m where m.id = media_id and m.owner_id = auth.uid())
    or (visibility = 'friends'
        and exists (select 1 from albums a where a.id = album_id
                    and (a.author_id = auth.uid() or are_friends(a.author_id, auth.uid()))))
  ));

-- ------------------------------------------------ 4. демография профиля

-- В 021 стоял revoke select (birth_year, gender) — в Postgres поколоночный
-- revoke НЕ вычитается из выданного ранее табличного grant, и демография
-- читалась через REST кем угодно. Лечится только заменой табличного гранта
-- на поколоночный.
revoke all on public.profiles from anon, authenticated;

grant select (id, username, display_name, avatar_url, banner_url, bio, location,
              created_at, followers_count, following_count, plan, banned_at, deleted_at)
  on public.profiles to anon, authenticated;

-- Писать в свою строку разрешает политика profiles_update; тариф и бан
-- по-прежнему держит trg_profile_guard, демография — только через RPC.
grant update (display_name, avatar_url, banner_url, bio, location)
  on public.profiles to authenticated;

-- ------------------------------------------------ 5. счётчик неудачных входов

/**
 * Неудачные попытки входа модератора за 15 минут. Функция была создана
 * когда-то напрямую в проде и в миграциях отсутствовала: на чистой базе
 * revoke в 020 падал и всё, что за ним, не применялось.
 */
create or replace function public.mod_recent_fails(p_ip text)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select count(*)::int from mod_login_attempts
                   where ip_hash = p_ip and not ok and created_at > now() - interval '15 minutes'), 0);
$$;

revoke execute on function public.mod_recent_fails(text) from public, anon, authenticated;

-- ------------------------------------------------ 6. уборка анонимов

/**
 * Удаляет анонимные аккаунты старше p_min_age БЕЗ контента. К файлам,
 * комментариям и постам добавлены альбомы: анонимная сессия — полноправный
 * authenticated и может завести альбом из одних текстовых блоков, который
 * каскадом ушёл бы вместе с пользователем (тексты живут внутри альбома,
 * своего автора у них нет).
 */
create or replace function public.cleanup_anon_users(p_min_age interval default interval '30 days')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with victims as (
    select u.id from auth.users u
    where coalesce(u.is_anonymous, false)
      and u.created_at < now() - p_min_age
      and not exists (select 1 from media m where m.owner_id = u.id)
      and not exists (select 1 from comments c where c.author_id = u.id)
      and not exists (select 1 from posts p where p.author_id = u.id)
      and not exists (select 1 from albums a where a.author_id = u.id)
  )
  delete from auth.users u using victims v where u.id = v.id;
  get diagnostics n = row_count;

  if n > 0 then
    insert into anon_cleanup_log (deleted) values (n);
  end if;
  return n;
end $$;

revoke execute on function public.cleanup_anon_users(interval) from public, anon, authenticated;

-- ------------------------------------------------ 7. пинг о новом альбоме

-- Событийный альбом создаётся сразу с published_at и статусом pending, то
-- есть попадает в очередь модерации через INSERT, а триггер висел только на
-- UPDATE — в очередь альбом падал молча.
drop trigger if exists trg_notify_album_review_ins on public.albums;
create trigger trg_notify_album_review_ins after insert on public.albums
  for each row
  when (new.published_at is not null and new.moderation_status = 'pending')
  execute function public.trg_notify_album_review();

-- ------------------------------------------------ 8. поля, которых ждал фронт

-- is_author: без него автор поста не мог удалить чужой комментарий в своей
-- ленте. author_avatar в поиске: карточка альбома рисовала пустую картинку.
drop function if exists public.feed_posts(int, int);
create function public.feed_posts(p_limit int default 12, p_offset int default 0)
returns table (
  id uuid, caption text, created_at timestamptz,
  author_username text, author_name text, author_avatar text,
  coauthor_username text, coauthor_name text,
  likes_count int, comments_count int, liked boolean, is_author boolean, slides jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.caption, p.created_at,
         pr.username, pr.display_name, pr.avatar_url,
         co.username, co.display_name,
         p.likes_count, p.comments_count,
         exists (select 1 from likes l where l.subject_type='post' and l.subject_id=p.id and l.user_id=auth.uid()),
         auth.uid() is not null and (p.author_id = auth.uid() or p.coauthor_id = auth.uid()),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
             'width', m.width, 'height', m.height) order by pm.position)
           from post_media pm join media m on m.id = pm.media_id
           where pm.post_id = p.id), '[]'::jsonb)
  from posts p
  join profiles pr on pr.id = p.author_id
  left join profiles co on co.id = p.coauthor_id
  where p.hidden_at is null and can_view_post(p.id, auth.uid())
  order by p.created_at desc
  limit greatest(1, least(p_limit, 40)) offset greatest(0, p_offset);
$$;

drop function if exists public.feed_posts_recommended(text, int, int);
create function public.feed_posts_recommended(
  p_seed text default 'seed', p_limit int default 12, p_offset int default 0)
returns table (
  id uuid, caption text, created_at timestamptz,
  author_username text, author_name text, author_avatar text,
  coauthor_username text, coauthor_name text,
  likes_count int, comments_count int, liked boolean, is_author boolean, slides jsonb)
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
         (select uid from me) is not null
           and (s.author_id = (select uid from me) or s.coauthor_id = (select uid from me)),
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

grant execute on function
  public.feed_posts(int, int),
  public.feed_posts_recommended(text, int, int)
to anon, authenticated;

create or replace function public.search_all(p_q text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'title', a.title, 'category', a.category,
        'author_username', p.username, 'author_name', p.display_name,
        'author_avatar', p.avatar_url,
        'photos_count', a.photos_count, 'videos_count', a.videos_count, 'audio_count', a.audio_count,
        'views_count', a.views_count, 'published_at', a.published_at,
        'visibility', a.visibility, 'is_event', a.is_event,
        'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
        'thumb1', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1),
        'thumb2', (select coalesce(m.thumb_path, m.storage_path) from album_media am join media m on m.id=am.media_id
                   where am.album_id=a.id and m.kind<>'audio' and not am.is_private order by am.position limit 1 offset 1)))
      from albums a join profiles p on p.id = a.author_id
      where a.published_at is not null and a.hidden_at is null
        and (a.visibility <> 'private' or a.author_id = auth.uid())
        and can_view_album(a.id, auth.uid()) and a.title ilike '%' || p_q || '%'
      limit 24), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url, 'bio', p.bio))
      from profiles p
      where p.banned_at is null and p.deleted_at is null
        and not is_blocked_between(p.id, auth.uid())
        and (p.username ilike '%' || p_q || '%' or p.display_name ilike '%' || p_q || '%')
      limit 12), '[]'::jsonb));
$$;

grant execute on function public.search_all(text) to anon, authenticated;

-- ------------------------------------------------ 9. хвост бэкфилла 022

-- В 022 условие «created_at < now()» истинно вообще для всех строк, поэтому
-- одобрены были и неопубликованные черновики — при публикации они миновали
-- бы премодерацию. Возвращаем в очередь только то, что ещё не публиковалось.
update public.albums
   set moderation_status = 'pending', reviewed_at = null
 where published_at is null and moderation_status = 'approved';
