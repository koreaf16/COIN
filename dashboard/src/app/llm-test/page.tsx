'use client';

import { useEffect, useState } from 'react';

interface ProviderStatus {
  available: boolean;
  model?: string;
  path?: string;
  url?: string;
  has_key?: boolean;
}

interface LLMStatus {
  local?: ProviderStatus;
  claude_cli?: ProviderStatus;
  gemini_cli?: ProviderStatus;
  cloud_api?: ProviderStatus;
  routing?: Record<string, string>;
  error?: string;
}

interface TestResult {
  provider: string;
  prompt: string;
  response: string;
  latency_ms: number;
  tokens: number;
  status: string;
}

export default function LLMTestPage() {
  const [status, setStatus] = useState<LLMStatus>({});
  const [testPrompt, setTestPrompt] = useState('BTC가 현재 $68,000인데, 펀딩비가 -0.08%이고 OI가 증가 중이야. 시장 상태를 한 줄로 진단해줘.');
  const [results, setResults] = useState<TestResult[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetchStatus();
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/coin/llm-status');
      if (res.ok) setStatus(await res.json());
      else setStatus({ error: 'LLM 서버 연결 실패' });
    } catch { setStatus({ error: 'LLM 서버 미실행' }); }
  };

  const runTest = async (provider: string) => {
    setTesting(provider);
    setElapsed(0);
    const elapsedTimer = setInterval(() => setElapsed(e => e + 1), 1000);
    try {
      const res = await fetch('/api/coin/test-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: testPrompt, provider }),
        signal: AbortSignal.timeout(180000), // 3분 타임아웃 (Gemini CLI가 느림)
      });
      if (res.ok) {
        const result = await res.json();
        setResults(prev => [result, ...prev]);
      }
    } catch (err) {
      setResults(prev => [{
        provider, prompt: testPrompt, response: '연결 실패 또는 타임아웃', latency_ms: 0, tokens: 0, status: 'error'
      }, ...prev]);
    } finally { clearInterval(elapsedTimer); setTesting(null); setElapsed(0); }
  };

  const providers = [
    { key: 'local', label: '로컬 LLM', icon: 'memory', desc: 'Ollama / Qwen3.5-27B', data: status.local },
    { key: 'claude_cli', label: 'Claude CLI', icon: 'terminal', desc: 'Claude Opus 4.6', data: status.claude_cli },
    { key: 'gemini_cli', label: 'Gemini CLI', icon: 'auto_awesome', desc: 'Gemini 3.1 Pro Preview', data: status.gemini_cli },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-headline font-bold text-2xl">LLM 테스트</h1>
          <p className="text-sm text-on-surface-variant mt-1">각 LLM 프로바이더의 동작 상태를 확인하고 테스트합니다.</p>
        </div>
        <button onClick={fetchStatus} className="px-3 py-1.5 text-xs font-label border border-outline-variant/30 rounded hover:bg-surface-container-low">
          상태 새로고침
        </button>
      </div>

      {status.error && (
        <div className="bg-error/10 text-error p-4 rounded text-sm">
          <span className="material-symbols-outlined text-base align-middle mr-1">error</span>
          {status.error} — Python LLM 서버(port 2002)가 실행 중인지 확인하세요.
        </div>
      )}

      {/* 프로바이더 상태 카드 */}
      <div className="grid grid-cols-4 gap-4">
        {providers.map(p => {
          const available = p.data?.available;
          const isRunning = testing === p.key;
          return (
            <div key={p.key} className="bg-surface-container-lowest p-5 rounded shadow-sm flex flex-col">
              <div className="flex items-center gap-3 mb-3">
                <span className="material-symbols-outlined text-xl text-primary">{p.icon}</span>
                <div className="flex-1">
                  <span className="text-sm font-bold block">{p.label}</span>
                  <span className="text-[10px] font-label text-outline">{p.desc}</span>
                </div>
                <span className={`w-2.5 h-2.5 rounded-full ${available ? 'bg-success' : 'bg-error'}`} />
              </div>

              <div className="text-[11px] space-y-1 text-on-surface-variant flex-1 mb-3">
                {p.data?.model && <p>모델: <strong className="font-label text-on-surface">{p.data.model}</strong></p>}
                {p.data?.path && <p>경로: <code className="font-label bg-surface-container-low px-1 rounded text-[10px]">{p.data.path}</code></p>}
                {p.data?.url && <p>URL: <code className="font-label bg-surface-container-low px-1 rounded text-[10px]">{p.data.url}</code></p>}
                {p.data?.has_key !== undefined && <p>API 키: {p.data.has_key ? '설정됨' : '없음'}</p>}
                <p>상태: <strong className={available ? 'text-success' : 'text-error'}>{available ? '사용 가능' : '사용 불가'}</strong></p>
              </div>

              <button
                onClick={() => runTest(p.key)}
                disabled={isRunning || !available}
                className={`w-full py-2 text-xs font-label rounded transition-colors ${
                  isRunning ? 'bg-surface-container animate-pulse text-outline' :
                  available ? 'bg-primary text-on-primary hover:bg-primary-dim' :
                  'bg-surface-container-low text-outline cursor-not-allowed'
                }`}
              >
                {isRunning ? `테스트 중... ${elapsed}초` : '테스트 실행'}
              </button>
            </div>
          );
        })}
      </div>

      {/* 라우팅 규칙 */}
      {status.routing && (
        <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
          <h3 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-3">라우팅 규칙</h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(status.routing).map(([task, route]) => (
              <div key={task} className="flex items-center gap-2 bg-surface-container-low px-3 py-1.5 rounded">
                <span className="text-xs font-label font-bold text-on-surface">{task}</span>
                <span className="text-[10px] text-outline">→</span>
                <span className={`text-xs font-label font-bold ${route === 'local' ? 'text-primary' : 'text-success'}`}>{route}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-outline mt-2">cloud 라우팅: Claude CLI (Opus 4.6) → Gemini CLI (3.1 Pro) → Local 폴백</p>
        </div>
      )}

      {/* 테스트 프롬프트 */}
      <div className="bg-surface-container-lowest p-5 rounded shadow-sm">
        <h3 className="font-headline font-bold text-xs uppercase tracking-widest text-outline mb-3">테스트 프롬프트</h3>
        <textarea
          value={testPrompt}
          onChange={e => setTestPrompt(e.target.value)}
          className="w-full bg-surface-container-low border-none rounded-lg p-3 text-sm font-label resize-none focus:ring-1 focus:ring-primary focus:outline-none"
          rows={3}
        />
        <div className="flex gap-2 mt-3">
          <button onClick={() => runTest('auto')} disabled={!!testing}
            className="px-4 py-2 bg-primary text-on-primary text-xs font-label rounded hover:bg-primary-dim disabled:opacity-50">
            {testing === 'auto' ? `실행 중... ${elapsed}초` : '자동 라우팅 테스트'}
          </button>
          <button onClick={() => setResults([])} className="px-4 py-2 text-xs font-label border border-outline-variant/30 rounded hover:bg-surface-container-low">
            결과 초기화
          </button>
        </div>
      </div>

      {/* 테스트 결과 */}
      {results.length > 0 && (
        <div className="bg-surface-container-lowest rounded shadow-sm overflow-hidden">
          <div className="p-4 border-b border-surface-container-high/30">
            <h3 className="font-headline font-bold text-sm">테스트 결과 ({results.length}건)</h3>
          </div>
          <div className="divide-y divide-surface-container-high/20">
            {results.map((r, i) => (
              <div key={i} className="p-4">
                <div className="flex items-center gap-3 mb-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold font-label ${
                    r.status === 'ok' ? 'bg-success/10 text-success' :
                    r.status === 'not_found' ? 'bg-surface-variant text-outline' :
                    'bg-error/10 text-error'
                  }`}>{r.status === 'ok' ? '성공' : r.status === 'not_found' ? '미설치' : '실패'}</span>
                  <span className="text-sm font-bold">{r.provider}</span>
                  {r.latency_ms > 0 && (
                    <span className="text-[10px] font-label text-outline">{(r.latency_ms / 1000).toFixed(1)}초 | {r.tokens} 토큰</span>
                  )}
                </div>
                <div className="bg-surface-container-low p-3 rounded text-xs font-label leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                  {r.response || '(응답 없음)'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
