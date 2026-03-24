-- z4_positions에 candle_data 컬럼 추가
-- 거래 1초봉 데이터 저장 (진입 5분전 ~ 청산 1분후)
-- JSON 배열: [{time, open, high, low, close, volume}, ...]

ALTER TABLE z4_positions ADD (candle_data CLOB);
-- JSON check (optional)
-- ALTER TABLE z4_positions ADD CONSTRAINT chk_z4_candle_json CHECK (candle_data IS JSON);

-- 후행 캡처 완료 플래그 (0=미완료, 1=완료)
ALTER TABLE z4_positions ADD (candle_post_exit NUMBER(1) DEFAULT 0);
