import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Onest } from 'next/font/google';
import './globals.css';

// Две гарнитуры на две роли, обе с кириллицей: Onest — весь текст, от заголовка
// вердикта до подписи, JetBrains Mono — машинные данные (утилита .mono).
// Отдельной «вывесочной» гарнитуры нет намеренно: интерфейс держится системной
// эстетики Apple, где иерархию задают кегль, вес и разрядка, а не третий шрифт.
// Первым в стеке стоит -apple-system, поэтому на macOS и iOS страница набрана SF;
// Onest — тот же нейтральный гротеск для всех остальных.
const body = Onest({ subsets: ['cyrillic', 'latin'], variable: '--font-body' });
const mono = JetBrains_Mono({ subsets: ['cyrillic', 'latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Wellness-агент',
  description: 'Коуч пишет план, ревьюер проверяет его на безопасность',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#e7ebf3' },
    { media: '(prefers-color-scheme: dark)', color: '#070a12' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
