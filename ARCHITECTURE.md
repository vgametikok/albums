# Albums — архитектура

Соцсеть, где единица контента — **альбом**: курируемая коллекция фото, видео и голосовых заметок, читающаяся как история (референс-дизайн: `Albums social network design/` — main/Album/Profile, палитра #F5F4F0, акцент #E8552B, Inter). Вторая поверхность — **инста-лента постов**: пост = фото/видео или карусель из них.

Дата: 2026-07-19. Статус: архитектура утверждается, код не написан.

---

## 1. Стек и слои

| Слой | Технология |
|---|---|
| Frontend | Статика: HTML + ES-модули, **без сборки** (паттерн sharky_web) |
| Хостинг | GitHub Pages, репо `vgametikok/albums` → `https://vgametikok.github.io/albums/` |
| Backend | Supabase: Postgres + RLS, Auth (Google), Storage, RPC (SECURITY DEFINER) |
| Клиент БД | supabase-js v2 с jsDelivr (пин версии) |
| DB-деплой | Миграции SQL; см. §10 «Операционное ограничение» |

Edge Functions в MVP **не нужны**: вся логика в RLS + DEFINER-RPC. (Появятся позже — транскодинг/уведомления.)

## 2. Структура репозитория

```
albums/
  index.html      — главная: лента рекомендаций альбомов (чипы, featured, сетка)
  posts.html      — инста-лента постов + композер (карусель)
  album.html?id=  — страница альбома: обложка, главы, медиа, комментарии
  post.html?id=   — пост по дип-линку + комментарии
  profile.html?u= — профиль: статистика, кнопка дружбы, сетка альбомов
  editor.html?id= — создание/редактирование альбома (медиа, главы, видимость)
  js/   config.js sb.js ui.js api.js feed.js editor.js composer.js comments.js
  css/  base.css
  supabase/migrations/*.sql   — исходники миграций (применяются в БД отдельно)
  design/                     — референсы .dc.html (не для прода)
  ARCHITECTURE.md  CHANGELOG.txt
```

Версионирование: v0.x.0 + CHANGELOG.txt (как в sharky).

## 3. Аутентификация

- **Только Google OAuth** через Supabase Auth: `signInWithOAuth({provider:'google', redirectTo: location.href})`, PKCE (дефолт supabase-js v2), сессия в localStorage, авторефреш.
- Гость: читает всё публичное; любое действие (лайк/коммент/друзья/создание) открывает логин-модалку (паттерн sharky_web).
- **Провижининг профиля — триггером** `on_auth_user_created` (SECURITY DEFINER) на `auth.users`: создаёт строку `profiles` с `username` из local-part email (нормализация + счётчик при коллизии), `display_name`/`avatar_url` из Google-метаданных.
- **Email никогда не попадает в `profiles`** и наружу не отдаётся; он живёт только в `auth.users`.

## 4. Модель данных

Все id — `uuid default gen_random_uuid()`, время — `timestamptz default now()`.

```
profiles        id PK (= auth.users.id), username citext UNIQUE CHECK ^[a-z0-9_]{3,24}$,
                display_name, avatar_url, banner_url, bio, created_at

media           id PK, owner_id → profiles, kind ENUM(photo|video|audio),
                storage_path, thumb_path NULL, width, height, duration_seconds,
                size_bytes, created_at
                -- единая библиотека: файл грузится один раз, переиспользуется
                -- и в альбомах, и в постах

albums          id PK, author_id → profiles, title, description, category text,
                cover_media_id → media NULL,
                visibility ENUM(public|private|friends) DEFAULT private,
                photos_count, videos_count, audio_count,       -- триггер по album_media
                likes_count, comments_count, views_count,      -- триггеры
                created_at, updated_at, published_at NULL      -- NULL = черновик

album_chapters  id PK, album_id → albums CASCADE, position int,
                label ("DAY 1–3"), title, body

album_media     id PK, album_id → albums CASCADE, chapter_id → album_chapters NULL,
                media_id → media, position int, caption

album_exceptions album_id + user_id PK   -- «для друзей, КРОМЕ этих» при visibility=friends

posts           id PK, author_id → profiles, caption,
                visibility ENUM тот же, DEFAULT public,
                likes_count, comments_count, created_at

post_media      post_id + position PK, media_id → media   -- карусель, 1..10 слайдов

friendships     user_a + user_b PK, CHECK (user_a < user_b),  -- канон: одна строка на пару
                requested_by → profiles, status ENUM(pending|accepted),
                created_at, responded_at

comments        id PK, subject_type ENUM(album|post), subject_id uuid,
                author_id → profiles, parent_id → comments NULL (1 уровень ответов),
                body CHECK (length ≤ 2000), created_at

likes           subject_type + subject_id + user_id PK
saves           user_id + album_id PK       -- закладки альбомов
album_views     album_id + viewer_id + day PK   -- дедуп просмотров залогиненных
```

Решения:
- **Видимость — enum из 3 значений**, а «друзья кроме некоторых» = `friends` + строки в `album_exceptions` (UI показывает это как 4-й режим). Нет невалидных комбинаций состояний.
- Счётчики — денормализованы, поддерживаются **триггерами SECURITY DEFINER** (гоча sharky: триггер срабатывает от имени пользователя без прав UPDATE на целевую таблицу — функция триггера обязана быть definer).
- Аудио — только в альбомах; посты = фото/видео (по ТЗ).
- Категории (чипы All/Following/Travel/Music/Family/Art/Sport из дизайна) — `albums.category` c CHECK по списку; «Following» — не категория, а фильтр по друзьям.

## 5. Приватность: одна центральная функция

```sql
create function can_view_album(a_id uuid, viewer uuid) returns boolean
  language sql stable security definer as $$
    -- public → true; author = viewer → true; private → false;
    -- friends → exists accepted-friendship(author,viewer)
    --           AND NOT exists album_exceptions(a_id, viewer)
$$;
-- аналогично can_view_post (без exceptions)
```

Эта функция — **единственный источник истины о видимости**, используется в:
1. RLS SELECT-политике `albums`, `album_chapters`, `album_media`;
2. RLS-политиках `comments`/`likes` (видеть и писать можно только к видимому subject);
3. политике `storage.objects` (см. §6);
4. фид-RPC (они definer и обязаны фильтровать сами — RLS их не страхует).

Черновики (`published_at IS NULL`) видит только автор независимо от visibility.

Матрица: | режим | гость | не-друг | друг | друг-исключение | автор |
public → да/да/да/да/да · friends → нет/нет/**да**/**нет**/да · private → только автор.

## 6. Storage

Два бакета:

- **`avatars` (public)** — аватары/баннеры: `<uid>/avatar.jpg`, `<uid>/banner.jpg`. Публичны по природе (профили публичны).
- **`media` (private)** — весь контент: `<uid>/<media_id>/orig.<ext>` + `<uid>/<media_id>/thumb.jpg`.

Политики `storage.objects`:
- INSERT/UPDATE/DELETE: только authenticated и только в свой префикс — `(storage.foldername(name))[1] = auth.uid()::text`;
- SELECT (bucket `media`): `can_view_storage_object(name)` — definer-функция: парсит `<media_id>` из пути → медиа видимо, если viewer владелец **или** медиа входит хотя бы в один видимый альбом/пост (через can_view_*).

**Выдача файлов — batch signed URLs**: страница получает от RPC `storage_path`-ы и одним вызовом `createSignedUrls(paths, 3600)` подписывает их (работает и для anon — право даёт RLS-политика SELECT). Стабильных публичных URL нет — это цена настоящей приватности; CDN кэширует по токену, для MVP-масштаба достаточно.

Лимиты бакетов (`file_size_limit`, `allowed_mime_types`):
- фото ≤ 10 МБ (клиент перед загрузкой сжимает canvas'ом до ~2560px WebP/JPEG),
- аудио ≤ 20 МБ (webm/m4a/mp3), видео ≤ 50 МБ (mp4/webm; потолок free-тарифа).
- Постер видео и thumb фото генерирует клиент (canvas). Серверный транскодинг — фаза 3.

## 7. RLS и запись данных

RLS включён на **каждой** таблице, default deny. Прямые операции под RLS там, где инвариант простой:

| Таблица | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | все (только безопасные колонки) | — (триггер) | своя строка | — |
| media | владелец (наружу пути идут через RPC/подпись) | владелец | владелец | владелец |
| albums/chapters/album_media | can_view / автор | автор | автор | автор |
| album_exceptions | автор альбома | автор | — | автор |
| posts/post_media | can_view / автор | автор | автор | автор |
| comments | can_view(subject) | can_view(subject), author_id=auth.uid() | автор (edit) | автор **или** владелец subject (модерация) |
| likes/saves | свои (+счётчики публичны) | can_view(subject) | — | свои |
| friendships | участник пары | — (только RPC) | — (только RPC) | — (только RPC) |

**DEFINER-RPC** (валидация внутри; обязательная проверка `auth.uid() is not null` — гоча sharky «admin=authenticated»; grant execute точечно: фиды — anon+authenticated, остальное — только authenticated):

- `friend_request(target_username)` / `friend_respond(other_id, accept bool)` / `friend_remove(other_id)` — канонизация пары (a<b), запрет дублей/самодружбы; список заявок — `my_friend_requests()`. Списки друзей приватны (видит только владелец).
- `feed_albums(p_seed, p_category, p_limit, p_offset)` — рекомендации: `score = 0.5*seeded_random(md5(id||seed)) + 0.3*норм.популярность + 0.2*свежесть` (формула проверена в sharky web_home_v2), сид-стабильная пагинация без дублей; отдаёт только видимое зрителю: публичное + альбомы друзей (минус исключения). Карточке — cover + 2 миниатюры + счётчики + автор.
- `feed_posts(p_seed, p_limit, p_offset)` — то же для постов.
- `get_album(p_id)` / `get_post(p_id)` / `get_profile(p_username)` — агрегат страницы одним вызовом (+ liked/saved зрителя; профиль отдаёт только видимые зрителю альбомы).
- `log_album_view(p_id)` — просмотр: authenticated дедуп по дню через `album_views`, anon — простой инкремент.
- `search(p_q)` — фаза 2 (ilike по title/username, только видимое).

## 8. Безопасность — чеклист

1. **Ключи.** `sb_publishable_…` — публичный по дизайну, живёт в `js/config.js`. **`sb_secret_…` НЕ ПОПАДАЕТ в репозиторий и ни в один файл проекта никогда** (репо публичный!). Для этой архитектуры секретный ключ вообще не нужен; хранить вне репо, после настройки — **ротировать** (он передавался в переписке).
2. RLS default deny везде; definer-RPC сами фильтруют видимость и проверяют auth.uid().
3. Email пользователей не покидает `auth.users`.
4. **XSS**: весь пользовательский контент рендерится только через `textContent`; никакого innerHTML с данными.
5. **CSP на каждой странице**: `script-src 'self' https://cdn.jsdelivr.net; connect-src <project>.supabase.co; img-src 'self' data: blob: <project>.supabase.co; media-src blob: <project>.supabase.co; frame-ancestors 'none'` (+ Google Fonts в style/font-src).
6. OAuth: в Supabase URL Configuration — Site URL = прод, redirect allowlist = `https://poklontsevv.github.io/albums/*` + `http://localhost:5085/*`. Ничего лишнего.
7. Storage: запись только в свой префикс; mime/size-лимиты на бакетах; приватный бакет + подписанные URL (§6).
8. Валидация в БД (CHECK): длины title/bio/caption/comment, формат username, position ≥ 0, слайдов карусели ≤ 10.
9. Антиспам минимум MVP: CHECK-длины + PK-дедупы (лайки, просмотры, дружба). Rate-limit триггером по `created_at` — фаза 3.
10. Модерация: владелец альбома/поста может удалять чужие комментарии под своим контентом.

## 9. Страницы ↔ дизайн

- `index.html` = `main.dc.html`: шапка (лого, поиск, New Album, профиль), чипы, featured-блок, сетка карточек (обложка + 2 миниатюры + бейдж «8 photos · 1 video»).
- `album.html` = `Album.dc.html`: hero-обложка с белой карточкой (Watch/like/save/share), главы (label/заголовок/текст + сетки фото + видео + войсы с волноформой), липкий сайдбар (автор, состав, другие альбомы) + **блок комментариев внизу** (в дизайне его нет — рисуем в том же стиле).
- `profile.html` = `Profile.dc.html`: статистика, кнопка **«Добавить в друзья»** (в дизайне «Follow» — маппится на дружбу, см. §11), закреплённый альбом, фильтруемая сетка.
- `posts.html`, `post.html`, `editor.html` — дизайна нет; строим в той же системе (можно догенерить в Claude Design позже).

## 10. Деплой и операционное ограничение

- **Frontend**: push в `vgametikok/albums` (ветка main, корень) → Pages, прод `https://vgametikok.github.io/albums/`. Тот же GitHub-аккаунт, что у sharky, поэтому push работает на закэшированных credentials без диалога. (Ранее рассматривался репо `Poklontsevv/albums` под вторым аккаунтом — отменено 2026-07-19: пуш туда требовал интерактивного входа и висел.) В репозитории на момент подключения уже лежал коммит с экспортом Claude Design (`main.html`, `Album.dc.html`, `Profile.dc.html`, `support.js` в корне) — влит через merge, не затёрт; на работу сайта не влияет, точка входа `index.html`.
- **База — доступ решён через Management API, не через MCP-коннектор** (коннектор Supabase на claude.ai позволяет авторизовать доступ только к одной организации за раз, а Sharky и Albums — в разных организациях одного аккаунта vgametikok). Вместо этого: Personal Access Token аккаунта vgametikok (он Owner в обеих организациях) + прямые HTTP-вызовы `https://api.supabase.com/v1/projects/{ref}/...`. Токен лежит в `D:\Albums\.supabase-token` (в `.gitignore`, в репозиторий не попадает), читается в PowerShell перед каждым вызовом. Проверено: `GET /v1/projects`, `POST /v1/projects/{ref}/database/query` (миграции/SQL), `GET /v1/projects/{ref}/api-keys` — всё работает.
  - **Project ref**: `rizveurkjpcwrmbtoawj` → URL `https://rizveurkjpcwrmbtoawj.supabase.co`.
  - Ключи подтверждены Management API и совпадают с присланными: publishable `sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD` (идёт в `config.js`), secret `sb_secret_1z17…` (⚠️ засветился в чате открытым текстом — не используется нигде в архитектуре, но стоит ротировать в Project Settings → API Keys, когда будет минутка).
- Локальный дев: `serve.js` + launch.json, **порт 5085** (5060 запрещён; 5070/5080/5090 заняты sharky).

## 11. Решения по умолчанию — поправь, если что-то не так

1. **Друзья вместо подписок**: в MVP единственная связь — взаимная дружба (заявка → принятие); «Follow» из дизайна = «Добавить в друзья». Подписки (односторонние) можно добавить позже отдельно.
2. **Посты по умолчанию публичные**, но у них тот же enum видимости (public/private/friends) — без списка исключений.
3. Комментарии: один уровень ответов (parent_id), без лайков комментариев (позже).
4. Аудио — только внутри альбомов; в постах фото/видео.
5. Медиа-библиотека едина: в карусель поста можно взять уже загруженное (из альбомов) или залить новое.
6. Списки друзей приватны (видны только владельцу).
7. Просмотры: считаем с дедупом по дню для залогиненных, честные шейры/OG-мета — позже.

## 12. Фазы

- **Фаза 0 — ✅ кроме двух пунктов**: доступ к БД решён (Management API), схема применена, код запушен, auth URL Configuration выставлен через API. Осталось вручную: (а) включить GitHub Pages (Settings → Pages → main / root); (б) включить Google-провайдер в Supabase — Client ID/Secret из Google Cloud Console, redirect URI `https://rizveurkjpcwrmbtoawj.supabase.co/auth/v1/callback`; без этого вход не работает вообще. Плюс на досуге ротировать sb_secret (светился в переписке, в коде не используется).
- **Фаза 1 — «Альбомы» (MVP)**: миграция v1 (вся схема §4–§7 + бакеты + триггеры), каркас страниц + auth, editor.html (загрузка, главы, видимость+исключения), album.html, лента index.html, profile.html + друзья, комментарии альбомов.
- **Фаза 2 — «Посты»**: posts/post_media, композер-карусель, posts.html, post.html, комментарии постов, поиск.
- **Фаза 3**: уведомления (заявки/комменты), watch-режим альбома, лайки комментариев, rate-limit, серверные постеры/транскодинг, рекомендации v2 (провенанс кликов как в sharky), PWA.
