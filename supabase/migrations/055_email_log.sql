-- =====================================================================
-- 055: служебные письма через Resend (после 054).
--
-- Схема: база решает, КОМУ и КОГДА писать, edge-функция notify — только
-- рендерит и отправляет. Каждое письмо сначала ложится строкой в email_log
-- (очередь + журнал). Уникальный dedupe_key и оконные проверки держат
-- «не чаще» прямо в базе, поэтому повтор вебхука, двойной клик или гонка
-- двух вкладок второго письма не дадут.
--
-- Откуда берутся письма (всё — триггерами/функциями базы, фронт и вебхуки
-- для этого не нужны):
--   welcome        ensure_profile(): первое появление настоящего (не гостевого)
--                  аккаунта. Один раз на человека (welcome:<uid>).
--   signin         ensure_profile(): сессия создана позже последней виденной
--                  (новый вход, а не обновление токена). Не чаще раза в 24 ч;
--                  самый первый вход не шлёт (его покрывает welcome).
--   mod_pending    mod_media_queue insert: файл ушёл модератору. Дайджест: одно
--                  письмо на альбом на загрузившего не чаще раза в час, первое
--                  уходит через 10 минут, чтобы собрать пачку.
--   mod_approved   mod_media_queue: decision -> approved. Так же, раз в час,
--                  через 15 минут после первого одобрения сессии модератора.
--   purchase_event paypal_orders insert (status COMPLETED): это и Paddle, и
--                  PayPal — обе выдачи идут через paypal_grant_event[_tier],
--                  строка заказа вставляется ровно один раз на транзакцию.
--   purchase_pro   paypal_subscriptions: подписка впервые стала ACTIVE (Paddle
--                  и PayPal — оба через paypal_apply_sub). Раз на подписку.
--   storage80      album_media insert: событийный альбом занял 80% тарифа
--                  (по серверному леджеру r2_reservations). Раз на альбом на
--                  срок хранения.
--
-- Отправка: строка с send_after <= now() «пинает» функцию notify через pg_net
-- (после коммита, не блокируя транзакцию); отложенные и повторные подбирает
-- pg_cron раз в 5 минут. Функция забирает строки email_claim() (с лимитом
-- Resend free: по умолчанию 90 в сутки и 2900 за 30 дней, покупки и welcome
-- в приоритете) и отмечает итог email_mark(). Нет RESEND_API_KEY — функция
-- ничего не забирает, строки ждут (и протухают по сроку, см. email_claim).
--
-- Письма никогда не ломают основной путь: каждая точка входа ловит ошибки.
-- Повторный запуск безопасен.
-- =====================================================================

-- ---------------------------------------------------------------- настройки

create table if not exists public.email_config (
  id          boolean primary key default true check (id),
  enabled     boolean not null default true,
  notify_url  text    not null default 'https://rizveurkjpcwrmbtoawj.supabase.co/functions/v1/notify',
  daily_cap   int     not null default 90,     -- Resend free: 100 в сутки
  monthly_cap int     not null default 2900,   -- Resend free: 3000 в месяц
  updated_at  timestamptz not null default now()
);
alter table public.email_config enable row level security;   -- политик нет
revoke all on public.email_config from anon, authenticated;
insert into public.email_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- состояние пользователя

-- Язык писем и отметка последнего виденного входа. Отдельно от profiles:
-- туда пользователь пишет сам (политика profiles_update), а отметку входа
-- подделывать нельзя. Политик нет — только SECURITY DEFINER функции.
create table if not exists public.email_user_state (
  user_id           uuid primary key references public.profiles(id) on delete cascade,
  locale            text check (locale is null or locale in ('en','ru','vi','fr','es','de','zh-CN','ko','ja')),
  last_sign_in_seen timestamptz,
  welcomed          boolean not null default false,
  updated_at        timestamptz not null default now()
);
alter table public.email_user_state enable row level security;
revoke all on public.email_user_state from anon, authenticated;

-- Уже существующим людям welcome не шлём, а вход считаем виденным «сейчас»:
-- иначе первая же загрузка страницы после миграции разослала бы всем письма.
insert into public.email_user_state (user_id, last_sign_in_seen, welcomed)
select p.id, now(), true from public.profiles p
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- очередь / журнал

