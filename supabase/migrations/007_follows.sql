-- 007: подписки (односторонняя связь в дополнение к взаимной дружбе).
--
-- ВАЖНО: подписка НИКОГДА не расширяет видимость. Доступ к контенту «для друзей»
-- по-прежнему даёт только взаимная дружба. Подписка влияет исключительно на ленту
-- и на счётчики профиля.
--
-- Эта миграция ДОБАВЛЯЕТ объекты и не трогает функции ядра видимости — они
-- переопределяются один раз в 015 (см. PLAN.md).

create table if not exists follows (
  follower_id  uuid not null references profiles(id) on delete cascade,
  following_id uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index if not exists follows_following_idx on follows(following_id, created_at desc);
create index if not exists follows_follower_idx  on follows(follower_id, created_at desc);

alter table profiles add column if not exists followers_count int not null default 0;
alter table profiles add column if not exists following_count int not null default 0;

alter table follows enable row level security;

-- Кто на кого подписан — открыто (как в большинстве соцсетей), но менять только через RPC.
drop policy if exists follows_read on follows;
create policy follows_read on follows for select using (true);

create or replace function public.trg_follow_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare f uuid; g uuid;
begin
  f := coalesce(new.follower_id, old.follower_id);
  g := coalesce(new.following_id, old.following_id);
  update profiles set following_count = (select count(*) from follows where follower_id = f) where id = f;
  update profiles set followers_count = (select count(*) from follows where following_id = g) where id = g;
  return null;
end $$;

drop trigger if exists follow_counts_t on follows;
create trigger follow_counts_t after insert or delete on follows
for each row execute function public.trg_follow_counts();

create or replace function public.is_following(p_follower uuid, p_following uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_follower is not null and p_following is not null
     and exists (select 1 from follows where follower_id = p_follower and following_id = p_following);
$$;

create or replace function public.follow_user(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Нельзя подписаться на себя'; end if;
  insert into follows (follower_id, following_id) values (me, target) on conflict do nothing;
  return jsonb_build_object('following', true);
end $$;

create or replace function public.unfollow_user(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  delete from follows where follower_id = me and following_id = target;
  return jsonb_build_object('following', false);
end $$;

create or replace function public.my_follows()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'following', coalesce((
      select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
      from follows f join profiles p on p.id = f.following_id
      where f.follower_id = auth.uid()), '[]'::jsonb),
    'followers', coalesce((
      select jsonb_agg(jsonb_build_object('username',p.username,'name',p.display_name,'avatar',p.avatar_url))
      from follows f join profiles p on p.id = f.follower_id
      where f.following_id = auth.uid()), '[]'::jsonb));
$$;

-- Дружба подразумевает подписку в обе стороны: иначе друзья не видят друг друга в ленте.
create or replace function public.friend_request(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid; f friendships;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Нельзя добавить себя'; end if;

  select * into f from friendships
   where user_a = least(me,target) and user_b = greatest(me,target);

  if found then
    if f.status = 'accepted' then return jsonb_build_object('state','friends'); end if;
    if f.requested_by = me then return jsonb_build_object('state','sent'); end if;
    update friendships set status='accepted', responded_at=now()
     where user_a = least(me,target) and user_b = greatest(me,target);
    insert into follows (follower_id, following_id) values (me, target), (target, me)
      on conflict do nothing;
    return jsonb_build_object('state','friends');
  end if;

  insert into friendships (user_a, user_b, requested_by)
  values (least(me,target), greatest(me,target), me);
  return jsonb_build_object('state','sent');
end $$;

create or replace function public.friend_respond(p_username text, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid; f friendships;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into other from profiles where username = lower(p_username);
  if other is null then raise exception 'Пользователь не найден'; end if;

  select * into f from friendships
   where user_a = least(me,other) and user_b = greatest(me,other) and status = 'pending';
  if not found then raise exception 'Заявки нет'; end if;
  if f.requested_by = me then raise exception 'Нельзя ответить на свою заявку'; end if;

  if p_accept then
    update friendships set status='accepted', responded_at=now()
     where user_a = least(me,other) and user_b = greatest(me,other);
    insert into follows (follower_id, following_id) values (me, other), (other, me)
      on conflict do nothing;
    return jsonb_build_object('state','friends');
  else
    delete from friendships where user_a = least(me,other) and user_b = greatest(me,other);
    return jsonb_build_object('state','none');
  end if;
end $$;

-- Разрыв дружбы снимает и подписки: иначе человек «удалил из друзей», а контент
-- продолжает приходить в ленту — ровно та путаница двух связей, которой боялись.
create or replace function public.friend_remove(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); other uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select id into other from profiles where username = lower(p_username);
  if other is null then raise exception 'Пользователь не найден'; end if;
  delete from friendships where user_a = least(me,other) and user_b = greatest(me,other);
  delete from follows where (follower_id = me and following_id = other)
                         or (follower_id = other and following_id = me);
  return jsonb_build_object('state','none');
end $$;

grant select on follows to anon, authenticated;
