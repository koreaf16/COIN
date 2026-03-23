'use client';

import { useEffect, useState, useRef } from 'react';

interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const url = filter === 'all' ? '/api/coin/logs?limit=150' : `/api/coin/logs?level=${filter}&limit=150`;
        const res = await fetch(url);
        if (res.ok) setLogs(await res.json());
      } catch {}
    };
    fetchLogs();
    const t = setInterval(fetchLogs, 3000);
    return () => clearInterval(t);
  }, [filter]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const levelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-error';
      case 'warn': return 'text-yellow-500';
      default: return 'text-surface-container-low';
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="font-headline font-bold text-2xl">시스템 로그</h1>
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-1 text-xs text-outline">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="rounded" />
            자동 스크롤
          </label>
          {['all', 'info', 'warn', 'error'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-[10px] font-label rounded transition-colors ${
                filter === f ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
              }`}>{f === 'all' ? '전체' : f.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* 로그 출력 */}
      <div ref={logRef} className="bg-inverse-surface text-inverse-on-surface p-4 rounded font-label text-xs leading-relaxed h-[calc(100vh-220px)] overflow-y-auto">
        {logs.length === 0 ? (
          <p className="opacity-50">로그 수집 중...</p>
        ) : logs.map((log, i) => (
          <div key={i} className={`${levelColor(log.level)} py-0.5 flex`}>
            <span className="text-outline opacity-50 w-20 shrink-0">
              {log.ts ? new Date(log.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) : ''}
            </span>
            <span className="w-12 shrink-0 opacity-70">
              {log.level === 'error' ? 'ERR' : log.level === 'warn' ? 'WRN' : 'INF'}
            </span>
            <span className="break-all">{log.msg}</span>
          </div>
        ))}
      </div>

      {/* 아키텍처 참조 */}
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
          <h3 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-4">5-Zone 아키텍처</h3>
          <div className="space-y-2 text-sm">
            {[
              { zone: 'Z0', name: '원시 데이터', desc: 'WebSocket, REST, 매크로, 뉴스' },
              { zone: 'Z1', name: '가공 데이터', desc: 'PL/SQL 트리거, 시장상태 벡터' },
              { zone: 'Z2', name: '지능', desc: 'LLM 스케줄러, 이벤트 모니터' },
              { zone: 'Z3', name: '실행', desc: '룰엔진, 지능형 청산' },
              { zone: 'Z4', name: '결과', desc: '거래 기록, 성과 추적' },
            ].map(z => (
              <div key={z.zone} className="flex items-center gap-3">
                <span className="px-2 py-1 bg-primary text-on-primary text-[10px] font-label font-bold rounded w-8 text-center">{z.zone}</span>
                <span className="font-medium">{z.name}</span>
                <span className="text-[10px] font-label text-outline">{z.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
          <h3 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-4">접속 정보</h3>
          <div className="space-y-2 text-sm">
            <p className="text-on-surface-variant">백엔드 API: <code className="font-label bg-surface-container-low px-1 rounded">localhost:2001</code></p>
            <p className="text-on-surface-variant">LLM 서버: <code className="font-label bg-surface-container-low px-1 rounded">localhost:2002</code></p>
            <p className="text-on-surface-variant">대시보드: <code className="font-label bg-surface-container-low px-1 rounded">localhost:2000</code></p>
            <p className="text-on-surface-variant">Oracle: <code className="font-label bg-surface-container-low px-1 rounded">192.168.0.120:1521/AI_DB</code></p>
          </div>
        </div>
      </div>
    </div>
  );
}
