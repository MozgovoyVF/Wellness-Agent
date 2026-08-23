import { runHealthAgent } from '@/src/harness/runHealthAgent';

// Агенты читают и пишут файлы в data/ — нужен nodejs-рантайм, не edge.
export const runtime = 'nodejs';

export async function POST(request: Request) {
  let task: unknown;
  try {
    ({ task } = await request.json());
  } catch {
    return Response.json({ error: 'Тело запроса не является валидным JSON.' }, { status: 400 });
  }

  if (typeof task !== 'string' || !task.trim()) {
    return Response.json({ error: 'Укажи задачу.' }, { status: 400 });
  }

  try {
    const result = await runHealthAgent(task.trim());
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка.';
    console.error(`Ошибка прогона: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
