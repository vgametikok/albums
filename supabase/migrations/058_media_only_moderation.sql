-- =====================================================================
-- 058: модерируем только медиа. Альбомы (в т.ч. пустые) в очередь больше
-- не попадают.
--
-- Было (022 + 039): опубликованный альбом ждёт ручной проверки целиком и
-- посторонним не виден, пока модератор его не одобрит. Пустые альбомы
-- (события создаются сразу опубликованными и без единого кадра) забивали
-- очередь «New albums», а проверять в них нечего. Файлы, долитые автором
-- ПОСЛЕ одобрения альбома, модератор не видел вообще.
--
-- Стало:
--   1) Публикация альбома одобряет его автоматически (moderation_status =
--      'approved', запись в mod_actions от 'system'). Очередь альбомов
--      пустеет. Отклонённый ('rejected') альбом так и остаётся отклонённым.
--   2) Уведомление в Telegram о новом альбоме приходит в те же моменты, что
--      и раньше, но помечено «только для сведения»: число медиа, пометка
--      «пустой альбом» и начало описания — текст альбома больше никто не
--      проверяет, пусть хоть мелькнёт в чате.
--   3) КАЖДЫЙ кадр, положенный в альбом (автором, соавтором, гостем; до или
--      после публикации), попадает в mod_media_queue и до решения
--      модератора ПРИДЕРЖАН: album_media.mod_hold = true, visibility =
--      'private'. Задуманная видимость (null / friends / private) лежит в
--      mod_hold_vis и возвращается при одобрении. Так придержанный кадр
--      скрыт от публики сразу во всех местах, которые уже понимают
--      «private» (get_album, ленты, превью, счётчики, can_view_media,
--      подпись ссылок r2-sign, политика amedia_read, архив «Скачать всё»),
--      а автор, редакторы альбома, сам загрузивший и админка его видят.
--      Пока кадр придержан, смена видимости автором не снимает придержку —
--      выбор запоминается в mod_hold_vis.
--      Исключения из придержки (в очередь кадр всё равно попадает):
--        • файл уже одобрен модератором (или давно живёт в одобренном
--          опубликованном альбоме) — повторно не проверяем;
--        • неопубликованное (приватное) событие: его видят только автор и
--          участники, живая стена свадьбы не должна ждать модератора. Если
--          событие потом откроют, непроверенные кадры придержатся в момент
--          публикации.
--      Черновик обычного альбома: кадры придержаны сразу, а в очередь
--      уходят при публикации — модератор не тратит время на черновики,
--      которые никогда не выйдут.
--   4) Обложка. Обложка из кадров альбома прячется вместе с кадром (ветка
--      обложки в can_view_media требует, чтобы файл не был придержан и не
--      был скрыт модератором). Обложка, загруженная отдельно (не кадр
--      альбома, напр. «Обложка» на странице события), попадает в новую
--      очередь mod_cover_queue и до одобрения публике не подписывается —
--      фронт уже подставляет первый открытый кадр или заглушку.
--   5) mod_media_pending отдаёт обе очереди одной лентой, сгруппированной
--      по альбому, с названием, ссылками и автором. Сигнатуры RPC прежние —
--      mod-api передеплоивать не нужно.
--   6) Пинг «Новое медиа в альбоме» (038) теперь про всё, что ушло в
--      очередь (не только гостевое), с автором альбома и ссылками.
--   7) Бэкфилл: опубликованные альбомы, ждущие проверки, одобряются;
--      их непроверенные кадры придерживаются и уходят в очередь. Уже
--      одобренное не трогаем и в очередь не кладём.
--
-- ВНИМАНИЕ ПРО ЯДРО: здесь целиком переписываются can_view_media (прошлое
-- тело — 041) и og_card (036). С этого момента их единственный источник —
-- ЭТА миграция.
--
-- РИСК: название и описание альбома больше не проверяются человеком до
-- показа. Смягчение — текст приходит в Telegram (см. п.2), а жалобы и
-- ручное отклонение альбома (mod_review_album) работают как раньше.
--
-- Идемпотентна: повторный запуск ничего не ломает и не шлёт уведомлений.
-- =====================================================================

-- ---------------------------------------------------------------- 1. колонки

alter table public.album_media add column if not exists mod_hold boolean not null default false;
alter table public.album_media add column if not exists mod_hold_vis visibility_level;
create index if not exists album_media_mod_hold_idx on public.album_media (album_id) where mod_hold;

