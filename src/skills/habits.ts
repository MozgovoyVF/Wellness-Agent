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
export function checkHabit(habit: string, date: string): string {
  const raw = readData('habits.md');
  const parts = raw.split(HABIT_HEADING);
  const head = parts[0].trimEnd();
  const sections = parts.slice(1).map((part) => `## ${part}`);

  const needle = habit.trim().toLowerCase();
  const index = sections.findIndex((section) => {
    const title = titleOf(section).toLowerCase();
    return title === needle || title.includes(needle);
  });

  if (index === -1) {
    const titles = sections.map(titleOf);
    return (
      `Нет привычки «${habit}». Есть такие: ${titles.join('; ') || 'ни одной'}. ` +
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
