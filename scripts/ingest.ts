// Ингест базы знаний: knowledge/*.md → эмбеддинги → таблица knowledge_chunks.
//
//   npm run ingest
//
// Операция разрушающая и идемпотентная одновременно: таблица очищается и заливается
// заново, поэтому повторный запуск не создаёт дублей, но и правки, сделанные в базе
// руками, он сотрёт. Это осознанно — источник истины здесь knowledge/, а не Postgres.
//
// Первым импортом — ./env: вне Next .env читать некому, а тела импортированных модулей
// выполняются раньше тела скрипта.

import './env';
import {
  closePool,
  embed,
  embeddableText,
  embeddingModel,
  readKnowledgeChunks,
  replaceChunks,
  type StoredChunk,
} from '../src/rag';

// Столько текстов уходит в один запрос эмбеддингов. Батч нужен не сегодняшним семидесяти
// секциям, а базе, которая вырастет: в один запрос всё не влезет ни по числу входов,
// ни по токенам.
const BATCH = 64;

// Размерность, под которую заведена колонка в docs/001_create_knowledge_chunks_table.sql.
// Сверяем здесь, потому что несовпадение иначе всплывёт невнятной ошибкой драйвера
// на вставке — а причина у неё всегда одна: сменили EMBEDDING_MODEL, не тронув схему.
const EXPECTED_DIMENSIONS = 1536;

const chunks = readKnowledgeChunks();

if (chunks.length === 0) {
  console.error('В knowledge/ не нашлось ни одной ##-секции. Заливать нечего.');
  process.exit(1);
}

// Сколько секций дал каждый файл. Печатаем всегда: «залилось» и «залилось правильно» —
// разные вещи, и различить их можно только по числам.
const perFile = new Map<string, number>();
for (const chunk of chunks) perFile.set(chunk.file, (perFile.get(chunk.file) ?? 0) + 1);

console.log(`\nБаза знаний: ${chunks.length} секций в ${perFile.size} файлах.`);
for (const [file, count] of [...perFile].sort()) console.log(`  ${file.padEnd(28)}${count}`);

console.log(`\nСчитаю эмбеддинги моделью ${embeddingModel()}…`);

// Всё остальное — в один try: отсюда и до конца любая неудача это неудача ингеста,
// и человеку нужна её причина одной строкой, а не стек через половину экрана. Ошибки
// здесь бытовые — нет ключа, нет базы, сменили модель, — и все чинятся правкой .env.
try {
  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += BATCH) {
    const batch = chunks.slice(offset, offset + BATCH);
    vectors.push(...(await embed(batch.map(embeddableText))));
    console.log(`  ${Math.min(offset + BATCH, chunks.length)}/${chunks.length}`);
  }

  const dimensions = vectors[0].length;
  if (dimensions !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `Модель ${embeddingModel()} даёт вектор размерности ${dimensions}, а колонка заведена ` +
        `под ${EXPECTED_DIMENSIONS}. Либо верни прежнюю модель, либо пересоздай таблицу ` +
        'с новой размерностью в docs/001_create_knowledge_chunks_table.sql — сравнивать векторы ' +
        'разных моделей всё равно нельзя, так что переингест обязателен.',
    );
  }

  const rows: StoredChunk[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: vectors[index],
  }));

  const written = await replaceChunks(rows);
  console.log(`\nЗалито строк: ${written}. Таблица knowledge_chunks перезаписана целиком.`);
  console.log(
    'Если ivfflat-индекс ещё не создан — самое время: выполни ' +
      'docs/002_create_knowledge_embedding_index.sql, теперь он построится по данным.\n',
  );
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  // Пул держит процесс живым — скрипт обязан завершиться сам, без ctrl+C.
  await closePool();
}
