// Доступ к базе знаний в Postgres. Драйвер и SQL, без ORM и без клиентской обёртки:
// весь смысл RAG здесь — в одном операторе pgvector, и прятать его за чужой абстракцией
// значит спрятать ровно то, ради чего всё это написано.
//
// Что здесь НЕ лежит: личная память человека. Профиль, дневник и любимые рецепты
// остаются в data/*.md за MCP-сервером — это осознанная граница, а не недоделка.

import { Pool } from 'pg';
import type { KnowledgeChunk } from './chunks';

/** Строка таблицы: chunk вместе с посчитанным для него вектором. */
export type StoredChunk = KnowledgeChunk & { embedding: number[] };

/** Найденный chunk: то же самое плюс похожесть на запрос, 0…1, больше — лучше. */
export type KnowledgeMatch = KnowledgeChunk & { similarity: number };

let pool: Pool | null = null;

/**
 * Пул один на процесс и ленивый: в Next он живёт вместе с сервером, в скрипте —
 * до closePool(). Отсутствие строки подключения — понятная ошибка, а не падение
 * на первом запросе.
 */
function getPool(): Pool {
  if (pool !== null) return pool;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'Не найден SUPABASE_DB_URL. Возьми строку подключения в Supabase → Connect → ' +
        'Transaction pooler и добавь её в .env.',
    );
  }

  pool = new Pool({
    connectionString,
    // Pooler Supabase отдаёт сертификат, которого нет в доверенных корнях Node, поэтому
    // проверку цепочки выключаем — сам канал при этом остаётся зашифрованным. Для учебного
    // проекта это приемлемо; в проде сюда кладут CA-сертификат из дашборда Supabase.
    ssl: { rejectUnauthorized: false },
    max: 4,
  });

  return pool;
}

/**
 * Заливает базу знаний заново: удаляет всё и вставляет переданное. Отсюда
 * идемпотентность `npm run ingest` — повторный запуск не создаёт дублей, потому что
 * дублировать нечего, таблица каждый раз начинается с нуля.
 *
 * Одной транзакцией, и это не формальность: без неё между delete и insert существует
 * момент, когда таблица пуста, и попавший в него retriever честно ответит «ничего
 * не найдено». Возвращает число вставленных строк.
 */
export async function replaceChunks(rows: StoredChunk[]): Promise<number> {
  const client = await getPool().connect();

  try {
    await client.query('begin');
    await client.query('delete from knowledge_chunks');

    if (rows.length > 0) {
      // Многострочный insert одним запросом: семьдесят отдельных вставок дали бы
      // семьдесят раундтрипов там, где хватает одного.
      const values = rows
        .map((_, index) => {
          const base = index * 4;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector)`;
        })
        .join(', ');

      await client.query(
        `insert into knowledge_chunks (file, heading, content, embedding) values ${values}`,
        // Вектор уезжает строкой '[0.1,0.2,…]': массив JS драйвер превратил бы
        // в постгресовый литерал {0.1,0.2,…}, а такой тип vector не принимает.
        rows.flatMap((row) => [row.file, row.heading, row.content, JSON.stringify(row.embedding)]),
      );
    }

    await client.query('commit');
    return rows.length;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Топ-K ближайших chunks по косинусной близости.
 *
 * `<=>` — косинусное расстояние pgvector: 0 у одинаковых векторов, 2 у противоположных.
 * `1 - расстояние` переворачивает его в привычную похожесть, где больше значит лучше.
 * Порядок задаётся расстоянием, а не похожестью, — так запрос попадает в ivfflat-индекс,
 * который построен ровно по этому оператору.
 */
export async function matchChunks(vector: number[], topK: number): Promise<KnowledgeMatch[]> {
  const { rows } = await getPool().query<KnowledgeMatch>(
    `select file, heading, content,
            1 - (embedding <=> $1::vector) as similarity
       from knowledge_chunks
      order by embedding <=> $1::vector
      limit $2`,
    [JSON.stringify(vector), topK],
  );

  // similarity приезжает из Postgres как double precision — драйвер отдаёт его числом,
  // но округляем здесь, а не в трейсе и не в UI: показывать шестнадцать знаков незачем,
  // а место скругления должно быть одно.
  return rows.map((row) => ({ ...row, similarity: Number(row.similarity.toFixed(4)) }));
}

/**
 * Закрывает пул. Зовёт только скрипт ингеста: он обязан завершиться, а открытый пул
 * держит процесс живым. В Next пул живёт столько же, сколько сервер, и закрывать его
 * некому и незачем.
 */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  await pool.end();
  pool = null;
}
