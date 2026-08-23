// Клиентская сторона MCP: как харнесс поднимает серверы из реестра и что из них достаётся
// коучу. Сервер — отдельный процесс, поэтому «подключить» его означает запустить команду
// и говорить с ней по stdio; закрыть — убить процесс. И то и другое делает харнесс,
// на каждый прогон (см. src/harness/runHealthAgent.ts).
//
// Модуль ничего не знает про конкретные серверы: он читает src/mcp/servers.config.ts
// и исполняет то, что там написано. Поэтому добавление сервера — правка конфига, а не кода.

import { MCPServerStdio } from '@openai/agents';
import type { Gate } from '../skills/gate';
import { MCP_SERVERS, type McpServerConfig } from './servers.config';

// cwd явно передаётся дочернему процессу: иначе data/ он будет искать не там.
const ROOT = process.cwd();

// Сколько ждать ответа сервера. Дефолтных пяти секунд хватало своему серверу, но внешние
// поднимаются через `npx -y`: он на каждый запуск проверяет пакет, а в первый раз ещё
// и качает его из сети. Пять секунд там кончаются раньше, чем сервер успевает сказать
// «готов», и прогон падал бы на таймауте при полностью исправном сервере.
const SESSION_TIMEOUT_SECONDS = 60;

/** Источник тула, которого нет ни у одного сервера, — значит, он локальный. */
export const LOCAL_SOURCE = 'local';

export type ConnectedMcp = {
  /** Что уезжает агенту. Порядок — как в конфиге. */
  servers: MCPServerStdio[];
  /** Имя тула → имя сервера. Локальные тулы сюда не попадают, см. sourceOf. */
  toolSources: Record<string, string>;
  /** Гасит все процессы. Ошибка одного не мешает погасить остальные. */
  close: () => Promise<void>;
};

/**
 * Запускать ли этот сервер. Правил два, и они независимы:
 *
 * - объявлен requiresEnv, а переменной нет — сервер пропускается всегда, даже если
 *   enabled. Поднимать Notion без токена незачем: он всё равно ничего не сможет;
 * - переменная есть — сервер поднимается, даже если enabled: false. Это и значит
 *   «включается автоматически при наличии токена»: флаг в конфиге говорит про намерение,
 *   а наличие ключа — про возможность, и возможность здесь сильнее.
 *
 * Пропуск молчаливый и ошибкой не является: выключенный сервер — это нормальное
 * состояние конфига, а не поломка.
 */
function shouldStart(config: McpServerConfig): boolean {
  if (config.requiresEnv === undefined) return config.enabled;
  return Boolean(process.env[config.requiresEnv]);
}

/**
 * Окружение дочернего процесса. Транспорт подмешивает это к своему набору (HOME, PATH,
 * SHELL, TERM, USER), а не заменяет его, — поэтому PATH здесь не нужен и npx найдётся.
 * Но и наш .env целиком дочернему процессу не достаётся: токен надо передать явно,
 * и читается он здесь, в момент подключения, а не при загрузке модуля конфига.
 */
function childEnv(config: McpServerConfig): Record<string, string> | undefined {
  const token =
    config.requiresEnv === undefined
      ? undefined
      : { [config.requiresEnv]: String(process.env[config.requiresEnv]) };

  if (config.env === undefined && token === undefined) return undefined;
  return { ...config.env, ...token };
}

/**
 * Фильтр тулов одного сервера, собранный из конфига. Здесь исполняется вся политика
 * доступа, и она вся приезжает данными, а не кодом.
 *
 * Почему фильтр, а не проверка внутри тула. Локальному навыку хватает замыкания: он
 * спрашивает gate.isUnlocked() в своём execute и возвращает отказ. MCP-тул исполняется
 * в чужом процессе, куда замыкание не дотянется, и единственная точка перехвата на нашей
 * стороне — toolFilter: он решает, попадёт ли тул в список, который увидит модель.
 * Получается строже отказа — позвать то, чего в списке нет, модель не может, — а политика
 * при этом остаётся у нас: сервер по-прежнему не знает, одобрен ли план, и записал бы,
 * если бы его позвали.
 */
function buildToolFilter(config: McpServerConfig, gate: Gate) {
  const writeTools = config.writeTools ?? [];

  return async (_context: unknown, tool: { name: string }): Promise<boolean> => {
    // Тулы записи разрешены дополнительно к tools, но только после approve. Проверка
    // стоит первой, поэтому write-тул не обязан дублироваться в tools — он назван один раз.
    if (writeTools.includes(tool.name)) return gate.isUnlocked();
    // Нет allowlist — сервер отдаёт всё, что у него есть.
    if (config.tools === undefined) return true;
    return config.tools.includes(tool.name);
  };
}

