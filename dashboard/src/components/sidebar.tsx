'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const menuItems = [
  { icon: 'dashboard', label: '대시보드', href: '/' },
  { icon: 'analytics', label: '시장 분석', href: '/market-analysis' },
  { icon: 'psychology', label: '시나리오 설정', href: '/scenario-setting' },
  { icon: 'history', label: '백테스팅', href: '/backtesting' },
  { icon: 'stream', label: '실시간 데이터', href: '/realtime' },
];

const bottomItems = [
  { icon: 'smart_toy', label: 'LLM 테스트', href: '/llm-test' },
  { icon: 'settings', label: '설정', href: '/settings' },
  { icon: 'terminal', label: '로그', href: '/support' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="bg-surface-container-low border-r border-surface-container-high/50 h-screen w-56 fixed left-0 top-0 flex flex-col pt-20 pb-6 px-3 z-40">
      <div className="mb-6 px-2">
        <h2 className="text-on-surface font-bold tracking-normal text-sm font-headline">터미널</h2>
        <p className="text-[10px] text-outline font-label opacity-70">v2 — 5-Zone</p>
      </div>

      <nav className="flex flex-col gap-0.5">
        {menuItems.map((item) => {
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-white text-on-surface shadow-sm ring-1 ring-surface-container-high'
                  : 'text-on-surface-variant hover:text-on-surface hover:translate-x-0.5'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto">
        {/* 신규 거래 버튼 */}
        <button className="w-full mb-4 py-2.5 bg-primary text-on-primary rounded-lg text-xs font-bold flex items-center justify-center gap-2 hover:bg-primary-dim transition-colors">
          <span className="material-symbols-outlined text-[16px]">add</span>
          신규 거래
        </button>

        <div className="flex flex-col gap-0.5 border-t border-surface-container-high/50 pt-3">
          {bottomItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium text-on-surface-variant hover:text-on-surface hover:translate-x-0.5 transition-all duration-200"
            >
              <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </aside>
  );
}
