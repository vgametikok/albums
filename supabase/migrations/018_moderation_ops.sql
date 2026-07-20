-- 018: серверные операции модерации.
--
-- Эти функции вызываются ТОЛЬКО из edge-функции mod-api под service-ключом
-- (у него роль postgres/service_role, RLS не действует). Ни anon, ни
-- authenticated их не получают — грантов ниже нет вовсе. Аутентификация
-- модератора (пароль) проверяется в edge-функции ДО вызова этих функций.
--
-- Каждое действие пишет строку в mod_actions с логином — чтобы был след,
-- кто и что сделал (насколько это возможно при общем пароле).

-- Очередь жалоб: свежие открытые, с минимумом данных о цели.
create or replace function public.mod_queue(p_limit int default 50, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'subject_type', r.subject_type, 'subject_id', r.subject_id,
      'reason', r.reason, 'note', r.note, 'status', r.status, 'created_at', r.created_at,
      'reporter', jsonb_build_object('username', rp.username, 'name', rp.display_name),
      'reports_on_subject', (select count(*) from reports r2
                             where r2.subject_type = r.subject_type and r2.subject_id = r.subject_id),
      'target', case r.subject_type
        when 'album' then (select jsonb_build_object('title', a.title, 'author', ap.username,
                             'hidden', a.hidden_at is not null, 'visibility', a.visibility)
                           from albums a join profiles ap on ap.id = a.author_id where a.id = r.subject_id)
        when 'post' then (select jsonb_build_object('caption', left(coalesce(p.caption,''),80), 'author', pp.username,
                            'hidden', p.hidden_at is not null)
                          from posts p join profiles pp on pp.id = p.author_id where p.id = r.subject_id)
        when 'comment' then (select jsonb_build_object('body', left(c.body,120), 'author', cp.username,
                              'hidden', c.hidden_at is not null)
                             from comments c join profiles cp on cp.id = c.author_id where c.id = r.subject_id)
        when 'profile' then (select jsonb_build_object('username', pr.username, 'name', pr.display_name,
                              'banned', pr.banned_at is not null)
                             from profiles pr where pr.id = r.subject_id)
      end
    ) as x
    from reports r
    join profiles rp on rp.id = r.reporter_id
    where r.status = 'open'
    order by r.created_at
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  ) s;
$$;

-- Открыть спорный контент (модератор видит приватное по жалобе — это залогировано).
create or replace function public.mod_open_subject(p_type text, p_id uuid, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  insert into mod_actions (login, action, subject_type, subject_id)
  values (p_login, 'open', p_type, p_id);

  if p_type = 'album' then
    select jsonb_build_object(
      'type','album','title',a.title,'description',a.description,'visibility',a.visibility,
      'hidden', a.hidden_at is not null, 'author', ap.username,
      'media', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path) order by am.position)
        from album_media am join media m on m.id=am.media_id where am.album_id=a.id), '[]'::jsonb))
    into res from albums a join profiles ap on ap.id=a.author_id where a.id = p_id;
  elsif p_type = 'post' then
    select jsonb_build_object(
      'type','post','caption',p.caption,'hidden', p.hidden_at is not null,'author',pp.username,
      'media', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path) order by pm.position)
        from post_media pm join media m on m.id=pm.media_id where pm.post_id=p.id), '[]'::jsonb))
    into res from posts p join profiles pp on pp.id=p.author_id where p.id = p_id;
  elsif p_type = 'comment' then
    select jsonb_build_object('type','comment','body',c.body,'hidden', c.hidden_at is not null,'author',cp.username)
    into res from comments c join profiles cp on cp.id=c.author_id where c.id = p_id;
  elsif p_type = 'profile' then
    select jsonb_build_object('type','profile','username',pr.username,'name',pr.display_name,
      'bio',pr.bio,'banned', pr.banned_at is not null)
    into res from profiles pr where pr.id = p_id;
  end if;
  return coalesce(res, jsonb_build_object('error','not_found'));
end $$;

-- Скрыть / показать контент.
create or replace function public.mod_hide(p_type text, p_id uuid, p_hide boolean, p_login text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if p_type = 'album' then
    update albums set hidden_at = case when p_hide then now() else null end, hidden_reason = p_reason
      where id = p_id returning author_id into owner;
  elsif p_type = 'post' then
    update posts set hidden_at = case when p_hide then now() else null end, hidden_reason = p_reason
      where id = p_id returning author_id into owner;
  elsif p_type = 'comment' then
    update comments set hidden_at = case when p_hide then now() else null end
      where id = p_id returning author_id into owner;
  else
    raise exception 'bad type';
  end if;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_hide then 'hide' else 'unhide' end, p_type, p_id, p_reason);

  -- автору — уведомление, что с его контентом что-то сделали
  if owner is not null and p_hide then
    perform notify_user(owner, 'moderation_action', null, p_type, p_id, null,
                        'moderation_action:' || p_id::text);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Бан / разбан пользователя.
create or replace function public.mod_ban(p_user uuid, p_ban boolean, p_login text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update profiles set banned_at = case when p_ban then now() else null end, ban_reason = p_reason
    where id = p_user;
  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_ban then 'ban' else 'unban' end, 'profile', p_user, p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- Закрыть жалобу (решена / отклонена).
create or replace function public.mod_resolve(p_report uuid, p_status text, p_login text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare reporter uuid; st subject_kind; sid uuid;
begin
  update reports set status = p_status::report_status, resolved_at = now(), resolution = p_note
    where id = p_report returning reporter_id into reporter;

  insert into mod_actions (login, action, report_id, note)
  values (p_login, 'resolve_' || p_status, p_report, p_note);

  if reporter is not null then
    perform notify_user(reporter, 'moderation_action', null, 'profile', reporter, null,
                        'mod_resolved:' || p_report::text);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Записать успешный/неуспешный вход модератора (для rate-limit по ip).
create or replace function public.mod_note_attempt(p_ip text, p_ok boolean)
returns int language plpgsql security definer set search_path = public as $$
declare fails int;
begin
  insert into mod_login_attempts (ip_hash, ok) values (p_ip, p_ok);
  select count(*) into fails from mod_login_attempts
   where ip_hash = p_ip and not ok and created_at > now() - interval '15 minutes';
  return fails;
end $$;

create or replace function public.mod_session_create(p_hash text, p_login text, p_ip text)
returns void language sql security definer set search_path = public as $$
  insert into mod_sessions (token_hash, login, expires_at, ip_hash)
  values (p_hash, p_login, now() + interval '2 hours', p_ip);
$$;

create or replace function public.mod_session_check(p_hash text)
returns text language sql stable security definer set search_path = public as $$
  select login from mod_sessions where token_hash = p_hash and expires_at > now();
$$;

-- Гранты namеренно НЕ выдаются: эти функции доступны только под service-ключом.
