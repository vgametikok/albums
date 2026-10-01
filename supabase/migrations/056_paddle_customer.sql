-- =====================================================================
-- 056: Paddle ID покупателя (ctm_…) для Paddle Retain (после 055).
--
-- Retain (спасение неудачных списаний, сценарии отмены) узнаёт человека
-- на сайте только по Paddle ID покупателя: Paddle.Initialize({ pwCustomer:
-- { id: 'ctm_…' } }). Paddle присылает его в каждом вебхуке
-- (data.customer_id), но раньше мы его нигде не хранили.
--
--   paddle_customers   одна строка на (пользователь, среда). sandbox и live —
--                      разные аккаунты Paddle с разными ctm_…, поэтому среда
--                      в ключе: тестовый id никогда не уйдёт в live Retain.
--                      Пишет только вебхук paddle-webhook (service_role).
--   my_paddle_customer(p_env)  вошедший получает СВОЙ id (или null).
--
-- Строки напрямую клиенту не видны (RLS без политик), только через RPC.
-- Повторный запуск безопасен. До применения вебхук и фронт работают как
-- раньше: запись/чтение id просто пропускаются.
-- =====================================================================

create table if not exists public.paddle_customers (
  user_id      uuid not null references auth.users(id) on delete cascade,
  env          text not null check (env in ('sandbox', 'live')),
  customer_id  text not null check (customer_id ~ '^ctm_[a-z0-9]{26}$'),
  updated_at   timestamptz not null default now(),
  primary key (user_id, env)
);
create index if not exists paddle_customers_customer_idx on public.paddle_customers (env, customer_id);

alter table public.paddle_customers enable row level security;
revoke all on public.paddle_customers from anon, authenticated;

-- Запись из вебхука: последний увиденный id побеждает (у человека мог
-- появиться новый покупатель в Paddle, если он платил с другой почты).
create or replace function public.paddle_set_customer(p_user_id uuid, p_env text, p_customer_id text)
returns void language sql security definer set search_path = public as $$
  insert into paddle_customers (user_id, env, customer_id, updated_at)
  values (p_user_id, p_env, p_customer_id, now())
  on conflict (user_id, env) do update
    set customer_id = excluded.customer_id, updated_at = now()
    where paddle_customers.customer_id is distinct from excluded.customer_id;
$$;
revoke all on function public.paddle_set_customer(uuid, text, text) from public, anon, authenticated;
grant execute on function public.paddle_set_customer(uuid, text, text) to service_role;

-- Чтение для фронта: только свой id. Гость (анонимная сессия) тоже
-- authenticated, но у него строк нет — вернётся null.
create or replace function public.my_paddle_customer(p_env text default 'live')
returns text language sql stable security definer set search_path = public as $$
  select customer_id from paddle_customers
  where user_id = auth.uid() and env = p_env;
$$;
revoke all on function public.my_paddle_customer(text) from public, anon;
grant execute on function public.my_paddle_customer(text) to authenticated;
