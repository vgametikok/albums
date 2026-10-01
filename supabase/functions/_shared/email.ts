// Служебные письма Albums.ink: тексты на 9 языках, шаблон (HTML + текст),
// отправка через Resend и разбор очереди email_log (миграция 055).
//
// Кому и когда писать, решает база (триггеры 055); здесь только «как».
// Модуль без зависимостей: его импортирует функция notify, а тесты
// (email.test.ts) гоняют рендер и разбор очереди без сети и базы.

export const FROM = 'Albums.ink <noreply@albums.ink>';
export const REPLY_TO = 'support@albums.ink';
export const SUPPORT = 'support@albums.ink';
export const SITE = 'https://albums.ink';
export const LINKS = {
  profile: `${SITE}/profile.html`,
  cabinet: `${SITE}/event.html`,
  events: `${SITE}/events/`,
  album: (id: string) => `${SITE}/album.html?id=${encodeURIComponent(id)}`,
  eventAlbum: (id: string) => `${SITE}/event.html?id=${encodeURIComponent(id)}`,
};

export const LOCALES = ['en', 'ru', 'vi', 'fr', 'es', 'de', 'zh-CN', 'ko', 'ja'] as const;
export type Locale = typeof LOCALES[number];
export type Kind = 'welcome' | 'signin' | 'mod_pending' | 'mod_approved' | 'purchase_event' | 'purchase_pro' | 'storage80';
export type Tier = 'small' | 'medium' | 'large';

export const TIERS: Record<Tier, { gb: number; price: string }> = {
  small: { gb: 100, price: '$39.99' },
  medium: { gb: 200, price: '$69.99' },
  large: { gb: 400, price: '$129.99' },
};
export const PRO_PRICE = '$9.99';
// Докупка места для событийного альбома (оформление — через поддержку, см. storage80).
export const STORAGE_PACKS = [
  { gb: 30, price: '$15.99' },
  { gb: 70, price: '$34.99' },
  { gb: 100, price: '$48.99' },
];

/** Строка из email_claim(). */
export interface EmailJob {
  id: number;
  kind: Kind;
  count?: number;
  attempt?: number;
  created_at?: string;
  payload?: Record<string, unknown>;
  to?: string | null;
  anon?: boolean;
  locale?: string | null;
  name?: string | null;
  username?: string | null;
  plan_until?: string | null;
  album?: { id: string; title?: string | null; is_event?: boolean; tier?: string | null; storage_gb?: number | null; storage_until?: string | null } | null;
  order?: { tier?: string | null; storage_gb?: number | null; amount?: number | string | null } | null;
}

type Plural = { one?: string; few?: string; many?: string; other: string };
type Dict = Record<string, string | Plural>;