comment on column public.album_media.mod_hold is
  '058: кадр ждёт модератора и скрыт от публики (visibility=private). Снимает только mod_media_review.';
comment on column public.album_media.mod_hold_vis is
  '058: видимость, которую кадр получит после одобрения (null = как у альбома).';

-- ---------------------------------------------------------------- 2. очередь обложек

-- Обложка, которая не является кадром ни одного альбома: проверяется
-- отдельно. id идёт в mod_media_review тем же параметром p_am_id.
create table if not exists public.mod_cover_queue (
  id          uuid primary key default gen_random_uuid(),
  album_id    uuid not null references albums(id) on delete cascade,
  media_id    uuid not null references media(id) on delete cascade,
  added_at    timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  decision    text check (decision in ('approved', 'hidden')),
  unique (album_id, media_id)
);
create index if not exists mod_cover_queue_open_idx on public.mod_cover_queue (added_at)
  where reviewed_at is null;
create index if not exists mod_cover_queue_media_idx on public.mod_cover_queue (media_id);
create index if not exists mod_media_queue_media_idx on public.mod_media_queue (media_id);
alter table public.mod_cover_queue enable row level security;   -- политик нет: только mod-api
revoke all on public.mod_cover_queue from anon, authenticated;

-- ---------------------------------------------------------------- 3. помощники

/** Публичная ссылка на альбом (пара к mod_album_link из 044). */
create or replace function public.mod_album_public_link(p_album uuid)
returns text language sql immutable set search_path = public as $$
  select 'https://albums.ink/album.html?id=' || p_album::text;
$$;

/**
 * Файл уже проверен: модератор одобрил его (кадром или обложкой) либо он
 * давно живёт открытым кадром в одобренном опубликованном альбоме (всё, что
 * было до 058, считается проверенным). Скрытый модератором файл не проверен
 * никогда. p_skip_album — альбом, который сейчас публикуется: его
 * собственные строки доказательством служить не могут.
 */
create or replace function public.mod_media_is_approved(p_media uuid, p_skip_album uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from mod_media_queue q where q.media_id = p_media and q.decision = 'hidden')
     and not exists (select 1 from mod_cover_queue c where c.media_id = p_media and c.decision = 'hidden')
     and (exists (select 1 from mod_media_queue q where q.media_id = p_media and q.decision = 'approved')
          or exists (select 1 from mod_cover_queue c where c.media_id = p_media and c.decision = 'approved')
          or exists (select 1 from album_media am join albums a on a.id = am.album_id
                      where am.media_id = p_media
                        and am.album_id is distinct from p_skip_album
                        and not am.mod_hold
                        and a.published_at is not null and a.moderation_status = 'approved'
                        and not exists (select 1 from mod_media_queue q
                                        where q.am_id = am.id and q.reviewed_at is null)));
$$;

/**
 * Можно ли показывать файл ПОСТОРОННИМ как обложку альбома: он нигде не
 * придержан, не ждёт проверки и не скрыт модератором.
 */
create or replace function public.mod_cover_ok(p_album uuid, p_media uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from album_media am where am.media_id = p_media and am.mod_hold)
     and not exists (select 1 from mod_media_queue q
                     where q.media_id = p_media and (q.reviewed_at is null or q.decision = 'hidden'))
     and not exists (select 1 from mod_cover_queue c
                     where c.media_id = p_media
                       and ((c.album_id = p_album and c.reviewed_at is null) or c.decision = 'hidden'));
$$;

-- ---------------------------------------------------------------- 4. придержка кадра

/**
 * BEFORE INSERT OR UPDATE на album_media. Имя триггера начинается с
 * album_media_zz_, чтобы срабатывать ПОСЛЕ album_media_visibility_t (026):
 * тот сначала выставляет видимость (придержка гостя события), мы её
 * запоминаем и закрываем кадр.
 *
 * Снять придержку может только mod_media_review / бэкфилл: они ставят
 * локальный флаг albums.mod_release на время своей правки. Клиенту через
 * PostgREST его не выставить.
 */
