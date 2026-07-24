-- 032_paypal_plans.sql — кэш созданных в PayPal Product+Plan по среде.
--
-- Подписка PayPal привязывается к plan_id. План (Albums Pro, $9.99/мес) создаётся
-- один раз на среду прямо из edge-функции при первой подписке и кладётся сюда,
-- чтобы не пересоздавать и не хранить сырые ключи вне секретов. sandbox и live —
-- разные PayPal-среды, поэтому ключ таблицы = env.
--
-- Только сервисный ключ (edge-функция) читает/пишет — RLS включён, политик нет.
create table if not exists public.paypal_plans (
  env         text primary key,           -- 'sandbox' | 'live'
  product_id  text not null,
  plan_id     text not null,
  created_at  timestamptz not null default now()
);
alter table public.paypal_plans enable row level security;