// ── Тексты ───────────────────────────────────────────────────────────────────
// Названия тарифов, продукта, раздела кабинета и возможностей Pro — дословно
// как на сайте (js/i18n/*.js), чтобы письмо и сайт говорили одним языком.
export const STR: Record<Locale, Dict> = {
  en: {
    hi: 'Hi {name},', hi_anon: 'Hi,',
    gb: '{n} GB',
    files: { one: '{n} file', other: '{n} files' },
    open_profile: 'Open my profile', open_album: 'Open the album', open_account: 'Open my account',
    foot_help: 'Questions? Just reply to this email or write to {support}.',
    foot_why: 'You are receiving this service email because you have an account at albums.ink.',
    foot_brand: 'Albums.ink — story albums, and every guest photo with one QR code.',
    tier_small: 'Small', tier_medium: 'Medium', tier_large: 'Large',
    product: 'Event Album', cabinet: 'Shared album', taxes: 'taxes included',

    welcome_subject: 'Welcome to Albums.ink',
    welcome_pre: 'Your account is ready.',
    welcome_title: 'Welcome to Albums!',
    welcome_p1: 'Your account is ready. Make story albums — photos, videos and voice notes arranged in chapters — and share them with friends or keep them private.',
    welcome_p2: 'Planning a wedding or a party? An Event Album collects every guest photo with one QR code: guests need no app and no signup.',
    welcome_link: 'How Event Albums work',

    signin_subject: 'New sign-in to Albums.ink',
    signin_pre: 'We noticed a sign-in to your account.',
    signin_title: 'You signed in to Albums.ink',
    signin_p1: 'Someone just signed in to your Albums.ink account.',
    signin_when: 'When', signin_device: 'Device', signin_unknown: 'Unknown device',
    signin_p2: 'If this was you, there is nothing to do.',
    signin_p3: 'If it wasn’t you, sign out of your Google account on devices you don’t recognise, change your Google password and write to us at {support}.',
    signin_note: 'We send this notice at most once a day.',

    modp_subject: 'Your uploads to “{album}” are in review',
    modp_pre: '{files} sent for a quick check.',
    modp_title: 'Your uploads are in review',
    modp_p1: 'You added {files} to the album “{album}”. Like every new upload to a shared album, they get a quick look from our moderators.',
    modp_p2: 'There is nothing you need to do — we’ll let you know once they are approved.',

    moda_subject: 'Your uploads to “{album}” are approved',
    moda_pre: '{files} passed moderation.',
    moda_title: 'Approved',
    moda_p1: 'Good news: {files} you added to the album “{album}” passed moderation.',
    moda_p2: 'Thank you for sharing your shots!',

    pe_subject: 'Your {product} ({tier}) is ready',
    pe_pre: 'It is already waiting in your account.',
    pe_title: 'Thank you for your purchase!',
    pe_p1: 'Your {product} — {tier} is paid and already available in your account, in the “{cabinet}” section.',
    pe_p1_many: '{n} × {product} — {tier} are paid and already available in your account, in the “{cabinet}” section.',
    row_plan: 'Plan', row_storage: 'Storage', row_period: 'Storage period', row_price: 'Price',
    pe_period: '6 months from the first upload into the album, can be extended',
    pe_p2: 'Start the album whenever you are ready — there is no deadline, and the 6 months begin with the first photo.',
    receipt: 'The payment receipt comes separately from our payment provider.',

    pp_subject: 'Albums Pro is active',
    pp_pre: 'Everything is already available in your account.',
    pp_title: 'Welcome to Pro!',
    pp_p1: 'Your Pro subscription is active, and everything is already available in your account:',
    pp_f1: 'Photos up to 4K — sharper on large screens',
    pp_f2: 'Videos up to 500 MB per file',
    pp_f3: 'Up to 10 collaborators per album',
    pp_f4: 'Advanced statistics and audience analytics',
    pp_price: '{price} / month · {taxes}',
    pp_per: 'billed monthly, cancel anytime',
    row_billing: 'Billing',
    pp_p2: 'You can cancel at any time; Pro stays active until the end of the paid period.',

    s80_subject: '“{album}” has used 80% of its storage',
    s80_pre: 'About {left} left — you can add more space.',
    s80_title: 'Your event album is almost full',
    s80_p1: 'The event album “{album}” has used {used} of {cap} ({pct}%).',
    s80_p2: 'No worries — you can add more space to this album:',
    s80_tax: 'One-time payment, taxes included.',
    s80_p3: 'Reply to this email or press the button and tell us which option you’d like — we’ll add the space to this album.',
    s80_cta: 'Request more space',
    s80_mail_subject: 'More storage for “{album}”',
  },

  ru: {
    hi: 'Здравствуйте, {name}!', hi_anon: 'Здравствуйте!',
    gb: '{n} ГБ',
    files: { one: '{n} файл', few: '{n} файла', many: '{n} файлов', other: '{n} файла' },
    open_profile: 'Открыть профиль', open_album: 'Открыть альбом', open_account: 'Открыть личный кабинет',
    foot_help: 'Есть вопросы? Просто ответьте на это письмо или напишите на {support}.',
    foot_why: 'Это служебное письмо: у вас есть аккаунт на albums.ink.',
    foot_brand: 'Albums.ink — альбомы-истории и все фото гостей по одному QR-коду.',
    tier_small: 'Малый', tier_medium: 'Средний', tier_large: 'Большой',
    product: 'Событийный альбом', cabinet: 'Общий альбом', taxes: 'налоги включены',

    welcome_subject: 'Добро пожаловать в Albums.ink',
    welcome_pre: 'Ваш аккаунт готов.',
    welcome_title: 'Добро пожаловать в Albums!',
    welcome_p1: 'Ваш аккаунт готов. Собирайте альбомы-истории — фото, видео и голосовые заметки по главам — и делитесь ими с друзьями или держите их приватными.',
    welcome_p2: 'Готовите свадьбу или праздник? Событийный альбом соберёт все фото гостей по одному QR-коду: гостям не нужны ни приложение, ни регистрация.',
    welcome_link: 'Как работают событийные альбомы',

    signin_subject: 'Новый вход в Albums.ink',
    signin_pre: 'Мы заметили вход в ваш аккаунт.',
    signin_title: 'Вы вошли в Albums.ink',
    signin_p1: 'Только что выполнен вход в ваш аккаунт Albums.ink.',
    signin_when: 'Когда', signin_device: 'Устройство', signin_unknown: 'Неизвестное устройство',
    signin_p2: 'Если это были вы, ничего делать не нужно.',
    signin_p3: 'Если это были не вы, выйдите из аккаунта Google на незнакомых устройствах, смените пароль Google и напишите нам на {support}.',
    signin_note: 'Такое уведомление приходит не чаще раза в сутки.',

    modp_subject: 'Ваши файлы в альбоме «{album}» на проверке',
    modp_pre: 'Отправили на короткую проверку: {files}.',
    modp_title: 'Ваши файлы на проверке',
    modp_p1: 'Вы добавили {files} в альбом «{album}». Как и всё новое в общих альбомах, их быстро посмотрят наши модераторы.',
    modp_p2: 'От вас ничего не требуется — мы сообщим, когда проверка будет пройдена.',

    moda_subject: 'Ваши файлы в альбоме «{album}» одобрены',
    moda_pre: 'Прошли модерацию: {files}.',
    moda_title: 'Одобрено',
    moda_p1: 'Хорошие новости: всё, что вы добавили в альбом «{album}» ({files}), прошло модерацию.',
    moda_p2: 'Спасибо, что поделились кадрами!',

    pe_subject: '{product} ({tier}) уже ждёт вас',
    pe_pre: 'Он уже доступен в личном кабинете.',
    pe_title: 'Спасибо за покупку!',
    pe_p1: '{product} — {tier} оплачен и уже доступен в вашем личном кабинете, в разделе «{cabinet}».',
    pe_p1_many: '{n} × {product} — {tier} оплачены и уже доступны в вашем личном кабинете, в разделе «{cabinet}».',
    row_plan: 'Тариф', row_storage: 'Хранилище', row_period: 'Срок хранения', row_price: 'Цена',
    pe_period: '6 месяцев с первой загрузки в альбом, можно продлить',
    pe_p2: 'Начните альбом, когда будете готовы, — срока нет, 6 месяцев отсчитываются с первого фото.',
    receipt: 'Чек об оплате придёт отдельно от платёжного партнёра.',

    pp_subject: 'Albums Pro подключён',
    pp_pre: 'Всё уже доступно в личном кабинете.',
    pp_title: 'Добро пожаловать в Pro!',
    pp_p1: 'Подписка Pro активна, и всё уже доступно в вашем личном кабинете:',
    pp_f1: 'Фотографии до 4K — заметно чётче на больших экранах',
    pp_f2: 'Видео до 500 МБ на файл',
    pp_f3: 'До 10 соавторов в каждом альбоме',
    pp_f4: 'Продвинутая статистика и аналитика аудитории',
    pp_price: '{price} в месяц · {taxes}',
    pp_per: 'помесячно, отмена в любой момент',
    row_billing: 'Оплата',
    pp_p2: 'Отменить можно в любой момент; Pro действует до конца оплаченного периода.',

    s80_subject: 'Альбом «{album}» заполнен на 80%',
    s80_pre: 'Осталось около {left} — место можно докупить.',
    s80_title: 'Событийный альбом почти заполнен',
    s80_p1: 'В событийном альбоме «{album}» занято {used} из {cap} ({pct}%).',
    s80_p2: 'Не страшно — место в этом альбоме можно докупить:',
    s80_tax: 'Разовый платёж, налоги включены.',
    s80_p3: 'Ответьте на это письмо или нажмите кнопку и напишите, какой вариант выбрали, — мы добавим место в этот альбом.',
    s80_cta: 'Докупить место',
    s80_mail_subject: 'Больше места для альбома «{album}»',
  },

  vi: {
    hi: 'Xin chào {name},', hi_anon: 'Xin chào,',
    gb: '{n} GB',
    files: { other: '{n} tệp' },
    open_profile: 'Mở hồ sơ của tôi', open_album: 'Mở album', open_account: 'Mở tài khoản của tôi',
    foot_help: 'Có câu hỏi? Chỉ cần trả lời email này hoặc viết cho {support}.',
    foot_why: 'Bạn nhận được email dịch vụ này vì bạn có tài khoản tại albums.ink.',
    foot_brand: 'Albums.ink — album kể chuyện và mọi ảnh của khách qua một mã QR.',
    tier_small: 'Nhỏ', tier_medium: 'Vừa', tier_large: 'Lớn',
    product: 'Album sự kiện', cabinet: 'Album chung', taxes: 'đã gồm thuế',

    welcome_subject: 'Chào mừng bạn đến với Albums.ink',
    welcome_pre: 'Tài khoản của bạn đã sẵn sàng.',
    welcome_title: 'Chào mừng bạn đến với Albums!',
    welcome_p1: 'Tài khoản của bạn đã sẵn sàng. Hãy tạo album kể chuyện — ảnh, video và ghi chú giọng nói sắp xếp theo chương — rồi chia sẻ với bạn bè hoặc giữ riêng tư.',
    welcome_p2: 'Sắp tổ chức đám cưới hay bữa tiệc? Album sự kiện thu thập mọi ảnh của khách qua một mã QR: khách không cần ứng dụng, không cần đăng ký.',
    welcome_link: 'Album sự kiện hoạt động thế nào',

    signin_subject: 'Đăng nhập mới vào Albums.ink',
    signin_pre: 'Chúng tôi ghi nhận một lần đăng nhập vào tài khoản của bạn.',
    signin_title: 'Bạn đã đăng nhập vào Albums.ink',
    signin_p1: 'Tài khoản Albums.ink của bạn vừa được đăng nhập.',
    signin_when: 'Thời gian', signin_device: 'Thiết bị', signin_unknown: 'Thiết bị không xác định',
    signin_p2: 'Nếu đó là bạn, bạn không cần làm gì cả.',
    signin_p3: 'Nếu không phải bạn, hãy đăng xuất tài khoản Google trên các thiết bị lạ, đổi mật khẩu Google và viết cho chúng tôi tại {support}.',
    signin_note: 'Chúng tôi gửi thông báo này tối đa một lần mỗi ngày.',

    modp_subject: 'Các tệp bạn tải lên “{album}” đang được kiểm duyệt',
    modp_pre: '{files} đã được gửi để kiểm tra nhanh.',
    modp_title: 'Các tệp của bạn đang được kiểm duyệt',
    modp_p1: 'Bạn đã thêm {files} vào album “{album}”. Như mọi nội dung mới trong album chung, đội ngũ kiểm duyệt sẽ xem nhanh.',
    modp_p2: 'Bạn không cần làm gì — chúng tôi sẽ báo khi các tệp được duyệt.',

    moda_subject: 'Các tệp bạn tải lên “{album}” đã được duyệt',
    moda_pre: '{files} đã qua kiểm duyệt.',
    moda_title: 'Đã duyệt',
    moda_p1: 'Tin vui: {files} bạn thêm vào album “{album}” đã qua kiểm duyệt.',
    moda_p2: 'Cảm ơn bạn đã chia sẻ khoảnh khắc!',

    pe_subject: '{product} ({tier}) của bạn đã sẵn sàng',
    pe_pre: 'Đã có sẵn trong tài khoản của bạn.',
    pe_title: 'Cảm ơn bạn đã mua hàng!',
    pe_p1: '{product} — {tier} đã được thanh toán và có sẵn trong tài khoản của bạn, ở mục “{cabinet}”.',
    pe_p1_many: '{n} × {product} — {tier} đã được thanh toán và có sẵn trong tài khoản của bạn, ở mục “{cabinet}”.',
    row_plan: 'Gói', row_storage: 'Dung lượng', row_period: 'Thời hạn lưu trữ', row_price: 'Giá',
    pe_period: '6 tháng kể từ lần tải lên đầu tiên vào album, có thể gia hạn',
    pe_p2: 'Hãy bắt đầu album khi bạn sẵn sàng — không có thời hạn, và 6 tháng bắt đầu từ bức ảnh đầu tiên.',
    receipt: 'Biên lai thanh toán sẽ được đối tác thanh toán gửi riêng.',

    pp_subject: 'Albums Pro đã được kích hoạt',
    pp_pre: 'Mọi thứ đã có sẵn trong tài khoản của bạn.',
    pp_title: 'Chào mừng bạn đến với Pro!',
    pp_p1: 'Gói Pro của bạn đã hoạt động, và mọi thứ đã có sẵn trong tài khoản:',
    pp_f1: 'Ảnh lên đến 4K — sắc nét hơn trên màn hình lớn',
    pp_f2: 'Video tối đa 500 MB mỗi tệp',
    pp_f3: 'Tối đa 10 người cộng tác mỗi album',
    pp_f4: 'Thống kê nâng cao và phân tích khán giả',
    pp_price: '{price} / tháng · {taxes}',
    pp_per: 'thanh toán hằng tháng, hủy bất cứ lúc nào',
    row_billing: 'Thanh toán',
    pp_p2: 'Bạn có thể hủy bất cứ lúc nào; Pro vẫn hoạt động đến hết kỳ đã thanh toán.',

    s80_subject: '“{album}” đã dùng 80% dung lượng',
    s80_pre: 'Còn khoảng {left} — bạn có thể mua thêm dung lượng.',
    s80_title: 'Album sự kiện của bạn sắp đầy',
    s80_p1: 'Album sự kiện “{album}” đã dùng {used} trên {cap} ({pct}%).',
    s80_p2: 'Đừng lo — bạn có thể thêm dung lượng cho album này:',
    s80_tax: 'Thanh toán một lần, đã gồm thuế.',
    s80_p3: 'Hãy trả lời email này hoặc bấm nút và cho chúng tôi biết lựa chọn của bạn — chúng tôi sẽ thêm dung lượng vào album này.',
    s80_cta: 'Yêu cầu thêm dung lượng',
    s80_mail_subject: 'Thêm dung lượng cho “{album}”',
  },

  fr: {
    hi: 'Bonjour {name},', hi_anon: 'Bonjour,',
    gb: '{n} Go',
    files: { one: '{n} fichier', other: '{n} fichiers' },
    open_profile: 'Ouvrir mon profil', open_album: 'Ouvrir l’album', open_account: 'Ouvrir mon compte',
    foot_help: 'Une question ? Répondez simplement à cet e-mail ou écrivez à {support}.',
    foot_why: 'Vous recevez cet e-mail de service parce que vous avez un compte sur albums.ink.',
    foot_brand: 'Albums.ink — des albums-récits, et toutes les photos des invités avec un seul QR code.',
    tier_small: 'Petit', tier_medium: 'Moyen', tier_large: 'Grand',
    product: 'Album d’événement', cabinet: 'Album partagé', taxes: 'taxes incluses',

    welcome_subject: 'Bienvenue sur Albums.ink',
    welcome_pre: 'Votre compte est prêt.',
    welcome_title: 'Bienvenue sur Albums !',
    welcome_p1: 'Votre compte est prêt. Créez des albums-récits — photos, vidéos et notes vocales en chapitres — et partagez-les avec vos amis ou gardez-les privés.',
    welcome_p2: 'Vous préparez un mariage ou une fête ? Un Album d’événement rassemble toutes les photos des invités avec un seul QR code : ni appli, ni inscription pour eux.',
    welcome_link: 'Comment fonctionnent les Albums d’événement',

    signin_subject: 'Nouvelle connexion à Albums.ink',
    signin_pre: 'Nous avons remarqué une connexion à votre compte.',
    signin_title: 'Vous vous êtes connecté à Albums.ink',
    signin_p1: 'Une connexion à votre compte Albums.ink vient d’avoir lieu.',
    signin_when: 'Quand', signin_device: 'Appareil', signin_unknown: 'Appareil inconnu',
    signin_p2: 'Si c’était vous, vous n’avez rien à faire.',
    signin_p3: 'Si ce n’était pas vous, déconnectez votre compte Google des appareils que vous ne reconnaissez pas, changez votre mot de passe Google et écrivez-nous à {support}.',
    signin_note: 'Nous envoyons cet avis au plus une fois par jour.',

    modp_subject: 'Vos envois dans « {album} » sont en cours de vérification',
    modp_pre: 'Envoyé pour une vérification rapide : {files}.',
    modp_title: 'Vos envois sont en cours de vérification',
    modp_p1: 'Vous avez ajouté {files} à l’album « {album} ». Comme tout nouvel envoi dans un album partagé, nos modérateurs y jettent un coup d’œil rapide.',
    modp_p2: 'Vous n’avez rien à faire — nous vous préviendrons dès qu’ils seront approuvés.',

    moda_subject: 'Vos envois dans « {album} » sont approuvés',
    moda_pre: 'Modération réussie : {files}.',
    moda_title: 'Approuvé',
    moda_p1: 'Bonne nouvelle : ce que vous avez ajouté à l’album « {album} » ({files}) a passé la modération.',
    moda_p2: 'Merci d’avoir partagé vos photos !',

    pe_subject: 'Votre {product} ({tier}) est prêt',
    pe_pre: 'Il vous attend déjà dans votre compte.',
    pe_title: 'Merci pour votre achat !',
    pe_p1: 'Votre {product} — {tier} est payé et déjà disponible dans votre compte, rubrique « {cabinet} ».',
    pe_p1_many: '{n} × {product} — {tier} sont payés et déjà disponibles dans votre compte, rubrique « {cabinet} ».',
    row_plan: 'Offre', row_storage: 'Stockage', row_period: 'Durée de stockage', row_price: 'Prix',
    pe_period: '6 mois à partir du premier envoi dans l’album, prolongeable',
    pe_p2: 'Lancez l’album quand vous êtes prêt — aucune date limite, et les 6 mois commencent avec la première photo.',
    receipt: 'Le reçu de paiement vous est envoyé séparément par notre prestataire de paiement.',

    pp_subject: 'Albums Pro est activé',
    pp_pre: 'Tout est déjà disponible dans votre compte.',
    pp_title: 'Bienvenue dans Pro !',
    pp_p1: 'Votre abonnement Pro est actif, et tout est déjà disponible dans votre compte :',
    pp_f1: 'Photos jusqu’en 4K — plus nettes sur grand écran',
    pp_f2: 'Vidéos jusqu’à 500 Mo par fichier',
    pp_f3: 'Jusqu’à 10 collaborateurs par album',
    pp_f4: 'Statistiques avancées et analyse d’audience',
    pp_price: '{price} / mois · {taxes}',
    pp_per: 'facturé chaque mois, annulable à tout moment',
    row_billing: 'Facturation',
    pp_p2: 'Vous pouvez annuler à tout moment ; Pro reste actif jusqu’à la fin de la période payée.',

    s80_subject: '« {album} » a utilisé 80 % de son stockage',
    s80_pre: 'Il reste environ {left} — vous pouvez ajouter de l’espace.',
    s80_title: 'Votre album d’événement est presque plein',
    s80_p1: 'L’album d’événement « {album} » a utilisé {used} sur {cap} ({pct} %).',
    s80_p2: 'Pas de souci — vous pouvez ajouter de l’espace à cet album :',
    s80_tax: 'Paiement unique, taxes incluses.',
    s80_p3: 'Répondez à cet e-mail ou appuyez sur le bouton en indiquant l’option choisie — nous ajouterons l’espace à cet album.',
    s80_cta: 'Demander plus d’espace',
    s80_mail_subject: 'Plus d’espace pour « {album} »',
  },

  es: {
    hi: 'Hola, {name}:', hi_anon: 'Hola:',
    gb: '{n} GB',
    files: { one: '{n} archivo', other: '{n} archivos' },
    open_profile: 'Abrir mi perfil', open_album: 'Abrir el álbum', open_account: 'Abrir mi cuenta',
    foot_help: '¿Tienes preguntas? Responde a este correo o escribe a {support}.',
    foot_why: 'Recibes este correo de servicio porque tienes una cuenta en albums.ink.',
    foot_brand: 'Albums.ink — álbumes-historia y todas las fotos de los invitados con un solo código QR.',
    tier_small: 'Pequeño', tier_medium: 'Mediano', tier_large: 'Grande',
    product: 'Álbum de evento', cabinet: 'Álbum de evento', taxes: 'impuestos incluidos',

    welcome_subject: 'Te damos la bienvenida a Albums.ink',
    welcome_pre: 'Tu cuenta está lista.',
    welcome_title: '¡Bienvenido a Albums!',
    welcome_p1: 'Tu cuenta está lista. Crea álbumes-historia — fotos, vídeos y notas de voz organizados en capítulos — y compártelos con tus amigos o mantenlos privados.',
    welcome_p2: '¿Preparas una boda o una fiesta? Un Álbum de evento reúne todas las fotos de los invitados con un solo código QR: sin app y sin registro para ellos.',
    welcome_link: 'Cómo funcionan los Álbumes de evento',

    signin_subject: 'Nuevo inicio de sesión en Albums.ink',
    signin_pre: 'Hemos detectado un inicio de sesión en tu cuenta.',
    signin_title: 'Has iniciado sesión en Albums.ink',
    signin_p1: 'Se acaba de iniciar sesión en tu cuenta de Albums.ink.',
    signin_when: 'Cuándo', signin_device: 'Dispositivo', signin_unknown: 'Dispositivo desconocido',
    signin_p2: 'Si fuiste tú, no tienes que hacer nada.',
    signin_p3: 'Si no fuiste tú, cierra la sesión de tu cuenta de Google en los dispositivos que no reconozcas, cambia tu contraseña de Google y escríbenos a {support}.',
    signin_note: 'Enviamos este aviso como máximo una vez al día.',

    modp_subject: 'Tus archivos en «{album}» están en revisión',
    modp_pre: 'Enviado para una revisión rápida: {files}.',
    modp_title: 'Tus archivos están en revisión',
    modp_p1: 'Has añadido {files} al álbum «{album}». Como todo lo nuevo en un álbum compartido, nuestros moderadores les echarán un vistazo rápido.',
    modp_p2: 'No tienes que hacer nada: te avisaremos en cuanto se aprueben.',

    moda_subject: 'Tus archivos en «{album}» están aprobados',
    moda_pre: 'Moderación superada: {files}.',
    moda_title: 'Aprobado',
    moda_p1: 'Buenas noticias: lo que añadiste al álbum «{album}» ({files}) ha pasado la moderación.',
    moda_p2: '¡Gracias por compartir tus fotos!',

    pe_subject: 'Tu {product} ({tier}) está listo',
    pe_pre: 'Ya te espera en tu cuenta.',
    pe_title: '¡Gracias por tu compra!',
    pe_p1: 'Tu {product} — {tier} está pagado y ya disponible en tu cuenta, en la sección «{cabinet}».',
    pe_p1_many: '{n} × {product} — {tier} están pagados y ya disponibles en tu cuenta, en la sección «{cabinet}».',
    row_plan: 'Plan', row_storage: 'Almacenamiento', row_period: 'Plazo de almacenamiento', row_price: 'Precio',
    pe_period: '6 meses desde la primera subida al álbum, ampliable',
    pe_p2: 'Empieza el álbum cuando quieras: no hay fecha límite y los 6 meses empiezan con la primera foto.',
    receipt: 'El recibo de pago te llegará por separado de nuestro proveedor de pagos.',

    pp_subject: 'Albums Pro está activo',
    pp_pre: 'Todo ya está disponible en tu cuenta.',
    pp_title: '¡Bienvenido a Pro!',
    pp_p1: 'Tu suscripción Pro está activa y todo ya está disponible en tu cuenta:',
    pp_f1: 'Fotos hasta 4K: más nítidas en pantallas grandes',
    pp_f2: 'Vídeos de hasta 500 MB por archivo',
    pp_f3: 'Hasta 10 colaboradores por álbum',
    pp_f4: 'Estadísticas avanzadas y analítica de audiencia',
    pp_price: '{price} / mes · {taxes}',
    pp_per: 'cobro mensual, cancela cuando quieras',
    row_billing: 'Facturación',
    pp_p2: 'Puedes cancelar cuando quieras; Pro sigue activo hasta el final del periodo pagado.',

    s80_subject: '«{album}» ha usado el 80 % de su almacenamiento',
    s80_pre: 'Quedan unos {left}: puedes añadir más espacio.',
    s80_title: 'Tu álbum de evento está casi lleno',
    s80_p1: 'El álbum de evento «{album}» ha usado {used} de {cap} ({pct} %).',
    s80_p2: 'No te preocupes: puedes añadir más espacio a este álbum:',
    s80_tax: 'Pago único, impuestos incluidos.',
    s80_p3: 'Responde a este correo o pulsa el botón e indícanos qué opción prefieres: añadiremos el espacio a este álbum.',
    s80_cta: 'Pedir más espacio',
    s80_mail_subject: 'Más espacio para «{album}»',
  },

  de: {
    hi: 'Hallo {name},', hi_anon: 'Hallo,',
    gb: '{n} GB',
    files: { one: '{n} Datei', other: '{n} Dateien' },
    open_profile: 'Mein Profil öffnen', open_album: 'Album öffnen', open_account: 'Mein Konto öffnen',
    foot_help: 'Fragen? Antworte einfach auf diese E-Mail oder schreib an {support}.',
    foot_why: 'Du erhältst diese Service-E-Mail, weil du ein Konto bei albums.ink hast.',
    foot_brand: 'Albums.ink — Story-Alben und alle Gästefotos mit einem QR-Code.',
    tier_small: 'Klein', tier_medium: 'Mittel', tier_large: 'Groß',
    product: 'Event-Album', cabinet: 'Event-Album', taxes: 'inkl. Steuern',

    welcome_subject: 'Willkommen bei Albums.ink',
    welcome_pre: 'Dein Konto ist bereit.',
    welcome_title: 'Willkommen bei Albums!',
    welcome_p1: 'Dein Konto ist bereit. Erstelle Story-Alben — Fotos, Videos und Sprachnotizen in Kapiteln — und teile sie mit Freunden oder halte sie privat.',
    welcome_p2: 'Du planst eine Hochzeit oder eine Feier? Ein Event-Album sammelt alle Gästefotos mit einem QR-Code: Gäste brauchen keine App und kein Konto.',
    welcome_link: 'So funktionieren Event-Alben',

    signin_subject: 'Neue Anmeldung bei Albums.ink',
    signin_pre: 'Wir haben eine Anmeldung bei deinem Konto bemerkt.',
    signin_title: 'Du hast dich bei Albums.ink angemeldet',
    signin_p1: 'Soeben hat sich jemand bei deinem Albums.ink-Konto angemeldet.',
    signin_when: 'Wann', signin_device: 'Gerät', signin_unknown: 'Unbekanntes Gerät',
    signin_p2: 'Wenn du das warst, musst du nichts tun.',
    signin_p3: 'Wenn nicht, melde dein Google-Konto auf unbekannten Geräten ab, ändere dein Google-Passwort und schreib uns an {support}.',
    signin_note: 'Diesen Hinweis senden wir höchstens einmal pro Tag.',

    modp_subject: 'Deine Uploads in „{album}“ werden geprüft',
    modp_pre: 'Zur kurzen Prüfung gesendet: {files}.',
    modp_title: 'Deine Uploads werden geprüft',
    modp_p1: 'Du hast {files} zum Album „{album}“ hinzugefügt. Wie alles Neue in geteilten Alben sehen sich unsere Moderatoren sie kurz an.',
    modp_p2: 'Du musst nichts tun — wir sagen dir Bescheid, sobald sie freigegeben sind.',

    moda_subject: 'Deine Uploads in „{album}“ sind freigegeben',
    moda_pre: 'Moderation bestanden: {files}.',
    moda_title: 'Freigegeben',
    moda_p1: 'Gute Nachricht: Was du zum Album „{album}“ hinzugefügt hast ({files}), hat die Moderation bestanden.',
    moda_p2: 'Danke, dass du deine Fotos teilst!',

    pe_subject: 'Dein {product} ({tier}) ist bereit',
    pe_pre: 'Es wartet schon in deinem Konto.',
    pe_title: 'Danke für deinen Kauf!',
    pe_p1: 'Dein {product} — {tier} ist bezahlt und bereits in deinem Konto verfügbar, im Bereich „{cabinet}“.',
    pe_p1_many: '{n} × {product} — {tier} sind bezahlt und bereits in deinem Konto verfügbar, im Bereich „{cabinet}“.',
    row_plan: 'Tarif', row_storage: 'Speicher', row_period: 'Speicherdauer', row_price: 'Preis',
    pe_period: '6 Monate ab dem ersten Upload ins Album, verlängerbar',
    pe_p2: 'Starte das Album, wann du bereit bist – es gibt keine Frist, und die 6 Monate beginnen mit dem ersten Foto.',
    receipt: 'Den Zahlungsbeleg erhältst du separat von unserem Zahlungsanbieter.',

    pp_subject: 'Albums Pro ist aktiv',
    pp_pre: 'Alles ist bereits in deinem Konto verfügbar.',
    pp_title: 'Willkommen bei Pro!',
    pp_p1: 'Dein Pro-Abo ist aktiv, und alles ist bereits in deinem Konto verfügbar:',
    pp_f1: 'Fotos bis 4K — schärfer auf großen Bildschirmen',
    pp_f2: 'Videos bis 500 MB pro Datei',
    pp_f3: 'Bis zu 10 Mitwirkende pro Album',
    pp_f4: 'Erweiterte Statistiken und Publikums-Analysen',
    pp_price: '{price} / Monat · {taxes}',
    pp_per: 'monatliche Abrechnung, jederzeit kündbar',
    row_billing: 'Abrechnung',
    pp_p2: 'Du kannst jederzeit kündigen; Pro bleibt bis zum Ende des bezahlten Zeitraums aktiv.',

    s80_subject: '„{album}“ hat 80 % des Speichers belegt',
    s80_pre: 'Noch etwa {left} frei — du kannst Speicher hinzufügen.',
    s80_title: 'Dein Event-Album ist fast voll',
    s80_p1: 'Das Event-Album „{album}“ belegt {used} von {cap} ({pct} %).',
    s80_p2: 'Kein Problem — du kannst diesem Album mehr Speicher hinzufügen:',
    s80_tax: 'Einmalzahlung, inkl. Steuern.',
    s80_p3: 'Antworte auf diese E-Mail oder tippe auf den Button und sag uns, welche Option du möchtest — wir fügen den Speicher diesem Album hinzu.',
    s80_cta: 'Mehr Speicher anfragen',
    s80_mail_subject: 'Mehr Speicher für „{album}“',
  },

  'zh-CN': {
    hi: '{name}，你好：', hi_anon: '你好：',
    gb: '{n} GB',
    files: { other: '{n} 个文件' },
    open_profile: '打开我的主页', open_album: '打开相册', open_account: '打开我的账户',
    foot_help: '有疑问？直接回复这封邮件，或写信至 {support}。',
    foot_why: '你收到这封服务邮件，是因为你在 albums.ink 拥有账户。',
    foot_brand: 'Albums.ink —— 故事相册，以及用一个二维码收集所有宾客照片。',
    tier_small: '小型', tier_medium: '中型', tier_large: '大型',
    product: '活动相册', cabinet: '共享相册', taxes: '已含税',

    welcome_subject: '欢迎来到 Albums.ink',
    welcome_pre: '你的账户已准备就绪。',
    welcome_title: '欢迎来到 Albums！',
    welcome_p1: '你的账户已准备就绪。制作故事相册——按章节整理照片、视频和语音笔记——与朋友分享，或设为私密。',
    welcome_p2: '在筹备婚礼或派对？活动相册用一个二维码收集所有宾客的照片：宾客无需安装应用，也无需注册。',
    welcome_link: '了解活动相册如何使用',

    signin_subject: 'Albums.ink 新登录提醒',
    signin_pre: '我们注意到你的账户有一次登录。',
    signin_title: '你已登录 Albums.ink',
    signin_p1: '你的 Albums.ink 账户刚刚有一次登录。',
    signin_when: '时间', signin_device: '设备', signin_unknown: '未知设备',
    signin_p2: '如果是你本人，无需任何操作。',
    signin_p3: '如果不是你，请在不认识的设备上退出你的 Google 账户，修改 Google 密码，并写信至 {support} 联系我们。',
    signin_note: '此提醒每天最多发送一次。',

    modp_subject: '你上传到“{album}”的内容正在审核',
    modp_pre: '{files}已提交快速审核。',
    modp_title: '你的上传正在审核',
    modp_p1: '你向相册“{album}”添加了 {files}。与共享相册中的所有新内容一样，我们的审核员会快速查看。',
    modp_p2: '你无需任何操作——审核通过后我们会通知你。',

    moda_subject: '你上传到“{album}”的内容已通过审核',
    moda_pre: '{files}已通过审核。',
    moda_title: '已通过',
    moda_p1: '好消息：你添加到相册“{album}”的 {files}已通过审核。',
    moda_p2: '感谢你分享照片！',

    pe_subject: '你的{product}（{tier}）已就绪',
    pe_pre: '它已在你的账户中等你。',
    pe_title: '感谢你的购买！',
    pe_p1: '你的{product}——{tier}已付款，现已在你的账户“{cabinet}”栏目中可用。',
    pe_p1_many: '{n} × {product}——{tier}已付款，现已在你的账户“{cabinet}”栏目中可用。',
    row_plan: '方案', row_storage: '存储空间', row_period: '存储期限', row_price: '价格',
    pe_period: '自首次上传到相册起 6 个月，可续期',
    pe_p2: '准备好后随时开始相册——没有期限，6 个月从第一张照片开始计算。',
    receipt: '付款收据将由我们的支付服务商另行发送。',

    pp_subject: 'Albums Pro 已开通',
    pp_pre: '所有功能已在你的账户中可用。',
    pp_title: '欢迎使用 Pro！',
    pp_p1: '你的 Pro 订阅已生效，所有功能已在你的账户中可用：',
    pp_f1: '照片最高 4K —— 在大屏幕上更清晰',
    pp_f2: '单个视频最大 500 MB',
    pp_f3: '每个相册最多 10 位协作者',
    pp_f4: '高级统计与观众分析',
    pp_price: '{price} / 月 · {taxes}',
    pp_per: '按月计费，随时取消',
    row_billing: '计费',
    pp_p2: '你可以随时取消；Pro 会保持有效直至已付费周期结束。',

    s80_subject: '“{album}”已使用 80% 的存储空间',
    s80_pre: '剩余约 {left}——你可以增加空间。',
    s80_title: '你的活动相册快满了',
    s80_p1: '活动相册“{album}”已使用 {used}，共 {cap}（{pct}%）。',
    s80_p2: '别担心——你可以为这个相册增加空间：',
    s80_tax: '一次性付款，已含税。',
    s80_p3: '回复这封邮件或点击下方按钮，告诉我们你选择的方案——我们会为这个相册增加空间。',
    s80_cta: '申请更多空间',
    s80_mail_subject: '为“{album}”增加空间',
  },

  ko: {
    hi: '{name}님, 안녕하세요.', hi_anon: '안녕하세요.',
    gb: '{n}GB',
    files: { other: '파일 {n}개' },
    open_profile: '내 프로필 열기', open_album: '앨범 열기', open_account: '내 계정 열기',
    foot_help: '궁금한 점이 있으면 이 메일에 회신하거나 {support}로 문의해 주세요.',
    foot_why: 'albums.ink 계정이 있어 이 서비스 메일을 보내 드립니다.',
    foot_brand: 'Albums.ink — 스토리 앨범, 그리고 QR 코드 하나로 모으는 모든 하객 사진.',
    tier_small: '스몰', tier_medium: '미디엄', tier_large: '라지',
    product: '이벤트 앨범', cabinet: '공유 앨범', taxes: '세금 포함',

    welcome_subject: 'Albums.ink에 오신 것을 환영합니다',
    welcome_pre: '계정이 준비되었습니다.',
    welcome_title: 'Albums에 오신 것을 환영합니다!',
    welcome_p1: '계정이 준비되었습니다. 사진, 동영상, 음성 메모를 챕터로 엮은 스토리 앨범을 만들어 친구와 공유하거나 비공개로 간직하세요.',
    welcome_p2: '결혼식이나 파티를 준비 중이신가요? 이벤트 앨범은 QR 코드 하나로 모든 하객 사진을 모아 줍니다. 하객은 앱 설치도 가입도 필요 없습니다.',
    welcome_link: '이벤트 앨범 알아보기',

    signin_subject: 'Albums.ink 새 로그인 알림',
    signin_pre: '계정에 로그인이 확인되었습니다.',
    signin_title: 'Albums.ink에 로그인하셨습니다',
    signin_p1: '방금 회원님의 Albums.ink 계정에 로그인이 있었습니다.',
    signin_when: '시간', signin_device: '기기', signin_unknown: '알 수 없는 기기',
    signin_p2: '본인이 로그인했다면 아무것도 하지 않으셔도 됩니다.',
    signin_p3: '본인이 아니라면 모르는 기기에서 Google 계정을 로그아웃하고 Google 비밀번호를 변경한 뒤 {support}로 알려 주세요.',
    signin_note: '이 알림은 하루에 한 번까지만 보내 드립니다.',

    modp_subject: '“{album}”에 올린 파일을 검토 중입니다',
    modp_pre: '{files}를 빠른 검토에 보냈습니다.',
    modp_title: '업로드한 파일을 검토 중입니다',
    modp_p1: '앨범 “{album}”에 {files}를 추가하셨습니다. 공유 앨범의 모든 새 콘텐츠처럼 운영팀이 빠르게 확인합니다.',
    modp_p2: '따로 하실 일은 없습니다. 승인되면 알려 드릴게요.',

    moda_subject: '“{album}”에 올린 파일이 승인되었습니다',
    moda_pre: '{files}가 검토를 통과했습니다.',
    moda_title: '승인 완료',
    moda_p1: '좋은 소식입니다. 앨범 “{album}”에 추가하신 {files}가 검토를 통과했습니다.',
    moda_p2: '사진을 공유해 주셔서 감사합니다!',

    pe_subject: '{product}({tier})이 준비되었습니다',
    pe_pre: '이미 계정에서 사용할 수 있습니다.',
    pe_title: '구매해 주셔서 감사합니다!',
    pe_p1: '{product} — {tier} 결제가 완료되어 계정의 “{cabinet}” 메뉴에서 바로 사용할 수 있습니다.',
    pe_p1_many: '{product} — {tier} {n}개 결제가 완료되어 계정의 “{cabinet}” 메뉴에서 바로 사용할 수 있습니다.',
    row_plan: '요금제', row_storage: '저장 공간', row_period: '보관 기간', row_price: '가격',
    pe_period: '앨범에 처음 업로드한 날부터 6개월, 연장 가능',
    pe_p2: '준비되면 언제든 앨범을 시작하세요. 기한은 없으며 6개월은 첫 사진부터 시작됩니다.',
    receipt: '결제 영수증은 결제 대행사에서 별도로 보내 드립니다.',

    pp_subject: 'Albums Pro가 활성화되었습니다',
    pp_pre: '모든 기능을 이미 계정에서 사용할 수 있습니다.',
    pp_title: 'Pro에 오신 것을 환영합니다!',
    pp_p1: 'Pro 구독이 활성화되어 모든 기능을 이미 계정에서 사용할 수 있습니다.',
    pp_f1: '최대 4K 사진 — 큰 화면에서 더 선명하게',
    pp_f2: '동영상 파일당 최대 500MB',
    pp_f3: '앨범당 공동 작업자 10명까지',
    pp_f4: '고급 통계 및 시청자 분석',
    pp_price: '월 {price} · {taxes}',
    pp_per: '월 단위 결제, 언제든 해지 가능',
    row_billing: '결제',
    pp_p2: '언제든 해지할 수 있으며, Pro는 결제한 기간이 끝날 때까지 유지됩니다.',

    s80_subject: '“{album}” 저장 공간의 80%를 사용했습니다',
    s80_pre: '약 {left} 남았습니다. 공간을 추가할 수 있습니다.',
    s80_title: '이벤트 앨범이 거의 찼습니다',
    s80_p1: '이벤트 앨범 “{album}”의 사용량이 {cap} 중 {used}입니다({pct}%).',
    s80_p2: '걱정하지 마세요. 이 앨범에 공간을 추가할 수 있습니다.',
    s80_tax: '1회 결제, 세금 포함.',
    s80_p3: '이 메일에 회신하거나 버튼을 눌러 원하는 옵션을 알려 주시면 이 앨범에 공간을 추가해 드립니다.',
    s80_cta: '공간 추가 요청',
    s80_mail_subject: '“{album}” 저장 공간 추가',
  },

  ja: {
    hi: '{name} 様', hi_anon: 'こんにちは。',
    gb: '{n}GB',
    files: { other: '{n}件のファイル' },
    open_profile: 'プロフィールを開く', open_album: 'アルバムを開く', open_account: 'マイアカウントを開く',
    foot_help: 'ご不明な点は、このメールに返信するか {support} までご連絡ください。',
    foot_why: 'albums.ink のアカウントをお持ちの方にお送りしているサービスメールです。',
    foot_brand: 'Albums.ink — ストーリーアルバムと、QRコードひとつで集まるゲストの写真。',
    tier_small: 'スモール', tier_medium: 'ミディアム', tier_large: 'ラージ',
    product: 'イベントアルバム', cabinet: '共有アルバム', taxes: '税込',

    welcome_subject: 'Albums.ink へようこそ',
    welcome_pre: 'アカウントの準備ができました。',
    welcome_title: 'Albums へようこそ！',
    welcome_p1: 'アカウントの準備ができました。写真・動画・ボイスメモを章立てにしたストーリーアルバムを作り、友だちと共有したり、非公開で残したりできます。',
    welcome_p2: '結婚式やパーティーの予定がありますか？イベントアルバムなら、QRコードひとつでゲストの写真をすべて集められます。ゲストはアプリも登録も不要です。',
    welcome_link: 'イベントアルバムの使い方',

    signin_subject: 'Albums.ink への新しいログイン',
    signin_pre: 'アカウントへのログインを確認しました。',
    signin_title: 'Albums.ink にログインしました',
    signin_p1: 'たった今、あなたの Albums.ink アカウントにログインがありました。',
    signin_when: '日時', signin_device: 'デバイス', signin_unknown: '不明なデバイス',
    signin_p2: 'ご本人によるログインであれば、対応は不要です。',
    signin_p3: '心当たりがない場合は、見覚えのないデバイスで Google アカウントからログアウトし、Google のパスワードを変更のうえ、{support} までご連絡ください。',
    signin_note: 'この通知は1日1回までお送りします。',

    modp_subject: '「{album}」へのアップロードを確認中です',
    modp_pre: '{files}を簡単な確認に送りました。',
    modp_title: 'アップロードを確認中です',
    modp_p1: 'アルバム「{album}」に{files}を追加しました。共有アルバムへの新しい投稿と同様に、モデレーターが簡単に確認します。',
    modp_p2: 'お手続きは不要です。承認されたらお知らせします。',

    moda_subject: '「{album}」へのアップロードが承認されました',
    moda_pre: '{files}が確認を通過しました。',
    moda_title: '承認されました',
    moda_p1: 'アルバム「{album}」に追加した{files}が確認を通過しました。',
    moda_p2: '写真を共有していただき、ありがとうございます！',

    pe_subject: '{product}（{tier}）の準備ができました',
    pe_pre: 'すでにマイアカウントでご利用いただけます。',
    pe_title: 'ご購入ありがとうございます！',
    pe_p1: '{product}（{tier}）のお支払いが完了し、マイアカウントの「{cabinet}」ですでにご利用いただけます。',
    pe_p1_many: '{product}（{tier}）×{n} のお支払いが完了し、マイアカウントの「{cabinet}」ですでにご利用いただけます。',
    row_plan: 'プラン', row_storage: 'ストレージ', row_period: '保存期間', row_price: '価格',
    pe_period: 'アルバムへの最初のアップロードから6か月（延長可能）',
    pe_p2: '準備ができたらいつでもアルバムを開始してください。期限はなく、6か月は最初の写真から始まります。',
    receipt: 'お支払いの領収書は、決済パートナーから別途お送りします。',

    pp_subject: 'Albums Pro が有効になりました',
    pp_pre: 'すべての機能をマイアカウントでご利用いただけます。',
    pp_title: 'Pro へようこそ！',
    pp_p1: 'Pro のサブスクリプションが有効になり、すべての機能をマイアカウントでご利用いただけます。',
    pp_f1: '写真は最大4K — 大画面でもくっきり',
    pp_f2: '動画は1ファイル最大500MB',
    pp_f3: 'アルバムごとに共同編集者10人まで',
    pp_f4: '高度な統計と視聴者分析',
    pp_price: '月額 {price}（{taxes}）',
    pp_per: '月額課金・いつでも解約可能',
    row_billing: 'お支払い',
    pp_p2: 'いつでも解約でき、Pro はお支払い済みの期間の終わりまでご利用いただけます。',

    s80_subject: '「{album}」のストレージが80%に達しました',
    s80_pre: '残り約{left}です。容量を追加できます。',
    s80_title: 'イベントアルバムの容量が残りわずかです',
    s80_p1: 'イベントアルバム「{album}」は {cap} のうち {used} を使用しています（{pct}%）。',
    s80_p2: 'ご安心ください。このアルバムに容量を追加できます。',
    s80_tax: '一回払い・税込。',
    s80_p3: 'このメールに返信するかボタンを押して、ご希望のプランをお知らせください。このアルバムに容量を追加します。',
    s80_cta: '容量の追加を依頼する',
    s80_mail_subject: '「{album}」の容量追加',
  },
};

