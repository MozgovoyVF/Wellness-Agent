// Эмбеддинги: текст → вектор. Один fetch, никакого клиента и никакого SDK — эндпоинт
// OpenAI-совместимый, и запрос к нему это обычный POST с JSON.
//
// Ключ здесь не тот, которым ходит агент. Модель живёт на DeepSeek, а эмбеддингов
// у DeepSeek нет вовсе — поэтому у RAG отдельный провайдер, отдельный ключ и отдельный
// baseURL. Смешивать их нельзя.

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';

/**
 * Векторы для набора текстов, в том же порядке, что и вход.
 *
 * Один запрос на весь массив: API принимает батч, а делать семьдесят запросов подряд
 * ради семидесяти секций — это семьдесят раундтрипов и семьдесят шансов упереться
 * в лимит. Порядок ответа сортируется по полю index, а не берётся как пришёл:
 * спецификация его не гарантирует, а перепутанные векторы дадут молча неверный поиск.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Не найден OPENAI_API_KEY. Добавь его в .env — им считаются эмбеддинги базы знаний ' +
        '(у DeepSeek эндпоинта эмбеддингов нет).',
    );
  }

  const baseUrl = process.env.EMBEDDING_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODEL;

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`Эмбеддинги не посчитались: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { data: { index: number; embedding: number[] }[] };

  return [...payload.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

/** Какой моделью считаем — нужно ингесту в лог: размерность вектора зашита в схему БД. */
export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}
