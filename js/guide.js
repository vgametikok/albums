// Гайды (/guides/…): статичные английские статьи. Скрипт только ставит общую
// шапку, нижнюю панель и подвал — те же, что на главной (js/ui.js).
import { mountShell } from './ui.js';

mountShell('guides').catch((e) => console.error('shell', e));
