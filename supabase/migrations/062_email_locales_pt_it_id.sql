-- 062: языки писем pt-BR, it, id (к 9 языкам из 055).
-- ПОДГОТОВЛЕНО, НЕ ПРИМЕНЕНО: нужен накат вручную (supabase db push / sql.ps1).
-- До наката сайт и edge-функции работают: email_on_session отбрасывает
-- неизвестный язык (loc = null), и письма пользователей pt-BR/it/id уходят
-- на английском. После наката — на их языке.
-- Идемпотентно: можно запускать повторно.

alter table public.email_user_state drop constraint if exists email_user_state_locale_check;
alter table public.email_user_state add constraint email_user_state_locale_check
  check (locale is null or locale in ('en','ru','vi','fr','es','de','zh-CN','ko','ja','pt-BR','it','id'));

create or replace function public.email_on_session(p_uid uuid, p_locale text)
returns void language plpgsql security definer set search_path = public as $$
declare
  u record; st email_user_state; signin_at timestamptz; ua text;
  loc text := case when p_locale in ('en','ru','vi','fr','es','de','zh-CN','ko','ja','pt-BR','it','id') then p_locale end;
begin
  select email, coalesce(is_anonymous, false) as anon, last_sign_in_at into u
    from auth.users where id = p_uid;
  if not found then return; end if;

  insert into email_user_state (user_id, locale, last_sign_in_seen, welcomed)
  values (p_uid, loc, now(), false)
  on conflict (user_id) do nothing;
  select * into st from email_user_state where user_id = p_uid for update;

  if loc is not null and st.locale is distinct from loc then
    update email_user_state set locale = loc, updated_at = now() where user_id = p_uid;
  end if;
  if u.anon or coalesce(u.email, '') = '' then return; end if;

  if not st.welcomed then
    update email_user_state set welcomed = true, last_sign_in_seen = now(), updated_at = now()
     where user_id = p_uid;
    perform email_enqueue('welcome', p_uid, 'welcome:' || p_uid::text);
    return;
  end if;

  begin
    select s.created_at into signin_at from auth.sessions s
     where s.id = nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'session_id', '')::uuid;
  exception when others then signin_at := null;
  end;
  signin_at := coalesce(signin_at, u.last_sign_in_at);
  if signin_at is null or signin_at <= coalesce(st.last_sign_in_seen, '-infinity'::timestamptz) then return; end if;

  update email_user_state set last_sign_in_seen = signin_at, updated_at = now() where user_id = p_uid;
  if signin_at < now() - interval '1 hour' then return; end if;   -- старая сессия всплыла — не новость
  if exists (select 1 from email_log where kind = 'signin' and user_id = p_uid
               and created_at > now() - interval '24 hours') then
    return;
  end if;

  begin
    ua := current_setting('request.headers', true)::jsonb ->> 'user-agent';
  exception when others then ua := null;
  end;
  perform email_enqueue('signin', p_uid,
    'signin:' || p_uid::text || ':' || floor(extract(epoch from signin_at))::bigint::text,
    jsonb_build_object('at', signin_at, 'ua', left(ua, 300)));
exception when others then
  raise warning 'email_on_session: %', sqlerrm;
end $$;

revoke execute on function public.email_on_session(uuid, text) from public, anon, authenticated;