// ── Утилиты ─────────────────────────────────────────────────────────────────

export function pickLocale(l?: string | null): Locale {
  if (!l) return 'en';
  if ((LOCALES as readonly string[]).includes(l)) return l as Locale;
  const base = l.split(/[-_]/)[0].toLowerCase();
  if (base === 'zh') return 'zh-CN';
  return (LOCALES.find(x => x.split('-')[0] === base) ?? 'en') as Locale;
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fill(s: string, p: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
}

/** Текст по ключу (с откатом на английский) и подстановками. */
export function tr(loc: Locale, key: string, p: Record<string, string | number> = {}): string {
  let v = STR[loc][key] ?? STR.en[key];
  if (v === undefined) throw new Error(`email i18n: missing key ${key}`);
  if (typeof v === 'object') {
    const n = Number(p.n ?? 0);
    const form = new Intl.PluralRules(loc).select(n) as keyof Plural;
    v = (v as Plural)[form] ?? (v as Plural).other;
  }
  return fill(v as string, p);
}

/** Название альбома в тексте: без переводов строк, не длиннее 80 символов. */
export function albumTitle(s: unknown): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Albums';
  return t.length > 80 ? t.slice(0, 79) + '…' : t;
}

function fmtGb(loc: Locale, bytesOrGb: number, isBytes: boolean): string {
  const gb = isBytes ? bytesOrGb / 1073741824 : bytesOrGb;
  const n = new Intl.NumberFormat(loc, { maximumFractionDigits: gb < 10 ? 1 : 0 }).format(gb);
  return tr(loc, 'gb', { n });
}

