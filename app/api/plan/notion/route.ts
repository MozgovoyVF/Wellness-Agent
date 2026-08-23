import { NotionError, saveToNotion } from '@/src/mcp/notionPage';
import { planMatchesDisk } from '@/src/skills';

// Поднимается MCP-сервер (отдельный процесс) — нужен nodejs-рантайм, не edge.
export const runtime = 'nodejs';

/**
 * Сохранить уже готовый план в Notion. Роут для кнопки под планом, а не для агента:
 * прогон свою страницу создаёт сам, в закрепляющем заходе, если человек просил об этом
 * в задаче. Кнопка — второй путь, для случая «попросить забыл, а сохранить хочется».
 *
 * **Что здесь вместо гейта.** Гейт живёт ровно столько, сколько прогон, и к моменту
 * нажатия его давно нет. Роль «план одобрен» играет сверка с data/output.md: файл
 * пишется только после approve и только тем планом, что уехал наружу, поэтому совпадение
 * с ним и есть доказательство одобрения. Без такой проверки роут превратился бы в дырку
 * в воротах — «отправь в Notion любой текст», — и весь гейт стал бы декоративным.
 * Сверка по тексту, а не по флагу от клиента: браузеру здесь верить нечему.
 */
export async function POST(request: Request) {
  let plan: unknown;
  try {
    ({ plan } = await request.json());
  } catch {
    return Response.json({ error: 'Тело запроса не является валидным JSON.' }, { status: 400 });
  }

  if (typeof plan !== 'string' || !plan.trim()) {
    return Response.json({ error: 'Нечего сохранять: план пуст.' }, { status: 400 });
  }

  if (!planMatchesDisk(plan)) {
    return Response.json(
      {
        error:
          'В Notion уезжает только одобренный план. Этот не совпадает с data/output.md — ' +
          'значит, ревьюер его не одобрил или прогон с тех пор сменился.',
      },
      { status: 409 },
    );
  }

  try {
    return Response.json(await saveToNotion(plan));
  } catch (error) {
    // NotionError — это «не настроено» или «не найдено»: чинится руками в Notion за минуту,
    // и человеку надо показать текст, а не пятисотку. Всё остальное — настоящая поломка.
    if (error instanceof NotionError) {
      console.error(`Notion: ${error.message}`);
      return Response.json({ error: error.message }, { status: 422 });
    }

    const message = error instanceof Error ? error.message : 'Неизвестная ошибка.';
    console.error(`Ошибка сохранения в Notion: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
