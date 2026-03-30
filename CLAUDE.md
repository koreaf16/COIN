# CLAUDE.md — COIN 프로젝트 규칙

> 이 파일은 Claude Code가 프로젝트에 진입할 때 **반드시 먼저 읽는** 마스터 지침서입니다.
> 모든 작업 전에 이 파일과 ARCHITECTURE.md를 참조하세요.

---

## 프로젝트 개요

**COIN (Crypto Oracle Intelligence Network)** — 암호화폐 선물 자동매매 시스템
- 5-Zone 파이프라인: Z0(수집) → Z1(가공) → Z2(분석) → Z3(실행) → Z4(결과)
- Binance Futures (테스트넷/실거래) 대상
- LLM 기반 시장 분석 + 룰 엔진 기반 매매 실행
- Oracle DB + Node.js + Python FastAPI + Next.js 대시보드

---

## 핵심 규칙

### 1. 문서 우선 (Documentation First)

**작업 전**:
- `ARCHITECTURE.md` 읽고 현재 구조 파악
- 해당 Zone의 모듈 관계 확인

**작업 후**:
- 구조 변경 시 → `ARCHITECTURE.md` 즉시 업데이트
- 새 모듈 추가 시 → 파일 상단 주석 필수
- API 변경 시 → 관련 호출처 모두 확인
- 설정 변경 시 → `.env.example` 업데이트

### 2. 소스 파일 규칙

**파일 상단 주석 필수**:
모든 소스 파일 최상단에 아래 형식의 모듈 설명 블록을 넣는다.

#### Node.js 예시
```js
/**
 * @module 뉴스 수집기
 * @description Tiingo API에서 암호화폐 관련 기사를 수집하여 Oracle DB에 저장한다.
 *
 * ┌──────────┐     ┌──────────┐     ┌──────────┐
 * │ Tiingo   │ ──→ │ News     │ ──→ │ Oracle   │
 * │ API      │     │ Collector│     │ DB       │
 * └──────────┘     └──────────┘     └──────────┘
 *                       ↓
 *              state-vector-builder
 *             (Z1에서 벡터 합산 시 참조)
 *
 * @zone z0-raw
 * @dependencies config.js, db.js, tiingo API
 */
```

#### Python 예시
```python
"""
@module LLM 클라이언트
@description OpenAI/Claude API를 호출하여 시장 분석 및 매매 계획을 생성한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Oracle   │ ──→ │ LLM      │ ──→ │ Validator│
│ Reader   │     │ Client   │     │          │
└──────────┘     └──────────┘     └──────────┘
      ↑               ↓
  state_vectors    trade_plans
  (시장 데이터)    (매매 계획 저장)

@dependencies config.py, prompts.py, validator.py, oracle_reader.py
"""
```

**파일 크기 제한**:
- 단일 파일 **200줄 이하** 권장, **300줄 초과 금지**
- 초과 시 반드시 분리 (헬퍼, 유틸, 타입으로)

**함수 크기 제한**:
- 단일 함수 **50줄 이하** 권장
- 초과 시 서브 함수로 분리

### 3. 디렉토리 구조 규칙

**5-Zone 아키텍처 준수**:
```
src/
  shared/          ← 공통 (config, db, logger, time)
  z0-raw/          ← 데이터 수집 (WS, REST, 뉴스, 온체인)
  z1-processed/    ← 데이터 가공 (state-vector 생성)
  z2-intel/        ← AI 분석 (LLM 호출, 스케줄링)
  z3-exec/         ← 매매 실행 (룰엔진, 리스크, 주문)
  z4-results/      ← 결과 기록 (거래 기록, 성과 추적)
  api/             ← REST API 서버
  schema/          ← DB 스키마 및 마이그레이션
python-llm/        ← Python LLM 서비스 (FastAPI :2002)
dashboard/         ← Next.js 대시보드 (:2000)
```

**새 모듈 추가 시**:
1. 해당 Zone 디렉토리에 파일 생성
2. 파일 상단 주석 작성 (모듈 설명 + 관계도)
3. ARCHITECTURE.md 업데이트

### 4. Oracle DB 규칙

**인라인 SQL 금지**:
- 모든 쿼리는 `src/schema/` 하위에 SQL 파일로 분리
- PL/SQL 프로시저는 `v2-plsql.sql`에 정의

**타임존 규칙**:
- DB 저장: UTC
- UI 표시: ET (America/New_York)
- Oracle 세션: UTC 고정, 프론트에서 ET 변환

### 5. 타입 안전성

- `any` 타입 금지 (불가피한 경우 주석으로 이유 명시)
- Python: 모든 함수에 타입 힌트 필수

### 6. 에러 처리

- 모든 async 함수에 try-catch
- Python: logging 모듈 사용 (`print()` 금지)
- Node.js: `logger` 사용 (`console.log` 금지)

### 7. 환경 변수

- `.env.local`에 실제 값 (gitignore 됨)
- 새 환경 변수 추가 시 문서화
- 비밀 값은 절대 하드코딩 금지

### 8. Git 커밋 규칙

```
feat: 온체인 데이터 수집기 추가
fix: WebSocket 재연결 로직 수정
docs: ARCHITECTURE.md Zone 구조 업데이트
refactor: state-vector 빌더 모듈 분리
chore: 의존성 업데이트
```

