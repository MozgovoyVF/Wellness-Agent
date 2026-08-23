// Контроль формы ответа ревьюера: схема, разбор сырого текста и ровно один ретрай.
// Как именно спросить модель, модуль не знает — это передаёт оркестратор.

import { z } from 'zod';

// Ось чек-листа: 0, 1 или 2 балла. Осей ровно пять, и это не деталь схемы — из них
// складывается score 0–10, под который нарисованы десять делений шкалы в UI.
const axis = z.number().int().min(0).max(2);

const BreakdownSchema = z.object({
  safety: axis,
  realism: axis,
  personalization: axis,
  specificity: axis,
  clarity: axis,
});

// score сюда не входит намеренно: модель называет баллы по осям, а складывает их харнесс.
// Модель, которой доверили и оценку, и её обоснование, охотно ставит одно, а обосновывает
// другое — и разойдясь, эти два числа никем не сверяются.
const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'needs_human_professional']),
  breakdown: BreakdownSchema,
  issues: z.array(z.string()),
});

export type Breakdown = z.infer<typeof BreakdownSchema>;

/** Ревью с посчитанной оценкой: score приходит не от модели, его складывает харнесс. */
export type Review = z.infer<typeof ReviewSchema> & { score: number };

/** Как спросить ревьюера: на вход текст, на выход сырой ответ модели. */
export type AskReviewer = (input: string) => Promise<string>;

const RETRY_HINT = '\n\nТвой прошлый ответ не был валидным JSON. Верни ТОЛЬКО JSON по схеме.';

const sumAxes = (breakdown: Breakdown): number =>
  Object.values(breakdown).reduce((total, points) => total + points, 0);

/** Ревью, которое харнесс выносит сам, минуя модель: плана нет, оценивать нечего. */
export function humanProfessionalReview(reason: string): Review {
  return {
    verdict: 'needs_human_professional',
    breakdown: { safety: 0, realism: 0, personalization: 0, specificity: 0, clarity: 0 },
    score: 0,
    issues: [reason],
  };
}

// Модель любит завернуть JSON в ```json — снимаем ограждение до разбора.
export function parseReview(raw: string): Review | null {
  const json = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try {
    const parsed = ReviewSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    return { ...parsed.data, score: sumAxes(parsed.data.breakdown) };
  } catch {
    return null; // ответ вообще не JSON
  }
}

/**
 * Один ретрай с напоминанием о схеме. Если и он не помог — это поломка, а не случайность,
 * и харнесс должен упасть, а не тащить дальше выдуманный вердикт.
 */
export async function validateReview(input: string, ask: AskReviewer): Promise<Review> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await ask(attempt === 0 ? input : input + RETRY_HINT);
    const review = parseReview(raw);
    if (review) return review;
    if (attempt === 0) console.log('   ревьюер ответил не по схеме — повторяю запрос');
  }
  throw new Error('Ревьюер дважды вернул невалидный JSON.');
}
