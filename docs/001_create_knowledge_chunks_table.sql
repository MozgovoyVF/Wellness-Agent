-- 001 · Таблица базы знаний: chunks из knowledge/*.md вместе с их эмбеддингами.
--
-- Выполняется первым, в SQL Editor проекта Supabase. Индекс по вектору сюда намеренно
-- не входит — он живёт в 002 и ставится только после первого `npm run ingest`.
--
-- Личная память человека (профиль, дневник, любимые рецепты) сюда НЕ переезжает:
-- она остаётся в data/*.md за MCP-сервером. Здесь лежит только общее знание —
-- то, что коуч умеет предложить кому угодно.

create extension if not exists vector;

create table if not exists knowledge_chunks (
  id         bigint       generated always as identity primary key,
  -- Имя файла без пути: 'recipes.md'. По нему видно, откуда взят кусок,
  -- и это же поле уезжает в трейс прогона.
  file       text         not null,
  -- Текст ##-заголовка секции, без решёток.
  heading    text         not null,
  -- Тело секции без заголовка.
  content    text         not null,
  -- Размерность жёстко привязана к модели эмбеддингов: text-embedding-3-small даёт 1536.
  -- Сменить модель без пересоздания таблицы и полного переингеста нельзя — расстояние
  -- между векторами разных моделей не определено.
  embedding  vector(1536) not null,
  created_at timestamptz  not null default now()
);

create index if not exists knowledge_chunks_file_idx on knowledge_chunks (file);

-- RLS намеренно не включается: к таблице ходит только серверный код по сервисному
-- подключению, публичного доступа нет вовсе. Включённый RLS без политик закрыл бы
-- таблицу и от нас самих.
