import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = {
  title: 'Equity Sovereign | Terminal',
  description: 'LLM + Oracle Trading System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Inter:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-surface font-body text-on-surface">
        <TopNav />
        <Sidebar />
        <main className="ml-56 pt-14 min-h-screen">{children}</main>
      </body>
    </html>
  );
}
