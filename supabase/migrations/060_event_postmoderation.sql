-- =====================================================================
-- 060: альбомы событий (QR) — постмодерация.
--   • Кадр гостя попадает в альбом события СРАЗУ (альбом закрытый), в очередь
--     модератора уходит как раньше. Придержка 058 (mod_hold) для событий отменена.
--   • Отклонённый модератором кадр события НЕ пропадает из альбома: строка
--     получает album_media.mod_rejected = true, фронт рисует пометку.
--   • Отклонённое не публикуется: can_view_media отдаёт такой кадр только
--     автору альбома, его участникам (album_collaborators) и владельцу файла —
--     даже если альбом открыт/опубликован. Копии файла в другие альбомы
--     по-прежнему ждут проверки (mod_media_is_approved = false).
--   • Обычные альбомы — без изменений (058/059).
-- Идемпотентна: можно выполнять повторно.
-- =====================================================================

alter table public.album_media add column if not exists mod_rejected boolean not null default false;
comment on column public.album_media.mod_rejected is
  '060: модератор отклонил кадр события — он остаётся в альбоме с пометкой, но наружу не отдаётся.';

-- 1. придержка
create or replace function public.trg_album_media_mod_hold()
returns trigger language plpgsql security definer set search_path = public as $$
declare a_event boolean; a_pub timestamptz;
begin
  if coalesce(current_setting('albums.mod_release', true), '') = 'on' then return new; end if;

  -- 060: флаг «отклонено» ставит только модератор (mod_media_set)
  if tg_op = 'INSERT' then new.mod_rejected := false; else new.mod_rejected := old.mod_rejected; end if;

  -- 060: альбом события (QR) — закрытый, гости видят свои кадры сразу,
  -- модерация идёт после. Не держим никогда; отклонённый кадр остаётся в
  -- альбоме с пометкой, а наружу его не отдаёт can_view_media.
  select a.is_event, a.published_at into a_event, a_pub from albums a where a.id = new.album_id;
  if coalesce(a_event, false) then
    if tg_op = 'INSERT' then
      new.mod_hold := false; new.mod_hold_vis := null;
      return new;
    end if;
    new.mod_hold := false;
    new.mod_hold_vis := old.mod_hold_vis;
    if new.media_id is distinct from old.media_id then
      new.mod_rejected := false;
      if not mod_media_is_approved(new.media_id, null) then
        insert into mod_media_queue (am_id, album_id, media_id) values (new.id, new.album_id, new.media_id)
        on conflict (am_id) do update
          set media_id = excluded.media_id, added_at = now(),
              reviewed_at = null, reviewed_by = null, decision = null;
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.mod_hold := false;
    new.mod_hold_vis := null;
    -- уже проверенный файл (копия из библиотеки, спутник события) — не держим
    if mod_media_is_approved(new.media_id, new.album_id) then return new; end if;
    -- приватное (неопубликованное) событие: видят только участники — не держим,
    -- но в очередь кадр уйдёт (trg_mod_media_enqueue)
    select a.is_event, a.published_at into a_event, a_pub from albums a where a.id = new.album_id;
    if coalesce(a_event, false) and a_pub is null then return new; end if;

    new.mod_hold_vis := new.visibility;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    return new;
  end if;

  -- UPDATE
  -- подмена файла в уже одобренной строке (приложение так не делает, но
  -- прямой PATCH через PostgREST может): новый файл проходит проверку заново
  if new.media_id is distinct from old.media_id and not mod_media_is_approved(new.media_id, null) then
    if not old.mod_hold then new.mod_hold_vis := new.visibility; end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    insert into mod_media_queue (am_id, album_id, media_id) values (new.id, new.album_id, new.media_id)
    on conflict (am_id) do update
      set media_id = excluded.media_id, added_at = now(),
          reviewed_at = null, reviewed_by = null, decision = null;
    return new;
  end if;

  if old.mod_hold then
    -- автор/редактор меняет видимость придержанного кадра: запоминаем выбор,
    -- но кадр остаётся закрытым до решения модератора
    if new.visibility is distinct from old.visibility then
      new.mod_hold_vis := new.visibility;
    else
      new.mod_hold_vis := old.mod_hold_vis;
    end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
  elsif exists (select 1 from mod_media_queue q where q.am_id = new.id and q.decision = 'hidden') then
    -- 059: скрытый модератором файл автор не открывает сменой видимости —
    -- выбор запоминается и вернётся, если модератор передумает
    if new.visibility is distinct from old.visibility then
      new.mod_hold_vis := new.visibility;
    else
      new.mod_hold_vis := old.mod_hold_vis;
    end if;
    new.mod_hold := false;
    new.visibility := 'private';
    new.is_private := true;
  else
    -- самому себе придержку не ставят и чужую цель не подменяют
    new.mod_hold := false;
    new.mod_hold_vis := old.mod_hold_vis;
  end if;
  return new;
end $$;

