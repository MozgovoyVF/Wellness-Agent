// Клиент модели на весь процесс. Вынесен из runHealthAgent, потому что настроить его
// нужно раньше первого захода в модель, а первым теперь ходит не коуч и не триаж,
// а роутер намерения (src/os/router.ts) — он стоит до прогона.
//
// DeepSeek OpenAI-совместим, поэтому SDK хватает подменённого клиента: другой baseURL,
// принудительно chat_completions (Responses API у DeepSeek нет) и выключенный трейсинг —
// он шлёт данные в OpenAI.
//
// Настройка ленивая и однократная: на сервере отсутствие ключа должно быть ошибкой
// запроса, а не падением процесса при загрузке модуля.

import OpenAI from 'openai';
import { setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents';

let configured = false;

export function configureClient(): void {
  if (configured) return;

  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('Не найден DEEPSEEK_API_KEY. Добавь его в .env в корне проекта.');
  }

  setDefaultOpenAIClient(
    new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY }),
  );
  setOpenAIAPI('chat_completions');
  setTracingDisabled(true);

  configured = true;
}
