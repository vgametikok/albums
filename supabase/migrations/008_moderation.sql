-- 008: жалобы, блокировки между пользователями, баны, скрытие контента,
--      модераторы и журнал их действий.
--
-- ЕДИНСТВЕННАЯ реализация блокировок в проекте: user_blocks + is_blocked_between.
-- Функции ядра видимости здесь НЕ переопределяются — предикаты будут вплетены
-- в can_view_* один раз в 015 (см. PLAN.md).

do $$ begin
  create type report_reason as enum ('spam','abuse','nudity','violence','copyright','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_status as enum ('open','resolved','rejected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- жалобы

create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references profiles(id) on delete cascade,
  subject_type text not null check (subject_type in ('album','post','comment','profile')),
  subject_id   uuid not null,
  reason       report_reason not null,
  note         text check (char_length(note) <= 1000),
  status       report_status not null default 'open',
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolution   text,
  unique (reporter_id, subject_type, subject_id)     -- одна жалоба на объект от человека
);
create index if not exists reports_open_idx on reports(status, created_at) where status = 'open';
create index if not exists reports_subject_idx on reports(subject_type, subject_id);

alter table reports enable row level security;
drop policy if exists reports_read on reports;
create policy reports_read on reports for select using (reporter_id = auth.uid());
-- запись только через RPC

-- ---------------------------------------------------------------- блокировки

create table if not exists user_blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on user_blocks(blocked_id);

alter table user_blocks enable row level security;
drop policy if exists blocks_read on user_blocks;
create policy blocks_read on user_blocks for select using (blocker_id = auth.uid());

/** Блокировка в любую сторону. Используется в can_view_* (сборка в 015). */
create or replace function public.is_blocked_between(u1 uuid, u2 uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select u1 is not null and u2 is not null and exists (
    select 1 from user_blocks
    where (blocker_id = u1 and blocked_id = u2)
       or (blocker_id = u2 and blocked_id = u1));
$$;

-- ---------------------------------------------------------------- баны и скрытие

alter table profiles add column if not exists banned_at    timestamptz;
alter table profiles add column if not exists ban_reason   text;
alter table albums   add column if not exists hidden_at    timestamptz;
alter table albums   add column if not exists hidden_reason text;
alter table posts    add column if not exists hidden_at    timestamptz;
alter table posts    add column if not exists hidden_reason text;
alter table comments add column if not exists hidden_at    timestamptz;

create index if not exists albums_hidden_idx on albums(hidden_at) where hidden_at is not null;
create index if not exists posts_hidden_idx  on posts(hidden_at)  where hidden_at is not null;

create or replace function public.is_banned(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and exists (select 1 from profiles where id = p_user and banned_at is not null);
$$;

-- ---------------------------------------------------------------- модераторы

create table if not exists mod_sessions (
  token_hash text primary key,               -- sha256 от случайного токена, сам токен не хранится
  login      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip_hash    text
);
create index if not exists mod_sessions_exp_idx on mod_sessions(expires_at);

create table if not exists mod_actions (
  id           uuid primary key default gen_random_uuid(),
  login        text not null,
  action       text not null,
  subject_type text,
  subject_id   uuid,
  report_id    uuid references reports(id) on delete set null,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists mod_actions_time_idx on mod_actions(created_at desc);

create table if not exists mod_login_attempts (
  ip_hash    text not null,
  created_at timestamptz not null default now(),
  ok         boolean not null
);
create index if not exists mod_attempts_idx on mod_login_attempts(ip_hash, created_at desc);

-- Ни одной политики: таблицы модерации недоступны ни anon, ни authenticated.
-- Работа с ними идёт только из edge-функции под service-ключом.
alter table mod_sessions       enable row level security;
alter table mod_actions        enable row level security;
alter table mod_login_attempts enable row level security;

revoke all on mod_sessions, mod_actions, mod_login_attempts from anon, authenticated;

-- ---------------------------------------------------------------- RPC пользователя

create or replace function public.report_submit(
  p_subject_type text, p_subject_id uuid, p_reason text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if me is null then raise exception 'auth required'; end if;
  if p_subject_type not in ('album','post','comment','profile') then
    raise exception 'Неизвестный тип объекта';
  end if;

  -- не даём заваливать жалобами
  select count(*) into n from reports where reporter_id = me and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'Слишком много жалоб за час, попробуйте позже'; end if;

  insert into reports (reporter_id, subject_type, subject_id, reason, note)
  values (me, p_subject_type, p_subject_id, p_reason::report_reason, nullif(btrim(coalesce(p_note,'')), ''))
  on conflict (reporter_id, subject_type, subject_id) do update
    set reason = excluded.reason, note = excluded.note, status = 'open', created_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.block_user(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Нельзя заблокировать себя'; end if;

  insert into user_blocks (blocker_id, blocked_id) values (me, target) on conflict do nothing;

  -- блокировка рвёт все связи: дружбу, подписки, соавторство
  delete from friendships where user_a = least(me,target) and user_b = greatest(me,target);
  delete from follows where (follower_id = me and following_id = target)
                         or (follower_id = target and following_id = me);
  delete from album_collaborators c using albums a
   where c.album_id = a.id
     and ((a.author_id = me and c.user_id = target) or (a.author_id = target and c.user_id = me));
  return jsonb_build_object('blocked', true);
end $$;

create or replace function public.unblock_user(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  delete from user_blocks where blocker_id = me and blocked_id = target;
  return jsonb_build_object('blocked', false);
end $$;

create or replace function public.my_blocks()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
    from user_blocks b join profiles p on p.id = b.blocked_id
    where b.blocker_id = auth.uid()), '[]'::jsonb);
$$;
