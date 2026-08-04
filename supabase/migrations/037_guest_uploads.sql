-- =====================================================================
-- 037: загрузка в общий альбом без регистрации + подпись «кто прислал».
--
--  1. Гость события может заливать фото БЕЗ входа: клиент создаёт анонимную
--     Supabase-сессию (Authentication → включить «Allow anonymous sign-ins»).
--     Для базы это обычный authenticated-пользователь: все политики,
--     квоты R2 и rate-limit'ы работают как есть.
--
--  2. Каждый участник выбирает, как подписывать свои файлы:
--     album_media.anon = true  — файл анонимный, зрителям автора не показываем;
--     album_media.anon = false — рядом с файлом ссылка на профиль автора.
--     По умолчанию TRUE: всё, что залито без явного выбора (старый клиент,
--     старые строки), остаётся анонимным — имя не публикуется без согласия.
--     Владельцу/редактору альбома «кто прислал» видно всегда: он разбирает
--     и модерирует гостевое, ему без этого никак.
--
--  3. Гость, загрузивший анонимно, может потом войти и «забрать» файлы себе:
--     guest_claim_start() (под гостевой сессией) выдаёт одноразовый код,
--     guest_claim_finish(code, public) (уже под настоящей) переносит владение
--     всеми файлами гостя, его строки участника и учёт квоты R2.
-- =====================================================================

alter table public.album_media add column if not exists anon boolean not null default true;

-- Строки, залитые самим владельцем альбома, анонимить незачем: альбом и так
-- подписан его именем. Гостевое остаётся анонимным до явного выбора.
update public.album_media am set anon = false
  from albums a, media m
 where a.id = am.album_id and m.id = am.media_id and m.owner_id = a.author_id and am.anon;

-- ---------------------------------------------------------------- перенос гостевых файлов

create table if not exists public.guest_claims (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  guest_id   uuid not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
alter table public.guest_claims enable row level security;   -- политик нет: только RPC
revoke all on public.guest_claims from anon, authenticated;

/** Гостевая сессия просит код переноса. Показывается один раз, живёт 7 дней. */
create or replace function public.guest_claim_start()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); is_anon boolean; tok text;
begin
  if me is null then raise exception 'auth required'; end if;
  select coalesce(u.is_anonymous, false) into is_anon from auth.users u where u.id = me;
  if not coalesce(is_anon, false) then raise exception 'Только для гостевой сессии'; end if;

  -- не gen_random_bytes: он в схеме extensions, а search_path тут прибит к
  -- public намеренно (см. миграцию 016). Два uuid дают ~244 бита.
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into guest_claims (code_hash, guest_id)
  values (encode(sha256(tok::bytea), 'hex'), me);
  return jsonb_build_object('code', tok);
end $$;

/**
 * Настоящий пользователь предъявляет код и забирает всё, что залил гостем:
 * файлы, строки участника альбомов, занятое место в квоте R2.
 * p_public = true — заодно подписать перенесённые файлы своим именем.
 */
create or replace function public.guest_claim_finish(p_code text, p_public boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); me_anon boolean; guest_anon boolean;
  claim guest_claims; m_ids uuid[];
begin
  if me is null then raise exception 'auth required'; end if;
  select coalesce(u.is_anonymous, false) into me_anon from auth.users u where u.id = me;
  if coalesce(me_anon, true) then raise exception 'Сначала войдите в настоящий аккаунт'; end if;

  select * into claim from guest_claims
   where code_hash = encode(sha256(p_code::bytea), 'hex')
     and used_at is null and created_at > now() - interval '7 days';
  if not found then raise exception 'Код переноса недействителен'; end if;
  if claim.guest_id = me then
    update guest_claims set used_at = now() where id = claim.id;
    return jsonb_build_object('moved', 0);
  end if;

  -- Переносим только с гостевых аккаунтов: код, выписанный кому-то другому,
  -- не должен уметь перекладывать файлы настоящих людей.
  select coalesce(u.is_anonymous, false) into guest_anon from auth.users u where u.id = claim.guest_id;
  if not coalesce(guest_anon, false) then raise exception 'Код переноса недействителен'; end if;

  select coalesce(array_agg(id), '{}') into m_ids from media where owner_id = claim.guest_id;

  update media set owner_id = me where owner_id = claim.guest_id;
  update r2_reservations set owner_id = me where owner_id = claim.guest_id;

  -- Участник альбома: гостевую строку сливаем с моей, если она уже есть.
  delete from album_collaborators c
   where c.user_id = claim.guest_id
     and (exists (select 1 from album_collaborators c2
                  where c2.album_id = c.album_id and c2.user_id = me)
          or exists (select 1 from albums a where a.id = c.album_id and a.author_id = me));
  update album_collaborators set user_id = me where user_id = claim.guest_id;

  if p_public then
    update album_media set anon = false where media_id = any(m_ids);
  end if;

  update guest_claims set used_at = now() where id = claim.id;
  return jsonb_build_object('moved', coalesce(array_length(m_ids, 1), 0));
