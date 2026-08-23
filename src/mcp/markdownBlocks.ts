// Markdown плана → блоки Notion. Парсер намеренно урезан под известный формат коуча —
// ровно тот же набор, что разбирает app/plan-markdown.tsx: заголовки «#» и «##», списки
// маркерами и цифрами с вложенностью на один уровень, **выделение** и абзацы. Полноценный
// markdown сюда тянуть незачем: коуч пишет по форме, заданной его же промптом.
//
// Это второй разбор того же текста, и это не дублирование: там из плана получается JSX
// для страницы, здесь — JSON-блоки для чужого API. Общее у них только знание формата,
// а оно живёт в промпте коуча. Меняется форма плана — чинить придётся оба.

/** Отрезок текста с разметкой. Notion принимает только такой вид, простую строку — нет. */
type RichText = {
  type: 'text';
  text: { content: string };
  annotations?: { bold: boolean };
};

type BlockType =
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'paragraph';

export type NotionBlock = {
  object: 'block';
  type: BlockType;
  [key: string]: unknown;
};

// Пределы API Notion, и оба жёсткие: длинный rich_text отвергается целиком, лишние блоки
// сверх сотни — тоже. План короче обоих порогов, но полагаться на это нельзя: упереться
// в предел должен урезанный текст, а не отказ всей страницы.
const MAX_TEXT_LENGTH = 2000;
const MAX_BLOCKS = 100;

const BULLET = /^[-*]\s+/;
const NUMBER = /^\d+[.)]\s+/;

/** Режет отрезок на куски, которые Notion примет. Возвращает пустой массив для пустого текста. */
function chunk(content: string, bold: boolean): RichText[] {
  const parts: RichText[] = [];

  for (let at = 0; at < content.length; at += MAX_TEXT_LENGTH) {
    parts.push({
      type: 'text',
      text: { content: content.slice(at, at + MAX_TEXT_LENGTH) },
      ...(bold ? { annotations: { bold: true } } : {}),
    });
  }

  return parts;
}

/** Строка с `**выделением**` → массив отрезков. Разбор тот же, что в plan-markdown.tsx. */
function richText(text: string): RichText[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .flatMap((part) =>
      part.startsWith('**') && part.endsWith('**')
        ? chunk(part.slice(2, -2), true)
        : chunk(part, false),
    );
}

function block(type: BlockType, text: string, children?: NotionBlock[]): NotionBlock {
  return {
    object: 'block',
    type,
    [type]: {
      rich_text: richText(text),
      // Вложенные пункты уезжают вместе с родителем: отдельным запросом их пришлось бы
      // дописывать после создания страницы, а список из двух вызовов рвётся посередине.
      ...(children === undefined || children.length === 0 ? {} : { children }),
    },
  };
}

/**
 * Разбирает план в блоки. Хвост сверх предела не молчит: вместо него встаёт последняя
 * строка с отсылкой к data/output.md — там план всегда лежит целиком.
 */
export function toNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');

  let paragraph: string[] = [];

  // Последний пункт списка держим отдельно: вложенные строки дописываются в него, и до
  // конца пункта неизвестно, будут они или нет.
  let item: { type: BlockType; text: string; children: string[] } | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push(block('paragraph', paragraph.join(' ')));
    paragraph = [];
  }

  function flushItem() {
    if (item === null) return;
    blocks.push(block(item.type, item.text, item.children.map((child) => block('bulleted_list_item', child))));
    item = null;
  }

  function flush() {
    flushParagraph();
    flushItem();
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const nested = /^\s{2,}([-*]|\d+[.)])\s+/.test(line);
    const isNumber = NUMBER.test(trimmed);
    const bullet = BULLET.test(trimmed) || isNumber;

    if (!trimmed) {
      flush();
    } else if (line.startsWith('## ')) {
      flush();
      // heading_2, а не heading_1: заголовок страницы в Notion — это её название,
      // и «##» коуча по смыслу стоит на ступеньку ниже него.
      blocks.push(block('heading_2', line.slice(3).trim()));
    } else if (line.startsWith('# ')) {
      flush();
      blocks.push(block('heading_1', line.slice(2).trim()));
    } else if (nested && item !== null) {
      item.children.push(trimmed.replace(BULLET, '').replace(NUMBER, ''));
    } else if (bullet) {
      flush();
      item = {
        type: isNumber ? 'numbered_list_item' : 'bulleted_list_item',
        text: trimmed.replace(BULLET, '').replace(NUMBER, ''),
        children: [],
      };
    } else if (item !== null) {
      // Продолжение пункта, перенесённое на новую строку.
      if (item.children.length > 0) item.children[item.children.length - 1] += ` ${trimmed}`;
      else item.text += ` ${trimmed}`;
    } else {
      paragraph.push(trimmed);
    }
  }

  flush();

  if (blocks.length <= MAX_BLOCKS) return blocks;
  return [
    ...blocks.slice(0, MAX_BLOCKS - 1),
    block('paragraph', 'План длиннее, чем помещается на страницу. Целиком он в data/output.md.'),
  ];
}