create or replace function public.trg_album_media_mod_hold()
returns trigger language plpgsql security definer set search_path = public as $$
declare a_event boolean; a_pub timestamptz;
begin
  if coalesce(current_setting('albums.mod_release', true), '') = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    new.mod_hold := false;
    new.mod_hold_vis := null;
    -- уже проверенный файл (копия из библиотеки, спутник события) — не держим
    if mod_media_is_approved(new.media_id, new.album_id) then return new; end if;
    -- приватное (неопубликованное) событие: видят только участники — не держим,
    -- но в очередь кадр уйдёт (trg_mod_media_enqueue)
    select a.is_event, a.published_at into a_event, a_pub from albums a where a.id = new.album_id;
    if coalesce(a_event, false) and a_pub is null then return new; end if;

    new.mod_hold_vis := new.visibility;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    return new;
  end if;

  -- UPDATE
  -- подмена файла в уже одобренной строке (приложение так не делает, но
  -- прямой PATCH через PostgREST может): новый файл проходит проверку заново
  if new.media_id is distinct from old.media_id and not mod_media_is_approved(new.media_id, null) then
    if not old.mod_hold then new.mod_hold_vis := new.visibility; end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
    insert into mod_media_queue (am_id, album_id, media_id) values (new.id, new.album_id, new.media_id)
    on conflict (am_id) do update
      set media_id = excluded.media_id, added_at = now(),
          reviewed_at = null, reviewed_by = null, decision = null;
    return new;
  end if;

  if old.mod_hold then
    -- автор/редактор меняет видимость придержанного кадра: запоминаем выбор,
    -- но кадр остаётся закрытым до решения модератора
    if new.visibility is distinct from old.visibility then
      new.mod_hold_vis := new.visibility;
    else
      new.mod_hold_vis := old.mod_hold_vis;
    end if;
    new.mod_hold := true;
    new.visibility := 'private';
    new.is_private := true;
  else
    -- самому себе придержку не ставят и чужую цель не подменяют
    new.mod_hold := false;
    new.mod_hold_vis := old.mod_hold_vis;
  end if;
  return new;
end $$;

drop trigger if exists album_media_zz_mod_hold_t on public.album_media;
create trigger album_media_zz_mod_hold_t before insert or update on public.album_media
  for each row execute function public.trg_album_media_mod_hold();

-- ---------------------------------------------------------------- 5. постановка в очередь

