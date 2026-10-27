-- =====================================================================
-- 061: источник регистрации (first touch).
--   • profiles.signup_referrer / signup_utm / signup_landing — откуда человек
--     впервые пришёл на сайт (внешний referrer, utm_*, посадочная страница).
--     Фронт запоминает их в localStorage (albums_first_touch) при первом визите
--     и после первого входа один раз зовёт set_signup_source().
--   • Прямой UPDATE этих колонок клиенту не выдан (у authenticated column-level
--     UPDATE только на avatar_url/banner_url/bio/display_name/location), так что
--     писать можно только через RPC. RPC пишет ТОЛЬКО в профиль auth.uid(),
--     ТОЛЬКО если все три колонки ещё пустые, и только для свежего профиля
--     (≤ 1 суток) — чтобы старые аккаунты не получили «источник» задним числом.
--   • trg_profile_guard (откат plan/ban/country) новых колонок не касается.
-- Идемпотентна: можно выполнять повторно.
-- =====================================================================

alter table public.profiles add column if not exists signup_referrer text;
alter table public.profiles add column if not exists signup_utm      jsonb;
alter table public.profiles add column if not exists signup_landing  text;

comment on column public.profiles.signup_referrer is '061: внешний document.referrer первого визита (пусто — прямой заход/свой домен).';
comment on column public.profiles.signup_utm      is '061: utm_* параметры первого визита (jsonb-объект).';
comment on column public.profiles.signup_landing  is '061: путь+query первой посадочной страницы.';

-- Возвращает true, если источник записан; false — если уже был записан,
-- профиль не найден/не свежий или пришли пустые данные. Исключений не бросает
-- (кроме отсутствия сессии), чтобы фронт мог молча игнорировать результат.
create or replace function public.set_signup_source(
  p_referrer text default null,
  p_utm      jsonb default null,
  p_landing  text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ref text := left(nullif(btrim(coalesce(p_referrer, '')), ''), 300);
  lnd text := left(nullif(btrim(coalesce(p_landing,  '')), ''), 300);
  utm jsonb := null;
  n int;
begin
  if uid is null then raise exception 'auth required'; end if;

  -- utm: только плоский объект строка→строка, до 10 ключей, значения до 100 символов
  if p_utm is not null and jsonb_typeof(p_utm) = 'object' then
    select jsonb_object_agg(left(k, 30), left(v #>> '{}', 100))
      into utm
      from (select key k, value v from jsonb_each(p_utm)
             where jsonb_typeof(value) in ('string', 'number') limit 10) s;
  end if;

  if ref is null and lnd is null and utm is null then return false; end if;

  update profiles
     set signup_referrer = ref,
         signup_utm      = utm,
         signup_landing  = lnd
   where id = uid
     and signup_referrer is null and signup_utm is null and signup_landing is null
     and created_at > now() - interval '1 day';
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.set_signup_source(text, jsonb, text) from public, anon;
grant execute on function public.set_signup_source(text, jsonb, text) to authenticated;
