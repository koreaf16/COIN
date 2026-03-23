'use client';

import { useEffect, useState } from 'react';

interface Setting {
  key: string;
  value: string;
  description: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [status, setStatus] = useState<any>({});
  const [llmStatus, setLlmStatus] = useState<any>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    fetchSettings();
    fetchStatus();
    fetchLlmStatus();
    const t = setInterval(() => { fetchStatus(); fetchLlmStatus(); }, 10000);
    return () => clearInterval(t);
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/coin/settings');
      if (res.ok) setSettings(await res.json());
    } catch {}
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/coin/system-status');
      if (res.ok) setStatus(await res.json());
    } catch {}
  };

  const fetchLlmStatus = async () => {
    try {
      const res = await fetch('/api/coin/llm-status');
      if (res.ok) {
        const data = await res.json();
        setLlmStatus(data);
      } else {
        setLlmStatus({ error: 'unreachable' });
      }
    } catch {
      setLlmStatus({ error: 'unreachable' });
    }
  };

  const saveSetting = async (key: string) => {
    try {
      await fetch(`/api/coin/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue }),
      });
      setEditKey(null);
      fetchSettings();
    } catch {}
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="font-headline font-bold text-2xl">설정</h1>

      <div className="grid grid-cols-2 gap-6">
        {/* 트레이딩 설정 (편집 가능) */}
        <div className="bg-surface-container-lowest p-6 rounded shadow-sm">
          <h3 className="font-headline font-bold text-sm border-b border-surface-container-high/30 pb-3 mb-4">트레이딩 설정</h3>
          <div className="space-y-3">
            {settings.map(s => (
              <div key={s.key} className="flex items-center justify-between">
                <div className="flex-1">
                  <span className="text-sm font-medium block">{s.key}</span>
                  <span className="text-[10px] font-label text-outline">{s.description}</span>
                </div>
                {editKey === s.key ? (
                  <div className="flex items-center gap-2">
                    <input value={editValue} onChange={e => setEditValue(e.target.value)}
                      className="w-20 bg-white border border-primary rounded px-2 py-1 text-sm font-label text-center" autoFocus />
                    <button onClick={() => saveSetting(s.key)} className="text-[10px] font-label text-success font-bold hover:underline">저장</button>
                    <button onClick={() => setEditKey(null)} className="text-[10px] font-label text-outline hover:underline">취소</button>
                  </div>
                ) : (
                  <button onClick={() => { setEditKey(s.key); setEditValue(s.value); }}
                    className="font-label text-sm font-bold text-primary hover:underline cursor-pointer">{s.value}</button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 시스템 상태 (실시간) */}
        <div className="bg-surface-container-lowest p-6 rounded shadow-sm">
          <h3 className="font-headline font-bold text-sm border-b border-surface-container-high/30 pb-3 mb-4">시스템 상태</h3>
          <div className="space-y-3">
            <StatusRow label="Oracle DB" value={status.oracleDb || '--'} ok={status.oracleDb === 'connected'} />
            <StatusRow label="Binance WS" value={status.binanceWs || '--'} ok={status.binanceWs === 'connected'} />
            <StatusRow label="LLM 서버" value={
              !llmStatus ? '--' :
              llmStatus.error ? '연결 안됨' : '연결됨'
            } ok={!!llmStatus && !llmStatus.error} />
            <StatusRow label="심볼 수" value={`${status.symbolCount || '--'}`} ok />
            <StatusRow label="수신 체결" value={`${(status.tradeCount || 0).toLocaleString()}건`} ok={status.tradeCount > 0} />
            <StatusRow label="매크로 레짐" value={status.macroRegime?.toUpperCase().replace('_', '-') || '--'} ok />
            <StatusRow label="거래 모드" value={status.mode || '--'} ok={status.mode === 'SIM' || status.mode === 'LIVE'} />
            <StatusRow label="가동 시간" value={status.uptime ? `${(status.uptime / 60).toFixed(0)}분` : '--'} ok />
            <StatusRow label="메모리" value={status.memoryMB ? `${status.memoryMB}MB` : '--'} ok />
            <StatusRow label="활성 플랜" value={`${status.ruleEngine?.activePlans || 0}개`} ok />
            <StatusRow label="시그널 (룰)" value={`${status.ruleEngine?.signalCount || 0}회`} ok />
          </div>
          <h3 className="font-headline font-bold text-sm border-b border-surface-container-high/30 pb-3 mb-4 mt-6">실행기 (Executor)</h3>
          <div className="space-y-3">
            <StatusRow label="시그널 수신" value={`${status.executor?.signals || 0}회`} ok />
            <StatusRow label="진입" value={`${status.executor?.entries || 0}회`} ok />
            <StatusRow label="청산" value={`${status.executor?.exits || 0}회`} ok />
            <StatusRow label="거부" value={`${status.executor?.rejected || 0}회`} ok={status.executor?.rejected === 0} />
            <StatusRow label="활성 포지션" value={`${status.executor?.activePositions || 0}개`} ok />
            <StatusRow label="잔고" value={`$${(status.executor?.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} ok={status.executor?.balance > 0} />
            <StatusRow label="지갑 잔고" value={`$${(status.executor?.walletBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} ok={status.executor?.walletBalance > 0} />
          </div>
        </div>

        {/* 거래소 연결 */}
        <div className="col-span-2 bg-surface-container-lowest p-6 rounded shadow-sm">
          <h3 className="font-headline font-bold text-sm border-b border-surface-container-high/30 pb-3 mb-4">거래소 연결</h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">현재 모드</span>
                <span className={`px-3 py-1 text-[10px] font-bold rounded font-label ${
                  status.mode === 'LIVE' ? 'bg-success/10 text-success' :
                  status.mode === 'SIM' ? 'bg-primary/10 text-primary' :
                  'bg-surface-variant text-outline'
                }`}>{status.mode === 'LIVE' ? (status.executor?.testnet ? 'TESTNET' : 'MAINNET') : 'SIMULATION'}</span>
              </div>
              <p className="text-[11px] text-on-surface-variant">잔고: <strong className="font-label">${(status.executor?.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></p>
            </div>
            <div className="p-3 bg-surface-container-low rounded-lg text-[11px] text-on-surface-variant leading-relaxed">
              <p className="mb-2 font-bold text-on-surface">실전 전환 방법:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li><code className="font-label bg-surface-variant px-1 rounded">BINANCE_TESTNET=false</code> 설정</li>
                <li>메인넷 API 키로 교체</li>
                <li>서버 재시작</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <span className={`px-2 py-0.5 text-[10px] font-bold rounded font-label ${
        ok ? 'bg-success/10 text-success' : 'bg-surface-variant text-outline'
      }`}>{value}</span>
    </div>
  );
}
