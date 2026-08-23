// Коуч отдаёт markdown фиксированной формы: заголовок, три раздела «##»,
// списки с вложенностью на один уровень и **выделение**. Здесь ровно этот
// набор и разбирается — полноценный парсер сюда тянуть незачем.

import type { ReactNode } from 'react';

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <b key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</b>
    ) : (
      part
    ),
  );
}

type Item = { text: string; children: string[] };

function List({ items, id, ordered }: { items: Item[]; id: string; ordered: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={`paper__list${ordered ? ' paper__list--num' : ''}`}>
      {items.map((item, index) => (
        <li className="paper__item" key={`${id}-${index}`}>
          {inline(item.text, `${id}-${index}`)}
          {item.children.length > 0 && (
            <ul className="paper__sub">
              {item.children.map((child, childIndex) => (
                <li className="paper__item" key={`${id}-${index}-${childIndex}`}>
                  {inline(child, `${id}-${index}-${childIndex}`)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </Tag>
  );
}

const BULLET = /^[-*]\s+/;
const NUMBER = /^\d+[.)]\s+/;

export function renderPlan(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');

  let list: Item[] = [];
  let ordered = false;
  let paragraph: string[] = [];

  function flush(key: string) {
    if (paragraph.length > 0) {
      blocks.push(
        <p className="paper__p" key={`p-${key}`}>
          {inline(paragraph.join(' '), `p-${key}`)}
        </p>,
      );
      paragraph = [];
    }
    if (list.length > 0) {
      blocks.push(<List items={list} ordered={ordered} id={`l-${key}`} key={`l-${key}`} />);
      list = [];
    }
  }

  lines.forEach((line, index) => {
    const key = String(index);
    const trimmed = line.trim();
    const nested = /^\s{2,}([-*]|\d+[.)])\s+/.test(line);
    const isNumber = NUMBER.test(trimmed);
    const bullet = BULLET.test(trimmed) || isNumber;

    if (!trimmed) {
      flush(key);
    } else if (line.startsWith('## ')) {
      flush(key);
      blocks.push(
        <h3 className="paper__h2" key={`h2-${key}`}>
          <span>{line.slice(3).trim()}</span>
        </h3>,
      );
    } else if (line.startsWith('# ')) {
      flush(key);
      blocks.push(
        <h2 className="paper__h1" key={`h1-${key}`}>
          {inline(line.slice(2).trim(), `h1-${key}`)}
        </h2>,
      );
    } else if (nested && list.length > 0) {
      list[list.length - 1].children.push(trimmed.replace(BULLET, '').replace(NUMBER, ''));
    } else if (bullet) {
      // смена вида списка закрывает предыдущий: нумерованные шаги и простые
      // пункты у коуча значат разное
      if (paragraph.length > 0 || (list.length > 0 && ordered !== isNumber)) flush(key);
      ordered = isNumber;
      list.push({ text: trimmed.replace(BULLET, '').replace(NUMBER, ''), children: [] });
    } else if (list.length > 0) {
      // продолжение последнего пункта, перенесённое на новую строку
      const last = list[list.length - 1];
      if (last.children.length > 0) last.children[last.children.length - 1] += ` ${trimmed}`;
      else last.text += ` ${trimmed}`;
    } else {
      paragraph.push(trimmed);
    }
  });

  flush('end');
  return blocks;
}
