// Единственная точка доступа навыков к data/. Вынесена отдельно, потому что читают
// три навыка, а пишут два: пусть путь и кодировка объявлены один раз.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// cwd, а не import.meta.url: после сборки этот модуль лежит внутри .next/,
// и путь от файла указал бы не туда.
const DATA_DIR = join(process.cwd(), 'data');

export function readData(name: string): string {
  return readFileSync(join(DATA_DIR, name), 'utf8');
}

export function writeData(name: string, text: string): void {
  writeFileSync(join(DATA_DIR, name), text);
}
