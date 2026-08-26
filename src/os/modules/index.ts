// Реестр модулей OS. Единственный файл, который правят, добавляя модуль: роутер читает
// этот массив и собирает из имён с описаниями свой промпт, а харнесс берёт отсюда
// наслойку и список тулов.
//
// ИНВАРИАНТ, который модуль не отменяет ни при каких обстоятельствах: Safety Reviewer
// не параметризуется модулем. Ни createReviewer, ни buildReviewerInput, ни APPROVE_SCORE,
// ни enforceApproveThreshold не получают module ни в каком виде, и добавлять его туда
// нельзя. Модуль — это про то, КАК писался план; вердикт — про то, ГОДИТСЯ ли он.
// Триаж по той же причине стоит до коуча и видит только задачу.

import { dailyPlan } from './dailyPlan';
import { general } from './general';
import { habits } from './habits';
import { knowledge } from './knowledge';
import { nutrition } from './nutrition';
import { recipes } from './recipes';
import { recovery } from './recovery';
import { shoppingList } from './shoppingList';
import { training } from './training';
import type { Module } from './types';

export type { Module } from './types';

/** Модуль по умолчанию: текущее поведение без специализации. */
export const GENERAL: Module = general;

/**
 * Все модули, включая general. Порядок — порядок в промпте роутера, и general стоит
 * первым намеренно: список читается сверху вниз, а «ни одно из перечисленного»
 * полезнее знать до того, как выбираешь из перечисленного.
 */
export const MODULES: Module[] = [
  general,
  dailyPlan,
  nutrition,
  recipes,
  training,
  recovery,
  habits,
  shoppingList,
  knowledge,
];

/** Модуль по имени. null — такого имени нет: разбирающая сторона обязана свести это к general. */
export function moduleByName(name: string): Module | null {
  return MODULES.find((module) => module.name === name) ?? null;
}
