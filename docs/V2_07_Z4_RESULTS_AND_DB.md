# V2_07. Zone 4 (Results) & Vector DB Schema

시스템의 거래 결과 추적, 퍼포먼스 기록, 그리고 오라클 기반 핵심 Vector 스키마 설계에 대한 문서입니다.

## 1. Zone 4 (Results) 로직
`PerformanceTracker`와 `TradeRecorder`가 담당합니다.

*   **PnL 추적**: 각 거래 종료 후 발생한 왕복 수수료, 지연(Slippage) 비율, 최종 순이익(Net PnL)을 계산합니다.
*   **자정 리셋**: `Executor` 내부에 스케줄러가 돌아 매일 로컬 자정 기준으로 리스크 관리를 위한 일일 PnL 한도 누적치를 0으로 초기화(`resetDaily`) 합니다.
*   **DB 적재**: 체결 내역과 진입 사유, 청산 사유(예: `ATR_TARGET`, `INVALIDATION` 등)를 `z4_positions` 테이블에 기록하여 향후 분석에 활용합니다.

---

## 2. Oracle 23c 데이터베이스 및 핵심 테이블 구조

현재 시스템은 오라클의 네이티브 Vector 데이터타입과 HNSW 계열 거리 연산을 적극 지원하는 환경으로 구성되어 있습니다.

### 주요 테이블 설명

*   **`z1_market_states`** (시장 상태 벡터)
    *   주요 컬럼: `state_vector VECTOR(9, FLOAT64)`
    *   설명: 15분마다 생성되는 9차원 숫자 피처 튜플.
    *   백필 컬럼: `next_1h_return`, `next_4h_return`, `next_24h_return`
    *   벡터 인덱스: 코사인 유사도를 위한 `idx_z1_states_vec` 생성.

*   **`z2_llm_analysis`** (LLM 판단 결과 및 텍스트 임베딩)
    *   주요 컬럼: `embedding VECTOR(1024, FLOAT64)`, `result JSON`
    *   설명: 센티먼트, 브리핑 분석 결과. BGE-M3 등 자연어 임베딩 벡터 저장.

*   **`z2_execution_plan`** (실행 계획)
    *   주요 컬럼: `entry_conditions JSON`, `status VARCHAR2`, `valid_until TIMESTAMP`
    *   설명: Z2에서 만든 함정(Plan) 목록. Z3 룰엔진이 이 테이블에서 `ACTIVE` 인 건들을 가져와 캐싱(`PlanCache`)하여 감시합니다.

*   **`z4_positions`** (진입 및 청산 내역)
    *   주요 컬럼: `status (OPEN/CLOSED)`, `entry_price`, `exit_price`, `exit_reason`
    *   설명: Smart Exit에서 어떤 이유로 청산되었는지 기록하여 백테스트 및 튜닝 피드백으로 삼습니다.

---

## 3. 벡터 정규화(Normalization) 관련 이슈 및 향후 과제

현재 9D 상태 벡터 생성 로직에서 펀딩비 Z-score(-3~3), 추세강도(-1~1) 등은 스케일링이 잘 되어 있으나, **미결제약정 변화율(OI Change Pct)은 백분율 값 그대로 입력**되고 있습니다.

코사인 거리(Cosine Distance) 기반 벡터 검색 시, 값의 단위(Scale)가 맞춰져 있지 않으면 변동 폭이 큰 특정 피처가 벡터의 방향을 완전히 지배해버리는 왜곡이 발생합니다. **추후 Z1 빌더 단에서 모든 9개의 피처를 -1.0 ~ 1.0의 Min-Max 혹은 Z-Score 형태로 일괄 정규화(Normalization)** 한 뒤 DB에 저장하도록 업그레이드할 예정입니다.
