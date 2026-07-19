-- 009: защита от злоупотреблений — ограничения частоты, мягкое удаление
--      аккаунта с окном отмены, экспорт своих данных.
--
-- Пороги подобраны так, чтобы не мешать живому человеку: они срабатывают на
-- скриптах, а не на активном обсуждении. Для событийных альбомов лимит
-- комментариев отдельно поднят — после свадьбы гости пишут пачками.

create or replace function public.rl_check(
  p_table text, p_owner_col text, p_user uuid, p_window interval, p_max int, p_what text)
returns void language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_user is null then return; end if;
  execute format('select count(*) from %I where %I = $1 and created_at > now() - $2', p_table, p_owner_col)
    into n using p_user, p_window;
  if n >= p_max then
    raise exception '%', p_what using errcode = 'PT429';
  end if;
end $$;

create or replace function public.trg_rl_comments()
returns trigger language plpgsql security definer set search_path = public as $$
declare lim int := 12;
begin
  -- в событийных альбомах обсуждение идёт лавиной — там потолок выше
  if new.subject_type = 'album' and exists (
      select 1 from album_collaborators c where c.album_id = new.subject_id) then
    lim := 40;
  end if;
  perform rl_check('comments', 'author_id', new.author_id, interval '1 minute', lim,
                   'Слишком много комментариев подряд, подождите минуту');
  perform rl_check('comments', 'author_id', new.author_id, interval '1 day', 500,
                   'Дневной лимит комментариев исчерпан');
  return new;
end $$;

create or replace function public.trg_rl_posts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform rl_check('posts', 'author_id', new.author_id, interval '1 hour', 30,
                   'Слишком много постов за час');
  return new;
end $$;

create or replace function public.trg_rl_albums()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform rl_check('albums', 'author_id', new.author_id, interval '1 hour', 40,
                   'Слишком много альбомов за час');
  return new;
end $$;

create or replace function public.trg_rl_media()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform rl_check('media', 'owner_id', new.owner_id, interval '1 hour', 400,
                   'Слишком много файлов за час');
  return new;
end $$;

create or replace function public.trg_rl_friendships()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform rl_check('friendships', 'requested_by', new.requested_by, interval '1 day', 100,
                   'Слишком много заявок в друзья за сутки');
  return new;
end $$;

drop trigger if exists rl_comments_t    on comments;
drop trigger if exists rl_posts_t       on posts;
drop trigger if exists rl_albums_t      on albums;
drop trigger if exists rl_media_t       on media;
drop trigger if exists rl_friendships_t on friendships;

create trigger rl_comments_t    before insert on comments    for each row execute function public.trg_rl_comments();
create trigger rl_posts_t       before insert on posts       for each row execute function public.trg_rl_posts();
create trigger rl_albums_t      before insert on albums      for each row execute function public.trg_rl_albums();
create trigger rl_media_t       before insert on media       for each row execute function public.trg_rl_media();
create trigger rl_friendships_t before insert on friendships for each row execute function public.trg_rl_friendships();

-- ---------------------------------------------------------------- удаление аккаунта

alter table profiles add column if not exists deleted_at timestamptz;

create table if not exists account_deletions (
  user_id      uuid primary key references profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after  timestamptz not null,
  cancelled_at timestamptz
);

alter table account_deletions enable row level security;
drop policy if exists acc_del_read on account_deletions;
create policy acc_del_read on account_deletions for select using (user_id = auth.uid());

/** Мягкое удаление: 7 дней на передумать, потом чистка сервисным ключом. */
create or replace function public.request_account_deletion()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  update profiles set deleted_at = now() where id = me;
  insert into account_deletions (user_id, purge_after)
  values (me, now() + interval '7 days')
  on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '7 days',
                                      cancelled_at = null;
  return jsonb_build_object('purge_after', (now() + interval '7 days'));
end $$;

create or replace function public.cancel_account_deletion()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  update profiles set deleted_at = null where id = me;
  update account_deletions set cancelled_at = now() where user_id = me;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- экспорт данных

create or replace function public.export_my_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'note', 'Ссылки на файлы действительны 24 часа. Не пересылайте этот файл — по нему доступен весь ваш архив.',
    'profile', (select to_jsonb(p) - 'id' from profiles p where p.id = auth.uid()),
    'albums', coalesce((select jsonb_agg(jsonb_build_object(
        'title', a.title, 'description', a.description, 'category', a.category,
        'visibility', a.visibility, 'created_at', a.created_at, 'published_at', a.published_at,
        'media', coalesce((select jsonb_agg(jsonb_build_object(
            'kind', m.kind, 'path', m.storage_path, 'caption', am.caption,
            'is_private', am.is_private) order by am.position)
          from album_media am join media m on m.id = am.media_id where am.album_id = a.id), '[]'::jsonb)))
      from albums a where a.author_id = auth.uid()), '[]'::jsonb),
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
        'caption', p.caption, 'visibility', p.visibility, 'created_at', p.created_at))
      from posts p where p.author_id = auth.uid()), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'body', c.body, 'created_at', c.created_at, 'subject_type', c.subject_type))
      from comments c where c.author_id = auth.uid()), '[]'::jsonb),
    'media_files', coalesce((select jsonb_agg(m.storage_path) from media m where m.owner_id = auth.uid()), '[]'::jsonb));
$$;
