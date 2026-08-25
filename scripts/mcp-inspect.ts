// Что MCP-серверы прогона показывают наружу:
//
//   npm run mcp:inspect            состав каждого сервера: тулы и ресурсы
//   npm run mcp:inspect -- --read  то же плюс содержимое каждого ресурса
//
// Скрипт идёт по src/mcp/servers.config.ts и поднимает те же серверы, что и харнесс,
// тем же способом. Смысл — увидеть их глазами клиента: это ровно то, что получил бы любой
// MCP-клиент, а не только наш коуч.
//
// Подключение здесь сырое, без toolFilter из конфига, — и так задумано. Именно в разнице
// видно, где проходит граница: markdown-health отдаёт пять тулов, а коуч в прогоне видит
// четыре (append_daily_log ему не дают никогда, save_health_plan появляется только после
// одобрения); filesystem отдаёт четырнадцать, а коуч видит три. Держит эту разницу
// харнесс, и написана она в конфиге — здесь она печатается строкой «коучу достаётся».
//
// Тулы скрипт не зовёт никогда, а ресурсы читает только по флагу. Причина в побочных
// эффектах: среди тулов есть save_health_plan, append_daily_log и write_file, и
// «посмотреть сервер» не должно переписывать data/. Чтение ресурса побочных эффектов
// не имеет по определению, но за флагом оно стоит ради читаемости вывода — по умолчанию
// сюда смотрят, чтобы увидеть состав сервера, а не перечитать профиль.

import './env';
import { MCPServerStdio } from '@openai/agents';
import { MCP_SERVERS, type McpServerConfig } from '../src/mcp/servers.config';
import { MODULES, moduleByName } from '../src/os/modules';

const ROOT = process.cwd();

// Ресурсы у нас маленькие, но профиль на полторы тысячи символов в терминале — это уже
// простыня. Печатаем начало и говорим, сколько всего: этого хватает, чтобы убедиться,
// что ресурс отдаёт тот файл, который должен.
const PREVIEW_LINES = 4;

const args = process.argv.slice(2);
const readContents = args.includes('--read');

// Какой модуль OS примерить. Без флага печатается базовая политика — та, что видит
// прогон без специализации. С флагом видно, что модуль отнимает сверх неё.
//
// Это ЕДИНСТВЕННАЯ проверка списков tools в src/os/modules/: имена там строки, опечатка
// тихо отнимет у коуча тул, и не поймает её ни сборка, ни прогон — тул просто не появится
// в списке, а модель не пожалуется на отсутствие того, чего не видела.
const moduleFlag = args[args.indexOf('--module') + 1];
const selected = args.includes('--module') ? moduleByName(moduleFlag ?? '') : null;

if (args.includes('--module') && selected === null) {
  console.error(
    `Нет модуля «${moduleFlag ?? ''}». Есть: ${MODULES.map((m) => m.name).join(', ')}`,
  );
  process.exit(1);
}

// Описание тула — это текст на несколько строк, и в списке он не нужен целиком:
// смотрят сюда, чтобы увидеть состав сервера, а не перечитать промпты тулов.
// Точка считается концом предложения только с пробелом после: иначе «data/log.md»
// обрывается на «data/log.».
const SENTENCE_END = /\.(\s|$)/u;

const firstSentence = (text: string | undefined) => {
  if (!text) return '';
  const end = SENTENCE_END.exec(text);
  return end === null ? text : text.slice(0, end.index + 1);
};

/**
 * Содержимое одного ресурса. Ответ на resources/read — это массив частей, и часть бывает
 * текстовой или двоичной: у первой поле text, у второй blob с base64. Наши все текстовые,
 * но разбор идёт по протоколу, а не по нашему частному случаю — иначе добавленная картинка
 * уронила бы скрипт.
 *
 * Проверяем `typeof`, а не `'text' in part`: у обеих половин типа есть индексная сигнатура
 * `[key: string]: unknown`, поэтому проверка на наличие ключа их не различает — text
 * формально есть у обеих, просто типа unknown.
 */
async function printResource(mcp: MCPServerStdio, uri: string): Promise<void> {
  const { contents } = await mcp.readResource(uri);

  for (const part of contents) {
    const kind = part.mimeType ?? 'без mimeType';

    if (typeof part.text !== 'string') {
      const size = typeof part.blob === 'string' ? `${part.blob.length} символов base64` : 'пусто';
      console.log(`    └ ${kind}, ${size}`);
      continue;
    }

    const lines = part.text.split('\n');
    const shown = lines.slice(0, PREVIEW_LINES);
    console.log(`    └ ${kind}, ${part.text.length} символов:`);
    for (const line of shown) console.log(`      ${line}`);
    if (lines.length > shown.length) console.log(`      … ещё ${lines.length - shown.length} строк`);
  }
}

/**
 * Что из тулов сервера достанется коучу — по тем же полям конфига, из которых харнесс
 * строит toolFilter, и по списку выбранного модуля. Считается здесь заново, а не
 * импортируется: в прогоне это функция от живого гейта, а тут нужен статический ответ
 * «когда и при каких условиях».
 *
 * Порядок проверок повторяет buildToolFilter, и это обязательно: ветка записи стоит
 * первой, поэтому модуль не может отнять пишущий тул. Разойдётся порядок — скрипт начнёт
 * врать ровно про то, ради чего его смотрят.
 */
