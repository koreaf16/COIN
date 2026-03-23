---
name: COIN 시스템 버그 수정 이력
description: COIN 암호화폐 트레이딩 시스템에서 발견 및 수정된 버그 목록
type: project
---

2026-03-19 디버깅 세션에서 수정된 버그들:

**Bug 1 - FRED INSERT 컬럼명 오류** (fred-collector.js)
- `fed_funds` → `fedfunds`, `cpi` → `cpiaucsl`, `m2` → `m2sl`, `stlfsi` → `stlfsi4`
- **Why:** DB 스키마(TB_L0_MACRO_REGIME)의 실제 컬럼명과 불일치
- **How to apply:** FRED 관련 INSERT 시 항상 DB 컬럼명 확인

**Bug 2 - SEC INSERT 컬럼명 오류** (sec-collector.js)
- `ts` → `fetched_at`, `filing_date` → `filed_at`, `title` 컬럼 제거(summary에 포함), `accession_no` 누락 추가
- **Why:** TB_L0_SEC_FILING 실제 스키마와 불일치

**Bug 3 - Pattern Trainer MERGE 컬럼명 오류** (pattern-trainer.js)
- `event_type` → 제거(TB_L2_PATTERN에 없음), `avg_magnitude` → `avg_ret_5m`, `avg_duration` → `avg_hold_time`, `avg_mfe_5m`/`avg_mae_5m` 추가
- **Why:** TB_L2_PATTERN 스키마에 event_type 컬럼 없음

**Bug 4 - Python Ollama URL 이중 /v1** (python-llm/config.py)
- LLM_BASE_URL=http://192.168.0.3:11434/v1 → 여기에 /v1/chat/completions을 붙이면 이중 /v1
- 수정: base URL에서 /v1 suffix 제거 후 /v1/chat/completions 추가

**Bug 5 - Node.js LLM 클라이언트 URL 오류** (llm-client.js)
- Ollama API URL(config.llm.baseUrl)을 Python FastAPI 서버 URL로 잘못 사용
- 수정: config.llm.pythonUrl 사용 + .env.local에 PYTHON_LLM_URL 추가

**Bug 6 - index.js 트레이너 URL 하드코딩** (index.js)
- llmBaseUrl: 'http://localhost:2002' → config.llm.pythonUrl 사용으로 변경

**Bug 7 - L1 EventWriter null 벡터** (l1-feature-engine/index.js)
- num_vector NOT NULL 제약인데 null 삽입 가능
- 수정: numVector null 체크 후 return

**Bug 8 - Python LLM 서버 포트 불일치** (package.json, .env.local)
- run.bat=2002, package.json=8000 불일치
- 수정: package.json llm 스크립트를 포트 2002로 통일

**시스템 현황:**
- Oracle 26ai 정상 연결 (192.168.0.120:1521/AI_DB)
- API 서버: http://localhost:2001
- 대시보드: http://localhost:2000 (Next.js, Next.js rewrite로 /api/coin/* → backend)
- Python LLM: http://localhost:2002 (FastAPI + BGE-M3 + Ollama)
- Binance WebSocket: 메인넷 데이터 수신 중 (testnet은 주문 실행용)
