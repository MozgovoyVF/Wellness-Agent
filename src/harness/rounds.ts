// Состояние раундов: что произошло в каждом заходе коуч → ревьюер и вся история целиком.
// Модуль ничего не решает про выход из цикла — только помнит.

import type { Review } from './validateReview';

export type RoundState = {
  /** Номер раунда, 1..maxRounds. */
  round: number;
  /** План этого раунда; null — план скрыт защитным контуром, см. redactPlans. */
  plan: string | null;
  review: Review;
};

/** Накопитель раундов: номера раздаёт сам, чтобы цикл их не считал. */
export function createRoundLog() {
  const rounds: RoundState[] = [];

  return {
    /** Записывает завершённый раунд и возвращает его. */
    record(plan: string, review: Review): RoundState {
      const state: RoundState = { round: rounds.length + 1, plan, review };
      rounds.push(state);
      return state;
    },
    get count(): number {
      return rounds.length;
    },
    /** Последний раунд или null, если не было ни одного. */
    get last(): RoundState | null {
      return rounds.at(-1) ?? null;
    },
    /** Копия истории: наружу отдаём снимок, а не живой массив. */
    history(): RoundState[] {
      return rounds.map((state) => ({ ...state }));
    },
  };
}

export type RoundLog = ReturnType<typeof createRoundLog>;

/**
 * Убирает тексты планов из истории. Нужно при needs_human_professional: план в таком
 * прогоне наружу не отдаётся, и история — это тоже «наружу».
 */
export function redactPlans(rounds: RoundState[]): RoundState[] {
  return rounds.map((state) => ({ ...state, plan: null }));
}