export function fmtWhen(loc: Locale, iso: string | undefined | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(loc, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC';
}

/** «Chrome, Windows» из User-Agent. Пусто — если ничего не узнали. */
export function parseUA(ua: string | null | undefined): string {
  const s = String(ua ?? '');
  if (!s) return '';
  const browser =
    /YaBrowser\//.test(s) ? 'Yandex Browser' :
    /SamsungBrowser\//.test(s) ? 'Samsung Internet' :
    /Edg(A|iOS)?\//.test(s) ? 'Edge' :
    /OPR\/|Opera/.test(s) ? 'Opera' :
    /Firefox\/|FxiOS\//.test(s) ? 'Firefox' :
    /Chrome\/|CriOS\//.test(s) ? 'Chrome' :
    /Safari\//.test(s) && /Version\//.test(s) ? 'Safari' : '';
  const os =
    /iPhone|iPad|iPod/.test(s) ? 'iOS' :
    /Android/.test(s) ? 'Android' :
    /CrOS/.test(s) ? 'ChromeOS' :
    /Windows/.test(s) ? 'Windows' :
    /Mac OS X|Macintosh/.test(s) ? 'macOS' :
    /Linux/.test(s) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(', ');
}

// ── Модель письма ───────────────────────────────────────────────────────────

type Block =
  | { p: string; muted?: boolean }
  | { rows: [string, string][]; prices?: boolean }
  | { list: string[] };

export interface Doc {
  locale: Locale;
  subject: string;
  preheader: string;
  title: string;
  greeting: string;
  blocks: Block[];
  cta: { label: string; url: string };
  link?: { label: string; url: string };
}

function tierOf(v: unknown): Tier {
  return v === 'medium' || v === 'large' ? v : 'small';
}

/** Письмо из строки очереди. null — вид неизвестен (строка будет пропущена). */
export function buildDoc(job: EmailJob): Doc | null {
  const loc = pickLocale(job.locale);
  const t = (k: string, p: Record<string, string | number> = {}) => tr(loc, k, p);
  const name = String(job.name || job.username || '').trim();
  const greeting = name ? t('hi', { name }) : t('hi_anon');
  const n = Math.max(1, Number(job.count ?? 1) || 1);
  const album = albumTitle(job.album?.title);
  const albumId = String(job.album?.id ?? job.payload?.album_id ?? '');
  const files = t('files', { n });
  const base = { locale: loc, greeting };

  switch (job.kind) {
    case 'welcome':
      return {
        ...base, subject: t('welcome_subject'), preheader: t('welcome_pre'), title: t('welcome_title'),
        blocks: [{ p: t('welcome_p1') }, { p: t('welcome_p2') }],
        cta: { label: t('open_profile'), url: LINKS.profile },
        link: { label: t('welcome_link'), url: LINKS.events },
      };

    case 'signin': {
      const device = parseUA(job.payload?.ua as string) || t('signin_unknown');
      return {
        ...base, subject: t('signin_subject'), preheader: t('signin_pre'), title: t('signin_title'),
        blocks: [
          { p: t('signin_p1') },
          { rows: [[t('signin_when'), fmtWhen(loc, (job.payload?.at as string) ?? job.created_at)], [t('signin_device'), device]] },
          { p: t('signin_p2') },
          { p: t('signin_p3', { support: SUPPORT }) },
          { p: t('signin_note'), muted: true },
        ],
        cta: { label: t('open_profile'), url: LINKS.profile },
      };
    }

    case 'mod_pending':
      return {
        ...base, subject: t('modp_subject', { album }), preheader: t('modp_pre', { files }), title: t('modp_title'),
        blocks: [{ p: t('modp_p1', { files, album }) }, { p: t('modp_p2') }],
        cta: { label: t('open_album'), url: albumId ? LINKS.album(albumId) : LINKS.profile },
      };

    case 'mod_approved':
      return {
        ...base, subject: t('moda_subject', { album }), preheader: t('moda_pre', { files }), title: t('moda_title'),
        blocks: [{ p: t('moda_p1', { files, album }) }, { p: t('moda_p2') }],
        cta: { label: t('open_album'), url: albumId ? LINKS.album(albumId) : LINKS.profile },
      };

    case 'purchase_event': {
      const tier = tierOf(job.order?.tier ?? job.payload?.tier);
      const T = TIERS[tier];
      const tierName = t('tier_' + tier);
      const product = t('product');
      const amount = Number(job.order?.amount);
      const price = amount > 0 ? `$${amount.toFixed(2)}` : T.price;
      return {
        ...base,
        subject: t('pe_subject', { product, tier: tierName }), preheader: t('pe_pre'), title: t('pe_title'),
        blocks: [
          { p: t(n > 1 ? 'pe_p1_many' : 'pe_p1', { n, product, tier: tierName, cabinet: t('cabinet') }) },
          { rows: [
            [t('row_plan'), `${product} — ${tierName}`],
            [t('row_storage'), fmtGb(loc, Number(job.order?.storage_gb) || T.gb, false)],
            [t('row_period'), t('pe_period')],
            [t('row_price'), `${price} · ${t('taxes')}`],
          ] },
          { p: t('pe_p2') },
          { p: t('receipt'), muted: true },
        ],
        cta: { label: t('open_account'), url: LINKS.cabinet },
      };
    }

    case 'purchase_pro':
      return {
        ...base, subject: t('pp_subject'), preheader: t('pp_pre'), title: t('pp_title'),
        blocks: [
          { p: t('pp_p1') },
          { list: [t('pp_f1'), t('pp_f2'), t('pp_f3'), t('pp_f4')] },
          { rows: [
            [t('row_plan'), 'Pro'],
            [t('row_price'), t('pp_price', { price: PRO_PRICE, taxes: t('taxes') })],
            [t('row_billing'), t('pp_per')],
          ] },
          { p: t('pp_p2') },
          { p: t('receipt'), muted: true },
        ],
        cta: { label: t('open_account'), url: LINKS.profile },
      };

    case 'storage80': {
      const capGb = Number(job.album?.storage_gb ?? job.payload?.cap_gb) || 100;
      const usedB = Math.max(0, Number(job.payload?.used_bytes) || 0);
      const capB = capGb * 1073741824;
      const pct = Math.min(100, Math.round((usedB / capB) * 100));
      const left = fmtGb(loc, Math.max(0, capB - usedB), true);
      const mailSubject = t('s80_mail_subject', { album }) + (albumId ? ` [${albumId}]` : '');
      return {
        ...base,
        subject: t('s80_subject', { album }), preheader: t('s80_pre', { left }), title: t('s80_title'),
        blocks: [
          { p: t('s80_p1', { album, used: fmtGb(loc, usedB, true), cap: fmtGb(loc, capGb, false), pct }) },
          { p: t('s80_p2') },
          { rows: STORAGE_PACKS.map(k => [`+${fmtGb(loc, k.gb, false)}`, k.price] as [string, string]), prices: true },
          { p: t('s80_tax'), muted: true },
          { p: t('s80_p3') },
        ],
        cta: { label: t('s80_cta'), url: `mailto:${SUPPORT}?subject=${encodeURIComponent(mailSubject)}` },
        link: albumId ? { label: t('open_album'), url: LINKS.eventAlbum(albumId) } : undefined,
      };
    }
  }
  return null;
}

// ── HTML и текст ────────────────────────────────────────────────────────────

const C = { bg: '#F3EEE6', card: '#FCFAF6', ink: '#2B2620', muted: '#7A7265', line: '#E4DCCE', accent: '#C9A227', accentInk: '#8A6E14', tint: '#F6EFDD' };
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans',sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

function htmlBlock(b: Block): string {
  if ('p' in b) {
    return `<p style="margin:0 0 14px;${b.muted ? `color:${C.muted};font-size:13.5px;` : ''}">${esc(b.p)}</p>`;
  }
  if ('rows' in b) {
    // prices: «+30 GB  ……  $15.99» — объём жирным слева, цена справа
    const k1 = b.prices ? `font-weight:700;color:${C.ink};font-size:15px;` : `color:${C.muted};font-size:13.5px;`;
    const v1 = b.prices ? 'text-align:right;font-weight:700;' : 'font-weight:600;';
    const rows = b.rows.map(([k, v], i) =>
      `<tr><td style="padding:9px 12px 9px 0;${k1}vertical-align:top;white-space:nowrap;${i ? `border-top:1px solid ${C.line};` : ''}">${esc(k)}</td>`
      + `<td style="padding:9px 0;${v1}vertical-align:top;${i ? `border-top:1px solid ${C.line};` : ''}">${esc(v)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;background:${C.tint};border-radius:12px;"><tr><td style="padding:6px 16px;">`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${SANS};font-size:14.5px;color:${C.ink};">${rows}</table></td></tr></table>`;
  }
  const items = b.list.map(x =>
    `<tr><td style="padding:3px 10px 3px 0;vertical-align:top;color:${C.accent};font-weight:700;">✓</td><td style="padding:3px 0;">${esc(x)}</td></tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-family:${SANS};font-size:15px;color:${C.ink};">${items}</table>`;
}

export function toHtml(d: Doc): string {
  const L = (k: string, p: Record<string, string | number> = {}) => tr(d.locale, k, p);
  const support = `<a href="mailto:${SUPPORT}" style="color:${C.accentInk};">${SUPPORT}</a>`;
  const help = esc(L('foot_help', { support: '\u0000' })).replace('\u0000', support);
  return `<!doctype html>
<html lang="${d.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${esc(d.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(d.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:0 6px 16px;"><a href="${SITE}/" style="font-family:${SERIF};font-size:26px;font-weight:600;color:${C.ink};text-decoration:none;">Albums<span style="color:${C.accent};">.ink</span></a></td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:30px 28px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.ink};">
<h1 style="margin:0 0 18px;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:600;color:${C.ink};">${esc(d.title)}</h1>
<p style="margin:0 0 14px;">${esc(d.greeting)}</p>
${d.blocks.map(htmlBlock).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 6px;"><tr><td style="border-radius:10px;background:${C.accent};">
<a href="${esc(d.cta.url)}" style="display:inline-block;padding:13px 24px;font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(d.cta.label)}</a></td></tr></table>
${d.link ? `<p style="margin:14px 0 0;font-size:14px;"><a href="${esc(d.link.url)}" style="color:${C.accentInk};">${esc(d.link.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:18px 8px 0;font-family:${SANS};font-size:12.5px;line-height:1.55;color:${C.muted};">
<p style="margin:0 0 8px;">${help}</p>
<p style="margin:0 0 8px;">${esc(L('foot_why'))}</p>
<p style="margin:0;"><a href="${SITE}/" style="color:${C.muted};">${esc(L('foot_brand'))}</a></p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

export function toText(d: Doc): string {
  const L = (k: string, p: Record<string, string | number> = {}) => tr(d.locale, k, p);
  const out: string[] = [d.title, '', d.greeting, ''];
  for (const b of d.blocks) {
    if ('p' in b) out.push(b.p, '');
    else if ('rows' in b) out.push(...b.rows.map(([k, v]) => `${k}: ${v}`), '');
    else out.push(...b.list.map(x => `• ${x}`), '');
  }
  out.push(`${d.cta.label}: ${d.cta.url}`);
  if (d.link) out.push(`${d.link.label}: ${d.link.url}`);
  out.push('', '—', L('foot_help', { support: SUPPORT }), L('foot_why'), `${L('foot_brand')} ${SITE}/`);
  return out.join('\n');
}

export interface Rendered { subject: string; html: string; text: string; locale: Locale }

export function render(job: EmailJob): Rendered | null {
  const d = buildDoc(job);
  if (!d) return null;
  const subject = d.subject.replace(/\s+/g, ' ').trim().slice(0, 180);
  return { subject, html: toHtml(d), text: toText(d), locale: d.locale };
}

// ── Отправка ────────────────────────────────────────────────────────────────

export interface SendResult { ok: boolean; id?: string; retry?: boolean; error?: string }
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** POST https://api.resend.com/emails. Ключ идемпотентности — id строки очереди. */
export async function sendResend(apiKey: string, m: { to: string; subject: string; html: string; text: string; kind: string; ref: string },
  fetchFn: FetchFn = fetch): Promise<SendResult> {
  try {
    const r = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': m.ref,
      },
      body: JSON.stringify({
        from: FROM, to: [m.to], reply_to: REPLY_TO,
        subject: m.subject, html: m.html, text: m.text,
        tags: [{ name: 'kind', value: m.kind }],
        headers: { 'X-Entity-Ref-ID': m.ref },
      }),
    });
    const body = await r.json().catch(() => ({} as Record<string, unknown>));
    if (r.ok && body?.id) return { ok: true, id: String(body.id) };
    const error = `${r.status} ${String(body?.name ?? '')} ${String(body?.message ?? '')}`.trim();
    return { ok: false, retry: r.status === 429 || r.status >= 500, error };
  } catch (e) {
    return { ok: false, retry: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Разбор очереди ──────────────────────────────────────────────────────────

export interface DrainDeps {
  apiKey: string | null | undefined;
  dryRun?: boolean;
  claim(limit: number): Promise<EmailJob[]>;
  mark(id: number, status: 'sent' | 'skipped' | 'retry' | 'failed', providerId?: string | null, error?: string | null): Promise<void>;
  send(m: { to: string; subject: string; html: string; text: string; kind: string; ref: string }): Promise<SendResult>;
  log(...a: unknown[]): void;
  sleep?(ms: number): Promise<void>;
}

export async function drain(d: DrainDeps, limit = 20) {
  if (!d.apiKey && !d.dryRun) {
    d.log('notify: RESEND_API_KEY is not set — emails stay queued, nothing sent');
    return { skipped: 'no_api_key' as const };
  }
  const jobs = await d.claim(limit);
  const res = { claimed: jobs.length, sent: 0, skipped: 0, retry: 0, failed: 0 };
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      if (!job.to || job.anon) {
        await d.mark(job.id, 'skipped', null, 'no recipient');
        res.skipped++;
        continue;
      }
      const m = render(job);
      if (!m) {
        await d.mark(job.id, 'skipped', null, 'unknown kind ' + job.kind);
        res.skipped++;
        continue;
      }
      if (d.dryRun) {
        d.log('notify: DRY RUN', job.id, job.kind, m.locale, job.to, m.subject);
        await d.mark(job.id, 'skipped', null, 'dry run');
        res.skipped++;
        continue;
      }
      const r = await d.send({ to: job.to, subject: m.subject, html: m.html, text: m.text, kind: job.kind, ref: `albums-email-${job.id}` });
      if (r.ok) { await d.mark(job.id, 'sent', r.id ?? null, null); res.sent++; }
      else if (r.retry) { await d.mark(job.id, 'retry', null, r.error ?? null); res.retry++; d.log('notify: retry later', job.id, r.error); }
      else { await d.mark(job.id, 'failed', null, r.error ?? null); res.failed++; d.log('notify: failed', job.id, r.error); }
    } catch (e) {
      res.retry++;
      d.log('notify: error', job.id, e instanceof Error ? e.message : e);
      try { await d.mark(job.id, 'retry', null, e instanceof Error ? e.message : String(e)); } catch { /* строка вернётся через 15 минут */ }
    }
    if (d.sleep && i < jobs.length - 1) await d.sleep(550);   // Resend: 2 запроса в секунду
  }
  return res;
}
