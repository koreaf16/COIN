# V2_04. Zone 2 (Intelligence) - LLM 기반 지능 엔진

Z2는 생성형 AI를 활용하여 인간 트레이더처럼 차트의 맥락, 거시경제 지표, 뉴스의 분위기를 종합적으로 분석하여 전략(Plan)을 세우는 느린 두뇌(Slow Brain)입니다.

## 1. Plan-based Execution 아키텍처
*   LLM API 호출은 5~10초 이상 소요되며 간헐적 타임아웃이 발생합니다. 이를 1초 단위로 변하는 호가창에 직접 연결하면 치명적입니다.
*   따라서 LLM은 **"지금 당장 사라/팔아라"** 가 아니라 **"이러이러한 지표가 달성되면 진입하라"**는 JSON 형태의 **실행 계획(Execution Plan)**을 생성하여 DB에 던져두고 빠집니다.

## 2. LLM Scheduler의 다단계 파이프라인
`src/z2-intel/scheduler.js` 가 전체 흐름을 관장합니다.

*   **1분 주기 (로컬 LLM - 센티먼트)**:
    *   수집된 영문 뉴스를 로컬의 빠르고 가벼운 LLM(예: Qwen)에 태워 실시간 센티먼트(Sentiment)를 추출합니다. (-1.0 ~ +1.0)
*   **10분 주기 (클라우드 LLM - Claude CLI)**:
    1.  **브리핑(Briefing)**: 현재 시장 지표와 뉴스를 바탕으로 전반적인 시장의 방향성(Direction Bias)에 대한 브리핑을 생성합니다. (텍스트는 임베딩되어 벡터 DB에 저장)
    2.  **시나리오(Scenario)**: 생성된 브리핑 + 경제 캘린더 + 스테이블코인 등 추가 매크로 데이터를 종합하여 구체적 진입/청산 조건을 포함한 시나리오를 도출합니다.
    3.  **플랜 저장**: 시나리오 결과 중 확률(Confidence)이 높은 것들을 `z2_execution_plan` 테이블에 `ACTIVE` 상태로 저장합니다.

## 3. 실행 계획(Execution Plan)의 구성 요소
*   `direction`: 진입 방향 (LONG / SHORT)
*   `entry_conditions`: 진입을 위한 세부 지표 조건식 (JSON 형태, 예: CVD > 0.5 AND RSI < 30)
*   `target_price` / `stop_price`: LLM이 생각하는 이론적 목표가와 손절가
*   `valid_until`: 플랜의 유효 기간 (기본 30분, 시간이 지나면 폐기됨)
*   `reasoning`: 진입을 결정한 논리적 근거 텍스트 (추후 Z3에서 Invalidation 검사 시 활용)
