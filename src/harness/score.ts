// Сведение оценок по истории раундов. Только арифметика: ни о выходе из цикла,
// ни о том, что делать с числом, модуль не знает.

import type { RoundState } from './rounds';
import type { Review } from './validateReview';

/**
 * Раунд, который прогон отдаёт наружу: последний одобренный. Одобрения нет — последний
 * бывший, это и есть план с пометкой «не одобрен».
 *
 * Выбор, а не просто «последний», нужен из-за минимума раундов: цикл продолжается и
 * после approve, и раунд добора может выйти хуже одобренного. Добор вправе улучшить
 * результат, но не испортить его.
 *
 * Обобщён по типу раунда, потому что то же правило нужно scripts/replay.ts — там раунды
 * приезжают из трейса, с выдержкой плана вместо плана. Правило одно, и жить оно должно
 * в одном месте: разъехавшись, скрипт начнёт показывать не тот раунд, что уехал наружу.
 */
export function finalRound<T extends { review: Review }>(rounds: T[]): T | null {
  const approved = rounds.filter((state) => state.review.verdict === 'approve').at(-1);
  return approved ?? rounds.at(-1) ?? null;
}


/**
 * Выросла ли оценка от первого раунда к последнему — то есть дали ли ревизии эффект.
 * Один раунд сравнивать не с чем, поэтому false.
 */
export function improvedAcrossRounds(rounds: RoundState[]): boolean {
  if (rounds.length < 2) return false;
  const first = rounds[0].review.score;
  const last = rounds[rounds.length - 1].review.score;
  return last > first;
}