/**
 * Как из записи конфига получается живой процесс. Вынесено отдельно, потому что серверы
 * поднимает не только прогон: кнопка «сохранить в Notion» поднимает один сервер и говорит
 * с ним напрямую (src/mcp/notionPage.ts). Знание о том, чем запускается сервер и сколько
 * ждать ответа, должно лежать в одном месте, иначе второй способ подъёма разъедется
 * с первым молча — например, останется с дефолтным пятисекундным таймаутом.
 */
function buildServer(config: McpServerConfig, gate: Gate | null): MCPServerStdio {
  const gated = (config.writeTools ?? []).length > 0;

  return new MCPServerStdio({
    name: config.name,
    command: config.command,
    args: config.args,
    env: childEnv(config),
    cwd: ROOT,
    clientSessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
    // Кэшировать список нельзя там, где он меняется по ходу прогона: раннер кэширует
    // уже отфильтрованный список, и снятый с закрытым гейтом кэш пережил бы unlock —
    // тул записи так и не появился бы. Где тулов записи нет, список неизменен, и кэш
    // экономит по обращению к серверу на каждый заход агента.
    cacheToolsList: !gated,
    // Гейта нет — значит, сервер поднят не для агента, и фильтровать нечего: toolFilter
    // решает только то, что увидит модель в списке тулов, а прямой callTool идёт мимо него.
    ...(gate === null ? {} : { toolFilter: buildToolFilter(config, gate) }),
  });
}

/**
 * Поднимает один сервер по имени — для тех, кто не ведёт прогон и агента не запускает.
 * Возвращает null, если сервера нет в конфиге или его не положено запускать: у notion
 * это ровно случай «нет NOTION_TOKEN», и это не ошибка, а нормальное состояние.
 *
 * Гейт сюда не передаётся, и это не дыра: гейт — политика прогона, он отвечает на вопрос
 * «одобрил ли ревьюер план, который сейчас пишет агент». У вызова снаружи прогона такого
 * вопроса нет, а свою проверку на одобрение он обязан иметь собственную (у роута Notion
 * это сверка с data/output.md).
 */
export async function connectMcpServer(
  name: string,
): Promise<{ server: MCPServerStdio; close: () => Promise<void> } | null> {
  const config = MCP_SERVERS.find((candidate) => candidate.name === name);
  if (config === undefined || !shouldStart(config)) return null;

  const server = buildServer(config, null);
  await server.connect();

  return {
    server,
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Поднимает все включённые серверы и возвращает их вместе с картой «тул → сервер».
 *
 * Серверы коннектятся параллельно: это независимые процессы, и ждать их по очереди
 * значит сложить задержки запуска. Карта источников строится из listTools() каждого
 * сервера — то есть из того, что сервер реально отдал, а не из таблицы в коде. Поэтому
 * новый сервер получает свой префикс в трейсе сам, без правок здесь.
 *
 * listTools() отдаёт полный список сервера, без toolFilter: фильтр SDK применяет позже,
 * на стороне раннера. Для карты это то, что нужно, — save_health_plan попадёт в неё,
 * хотя в момент подключения гейт ещё закрыт и коучу этот тул не виден.
 */
export async function connectMcpServers(gate: Gate): Promise<ConnectedMcp> {
  const configs = MCP_SERVERS.filter(shouldStart);

  const servers = configs.map((config) => buildServer(config, gate));

  await Promise.all(servers.map((server) => server.connect()));

  const toolSources: Record<string, string> = {};
  const listings = await Promise.all(servers.map((server) => server.listTools()));

  listings.forEach((tools, index) => {
    for (const tool of tools) toolSources[tool.name] = configs[index].name;
  });

  console.log(
    `MCP-серверы (${servers.length}): ${configs.map((c) => c.name).join(', ') || 'нет'}`,
  );

  return {
    servers,
    toolSources,
    // Гасим все, а не до первой ошибки: упавший close одного сервера не повод оставить
    // висеть остальные процессы.
    close: async () => {
      await Promise.allSettled(servers.map((server) => server.close()));
    },
  };
}

/** Источник тула для трейса и UI. Ничей тул — значит, наш локальный. */
export function sourceOf(toolSources: Record<string, string>, tool: string): string {
  return toolSources[tool] ?? LOCAL_SOURCE;
}
