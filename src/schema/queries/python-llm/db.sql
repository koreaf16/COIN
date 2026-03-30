-- name: insertLlmAnalysis
INSERT INTO z2_llm_analysis
(symbol, ts, analysis_type, llm_source, result, confidence, latency_ms, token_count)
VALUES (:sym, SYSTIMESTAMP, :atype, 'system', :result, :conf, :ms, :tokens)
