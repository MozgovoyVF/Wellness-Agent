// Мини-evals: шесть задач, у каждой заранее известно, чем прогон обязан кончиться.
//
//   npm run eval                      все кейсы
//   npm run eval bad-medical-request  только названные
//
// Проверяется не текст плана, а исход: вердикт, оценка и то, какими тулами агент
// пользовался. Текст у модели каждый раз свой, а вот «на такую просьбу агент обязан
// остановиться» или «обязан сходить в базу знаний» — свойства системы, и ломаются они
// правкой промпта незаметно. Ради этого здесь стоят bad-medical-request
// и knowledge-based-recipe.
//
// Прогоны идут строго по одному: это настоящие заходы в модель, и параллелить их незачем —
// шесть кейсов это десятки минут в любом случае, а последовательный лог читается.
//
// Прогоны не изолированы от data/: одобренные планы перезаписывают data/output.md и
// data/shopping.md ровно так же, как прогон из UI. Так и задумано — eval должен проверять
// тот же путь, которым ходит человек, а не его облегчённую копию.

import './env';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runHealthAgent } from '../src/harness/runHealthAgent';

type EvalCase = {
  name: string;
  task: string;
  expect: {
    verdict: 'approve' | 'needs_human_professional';
    /** Не задан — оценка не проверяется. У защитного кейса плана нет, спрашивать нечего. */
    minScore?: number;
    /**
     * Эти тулы обязаны встретиться среди вызовов прогона. Не задан — не проверяется.
     * Проверяется факт обращения, а не его выдача: что именно нашлось в базе знаний,
     * зависит от модели эмбеддингов и содержимого knowledge/, а вот «за рецептом положено
     * сходить в базу, а не сочинять его» — свойство системы.
     */
    usedTools?: string[];
  };
};

const CASES_DIR = join(process.cwd(), 'evals', 'cases');

const filter = process.argv.slice(2);

const cases: EvalCase[] = readdirSync(CASES_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as EvalCase)
  .filter((testCase) => filter.length === 0 || filter.includes(testCase.name));

if (cases.length === 0) {
  console.error(filter.length === 0 ? 'В evals/cases нет кейсов.' : `Нет кейсов: ${filter.join(', ')}`);
  process.exit(1);
}

// Ширины подобраны под самое длинное реальное значение: «needs_human_professional,
// score 0» — 33 символа, «approve, score ≥ 8 · searchKnowledge» — 36. Урежется — из
// таблицы пропадёт ровно то, ради чего смотрят.
const NAME = 22;
const EXPECTED = 38;
const ACTUAL = 34;

const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

const expectation = (expect: EvalCase['expect']) =>
  [
    expect.verdict,
    expect.minScore === undefined ? null : `score ≥ ${expect.minScore}`,
    expect.usedTools === undefined ? null : `· ${expect.usedTools.join(' ')}`,
  ]
    .filter((part) => part !== null)
    .join(', ')
    // Точка-разделитель перед тулами не должна ехать с запятой: она и есть разделитель.
    .replace(', ·', ' ·');

console.log(`\nКейсов: ${cases.length}. Каждый — настоящий прогон, это надолго.\n`);
console.log(`${cell('кейс', NAME)}${cell('ожидание', EXPECTED)}${cell('получилось', ACTUAL)}итог`);
console.log('─'.repeat(NAME + EXPECTED + ACTUAL + 4));

let failed = 0;

for (const testCase of cases) {
  let actual: string;
  let reason: string | null;

  try {
    const result = await runHealthAgent(testCase.task);
    const { verdict, score } = result.review;
    actual = `${verdict}, score ${score}`;

    const missing = (testCase.expect.usedTools ?? []).filter(
      (name) => !result.toolCalls.includes(name),
    );

    if (verdict !== testCase.expect.verdict) {
      reason = `вердикт ${verdict}, ждали ${testCase.expect.verdict}`;
    } else if (testCase.expect.minScore !== undefined && score < testCase.expect.minScore) {
      reason = `score ${score} ниже порога ${testCase.expect.minScore}`;
    } else if (missing.length > 0) {
      reason = `агент не вызвал: ${missing.join(', ')}`;
    } else {
      reason = null;
    }
  } catch (error) {
    // Упавший прогон — это тоже провал кейса, а не повод бросить остальные четыре.
    actual = 'ошибка прогона';
    reason = String(error);
  }

  if (reason !== null) failed += 1;

  console.log(
    `${cell(testCase.name, NAME)}${cell(expectation(testCase.expect), EXPECTED)}` +
      `${cell(actual, ACTUAL)}${reason === null ? 'PASS' : 'FAIL'}`,
  );
  if (reason !== null) console.log(`${' '.repeat(NAME)}└ ${reason}`);
}

console.log(`\n${cases.length - failed}/${cases.length} PASS\n`);

// Ненулевой код, чтобы прогон было видно снаружи скрипта — например, из истории команд.
if (failed > 0) process.exitCode = 1;
