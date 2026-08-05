-- =====================================================================
-- 042 — хвосты аудита: поиск пользователя по почте, ник из Telegram,
-- запрет придержанного кадра в обложке.
-- =====================================================================

-- ------------------------------------------------ поиск аккаунта по почте

/**
 * user_id по адресу почты. Нужна функциям входа (tg-auth, yandex-auth):
 * admin.listUsers отдаёт страницу, а не результат поиска, и на первой же
 * сотне-другой аккаунтов вход существующего человека начинал промахиваться
 * мимо его записи — Telegram уходил в создание дубля, Яндекс отвечал
 * «пользователь не найден».
 *
 * Вызывается только сервисным ключом из edge-функций.
 */
create or replace function public.auth_user_by_email(p_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke execute on function public.auth_user_by_email(text) from public, anon, authenticated;

-- ------------------------------------------------ ник профиля из Telegram

/**
 * Заводит профиль при первом входе. Ник берётся из части почты до «@», но
 * для Telegram почта теперь синтетическая и построена из id (tg<id>@…) —
 * из неё вышел бы ник вида «tg199993787». Поэтому если провайдер положил в
 * метаданные желаемый ник, используем его.
 */
create or replace function public.ensure_profile()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em text; base text; cand text; n int := 0; nm text; av text; pref text;
  existing profiles;
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into existing from profiles where id = uid;
  if found then
    return jsonb_build_object('id',existing.id,'username',existing.username,
      'display_name',existing.display_name,'avatar_url',existing.avatar_url,'created',false);
  end if;

  select email, raw_user_meta_data->>'full_name', raw_user_meta_data->>'avatar_url',
         raw_user_meta_data->>'telegram_username'
    into em, nm, av, pref from auth.users where id = uid;

  base := lower(regexp_replace(coalesce(nullif(pref, ''), split_part(em,'@',1), 'user'),
                               '[^a-zA-Z0-9_]', '', 'g'));
  if base is null or char_length(base) < 3 then base := 'user'; end if;
  base := left(base, 20);
  cand := base;
  while exists (select 1 from profiles where username = cand) loop
    n := n + 1;
    cand := left(base, 20) || n::text;
  end loop;

  insert into profiles (id, username, display_name, avatar_url)
  values (uid, cand, coalesce(nullif(nm,''), cand), av);

  return jsonb_build_object('id',uid,'username',cand,'display_name',coalesce(nullif(nm,''),cand),
    'avatar_url',av,'created',true);
end $$;

-- ------------------------------------------------ обложка из открытого кадра

/**
 * Обложка альбома из кадра. Придержанный (или скрытый модератором) кадр
 * обложкой быть не может: после 041 такой файл зрителям не отдаётся, и
 * альбом остался бы без картинки, а владелец не понял бы почему.
 */
create or replace function public.album_set_cover(p_am_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a_id uuid; m_id uuid; k media_kind; priv boolean;
begin
  if me is null then raise exception 'auth required'; end if;
  select am.album_id, am.media_id, m.kind, am.is_private into a_id, m_id, k, priv
    from album_media am join media m on m.id = am.media_id
    join albums a on a.id = am.album_id
   where am.id = p_am_id and a.author_id = me;
  if a_id is null then raise exception 'Недостаточно прав'; end if;
  if k = 'audio' then raise exception 'Обложкой может быть только фото или кадр видео'; end if;
  if priv then raise exception 'Придержанный кадр не может быть обложкой'; end if;

  update albums set cover_media_id = m_id where id = a_id;
  return jsonb_build_object('ok', true, 'media_id', m_id);
end $$;

grant execute on function public.album_set_cover(uuid) to authenticated;
revoke execute on function public.album_set_cover(uuid) from public, anon;

-- ------------------------------------------------ pg_cron без падения

-- В 038 расписание уборки гостей ставилось голым вызовом cron.schedule, хотя
-- в 031 такой же вызов уже обёрнут: на базе без pg_cron (локальная копия,
-- shadow-база при db push) миграция падала и всё после неё не применялось.
do $$ begin
  perform cron.schedule('cleanup-anon-users', '0 4 * * *', $c$select public.cleanup_anon_users()$c$);
exception when undefined_function or invalid_schema_name or insufficient_privilege then
  raise notice 'pg_cron недоступен — уборка гостей не запланирована';
end $$;