create table if not exists public.email_log (
  id          bigserial primary key,
  kind        text not null check (kind in ('welcome','signin','mod_pending','mod_approved',
                                            'purchase_event','purchase_pro','storage80')),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  album_id    uuid references public.albums(id) on delete cascade,
  dedupe_key  text not null unique,
  payload     jsonb not null default '{}'::jsonb,
  item_count  int  not null default 1,
  status      text not null default 'pending'
              check (status in ('pending','sending','sent','failed','skipped','expired')),
  send_after  timestamptz not null default now(),
  attempts    int  not null default 0,
  last_error  text,
  provider_id text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz
);
create index if not exists email_log_due on public.email_log (send_after)
  where status in ('pending', 'sending');
create index if not exists email_log_batch on public.email_log (kind, user_id, album_id, created_at desc);
create index if not exists email_log_sent on public.email_log (sent_at) where sent_at is not null;
alter table public.email_log enable row level security;       -- политик нет
revoke all on public.email_log from anon, authenticated;

-- ---------------------------------------------------------------- пинок отправки

/**
 * Будит функцию notify, если есть что отправить. pg_net кладёт запрос в
 * очередь и шлёт его фоновым воркером после коммита — транзакция не ждёт.
 */
create or replace function public.email_kick()
returns void language plpgsql security definer set search_path = public as $$
declare cfg email_config;
begin
  select * into cfg from email_config where id;
  if cfg.id is null or not cfg.enabled or coalesce(cfg.notify_url, '') = '' then return; end if;
  if not exists (
    select 1 from email_log
     where (status = 'pending' and send_after <= now())
        or (status = 'sending' and claimed_at < now() - interval '15 minutes')) then
    return;
  end if;
  perform net.http_post(
    url := cfg.notify_url,
    body := jsonb_build_object('drain', true),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'email_kick: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- постановка в очередь

/**
 * Поставить письмо. Только настоящим аккаунтам (не гостевым, с почтой).
 * dedupe_key уникален: повтор — no-op (при p_merge — +1 к счётчику, пока
 * письмо не ушло). Возвращает true, если строка создана сейчас.
 */
create or replace function public.email_enqueue(
  p_kind text, p_user uuid, p_key text, p_payload jsonb default '{}'::jsonb,
  p_album uuid default null, p_delay interval default interval '0', p_merge boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare new_id bigint;
begin
  if p_user is null or coalesce(p_key, '') = '' then return false; end if;
  if not exists (select 1 from email_config where id and enabled) then return false; end if;
  if not exists (select 1 from auth.users u
                  where u.id = p_user and not coalesce(u.is_anonymous, false)
                    and coalesce(u.email, '') <> '') then
    return false;
  end if;

  insert into email_log (kind, user_id, album_id, dedupe_key, payload, send_after)
  values (p_kind, p_user, p_album, p_key, coalesce(p_payload, '{}'::jsonb),
          now() + greatest(coalesce(p_delay, interval '0'), interval '0'))
  on conflict (dedupe_key) do nothing
  returning id into new_id;

  if new_id is null then
    if p_merge then
      update email_log set item_count = item_count + 1
       where dedupe_key = p_key and status = 'pending';
    end if;
    return false;
  end if;

  if coalesce(p_delay, interval '0') <= interval '0' then perform email_kick(); end if;
  return true;
exception when others then
  raise warning 'email_enqueue %: %', p_kind, sqlerrm;
  return false;
end $$;

/**
 * Дайджест «по альбому на человека не чаще раза в p_window». Есть неотправленное
 * письмо этого вида — +1 к нему. Последнее уже ушло — новое встаёт в очередь не
 * раньше, чем через p_window после него (ничего не теряется, просто одним
 * письмом позже). Иначе — новое через p_delay (время собрать пачку).
 */
create or replace function public.email_enqueue_batch(
  p_kind text, p_user uuid, p_album uuid, p_payload jsonb default '{}'::jsonb,
  p_window interval default interval '1 hour', p_delay interval default interval '10 minutes')
returns boolean language plpgsql security definer set search_path = public as $$
declare last email_log; d interval := p_delay;
begin
  if p_user is null or p_album is null then return false; end if;
  perform pg_advisory_xact_lock(hashtext('email:' || p_kind || ':' || p_user::text || ':' || p_album::text));

  select * into last from email_log
   where kind = p_kind and user_id = p_user and album_id = p_album
   order by created_at desc, id desc limit 1;

  if found and last.status = 'pending' then
    update email_log set item_count = item_count + 1 where id = last.id;
    return false;
  end if;
  if found and last.status in ('sent', 'sending') then
    d := greatest(p_delay, coalesce(last.sent_at, last.claimed_at, last.created_at) + p_window - now());
  end if;

  return email_enqueue(p_kind, p_user,
    p_kind || ':' || p_user::text || ':' || p_album::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
    p_payload, p_album, d, false);
exception when others then
  raise warning 'email_enqueue_batch %: %', p_kind, sqlerrm;
  return false;
end $$;

-- ---------------------------------------------------------------- вход / регистрация

/**
 * Зовётся из ensure_profile на каждой загрузке страницы вошедшего. Запоминает
 * язык сайта; для настоящего аккаунта — welcome (один раз) или уведомление о
 * новом входе. «Новый вход» — сессия (auth.sessions по session_id из JWT)
 * создана позже последней виденной; обновление токена сессию не меняет.
 * Ошибки глушатся: вход важнее письма.
 */
create or replace function public.email_on_session(p_uid uuid, p_locale text)
returns void language plpgsql security definer set search_path = public as $$
declare
  u record; st email_user_state; signin_at timestamptz; ua text;
  loc text := case when p_locale in ('en','ru','vi','fr','es','de','zh-CN','ko','ja') then p_locale end;
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

/**
 * Профиль текущего пользователя (как в 042) + язык сайта для писем.
 * p_locale необязателен: старый фронт зовёт без аргументов — работает.
 */
drop function if exists public.ensure_profile();
create or replace function public.ensure_profile(p_locale text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em text; base text; cand text; n int := 0; nm text; av text; pref text;
  existing profiles;
begin
  if uid is null then raise exception 'auth required'; end if;
  select * into existing from profiles where id = uid;
  if found then
    perform email_on_session(uid, p_locale);
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

  perform email_on_session(uid, p_locale);

  return jsonb_build_object('id',uid,'username',cand,'display_name',coalesce(nullif(nm,''),cand),
    'avatar_url',av,'created',true);
end $$;

-- ---------------------------------------------------------------- модерация

/** Файл ушёл модератору / одобрен — дайджест загрузившему (гостям без почты не пишем). */
create or replace function public.trg_email_mod_queue()
returns trigger language plpgsql security definer set search_path = public as $$
declare uploader uuid;
begin
  select owner_id into uploader from media where id = new.media_id;
  if uploader is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.reviewed_at is null then
      perform email_enqueue_batch('mod_pending', uploader, new.album_id, '{}'::jsonb,
                                  interval '1 hour', interval '10 minutes');
    end if;
  elsif new.decision = 'approved' and old.decision is null
        and coalesce(new.reviewed_by, '') <> 'backfill' then
    -- «на проверке», которое ещё не ушло, уже не новость: одобрение его покрывает
    update email_log set status = 'skipped', last_error = 'superseded by mod_approved'
     where kind = 'mod_pending' and user_id = uploader and album_id = new.album_id
       and status = 'pending';
    perform email_enqueue_batch('mod_approved', uploader, new.album_id, '{}'::jsonb,
                                interval '1 hour', interval '15 minutes');
  end if;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_email_mod_queue_t on public.mod_media_queue;
create trigger trg_email_mod_queue_t after insert or update of decision on public.mod_media_queue
  for each row execute function public.trg_email_mod_queue();

-- ---------------------------------------------------------------- покупки

/**
 * Оплаченный событийный альбом (Paddle txn_… или заказ PayPal). Строка заказа
 * вставляется один раз на транзакцию — это и есть «первая выдача». Несколько
 * штук одной транзакции Paddle (txn_…#2) складываются в одно письмо.
 * Ручные выдачи из админки (admin:…, status GRANTED) писем не шлют.
 */
create or replace function public.trg_email_purchase_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare base text := split_part(new.order_id, '#', 1);
begin
  if new.status = 'COMPLETED' and new.kind like 'event%' and new.order_id not like 'admin:%' then
    perform email_enqueue('purchase_event', new.user_id, 'purchase:' || base,
      jsonb_build_object('order_id', base,
                         'provider', case when base like 'txn\_%' then 'paddle' else 'paypal' end),
      null, interval '0', true);
  end if;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_email_purchase_order_t on public.paypal_orders;
create trigger trg_email_purchase_order_t after insert on public.paypal_orders
  for each row execute function public.trg_email_purchase_order();

/** Подписка Pro впервые стала активной. Продления (ACTIVE -> ACTIVE) и возврат
    после просрочки писем не дают; один раз на подписку. */
create or replace function public.trg_email_purchase_pro()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ACTIVE'
     and (tg_op = 'INSERT'
          or coalesce(old.status, '') not in ('ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED')) then
    perform email_enqueue('purchase_pro', new.user_id, 'purchase_pro:' || new.subscription_id,
      jsonb_build_object('subscription_id', new.subscription_id,
                         'provider', case when new.subscription_id like 'sub\_%' then 'paddle' else 'paypal' end));
  end if;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_email_purchase_pro_t on public.paypal_subscriptions;
create trigger trg_email_purchase_pro_t after insert or update of status on public.paypal_subscriptions
  for each row execute function public.trg_email_purchase_pro();

-- ---------------------------------------------------------------- место в событийном альбоме

/**
 * Событийный альбом занял 80% объёма тарифа. Объём — по r2_reservations
 * (пишет только сервер при подписи загрузки; media.size_bytes пишет клиент).
 * Раз на альбом на срок хранения: ключ содержит event_storage_until, и
 * продление срока откроет новое окно. Имя триггера с zz — чтобы шёл после
 * album_media_event_clock_t (054), который ставит срок на первом файле.
 */
create or replace function public.trg_email_storage80()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums; used bigint; cap bigint; k text;
begin
  select * into a from albums where id = new.album_id;
  if a.id is null or not a.is_event or coalesce(a.event_storage_gb, 0) <= 0 then return new; end if;
  k := 'storage80:' || a.id::text || ':'
       || coalesce(to_char(a.event_storage_until at time zone 'UTC', 'YYYYMMDD'), 'p0');
  if exists (select 1 from email_log where dedupe_key = k) then return new; end if;

  select coalesce(sum(r.size_bytes + r.thumb_bytes), 0) into used
    from album_media am join r2_reservations r on r.media_id = am.media_id
   where am.album_id = a.id;
  cap := a.event_storage_gb::bigint * 1073741824;
  if used * 5 >= cap * 4 then
    perform email_enqueue('storage80', a.author_id, k,
      jsonb_build_object('used_bytes', used, 'cap_gb', a.event_storage_gb), a.id);
  end if;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists album_media_zz_storage80_t on public.album_media;
create trigger album_media_zz_storage80_t after insert on public.album_media
  for each row execute function public.trg_email_storage80();

-- ---------------------------------------------------------------- выдача функции notify

/**
 * Забрать пачку к отправке (только сервисный ключ — функция notify).
 *  - протухшее не шлём: вход — через 6 ч, модерация и welcome — через 3 суток,
 *    место — через 14, покупки — через 30 (например, пока не был задан ключ);
 *  - бюджет Resend: daily_cap за 24 ч и monthly_cap за 30 дней; последние 20
 *    писем суток держим под покупки и welcome;
 *  - «зависшие» sending (функция упала) старше 15 минут берём повторно:
 *    у Resend ключ идемпотентности = id строки, второе письмо не уйдёт.
 * Возвращает массив писем с адресом, языком и свежими данными альбома/заказа.
 */
create or replace function public.email_claim(p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg email_config; day_n int; month_n int; budget int; res jsonb;
begin
  select * into cfg from email_config where id;
  if cfg.id is null or not cfg.enabled then return '[]'::jsonb; end if;

  update email_log set status = 'expired'
   where status = 'pending'
     and created_at < now() - case kind
           when 'signin'         then interval '6 hours'
           when 'storage80'      then interval '14 days'
           when 'purchase_event' then interval '30 days'
           when 'purchase_pro'   then interval '30 days'
           else interval '3 days' end;
  update email_log set status = 'failed', last_error = coalesce(last_error, 'too many attempts')
   where status = 'sending' and claimed_at < now() - interval '15 minutes' and attempts >= 4;

  select count(*) into day_n from email_log
   where status in ('sent', 'sending') and coalesce(sent_at, claimed_at) > now() - interval '24 hours';
  select count(*) into month_n from email_log
   where status in ('sent', 'sending') and coalesce(sent_at, claimed_at) > now() - interval '30 days';
  budget := least(greatest(coalesce(p_limit, 20), 1), 50, cfg.daily_cap - day_n, cfg.monthly_cap - month_n);
  if budget <= 0 then return '[]'::jsonb; end if;

  with c as (
    select id from email_log
     where ((status = 'pending' and send_after <= now())
            or (status = 'sending' and claimed_at < now() - interval '15 minutes'))
       and (kind in ('purchase_event', 'purchase_pro', 'welcome') or day_n < cfg.daily_cap - 20)
     order by case kind when 'purchase_event' then 0 when 'purchase_pro' then 0 when 'welcome' then 1
                        when 'storage80' then 2 when 'signin' then 3 when 'mod_approved' then 4 else 5 end,
              send_after, id
     limit budget
     for update skip locked),
  upd as (
    update email_log e set status = 'sending', claimed_at = now(), attempts = e.attempts + 1
      from c where e.id = c.id
    returning e.*)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'count', e.item_count, 'attempt', e.attempts,
      'created_at', e.created_at, 'payload', e.payload,
      'to', u.email, 'anon', coalesce(u.is_anonymous, false),
      'locale', s.locale, 'name', p.display_name, 'username', p.username,
      'plan_until', p.plan_until,
      'album', case when a.id is null then null else jsonb_build_object(
          'id', a.id, 'title', a.title, 'is_event', a.is_event, 'tier', a.event_tier,
          'storage_gb', a.event_storage_gb, 'storage_until', a.event_storage_until) end,
      'order', (select jsonb_build_object('tier', coalesce(o.tier,
                    case o.kind when 'event_medium' then 'medium' when 'event_large' then 'large' else 'small' end),
                    'storage_gb', o.storage_gb, 'amount', o.amount)
                  from paypal_orders o where o.order_id = e.payload->>'order_id')
    ) order by e.id), '[]'::jsonb) into res
    from upd e
    left join auth.users u on u.id = e.user_id
    left join profiles p on p.id = e.user_id
    left join email_user_state s on s.user_id = e.user_id
    left join albums a on a.id = e.album_id;
  return res;
end $$;

/** Итог отправки. p_retry — временная ошибка (429/5xx/сеть): ещё до 4 попыток. */
create or replace function public.email_mark(
  p_id bigint, p_status text, p_provider_id text default null, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update email_log set
    status = case p_status
               when 'sent'    then 'sent'
               when 'skipped' then 'skipped'
               when 'retry'   then case when attempts < 4 then 'pending' else 'failed' end
               else 'failed' end,
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    provider_id = coalesce(p_provider_id, provider_id),
    last_error = case when p_status = 'sent' then null else left(p_error, 500) end,
    send_after = case when p_status = 'retry' then now() + attempts * interval '10 minutes' else send_after end
  where id = p_id and status = 'sending';
end $$;

-- ---------------------------------------------------------------- расписание

-- Отложенные дайджесты и повторы. Без pg_cron они уйдут со следующим
-- «немедленным» письмом (email_kick при постановке).
do $$ begin
  perform cron.schedule('email-drain', '*/5 * * * *', $c$select public.email_kick()$c$);
exception when others then
  raise notice 'pg_cron недоступен — email-drain не запланирован: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- гранты

revoke execute on function public.email_kick()                                               from public, anon, authenticated;
revoke execute on function public.email_enqueue(text, uuid, text, jsonb, uuid, interval, boolean) from public, anon, authenticated;
revoke execute on function public.email_enqueue_batch(text, uuid, uuid, jsonb, interval, interval) from public, anon, authenticated;
revoke execute on function public.email_on_session(uuid, text)                               from public, anon, authenticated;
revoke execute on function public.email_claim(int)                                           from public, anon, authenticated;
revoke execute on function public.email_mark(bigint, text, text, text)                       from public, anon, authenticated;
revoke execute on function public.trg_email_mod_queue()                                      from public, anon, authenticated;
revoke execute on function public.trg_email_purchase_order()                                 from public, anon, authenticated;
revoke execute on function public.trg_email_purchase_pro()                                   from public, anon, authenticated;
revoke execute on function public.trg_email_storage80()                                      from public, anon, authenticated;
revoke execute on function public.ensure_profile(text)                                       from public, anon;
grant  execute on function public.ensure_profile(text)                                       to authenticated;