end $$;

-- ---------------------------------------------------------------- выдача альбома

/**
 * Полное тело get_album (единственный источник — эта миграция; предыдущее — 035).
 * Отличия от 035 — только в подписи файлов:
 *   — у файла отдаётся 'anon' (am.anon);
 *   — 'by' теперь видит ЛЮБОЙ зритель, если файл не анонимный; владельцу и
 *     редактору — всегда (разбор гостевого без этого невозможен).
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
      'has_voices', (exists (
          select 1 from album_media am
          where am.album_id = a.id and am.voice_media_id is not null
            and (not am.is_private
                 or can_edit_album(a.id)
                 or exists (select 1 from media mm where mm.id = am.media_id and mm.owner_id = auth.uid())
                 or (am.visibility = 'friends' and are_friends(a.author_id, auth.uid())))
        ) or exists (
          select 1 from album_galleries g
          where g.album_id = a.id and g.voice_media_id is not null
            and exists (select 1 from album_media am2
                        where am2.gallery_id = g.id and am2.album_id = g.album_id
                          and (not am2.is_private
                               or can_edit_album(a.id)
                               or exists (select 1 from media mm where mm.id = am2.media_id and mm.owner_id = auth.uid())
                               or (am2.visibility = 'friends' and are_friends(a.author_id, auth.uid()))))
        )),
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
                      where am2.gallery_id = g.id and am2.album_id = g.album_id
                        and (not am2.is_private
                             or can_edit_album(a.id)
                             or exists (select 1 from media mm where mm.id = am2.media_id and mm.owner_id = auth.uid())
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
              'anon', am.anon,
              'by', case when (not am.anon) or can_edit_album(a.id)
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
          'anon', am.anon,
          'by', case when (not am.anon) or can_edit_album(a.id)
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

-- ---------------------------------------------------------------- гости события

/**
 * Полное тело album_contributors (предыдущее — 027). Одно отличие: отдаётся
 * is_guest — участник сидит под гостевой (анонимной) сессией, профиль у него
 * технический, вести на его страницу бессмысленно.
 */
create or replace function public.album_contributors(p_album uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from albums where id = p_album and author_id = auth.uid())
      then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
        'role', c.role,
        'uploaded', contrib_upload_count(p_album, c.user_id),
        'shown', (select count(*) from album_media am join media m on m.id = am.media_id
                  where am.album_id = p_album and m.owner_id = c.user_id and not am.is_private),
        'held',  (select count(*) from album_media am join media m on m.id = am.media_id
                  where am.album_id = p_album and m.owner_id = c.user_id and am.visibility = 'private'),
        'is_friend', are_friends(auth.uid(), c.user_id),
        'is_follower', is_following(c.user_id, auth.uid()),
        'is_guest', exists (select 1 from auth.users u
                            where u.id = c.user_id and coalesce(u.is_anonymous, false)),
        'joined_at', c.created_at)
        order by contrib_upload_count(p_album, c.user_id) desc)
      from album_collaborators c join profiles p on p.id = c.user_id
      where c.album_id = p_album), '[]'::jsonb)
  end;
$$;

-- ---------------------------------------------------------------- гранты

grant execute on function
  public.guest_claim_start(),
  public.guest_claim_finish(text, boolean)
to authenticated;
