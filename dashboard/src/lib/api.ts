const BASE = '/api/coin';

export async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export interface StructureSnapshot {
  daily_bias?: string;
  trend_bias_4h?: string;
  trigger_bias_1h?: string;
  btc_daily_bias?: string;
}

export interface StructureMonitor {
  current?: StructureSnapshot;
  plan?: {
    higherTimeframe?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
  };
  hasHigherTimeframePlan?: boolean;
  hasTriggerPlan?: boolean;
  aligned?: boolean;
  blockReason?: string | null;
}

export interface DashboardData {
  symbols: { symbol: string; price: number; change24h: number; structure?: StructureMonitor }[];
  stats: { checkCount: number; signalCount: number; activePlans: number };
  execution: { signals: number; entries: number; exits: number; balance: number; mode: string; activePositions: number };
}

export interface LivePosition {
  id: string;
  planId: number;
  symbol: string;
  direction: string;
  entryPrice: number;
  currentPrice: number;
  qty: number;
  unrealizedPnlPct: number;
  unrealizedPnlUsd: number;
  targetPrice: number;
  safetyStop: number;
  timeStopMin: number;
  holdTimeMin: number;
  timeRemainingMin: number | null;
  confidence: number;
  entryTime: string;
  structure?: StructureMonitor;
}

export interface ConditionDetail {
  field: string;
  operator: string;
  expected: any;
  actual: any;
  met: boolean;
}

export interface PlanStatus {
  id: number;
  symbol: string;
  direction: string;
  targetPrice: number;
  confidence: number;
  createdAt: string;
  validUntil: string;
  timeRemainingMin: number;
  conditions: ConditionDetail[];
  conditionsMet: number;
  conditionsTotal: number;
  structure?: StructureMonitor;
}

export interface Position {
  id: number;
  symbol: string;
  direction: string;
  entryPrice: number;
  entryTime: string;
  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;
  pnlPct?: number;
  pnlAmount?: number;
  feeAmount?: number;
  status: string;
  notional?: number;
  structure?: StructureMonitor;
}
