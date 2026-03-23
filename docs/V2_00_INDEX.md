# 코인 투자 시스템 V2 문서 인덱스

과거 L0~L3 아키텍처는 전면 폐기되었으며, 현재 시스템은 **5단계 존(Zone 0 ~ Zone 4)** 아키텍처를 기반으로 완벽히 재설계되었습니다. 느린 생성형 AI(LLM)와 초고속 실시간 거래 시스템의 병목을 해결하기 위해 '계획(Plan)'과 '실행(Execution)'을 분리한 것이 핵심입니다.

각 Zone과 기능별 상세 설계 문서는 아래를 참조하십시오.

### 📚 아키텍처 및 시스템 개요
* [V2_01_ARCHITECTURE.md](./V2_01_ARCHITECTURE.md) : 전체 5-Zone 아키텍처 및 데이터 흐름 개요

### 📥 데이터 파이프라인
* [V2_02_Z0_RAW_DATA.md](./V2_02_Z0_RAW_DATA.md) : Z0 실시간/배치 데이터 수집 및 초고속 메모리 버퍼(RingBuffer)
* [V2_03_Z1_PROCESSED.md](./V2_03_Z1_PROCESSED.md) : Z1 데이터 가공, 9차원 상태 숫자 벡터 생성 및 코사인 유사도 검색

### 🧠 인공지능 및 전략 수립
* [V2_04_Z2_INTELLIGENCE.md](./V2_04_Z2_INTELLIGENCE.md) : Z2 LLM 스케줄러, 거시경제 분석, 시나리오 및 실행 계획(Plan) 생성

### ⚡ 실시간 실행 및 청산
* [V2_05_Z3_EXECUTION.md](./V2_05_Z3_EXECUTION.md) : Z3 룰 엔진, 리스크 게이트, 바이낸스 API 연동 및 시장가 주문 실행
* [V2_06_Z3_SMART_EXIT.md](./V2_06_Z3_SMART_EXIT.md) : Z3 7경로 멀티패스 지능형 청산 시스템 (100ms 실시간 + 30s LLM 무효화)

### 📊 결과 추적 및 데이터베이스
* [V2_07_Z4_RESULTS_AND_DB.md](./V2_07_Z4_RESULTS_AND_DB.md) : Z4 성과 추적 시스템, 오라클 Vector DB 스키마 및 벡터 스케일링 설계
