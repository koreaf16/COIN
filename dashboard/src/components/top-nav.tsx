'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const tabs = [
  { label: '터미널', href: '/' },
  { label: '포트폴리오', href: '/positions' },
  { label: '어드바이저리', href: '/market-analysis' },
];

function formatDualTime() {
  const now = new Date();
  const etOpts: Intl.DateTimeFormatOptions = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const kstOpts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false };
  const et = now.toLocaleTimeString('en-US', etOpts);
  const kst = now.toLocaleTimeString('en-US', kstOpts);
  return { et, kst };
}

export function TopNav() {
  const pathname = usePathname();
  const [time, setTime] = useState({ et: '--:--:--', kst: '--:--' });

  useEffect(() => {
    setTime(formatDualTime());
    const timer = setInterval(() => setTime(formatDualTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="bg-white border-b border-surface-container-high/50 flex justify-between items-center h-14 px-6 w-full fixed top-0 z-50">
      <div className="flex items-center gap-8">
        <span className="text-lg font-extrabold tracking-tighter text-on-surface uppercase font-headline">
          Equity Sovereign
        </span>
        <div className="hidden md:flex items-center bg-surface-container-low px-3 py-1.5 rounded-lg gap-2">
          <span className="material-symbols-outlined text-sm opacity-50">search</span>
          <input
            className="bg-transparent border-none focus:ring-0 focus:outline-none text-xs w-56 placeholder:text-outline p-0 font-label"
            placeholder="심볼, 뉴스, 로직 검색..."
            type="text"
          />
        </div>
      </div>
      <nav className="flex items-center gap-6">
        <div className="flex items-center gap-4 border-r border-outline-variant/20 pr-6 mr-2">
          {tabs.map((tab) => {
            const isActive =
              tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`font-semibold h-14 flex items-center px-1 text-sm transition-colors ${
                  isActive
                    ? 'text-on-surface border-b-2 border-on-surface'
                    : 'text-outline hover:text-on-surface-variant'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        {/* 시계: ET (KST) */}
        <div className="font-label text-xs text-on-surface-variant border-r border-outline-variant/20 pr-4 mr-1">
          <span className="font-bold text-on-surface">{time.et}</span>
          <span className="text-outline ml-1">ET</span>
          <span className="text-outline mx-1">|</span>
          <span className="text-on-surface-variant">{time.kst}</span>
          <span className="text-outline ml-1">KST</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined cursor-pointer hover:bg-surface-container-low p-1.5 rounded-md text-on-surface-variant">
            notifications
          </span>
          <span className="material-symbols-outlined cursor-pointer hover:bg-surface-container-low p-1.5 rounded-md text-on-surface-variant">
            settings
          </span>
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary text-xs font-bold">
            ES
          </div>
        </div>
      </nav>
    </header>
  );
}
