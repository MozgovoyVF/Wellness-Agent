// Обновление памяти после одобренного прогона. Две записи, обе от харнесса и обе
// через MCP: connectMcpServer('markdown-health') → callTool → close.
//
// Модели в этом пути нет вовсе — та же идиома, что у src/mcp/notionPage.ts: решать нечего,
// план уже написан и одобрен, надо исполнить. Тулы append_daily_log и update_preferences
// коучу не даются никогда, и здесь видно зачем: писать в долгую память — работа того,
// кто владеет прогоном, а не того, кто пишет план.
//
// Почему не внутри runHealthAgent, где сервер уже поднят: контракт прогона — «задача →
// план и вердикт». Запись памяти OS-уровня к нему не относится, и добавь мы её туда,
// replay и любой прямой вызов харнесса начали бы менять data/ вторым способом. Цена —
// повторный запуск локального процесса tsx, около секунды, и только при approve.

import { connectMcpServer } from '../mcp/connectServers';
import { MCP_TOOLS } from '../mcp/toolNames';
import { logDayHeading } from '../skills';

// Сколько символов задачи попадает в дневник. Запись читают глазами, и запрос на три
// абзаца сделал бы её нечитаемой.
const TASK_EXCERPT = 120;

// Столько же для предпочтения — но больше: это фраза, которую человек просил запомнить,
// и обрезать её по половине смысла хуже, чем занять строку подлиннее.
const PREFERENCE_EXCERPT = 300;

/**
 * Текст из ответа MCP-тула. Части бывают и двоичными — берём только текстовые.
 *
 * callTool() у MCPServerStdio отдаёт content-массив НАПРЯМУЮ, а не { content: [...] }:
 * SDK сам разворачивает CallToolResult до .content ещё внутри себя (см.
 * node_modules/@openai/agents-core/dist/mcp.mjs, класс MCPServerStdio.callTool).
 * Тем же способом читает ответ src/mcp/notionPage.ts — тот же сервер, тот же клиент.
 */
function textOf(result: unknown): string {
  const parts = Array.isArray(result) ? (result as { type: string; text?: string }[]) : [];
  return parts.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/** Заголовок плана — первая строка «# ». Плана без него не бывает: формат требует. */
function planTitle(plan: string): string {
  const line = plan.split('\n').find((candidate) => candidate.startsWith('# '));
  return line === undefined ? 'без заголовка' : line.slice(2).trim();
}

const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export type MemoryUpdate = {
  task: string;
  module: string;
  plan: string;
  score: number;
  /** Фраза от preferenceSignal или null, если человек ничего запоминать не просил. */
  preference: string | null;
};

/**
 * Дописывает след прогона в дневник и, если был явный сигнал, — в предпочтения.
 *
 * Не бросает никогда: план уже составлен, проверен и отдан человеку, и терять его
 * из-за недоступного сервера памяти нельзя. Та же логика, что у traceRun и у отказа
 * базы знаний — сбой служебной записи не сбой работы.
 */
export async function updateMemory(update: MemoryUpdate): Promise<void> {
  let connection: Awaited<ReturnType<typeof connectMcpServer>> = null;

  try {
    // Подъём сервера стоит ВНУТРИ try намеренно. connectMcpServer возвращает null только
    // когда сервер не положено запускать, а у markdown-health нет requiresEnv — значит
    // реалистичный отказ здесь не null, а бросок при спавне процесса или рукопожатии.
    // Снаружи try он улетел бы из runOS и уронил прогон, план которого уже одобрен.
    connection = await connectMcpServer('markdown-health');
    if (connection === null) {
      console.log('Память не обновлена: сервер markdown-health не поднялся.');
      return;
    }

    const heading = logDayHeading();

    // Смотрим, начат ли сегодняшний день. За день человек делает несколько прогонов,
    // и вторая запись со своим заголовком расколола бы один день надвое: getRecentLog
    // режет файл по «## » и вернул бы три блока вместо трёх дней.
    const recent = await connection.server.callTool(MCP_TOOLS.readRecentLogs, { days: 1 });
    const dayStarted = textOf(recent).includes(heading);

    // Подзаголовок обязателен и он не украшение: дневник — доказательная база ревьюера,
    // и без явной пометки следующий прогон прочитает намерение как факт. Промпт
    // safetyReviewer.v9 это различие называет вслух.
    const note =
      `### Предложено агентом · ${update.module}\n` +
      `- Запрос: «${excerpt(update.task, TASK_EXCERPT)}»\n` +
      `- План: «${planTitle(update.plan)}» · score ${update.score}/10`;

    await connection.server.callTool(MCP_TOOLS.appendDailyLog, {
      entry: dayStarted ? note : `${heading}\n\n${note}`,
    });
    console.log(`Память: запись о прогоне добавлена в data/log.md (модуль ${update.module}).`);

    if (update.preference !== null) {
      const today = new Date().toISOString().slice(0, 10);
      await connection.server.callTool(MCP_TOOLS.updatePreferences, {
        entry: `- ${today} · ${update.module} — «${excerpt(update.preference, PREFERENCE_EXCERPT)}»`,
      });
      console.log('Память: предпочтение записано в data/preferences.md.');
    }
  } catch (error) {
    console.log(`Память обновить не удалось (прогон это не отменяет): ${String(error)}`);
  } finally {
    // Закрытие тоже умеет бросать, а бросок из finally перекрыл бы catch выше и всё-таки
    // уронил бы прогон — поэтому у него свой guard.
    if (connection !== null) {
      try {
        await connection.close();
      } catch (error) {
        console.log(`Сервер памяти не закрылся: ${String(error)}`);
      }
    }
  }
}