---

## 작업 흐름 (매번 따라야 함)

```
1. ARCHITECTURE.md 읽기
2. 해당 Zone 모듈 구조 파악
3. 코드 작성/수정
4. 파일 상단 주석 확인/업데이트
5. ARCHITECTURE.md 업데이트 (구조 변경 시)
6. .env 관련 변경 시 문서화
```

---

## 기술 스택

| 구성 | 기술 | 비고 |
|------|------|------|
| 런타임 | Node.js 20+ | ES Modules (type: module) |
| 웹 서버 | Fastify 5.x | REST API + WebSocket |
| DB | Oracle (oracledb 6.x) | Node: 일반 CRUD, Python: 분석 쿼리 |
| **AI 전담** | **Python FastAPI** | **LLM 호출, 임베딩, 분석 (:2002)** |
| 대시보드 | Next.js (App Router) | (:2000) |
| 거래소 | Binance Futures | REST + WebSocket |
| 실시간 데이터 | WebSocket (ws 8.x) | Binance, Tiingo |

---

## Node.js ↔ Python 역할 분리 (매우 중요)

### 절대 규칙: LLM/AI 모델과 닿는 모든 코드는 Python에서 작성

| Node.js | Python (FastAPI :2002) |
|---------|------------------------|
| Binance WebSocket/REST 수집 | LLM API 호출 (시장 분석, 매매 계획) |
| Oracle 일반 CRUD | Oracle 분석 쿼리 (state-vector 읽기) |
| 룰 엔진 + 리스크 게이트 | 감정 분석 + 임베딩 생성 |
| 매매 주문 실행 | 프롬프트 최적화 |
| Fastify API 서버 | 시나리오 분석 |
| 스케줄링 (scheduler.js) | 포지션 검증 (validate_position) |
| 성과 추적 + 거래 기록 | 브리핑 생성 |

### Node.js에서 Python 호출 방법

```js
// Node.js → Python FastAPI (HTTP)
const response = await fetch('http://localhost:2002/api/unified-plan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbols, context })
});
const plan = await response.json();
```

### 금지: Node.js에서 직접 AI 호출

```js
// ❌ 절대 금지 — Node.js에서 LLM 직접 호출
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ❌ 절대 금지 — Node.js에서 임베딩 직접 생성
import { pipeline } from '@xenova/transformers';

// ✅ 올바른 방법 — Python API 호출
const result = await fetch('http://localhost:2002/api/sentiment', { ... });
```

---

## 외부 서비스 연결

| 서비스 | 호스트 | 포트 | 프로토콜 |
|--------|--------|------|----------|
| Node.js 메인 서버 | 0.0.0.0 | 2001 | HTTP/WS |
| Next.js 대시보드 | localhost | 2000 | HTTP |
| Python FastAPI | localhost | 2002 | REST |
| Oracle DB | localhost | 1521 | TCP (TNS) |
| Binance Futures | wss://fstream.binance.com | 443 | WebSocket |
| Tiingo Crypto | wss://api.tiingo.com | 443 | WebSocket |

---

## 5-Zone 파이프라인 상세

| Zone | 역할 | 주요 모듈 |
|------|------|----------|
| Z0 Raw | 실시간 데이터 수집 | futures-ws-connector, news-collector, onchain-collector, coinglass-collector, symbol-rotator |
| Z1 Processed | 데이터 가공/벡터화 | state-vector-builder |
| Z2 Intel | AI 분석/계획 수립 | llm-client → Python FastAPI, scheduler, event-monitor |
| Z3 Exec | 매매 실행/리스크 관리 | rule-engine, executor, risk-gate, smart-exit, condition-evaluator |
| Z4 Results | 성과 기록/분석 | trade-recorder, performance-tracker |

---

## 금지 사항

### Node.js
- `console.log` 직접 사용 금지 → `logger` 사용
- 인라인 SQL 금지 → 쿼리 파일 분리
- `any` 타입 금지
- 단일 파일 300줄 초과 금지
- 하드코딩된 경로/URL 금지 → `config.js` 사용
- 문서 업데이트 없는 구조 변경 금지
- **LLM/AI 모델 직접 호출 금지 → 반드시 Python API 경유**
- **임베딩 생성, 감정 분석 등 AI 연산 직접 수행 금지**

### Python
- 파일 상단 docstring 필수 (모듈 설명 + 구조도)
- 단일 파일 300줄 초과 금지
- 타입 힌트 필수 (모든 함수 인자 + 리턴)
- Pydantic 모델로 요청/응답 정의 (dict 직접 반환 금지)
- 인라인 SQL 금지 → 쿼리 분리
- 하드코딩 금지 → `config.py` 사용
- `print()` 금지 → `logging` 모듈 사용

### Python 파일 상단 규칙

```python
"""
@module 프롬프트 빌더
@description 시장 데이터를 기반으로 LLM 프롬프트를 구성한다.

┌──────────┐     ┌──────────┐     ┌──────────┐
│ Oracle   │ ──→ │ Prompt   │ ──→ │ LLM      │
│ Reader   │     │ Builder  │     │ Client   │
└──────────┘     └──────────┘     └──────────┘
      ↑
  state_vectors
  (시장 스냅샷)

@dependencies config.py, oracle_reader.py
"""
```
