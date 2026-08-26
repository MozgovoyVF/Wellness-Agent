// Переигрывание прогона: берёт задачу из трейса и гонит её через сегодняшний харнесс.
//
// Смысл — увидеть, что изменила правка. Промпт, модель, границы раундов правятся часто,
// а вопрос всегда один: стало лучше или просто иначе? Трейс хранит вчерашний ответ,
// этот скрипт добывает сегодняшний и ставит их рядом.
//
//   npm run replay runs/run-2026-08-17T10-00-00-000Z.json
//
// Прогон настоящий, поэтому он пишет и свой собственный трейс — отдельной логики
// для этого не нужно, харнесс делает это сам.

import './env';
import { readFileSync } from 'node:fs';
import { runHealthAgent } from '../src/harness/runHealthAgent';
import { finalRound } from '../src/harness/score';
import type { RunTrace } from '../src/harness/traceRun';

const path = process.argv[2];

if (!path) {
  console.error('Укажи трейс: npm run replay runs/run-XXX.json');
  process.exit(1);
}

let before: RunTrace;
try {
  before = JSON.parse(readFileSync(path, 'utf8')) as RunTrace;
} catch (error) {
  console.error(`Не прочитать трейс ${path}: ${String(error)}`);
  process.exit(1);
}

if (!before.task) {
  console.error(`В трейсе ${path} нет задачи — переигрывать нечего.`);
  process.exit(1);
}

// Ширины колонок фиксированы: сравнение читают глазами, и колонки должны стоять друг
// под другом, даже когда значения разной длины.
const LABEL = 16;
const VALUE = 34;

const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

function row(label: string, oldValue: string, newValue: string): void {
  const changed = oldValue !== newValue ? '  ←' : '';
  console.log(`${cell(label, LABEL)}${cell(oldValue, VALUE)}${cell(newValue, VALUE)}${changed}`);
}

// Прочерк вместо версии триажа — для трейсов, снятых до того, как триаж появился.
const versions = (v: RunTrace['promptVersions']) =>
  `coach ${v.coach} · reviewer ${v.reviewer} · triage ${v.triage ?? '—'}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

console.log(`\nЗадача: ${before.task}`);
console.log(`Трейс:  ${before.runId} (${before.createdAt})\n`);
console.log('Гоню заново — это несколько минут…\n');

const after = await runHealthAgent(before.task);

console.log(`\n${cell('', LABEL)}${cell('было', VALUE)}${cell('стало', VALUE)}`);
console.log('─'.repeat(LABEL + VALUE * 2 + 3));

row('вердикт', before.verdict, after.review.verdict);
row('оценка', `${before.finalScore}/10`, `${after.finalScore}/10`);
row('раундов', String(before.rounds.length), String(after.rounds.length));
row('промпты', versions(before.promptVersions), versions(after.promptVersions));
row('модель', before.model, process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash');
// Прочерк — для трейсов, снятых до появления OS. Новый прогон идёт через runHealthAgent
// напрямую, без роутера, поэтому «стало» здесь всегда general: replay сравнивает прогон,
// а не маршрутизацию.
row('модуль', before.module ?? '—', after.module);
row('время', seconds(before.durationMs), seconds(after.durationMs));

// Тулы и замечания в колонку не влезают: тулов бывает десяток, замечания — целые фразы.
// Обрезать их нельзя — именно в них видно, что поменялось в поведении агента, а не в цифрах.
function block(label: string, oldLines: string[], newLines: string[]): void {
  const show = (lines: string[]) => (lines.length === 0 ? ['—'] : lines);
  console.log(`\n${label} было:`);
  for (const line of show(oldLines)) console.log(`  ${line}`);
  console.log(`${label} стало:`);
  for (const line of show(newLines)) console.log(`  ${line}`);
}

block('Тулы', [before.toolCalls.join(', ')].filter(Boolean), [after.toolCalls.join(', ')].filter(Boolean));

// Замечания берём у итогового раунда, а не у последнего: при доборе это разные раунды.
block(
  'Замечания',
  (finalRound(before.rounds)?.review.issues ?? []).map((issue) => `- ${issue}`),
  after.review.issues.map((issue) => `- ${issue}`),
);

console.log();
