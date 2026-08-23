// Разбор ответа триаж-агента. Как именно спросить модель, модуль не знает — это передаёт
// оркестратор, ровно как в validateReview.
//
// Формат ответа — одно слово, а не JSON: у триажа единственный бит информации, и просить
// под него схему значит выдумывать поводы для ошибки разбора. WELLNESS — коуч работает,
// HUMAN — прогон останавливается, не начавшись.
//
// Непонятный ответ пропускает задачу дальше, а не блокирует её. Это осознанный выбор:
// триаж — первый контур, а не единственный. За ним стоит ревьюер, который тоже ставит
// needs_human_professional по сути запроса (prompts/safetyReviewer.v6.md, шаг 1), поэтому
// осечка триажа стоит одного лишнего прогона, а осечка в другую сторону отказывала бы
// человеку в ужине из-за одного сбойного ответа модели. О непонятном ответе видно в логе.

/** Итог триажа: пускать задачу к коучу или закрывать прогон. */
export type TriageVerdict = {
  blocked: boolean;
  /** Причина отказа одной фразой; при blocked = false пустая. */
  reason: string;
};

/** Как спросить триаж: на вход задача, на выход сырой ответ модели. */
export type AskTriage = (task: string) => Promise<string>;

const PASS: TriageVerdict = { blocked: false, reason: '' };

// Модель обязана дать причину сама, но остаться без текста для человека нельзя.
const DEFAULT_REASON = 'Задача требует живого специалиста, а не wellness-коуча.';

/**
 * Первая непустая строка ответа, очищенная от markdown: модель то обрамляет ответ
 * ```-ограждением, то выделяет слово звёздочками.
 */
function firstLine(raw: string): string {
  return (
    raw
      .split('\n')
      .map((line) => line.replace(/[`*#>]/g, '').trim())
      .find((line) => line.length > 0) ?? ''
  );
}

export function parseTriage(raw: string): TriageVerdict {
  const line = firstLine(raw);
  const upper = line.toUpperCase();

  // WELLNESS проверяется первым: в ответе «WELLNESS, а не HUMAN» решает первое слово.
  if (upper.startsWith('WELLNESS')) return PASS;

  const at = upper.indexOf('HUMAN');
  if (at === -1) return PASS;

  // Причина идёт после слова и любого разделителя — двоеточия, тире или просто пробела.
  const reason = line.slice(at + 'HUMAN'.length).replace(/^[\s:—–-]+/, '').trim();
  return { blocked: true, reason: reason || DEFAULT_REASON };
}

/**
 * Один заход, без ретрая. Формат ответа — одно слово: если модель не справилась с ним,
 * второй заход не поможет, а прогон и так уже стоит двух походов в модель за раунд.
 */
export async function triageTask(task: string, ask: AskTriage): Promise<TriageVerdict> {
  // firstLine идемпотентна, поэтому разбор можно кормить уже очищенной строкой —
  // она же нужна для лога.
  const line = firstLine(await ask(task));
  const verdict = parseTriage(line);

  if (!verdict.blocked && !line.toUpperCase().startsWith('WELLNESS')) {
    console.log(`   триаж ответил не по форме — пропускаю задачу дальше: ${line}`);
  }

  return verdict;
}