-- 2. решение модератора
create or replace function public.mod_media_set(p_am_id uuid, p_approve boolean, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare am album_media; q mod_media_queue; was text;
begin
  select * into am from album_media where id = p_am_id;
  if am.id is null then return jsonb_build_object('error', 'not_found'); end if;

  select * into q from mod_media_queue where am_id = p_am_id;
  was := case when am.mod_hold or (q.am_id is not null and q.reviewed_at is null) then 'pending'
              when q.am_id is null then 'auto'
              else coalesce(q.decision, 'approved') end;
  if q.am_id is null then
    insert into mod_media_queue (am_id, album_id, media_id, added_at)
    values (am.id, am.album_id, am.media_id, now())
    on conflict (am_id) do nothing;
    select * into q from mod_media_queue where am_id = p_am_id;
  end if;

  -- 060: событие (QR) — решение только помечает кадр, из альбома он не пропадает
  if exists (select 1 from albums where id = am.album_id and is_event) then
    perform set_config('albums.mod_release', 'on', true);
    update album_media
       set mod_rejected = not p_approve,
           visibility = case when mod_hold then coalesce(mod_hold_vis, visibility) else visibility end,
           mod_hold = false, mod_hold_vis = null
     where id = p_am_id;
    perform set_config('albums.mod_release', '', true);
  else
  perform set_config('albums.mod_release', 'on', true);
  if p_approve then
    if am.mod_hold or coalesce(q.decision, '') = 'hidden' then
      update album_media set mod_hold = false, visibility = mod_hold_vis, mod_hold_vis = null
       where id = p_am_id;
    end if;
  else
    if am.mod_hold or coalesce(q.decision, '') <> 'hidden' then
      update album_media
         set mod_hold_vis = case when am.mod_hold then am.mod_hold_vis else am.visibility end,
             mod_hold = false, visibility = 'private'
       where id = p_am_id;
    end if;
  end if;
  perform set_config('albums.mod_release', '', true);
  end if;

  update mod_media_queue
     set reviewed_at = now(), reviewed_by = p_login,
         decision = case when p_approve then 'approved' else 'hidden' end
   where am_id = p_am_id;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', am.album_id,
          'media ' || am.media_id::text || ' (was ' || was || ')');
  return jsonb_build_object('ok', true, 'status', case when p_approve then 'approved' else 'hidden' end);
end $$;

-- 3. публикация события
create or replace function public.mod_on_publish(p_album uuid, p_first boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- 060: событие (QR) при публикации ничего не прячет — отклонённое отсекает can_view_media
  if exists (select 1 from albums where id = p_album and is_event) then
    perform mod_enqueue_album(p_album);
    return;
  end if;
  perform set_config('albums.mod_release', 'on', true);
  update album_media am
     set mod_hold_vis = am.visibility, mod_hold = true, visibility = 'private'
   where am.album_id = p_album and not am.mod_hold
     and not exists (select 1 from mod_media_queue q where q.am_id = am.id and q.decision is not null)
     and (exists (select 1 from mod_media_queue q where q.am_id = am.id and q.reviewed_at is null)
          or (p_first and not mod_media_is_approved(am.media_id, p_album)));
  perform set_config('albums.mod_release', '', true);
  perform mod_enqueue_album(p_album);
end $$;

-- 4. кто видит отклонённое
create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- владелец файла (гость события всегда видит то, что залил сам)
    exists (select 1 from media where id = m_id and owner_id = viewer)
    -- открытый файл в видимом альбоме
    or exists (select 1 from album_media am
               where am.media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer)
                 and (not am.mod_rejected
                      or exists (select 1 from albums a0 where a0.id = am.album_id and a0.author_id = viewer)
                      or exists (select 1 from album_collaborators c0
                                 where c0.album_id = am.album_id and c0.user_id = viewer)))
    -- файл «только для друзей автора» внутри видимого альбома
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (not am.mod_rejected
                      or exists (select 1 from albums a0 where a0.id = am.album_id and a0.author_id = viewer)
                      or exists (select 1 from album_collaborators c0
                                 where c0.album_id = am.album_id and c0.user_id = viewer))
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- скрытый файл: только владелец альбома и РЕДАКТОР. Гость события — нет.
    -- (сюда же попадают кадры, придержанные до решения модератора, 058)
    or exists (select 1 from album_media am
               where am.media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- обложка видимого альбома: открытый кадр этого же альбома либо файл
    -- автора альбома, прошедший модерацию (058)
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer)
                 and (exists (select 1 from album_media am
                              where am.album_id = al.id and am.media_id = m_id and not am.is_private)
                      or (exists (select 1 from media m where m.id = m_id and m.owner_id = al.author_id)
                          and mod_cover_ok(al.id, m_id))))
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


drop trigger if exists album_media_zz_mod_hold_t on public.album_media;
create trigger album_media_zz_mod_hold_t before insert or update on public.album_media
  for each row execute function public.trg_album_media_mod_hold();

revoke execute on function public.mod_media_set(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.mod_on_publish(uuid, boolean)     from public, anon, authenticated;

-- ---------------------------------------------------------------- бэкфилл
-- придержанные кадры событий — открыть; скрытые модератором — вернуть с пометкой
do $$
begin
  perform set_config('albums.mod_release', 'on', true);
  update album_media am
     set visibility = coalesce(am.mod_hold_vis, am.visibility), mod_hold = false, mod_hold_vis = null,
         mod_rejected = exists (select 1 from mod_media_queue q where q.am_id = am.id and q.decision = 'hidden')
    from albums a
   where a.id = am.album_id and a.is_event
     and (am.mod_hold or exists (select 1 from mod_media_queue q where q.am_id = am.id and q.decision = 'hidden'));
  perform set_config('albums.mod_release', '', true);
end $$;

notify pgrst, 'reload schema';
