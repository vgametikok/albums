// Публичная конфигурация. Ключ publishable — публичный по дизайну,
// вся защита данных лежит на RLS/RPC (см. ARCHITECTURE.md §8).
export const SUPABASE_URL = 'https://rizveurkjpcwrmbtoawj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_vpoMQyLN_a1CeYBPuGIuIA_VI5x07JD';

// @username бота из @BotFather (без «@»). Пусто — кнопки Telegram нет.
// Публичный идентификатор, не секрет; сам токен бота живёт в секрете функции.
export const TELEGRAM_BOT = 'albumsregsbot';

export const CATEGORIES = ['Travel', 'Music', 'Family', 'Art', 'Sport', 'Other'];

// Лимиты на ИСХОДНЫЙ файл. Фото после сжатия всегда укладывается в пару сотен КБ,
// поэтому вход щедрый — ограничение тут только про память браузера.
export const LIMITS = {
  photo: 30 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  video: 50 * 1024 * 1024,   // 50 МБ — потолок файла на бесплатном тарифе Supabase
  slides: 10,
};