function access(config: McpServerConfig, name: string): string {
  if ((config.writeTools ?? []).includes(name)) return 'после approve';
  if (selected !== null && selected.tools !== null && !selected.tools.includes(name)) {
    return `нет (модуль ${selected.name})`;
  }
  if (config.tools === undefined || config.tools.includes(name)) return 'да';
  return 'нет';
}

/**
 * Достаётся ли тул коучу вообще. Отдельно от подписи намеренно: подпись бывает уточнённой
 * («нет (модуль recipes)»), и сравнивать её со строкой «нет» значит считать неверно —
 * ровно так шапка начинала противоречить строкам под собой.
 */
function reaches(config: McpServerConfig, name: string): boolean {
  return !access(config, name).startsWith('нет');
}

/** Ресурсы есть не у всякого сервера: у внешних их обычно нет вовсе. */
async function printResources(mcp: MCPServerStdio, name: string): Promise<void> {
  let resources;
  try {
    ({ resources } = await mcp.listResources());
  } catch {
    console.log('\n  Ресурсы: сервер их не поддерживает.');
    return;
  }

  console.log(`\n  Ресурсы (${resources.length}):`);
  for (const resource of resources) {
    console.log(`    ${resource.uri}`);
    console.log(`      ${resource.description ?? resource.title ?? ''}`);
    if (readContents) await printResource(mcp, String(resource.uri));
  }

  // Шаблоны — это ресурсы с параметром в URI (logs://day/{date}). У нашего таких нет,
  // и пустой список это подтверждает: адреса все фиксированные.
  const { resourceTemplates } = await mcp.listResourceTemplates();
  if (resourceTemplates.length > 0) {
    console.log(`\n  Шаблоны ресурсов (${resourceTemplates.length}):`);
    for (const template of resourceTemplates) console.log(`    ${template.uriTemplate}`);
  }

  if (name === 'markdown-health') {
    console.log('\n  Агенту ресурсы не достаются: Agents SDK делает тулы только из tools.');
  }
}

async function inspect(config: McpServerConfig): Promise<void> {
  const token = config.requiresEnv;
  const skipped = token !== undefined && !process.env[token];

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Сервер: ${config.name}${config.enabled ? '' : '  (enabled: false)'}`);
  console.log(`  запуск: ${config.command} ${config.args.join(' ')}`);

  if (skipped) {
    console.log(`  пропущен: нет ${token} в окружении. Это не ошибка — сервер просто не поднимается.`);
    return;
  }
  if (!config.enabled && token === undefined) {
    console.log('  пропущен: enabled: false.');
    return;
  }
  if (!config.enabled) console.log(`  включён автоматически: в окружении есть ${token}.`);

  const mcp = new MCPServerStdio({
    name: config.name,
    command: config.command,
    args: config.args,
    env: {
      ...config.env,
      ...(token === undefined ? {} : { [token]: String(process.env[token]) }),
    },
    cwd: ROOT,
    // Та же причина, что и в connectServers: внешние серверы едут через npx, и дефолтных
    // пяти секунд им не хватает.
    clientSessionTimeoutSeconds: 60,
    cacheToolsList: false,
  });

  await mcp.connect();

  try {
    const tools = await mcp.listTools();
    const reaching = tools.filter((tool) => reaches(config, tool.name)).length;

    console.log(`\n  Тулы (${tools.length}, коучу достаётся ${reaching}):`);
    for (const tool of tools) {
      const params = Object.keys(tool.inputSchema?.properties ?? {});
      console.log(`    ${tool.name}${params.length > 0 ? `({ ${params.join(', ')} })` : '()'}`);
      console.log(`      коучу: ${access(config, tool.name)}`);
      const description = firstSentence(tool.description);
      if (description) console.log(`      ${description}`);
    }

    await printResources(mcp, config.name);
  } finally {
    await mcp.close();
  }
}

if (selected !== null) {
  console.log(
    `\nМодуль: ${selected.name}` +
      (selected.tools === null
        ? ' — тулов не сужает, политика базовая.'
        : ` — сужает список до: ${selected.tools.join(', ')}.`),
  );
}

// Последовательно, а не Promise.all: вывод читают глазами, и перемешанные строки четырёх
// серверов читать нельзя. Здесь это не прогон, торопиться некуда.
for (const config of MCP_SERVERS) {
  try {
    await inspect(config);
  } catch (error) {
    // Один недоступный сервер не повод не показать остальные: внешние тянутся из сети,
    // и отсутствие интернета не должно прятать состав своего.
    console.log(`  не поднялся: ${String(error)}`);
  }
}

console.log(
  `\n${'─'.repeat(72)}\n` +
    'Серверы задаются в src/mcp/servers.config.ts — добавить новый значит дописать\n' +
    'туда запись. Харнесс правок не требует: он читает этот же список.\n\n' +
    'Тот же сервер в MCP Inspector:\n' +
    '  npx @modelcontextprotocol/inspector node node_modules/tsx/dist/cli.mjs src/mcp/markdownHealthServer.ts\n',
);
