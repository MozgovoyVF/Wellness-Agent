// Навык «дневник»: чистые функции над data/log.md. Обёрток tool() здесь больше нет —
// дневник модели показывает MCP-сервер (тулы read_recent_logs и append_daily_log).
// Читающую функцию, кроме сервера, зовёт харнесс: ревьюеру дневник кладётся в контекст.
//
// В отличие от профиля дневник растёт, поэтому наружу отдаётся хвост, а не файл целиком:
// коуч сам решает, сколько дней ему нужно под задачу.

import { readData, writeData } from './dataFiles';

// Дневник размечен по дням заголовками второго уровня («## 12 августа, вторник»).
// Разбор намеренно завязан на этот формат, а не универсальный: файл наш, формат известен.
const DAY_HEADING = /^## /m;

export const MAX_LOG_DAYS = 14;

// Формат заголовка дня. Он же разбирается регуляркой DAY_HEADING выше — писать и читать
// один формат должен один модуль. С календарным блоком порядок слов не совпадает
// намеренно: calendarBlock() даёт «суббота, 8 августа», дневник размечен «8 августа,
// суббота», и приводить одно к другому значило бы менять формат существующего файла.
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const weekdayName = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' });

/** Заголовок сегодняшнего дня для дневника: «## 24 августа, понедельник». */
export function logDayHeading(now: Date = new Date()): string {
  return `## ${dayMonth.format(now)}, ${weekdayName.format(now)}`;
}

/**
 * Последние `days` дней дневника. Всё, что стоит до первого «## » (заголовок файла),
 * отбрасывается: это не день, а шапка, и место в контексте она занимает зря.
 */
export function getRecentLog(days: number): string {
  const entries = readData('log.md')
    .split(DAY_HEADING)
    .slice(1)
    .map((entry) => `## ${entry.trimEnd()}`);

  if (entries.length === 0) return 'Дневник пуст.';

  return entries.slice(-days).join('\n\n');
}

/**
 * Дописывает запись в конец дневника. Дописывает, а не перезаписывает: дневник — это
 * история, и затереть её одной неудачной записью нельзя. Заголовок дня пишет вызывающий:
 * формат дня («## 12 августа, вторник») задан файлом, а не этой функцией, и угадывать
 * за автора записи, какой сегодня день, ей нечем.
 */
export function appendDailyLog(entry: string): string {
  const text = readData('log.md').trimEnd();
  writeData('log.md', `${text}\n\n${entry.trim()}\n`);
  return 'ok: запись добавлена в конец data/log.md.';
}
