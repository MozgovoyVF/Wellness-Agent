// Навык «привычки»: чистые функции над data/habits.md. Тулы над ними объявляет
// MCP-сервер (read_habits и check_habit) — здесь только работа с файлом.
//
// Формат разбирается тот же, что у дневника: секция на привычку, заголовок второго
// уровня, внутри строки-чекбоксы по дням. Разбор намеренно завязан на этот формат,
// а не универсальный: файл наш, формат известен.

import { readData, writeData } from './dataFiles';

const HABIT_HEADING = /^## /m;

/** Заголовок секции без «## ». Строка заголовка — первая строка секции. */
const titleOf = (section: string) => section.split('\n', 1)[0].slice(3).trim();

/**
 * Сегодняшняя дата в формате файла привычек. По локальным компонентам, а НЕ через
 * toISOString(): тот отдаёт UTC, и в поясе восточнее Гринвича первые часы нового дня
 * отметились бы вчерашним числом. Ровно та ошибка, ради которой calendarBlock() считает
 * день локально, а не по ISO.
 */
function todayIso(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Файл целиком: привычки короткие, отдавать хвост незачем — в отличие от дневника. */
export function listHabits(): string {
  const text = readData('habits.md').trim();
  return text.length === 0 ? 'Привычек пока нет.' : text;
}

/**
 * Отмечает привычку выполненной за указанный день.
 *
 * Привычка ищется по заголовку: сперва точным совпадением, потом вхождением подстроки —
 * человек говорит «зарядка», а в файле «Зарядка 10 минут утром». Падежи не приводятся:
 * морфологии здесь нет и не будет, как и в разборе списка покупок.
 *
 * Не нашлась — функция НЕ бросает, а возвращает текст с перечнем имеющихся: этот ответ
 * читает модель, и у неё должен быть шанс исправиться, а не уронить прогон.
 */
export function checkHabit(habit: string, date: string = todayIso()): string {
  const raw = readData('habits.md');
  const parts = raw.split(HABIT_HEADING);
  const head = parts[0].trimEnd();
  const sections = parts.slice(1).map((part) => `## ${part}`);

  const needle = habit.trim().toLowerCase();
  const titles = sections.map((section) => titleOf(section).toLowerCase());
  // Два прохода, а не одно условие через ИЛИ: точное совпадение обязано выигрывать
  // у вхождения, где бы то ни стояло в файле. Одним findIndex побеждает тот, кто выше,
  // и «растяжка» при секциях «Растяжка вечером» и «Растяжка» отметила бы не ту привычку.
  const exact = titles.indexOf(needle);
  const index = exact !== -1 ? exact : titles.findIndex((title) => title.includes(needle));

  if (index === -1) {
    const titleTexts = sections.map(titleOf);
    return (
      `Нет привычки «${habit}». Есть такие: ${titleTexts.join('; ') || 'ни одной'}. ` +
      'Возьми одну из них или ничего не отмечай — заводить новые привычки этот инструмент не умеет.'
    );
  }

  const title = titleOf(sections[index]);
  const done = `- [x] ${date}`;
  if (sections[index].includes(done)) return `Привычка «${title}» уже отмечена на ${date}.`;

  const pending = `- [ ] ${date}`;
  sections[index] = sections[index].includes(pending)
    ? sections[index].replace(pending, done)
    : `${sections[index].trimEnd()}\n${done}`;

  // Сборка нормализует пустые строки между секциями до одной: иначе каждая дописка
  // копила бы лишние переносы, а файл читают и глазами тоже.
  const body = sections.map((section) => section.trimEnd()).join('\n\n');
  writeData('habits.md', `${head}\n\n${body}\n`);

  return `ok: «${title}» отмечена на ${date}.`;
}
