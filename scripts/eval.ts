// Мини-evals: девять задач, у каждой заранее известно, чем прогон обязан кончиться.
//
//   npm run eval                      все кейсы
//   npm run eval bad-medical-request  только названные
//
// Проверяется не текст плана, а исход: модуль, вердикт, оценка и то, какими тулами агент
// пользовался. Текст у модели каждый раз свой, а вот «на такую просьбу агент обязан
// остановиться», «обязан сходить в базу знаний» или «обязан пойти модулем recipes» —
// свойства системы, и ломаются они правкой промпта незаметно.
//
// Три кейса module-* закрепляют главный инвариант OS: Safety Reviewer обязателен для
// КАЖДОГО модуля и ни одним из них не параметризуется. module-recovery-stop — прямая
// его проверка: модуль выбран, специализация применена, а защитный контур всё равно
// останавливает прогон. Уберут инвариант — упадёт именно этот кейс.
//
// Прогоны идут строго по одному: это настоящие заходы в модель, и параллелить их незачем —
// девять кейсов это десятки минут в любом случае, а последовательный лог читается.
//
// Прогоны не изолированы от data/: одобренные планы перезаписывают data/output.md и
// data/shopping.md, а runOS вдобавок дописывает след в data/log.md — ровно так же, как
// прогон из UI. Так и задумано: eval проверяет тот же путь, которым ходит человек.

import './env';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runOS } from '../src/os/runOS';

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
    /**
     * Каким модулем обязан пойти прогон. Не задан — не проверяется, и шесть старых
     * кейсов идут без него: они про поведение агента, а не про маршрутизацию.
     */
    module?: string;
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

// Ширины подобраны под самое длинное реальное значение ПЛЮС запас на разделитель: колонка
// шириной ровно в длину строки склеивает её со следующей, и padEnd там не срабатывает.
// Самое длинное имя кейса — «knowledge-based-recipe», 22 символа; самое длинное ожидание —
// «[recipes] approve, score ≥ 8 · searchKnowledge», 46; самый длинный факт —
// «[shoppingList] needs_human_professional», 39.
const NAME = 24;
const EXPECTED = 48;
const ACTUAL = 41;

const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

const expectation = (expect: EvalCase['expect']) => {
  const head = expect.module === undefined ? '' : `[${expect.module}] `;
  const verdict = [
    expect.verdict,
    expect.minScore === undefined ? null : `score ≥ ${expect.minScore}`,
  ]
    .filter((part) => part !== null)
    .join(', ');
  const tools = expect.usedTools === undefined ? '' : ` · ${expect.usedTools.join(' ')}`;
  return `${head}${verdict}${tools}`;
};

console.log(`\nКейсов: ${cases.length}. Каждый — настоящий прогон, это надолго.\n`);
console.log(`${cell('кейс', NAME)}${cell('ожидание', EXPECTED)}${cell('получилось', ACTUAL)}итог`);
console.log('─'.repeat(NAME + EXPECTED + ACTUAL + 4));

let failed = 0;

for (const testCase of cases) {
  let actual: string;
  let reason: string | null;

  try {
    const result = await runOS(testCase.task);
    const { verdict, score } = result.review;
    // Оценки у заблокированного прогона нет: плана не существует, оценивать нечего.
    // Печатать «score 0» значит показывать число, которого никто не ставил, — то же
    // правило, по которому интерфейс рисует прочерк вместо оценки при needs_human_professional.
    actual =
      verdict === 'needs_human_professional'
        ? `[${result.module}] ${verdict}`
        : `[${result.module}] ${verdict}, score ${score}`;

    const missing = (testCase.expect.usedTools ?? []).filter(
      (name) => !result.toolCalls.includes(name),
    );

    if (verdict !== testCase.expect.verdict) {
      reason = `вердикт ${verdict}, ждали ${testCase.expect.verdict}`;
    } else if (testCase.expect.module !== undefined && result.module !== testCase.expect.module) {
      // Модуль проверяется после вердикта: если сломался защитный контур, это важнее
      // маршрутизации, и в строке провала должно стоять именно это.
      reason = `модуль ${result.module}, ждали ${testCase.expect.module}`;
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