/** Обложка альбома, которая не кадр: в mod_cover_queue (только у опубликованных). */
create or replace function public.mod_enqueue_cover(p_album uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a albums;
begin
  select * into a from albums where id = p_album;
  if a.id is null then return; end if;
  -- обложку сменили — старая непросмотренная заявка больше не нужна
  delete from mod_cover_queue
   where album_id = a.id and reviewed_at is null
     and media_id is distinct from a.cover_media_id;
  if a.cover_media_id is null or a.published_at is null then return; end if;
  -- кадр какого-либо альбома проверяется в mod_media_queue (mod_cover_ok это учитывает)
  if exists (select 1 from album_media am where am.media_id = a.cover_media_id) then return; end if;
  if mod_media_is_approved(a.cover_media_id, null) then return; end if;
  insert into mod_cover_queue (album_id, media_id) values (a.id, a.cover_media_id)
  on conflict (album_id, media_id) do nothing;
end $$;

/** Всё придержанное в альбоме — в очередь, плюс обложка. */
create or replace function public.mod_enqueue_album(p_album uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into mod_media_queue (am_id, album_id, media_id)
  select am.id, am.album_id, am.media_id from album_media am
   where am.album_id = p_album and am.mod_hold
  on conflict (am_id) do nothing;
  perform mod_enqueue_cover(p_album);
end $$;

/**
 * Альбом становится видимым посторонним (публикация). p_first — альбом
 * публикуется впервые (ни разу не был одобрен): тогда придерживаем ВСЕ его
 * непроверенные кадры, включая залитые до 058. При повторной публикации
 * ранее одобренного альбома придерживаем только то, что ждёт в очереди
 * (например, кадры приватного события, которое сделали открытым).
 */
create or replace function public.mod_on_publish(p_album uuid, p_first boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('albums.mod_release', 'on', true);
  update album_media am
     set mod_hold_vis = am.visibility, mod_hold = true, visibility = 'private'
   where am.album_id = p_album and not am.mod_hold
     and not exists (select 1 from mod_media_queue q where q.am_id = am.id and q.decision is not null)
     and (exists (select 1 from mod_media_queue q where q.am_id = am.id and q.reviewed_at is null)
          or (p_first and not mod_media_is_approved(am.media_id, p_album)));
  perform set_config('albums.mod_release', '', true);
  perform mod_enqueue_album(p_album);
end $$;

/**
 * AFTER INSERT на album_media (имя триггера прежнее, из 039). В очередь —
 * всё, что не проверено, от кого бы ни пришло. Черновик обычного альбома
 * ждёт публикации (mod_on_publish), событие — в очередь сразу.
 */
create or replace function public.trg_mod_media_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums;
begin
  if not new.mod_hold and mod_media_is_approved(new.media_id, new.album_id) then return new; end if;
  select * into a from albums where id = new.album_id;
  if a.id is null then return new; end if;
  if not a.is_event and a.published_at is null then return new; end if;

  insert into mod_media_queue (am_id, album_id, media_id) values (new.id, a.id, new.media_id)
  on conflict (am_id) do nothing;
  return new;
exception when others then
  return new;   -- очередь не должна ронять загрузку
end $$;

drop trigger if exists trg_mod_media_enqueue_t on public.album_media;
create trigger trg_mod_media_enqueue_t after insert on public.album_media
  for each row execute function public.trg_mod_media_enqueue();

/**
 * Кадр, служивший обложкой, убрали из альбома, а обложкой он остался: теперь
 * это «отдельная» обложка — пусть её проверят (если файл не проверен).
 */
create or replace function public.trg_album_media_cover_orphan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from albums a where a.id = old.album_id and a.cover_media_id = old.media_id) then
    perform mod_enqueue_cover(old.album_id);
  end if;
  return null;
exception when others then
  return null;   -- удаление кадра важнее
end $$;

drop trigger if exists album_media_zz_mod_cover_t on public.album_media;
create trigger album_media_zz_mod_cover_t after delete on public.album_media
  for each row execute function public.trg_album_media_cover_orphan();

-- ---------------------------------------------------------------- 6. альбом: автоодобрение

/**
 * BEFORE INSERT OR UPDATE на albums. Имя trg_albums_zz_… сортируется ПОСЛЕ
 * trg_albums_review_guard (022): страж сначала возвращает статус, который
 * клиент пытался подменить, а уже потом мы одобряем публикуемый альбом.
 */
create or replace function public.trg_album_auto_approve()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.published_at is not null and new.moderation_status = 'pending' then
    new.moderation_status := 'approved';
    new.reviewed_at := now();
    new.review_note := null;
    insert into mod_actions (login, action, subject_type, subject_id, note)
    values ('system', 'approve', 'album', new.id, 'auto (058): media-only moderation, album text not reviewed');
  end if;
  return new;
end $$;

drop trigger if exists trg_albums_zz_auto_approve on public.albums;
create trigger trg_albums_zz_auto_approve before insert or update on public.albums
  for each row execute function public.trg_album_auto_approve();

/** AFTER: публикация и смена обложки — придержка и очередь. */
create or replace function public.trg_album_mod_publish()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.published_at is null then return null; end if;
  if tg_op = 'INSERT' then
    perform mod_on_publish(new.id, true);
  elsif old.published_at is null then
    perform mod_on_publish(new.id, old.moderation_status = 'pending');
  elsif new.cover_media_id is distinct from old.cover_media_id then
    perform mod_enqueue_cover(new.id);
  end if;
  return null;
end $$;

drop trigger if exists trg_albums_mod_publish_t on public.albums;
create trigger trg_albums_mod_publish_t after insert or update of published_at, cover_media_id on public.albums
  for each row execute function public.trg_album_mod_publish();

-- ---------------------------------------------------------------- 7. Telegram: альбом

/**
 * Тот же момент, что и раньше (первая публикация; события — при создании),
 * но альбом уже одобрен — сообщение только для сведения. Число медиа
 * считаем по строкам album_media: photos_count считает лишь открытые кадры,
 * а при публикации все они ещё придержаны.
 */
create or replace function public.trg_notify_album_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare author text; n_all int; n_held int; d text;
begin
  select username into author from profiles where id = new.author_id;
  select count(*), count(*) filter (where mod_hold) into n_all, n_held
    from album_media where album_id = new.id;
  d := nullif(btrim(coalesce(new.description, '')), '');
  perform notify_telegram(
    '🖼 Новый альбом опубликован — только для сведения' || chr(10) ||
    '«' || left(new.title, 120) || '» — @' || coalesce(author, '?') || chr(10) ||
    coalesce(new.category || ' · ', '') ||
    case when new.is_event then 'событие · ' else '' end ||
    case when n_all = 0 then '⚠️ пустой альбом, медиа нет'
         else n_all || ' медиа, на модерации: ' || n_held end || chr(10) ||
    case when d is not null
         then '📝 ' || left(d, 300) || case when length(d) > 300 then '…' else '' end || chr(10)
         else '' end ||
    'ℹ️ Альбом виден сразу. Название и описание модератор не проверяет, медиа ждут в New media.' || chr(10) ||
    mod_album_public_link(new.id) || chr(10) ||
    mod_album_link(new.id));
  return new;
exception when others then
  return new;   -- сборка текста не должна ронять публикацию альбома
end $$;

-- Условия: раньше «статус pending» — теперь BEFORE-триггер уже одобрил
-- строку, поэтому для UPDATE смотрим на СТАРЫЙ статус (альбом ни разу не
-- был одобрен — значит это его первая публикация, как и раньше).
drop trigger if exists trg_notify_album_review_t on public.albums;
create trigger trg_notify_album_review_t after update on public.albums
  for each row
  when (new.published_at is not null and old.published_at is null and old.moderation_status = 'pending')
  execute function public.trg_notify_album_review();

drop trigger if exists trg_notify_album_review_ins on public.albums;
create trigger trg_notify_album_review_ins after insert on public.albums
  for each row
  when (new.published_at is not null)
  execute function public.trg_notify_album_review();

-- ---------------------------------------------------------------- 8. Telegram: медиа

/**
 * Пинг про медиа (038), теперь про всё, что встало в очередь (а не только
 * гостевое), с автором альбома и ссылками. Троттлинг прежний: по альбому не
 * чаще раза в 30 минут, накопившееся — счётчиком. Черновики молчат: их
 * кадры посчитает сообщение о публикации.
 * Триггер trg_notify_album_media_t сортируется после trg_mod_media_enqueue_t,
 * поэтому строка очереди к этому моменту уже есть.
 */
create or replace function public.trg_notify_album_media()
returns trigger language plpgsql security definer set search_path = public as $$
declare a albums; author text; cur tg_media_pings; queued int;
begin
  if not exists (select 1 from mod_media_queue q where q.am_id = new.id and q.reviewed_at is null) then
    return new;
  end if;
  select * into a from albums where id = new.album_id;
  if a.id is null then return new; end if;

  insert into tg_media_pings (album_id, pending) values (a.id, 1)
  on conflict (album_id) do update set pending = tg_media_pings.pending + 1
  returning * into cur;

  if cur.last_sent is null or cur.last_sent < now() - interval '30 minutes' then
    update tg_media_pings set pending = 0, last_sent = now() where album_id = a.id;
    select username into author from profiles where id = a.author_id;
    select count(*) into queued from mod_media_queue q where q.album_id = a.id and q.reviewed_at is null;
    perform notify_telegram(
      '📸 Новое медиа на модерацию' || chr(10) ||
      '«' || left(a.title, 120) || '» — @' || coalesce(author, '?') || chr(10) ||
      case when cur.pending > 1
           then 'и ещё ' || (cur.pending - 1) || ' с прошлого уведомления · '
           else '' end ||
      'в очереди по альбому: ' || queued || chr(10) ||
      mod_album_public_link(a.id) || chr(10) ||
      'https://albums.ink/moderation.html?tab=media&album=' || a.id::text);
  end if;
  return new;
exception when others then
  return new;   -- уведомление не должно ронять загрузку
end $$;

drop trigger if exists trg_notify_album_media_t on public.album_media;
create trigger trg_notify_album_media_t after insert on public.album_media
  for each row execute function public.trg_notify_album_media();

-- ---------------------------------------------------------------- 9. админка: выдача и решение

/**
 * Обе очереди одной лентой. Порядок — по альбомам (альбом с самым старым
 * ожидающим файлом первым), внутри альбома — по времени, чтобы страница
 * выдачи резала ленту по границам групп как можно реже.
 * am_id — ключ для mod_media_review (строка album_media или заявка обложки).
 */
create or replace function public.mod_media_pending(p_limit int default 60, p_offset int default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  with open_items as (
    select q.am_id as qid, 'media'::text as item, q.album_id, q.media_id, q.added_at, q.am_id as am_row
      from mod_media_queue q where q.reviewed_at is null
    union all
    select c.id, 'cover', c.album_id, c.media_id, c.added_at, null::uuid
      from mod_cover_queue c where c.reviewed_at is null),
  ranked as (
    select o.*, min(o.added_at) over (partition by o.album_id) as album_first,
           count(*) over (partition by o.album_id) as album_open
      from open_items o),
  page as (
    select * from ranked
     order by album_first, album_id, added_at, qid
     limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset))
  select coalesce(jsonb_agg(x order by ord), '[]'::jsonb) from (
    select row_number() over (order by p.album_first, p.album_id, p.added_at, p.qid) as ord,
      jsonb_build_object(
        'am_id', p.qid, 'item', p.item, 'added_at', p.added_at,
        'album_id', a.id, 'album_title', a.title,
        'album_description', left(a.description, 300),
        'album_url', mod_album_public_link(a.id), 'album_mod_url', mod_album_link(a.id),
        'album_published', a.published_at is not null,
        'album_visibility', a.visibility::text, 'album_status', a.moderation_status,
        'album_open', p.album_open,
        'album_files', (select count(*) from album_media x where x.album_id = a.id),
        'is_event', a.is_event,
        'album_owner', op.username, 'album_owner_name', op.display_name,
        'kind', m.kind, 'path', m.storage_path, 'thumb', m.thumb_path,
        'duration', m.duration_seconds,
        'caption', am.caption,
        'held', coalesce(am.mod_hold, false),
        -- видимость, которую выбрал автор/владелец события (а не техническая придержка)
        'visibility', (case when am.mod_hold then am.mod_hold_vis else am.visibility end)::text,
        'is_private', case when am.mod_hold then coalesce(am.mod_hold_vis in ('friends', 'private'), false)
                           else coalesce(am.is_private, false) end,
        'anon', am.anon,
        'uploader', up.username, 'uploader_name', up.display_name,
        'uploader_is_author', m.owner_id = a.author_id,
        'uploader_guest', exists (select 1 from auth.users u
                                  where u.id = m.owner_id and coalesce(u.is_anonymous, false)),
        'reports', (select count(*) from reports r
                    where r.subject_type = 'album' and r.subject_id = a.id)) as x
    from page p
    join media m on m.id = p.media_id
    join albums a on a.id = p.album_id
    join profiles op on op.id = a.author_id
    left join album_media am on am.id = p.am_row
    left join profiles up on up.id = m.owner_id) s;
$$;

create or replace function public.mod_media_count()
returns int language sql stable security definer set search_path = public as $$
  select ((select count(*) from mod_media_queue where reviewed_at is null)
        + (select count(*) from mod_cover_queue where reviewed_at is null))::int;
$$;

/**
 * Решение. Кадр: approve — придержка снимается, возвращается задуманная
 * видимость; hide — кадр становится private (публика не видит, загрузивший
 * видит своё). Обложка: approve — показывается; hide — публике не
 * подписывается никогда (mod_cover_ok), фронт рисует запасную картинку.
 */
create or replace function public.mod_media_review(
  p_am_id uuid, p_approve boolean, p_login text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q mod_media_queue; c mod_cover_queue;
begin
  select * into q from mod_media_queue where am_id = p_am_id and reviewed_at is null;
  if found then
    perform set_config('albums.mod_release', 'on', true);
    if p_approve then
      update album_media set mod_hold = false, visibility = mod_hold_vis, mod_hold_vis = null
       where id = p_am_id and mod_hold;
    else
      update album_media set mod_hold = false, mod_hold_vis = null, visibility = 'private'
       where id = p_am_id;
    end if;
    perform set_config('albums.mod_release', '', true);

    update mod_media_queue
       set reviewed_at = now(), reviewed_by = p_login,
           decision = case when p_approve then 'approved' else 'hidden' end
     where am_id = p_am_id;

    insert into mod_actions (login, action, subject_type, subject_id, note)
    values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', q.album_id,
            'media ' || q.media_id::text);
    return jsonb_build_object('ok', true);
  end if;

  select * into c from mod_cover_queue where id = p_am_id and reviewed_at is null;
  if not found then return jsonb_build_object('error', 'not_in_queue'); end if;

  update mod_cover_queue
     set reviewed_at = now(), reviewed_by = p_login,
         decision = case when p_approve then 'approved' else 'hidden' end
   where id = p_am_id;

  insert into mod_actions (login, action, subject_type, subject_id, note)
  values (p_login, case when p_approve then 'approve' else 'hide' end, 'album', c.album_id,
          'cover ' || c.media_id::text);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- 10. ядро: can_view_media

/**
 * Полное тело (прошлое — 041). Единственная правка — ветка «обложка»:
 * файл автора альбома показывается обложкой, только если mod_cover_ok
 * (не придержан, не ждёт проверки, не скрыт модератором). Обложка-кадр
 * этого же альбома по-прежнему видна, пока кадр открыт.
 */
create or replace function public.can_view_media(m_id uuid, viewer uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    -- владелец файла (гость события всегда видит то, что залил сам)
    exists (select 1 from media where id = m_id and owner_id = viewer)
    -- открытый файл в видимом альбоме
    or exists (select 1 from album_media am
               where am.media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- файл «только для друзей автора» внутри видимого альбома
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- скрытый файл: только владелец альбома и РЕДАКТОР. Гость события — нет.
    -- (сюда же попадают кадры, придержанные до решения модератора, 058)
    or exists (select 1 from album_media am
               where am.media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- обложка видимого альбома: открытый кадр этого же альбома либо файл
    -- автора альбома, прошедший модерацию (058)
    or exists (select 1 from albums al
               where al.cover_media_id = m_id and can_view_album(al.id, viewer)
                 and (exists (select 1 from album_media am
                              where am.album_id = al.id and am.media_id = m_id and not am.is_private)
                      or (exists (select 1 from media m where m.id = m_id and m.owner_id = al.author_id)
                          and mod_cover_ok(al.id, m_id))))
    -- слайд видимого поста
    or exists (select 1 from post_media pm
               where pm.media_id = m_id and can_view_post(pm.post_id, viewer))
    -- аудио-рассказ виден тем же, кому виден альбом, но только если запись
    -- принадлежит автору альбома (страж ниже держит это и на входе)
    or exists (select 1 from album_narrations n join albums a on a.id = n.album_id
               where n.media_id = m_id and can_view_album(n.album_id, viewer)
                 and exists (select 1 from media m where m.id = m_id and m.owner_id = a.author_id))
    -- голосовая открытого кадра — тем, кому виден альбом
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and not am.is_private
                 and can_view_album(am.album_id, viewer))
    -- голосовая friends-кадра — друзьям автора (и самому автору)
    or exists (select 1 from album_media am join albums a on a.id = am.album_id
               where am.voice_media_id = m_id and am.visibility = 'friends'
                 and can_view_album(am.album_id, viewer)
                 and (a.author_id = viewer or are_friends(a.author_id, viewer)))
    -- голосовая скрытого кадра — только владельцу альбома и редакторам
    or exists (select 1 from album_media am
               where am.voice_media_id = m_id and am.visibility = 'private'
                 and (exists (select 1 from albums a where a.id = am.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = am.album_id and c.user_id = viewer and c.role = 'editor')))
    -- голосовая галереи
    or exists (select 1 from album_galleries g
               where g.voice_media_id = m_id
                 and (exists (select 1 from albums a where a.id = g.album_id and a.author_id = viewer)
                      or exists (select 1 from album_collaborators c
                                 where c.album_id = g.album_id and c.user_id = viewer and c.role = 'editor')
                      or (can_view_album(g.album_id, viewer)
                          and exists (select 1 from album_media am join albums a2 on a2.id = am.album_id
                                      where am.gallery_id = g.id and am.album_id = g.album_id
                                        and (not am.is_private
                                             or (am.visibility = 'friends'
                                                 and are_friends(a2.author_id, viewer)))))));
$$;

-- ---------------------------------------------------------------- 11. OG-превью без непроверенной обложки

/** Полное тело (прошлое — 036). Правка одна: обложка — только если её видно анониму. */
create or replace function public.og_card(p_type text, p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a albums; po posts; pr profiles; kid uuid;
begin
  if p_type = 'album' then
    begin kid := p_key::uuid; exception when others then return null; end;
    if not can_view_album(kid, null) then return null; end if;
    select * into a from albums where id = kid;
    select * into pr from profiles where id = a.author_id;
    return jsonb_build_object(
      'type', 'album', 'id', a.id, 'title', a.title,
      'desc', nullif(btrim(coalesce(a.description, '')), ''),
      'author', coalesce(nullif(pr.display_name, ''), pr.username),
      'author_username', pr.username,
      'photos', a.photos_count, 'videos', a.videos_count, 'audio', a.audio_count,
      'cover', (select coalesce(m.thumb_path, m.storage_path)
                from media m where m.id = a.cover_media_id and can_view_media(m.id, null)));

  elsif p_type = 'post' then
    begin kid := p_key::uuid; exception when others then return null; end;
    if not can_view_post(kid, null) then return null; end if;
    select * into po from posts where id = kid;
    select * into pr from profiles where id = po.author_id;
    return jsonb_build_object(
      'type', 'post', 'id', po.id,
      'title', coalesce(nullif(pr.display_name, ''), pr.username) || ' · Albums',
      'desc', nullif(btrim(coalesce(po.caption, '')), ''),
      'author', coalesce(nullif(pr.display_name, ''), pr.username),
      'author_username', pr.username,
      'cover', (select coalesce(m.thumb_path, m.storage_path)
                from post_media pm join media m on m.id = pm.media_id
                where pm.post_id = po.id order by pm.position limit 1));

  elsif p_type = 'user' then
    select * into pr from profiles where username = lower(p_key);
    if pr.id is null or pr.banned_at is not null or pr.deleted_at is not null then return null; end if;
    return jsonb_build_object(
      'type', 'user', 'username', pr.username,
      'title', coalesce(nullif(pr.display_name, ''), pr.username),
      'desc', nullif(btrim(coalesce(pr.bio, '')), ''),
      'avatar', pr.avatar_url,
      'albums', (select count(*) from albums al
                 where al.author_id = pr.id and can_view_album(al.id, null)));
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- 12. бэкфилл

/**
 * Опубликованные альбомы, ждущие проверки: их непроверенные кадры
 * придерживаются и уходят в очередь, сам альбом одобряется (в т.ч. пустой).
 * Уведомления в Telegram при этом НЕ уходят: published_at не меняется.
 * Черновики не трогаем — их кадры придержатся при публикации.
 * Уже одобренные альбомы и их кадры не трогаем и в очередь не кладём.
 */
do $$
declare r record; n_albums int := 0;
begin
  for r in select id from albums where published_at is not null and moderation_status = 'pending' loop
    perform mod_on_publish(r.id, true);
    update albums set moderation_status = 'approved', reviewed_at = now(), review_note = null
     where id = r.id;
    insert into mod_actions (login, action, subject_type, subject_id, note)
    values ('system', 'approve', 'album', r.id, 'auto (058 backfill): media-only moderation');
    n_albums := n_albums + 1;
  end loop;
  raise notice '058 backfill: % pending album(s) approved', n_albums;
end $$;

-- ---------------------------------------------------------------- гранты

revoke execute on function public.mod_album_public_link(uuid)           from public, anon, authenticated;
revoke execute on function public.mod_media_is_approved(uuid, uuid)     from public, anon, authenticated;
revoke execute on function public.mod_cover_ok(uuid, uuid)              from public, anon, authenticated;
revoke execute on function public.trg_album_media_mod_hold()            from public, anon, authenticated;
revoke execute on function public.mod_enqueue_cover(uuid)               from public, anon, authenticated;
revoke execute on function public.mod_enqueue_album(uuid)               from public, anon, authenticated;
revoke execute on function public.mod_on_publish(uuid, boolean)         from public, anon, authenticated;
revoke execute on function public.trg_mod_media_enqueue()               from public, anon, authenticated;
revoke execute on function public.trg_album_media_cover_orphan()        from public, anon, authenticated;
revoke execute on function public.trg_album_auto_approve()              from public, anon, authenticated;
revoke execute on function public.trg_album_mod_publish()               from public, anon, authenticated;
revoke execute on function public.trg_notify_album_review()             from public, anon, authenticated;
revoke execute on function public.trg_notify_album_media()              from public, anon, authenticated;
revoke execute on function public.mod_media_pending(int, int)           from public, anon, authenticated;
revoke execute on function public.mod_media_count()                     from public, anon, authenticated;
revoke execute on function public.mod_media_review(uuid, boolean, text) from public, anon, authenticated;
grant  execute on function public.can_view_media(uuid, uuid)            to anon, authenticated;
grant  execute on function public.og_card(text, text)                   to anon, authenticated;
