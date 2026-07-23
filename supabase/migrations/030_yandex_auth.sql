-- =====================================================================
-- 030: вход через Яндекс ID.
--
-- Supabase не умеет Яндекс среди встроенных провайдеров (проверено по списку
-- конфигурации проекта), а провайдер Keycloak под него не подходит: он жёстко
-- достраивает к адресу пути вида /protocol/openid-connect/auth. Поэтому обмен
-- с Яндексом делает своя edge-функция yandex-auth, а сессию она выдаёт штатным
-- механизмом Supabase — одноразовым токеном, который клиент меняет на сессию
-- через verifyOtp. Никаких самодельных JWT.
--
-- Здесь только две служебные таблицы. Обе без политик RLS намеренно: писать и
-- читать их должен исключительно сервисный ключ внутри функции.
-- =====================================================================

-- Состояние запроса на вход: защита от подделки и, главное, ХРАНЕНИЕ адреса
-- возврата на сервере. Если бы адрес ехал через параметр, мы получили бы
-- открытый редирект, а вместе с ним — утечку одноразового токена входа на
-- чужой сайт.
create table if not exists public.oauth_states (
  state       text primary key,
  provider    text not null,
  redirect_to text not null,
  created_at  timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
create index if not exists oauth_states_created_idx on public.oauth_states (created_at);

-- Связь «аккаунт у провайдера → пользователь Albums». Нужна, чтобы человек
-- попадал в свой аккаунт даже если сменил основную почту в Яндексе.
create table if not exists public.external_identities (
  provider    text not null,
  external_id text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now(),
  primary key (provider, external_id)
);
alter table public.external_identities enable row level security;
create index if not exists external_identities_user_idx on public.external_identities (user_id);

/** Уборка протухших состояний. Вызывается функцией при каждом входе — дёшево. */
create or replace function public.oauth_states_sweep()
returns void language sql security definer set search_path = public as $$
  delete from oauth_states where created_at < now() - interval '15 minutes';
$$;

revoke execute on function public.oauth_states_sweep() from public, anon, authenticated;
