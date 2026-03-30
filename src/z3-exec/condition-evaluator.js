/**
 * @module 조건 평가기
 * @description 실행 계획의 진입 및 청산 조건을 현재 시장 데이터와 대조하여 평가한다.
 *
 * ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
 * │ Execution    │ ───→ │ Condition    │ ───→ │ Signal /     │
 * │ Plan         │      │ Evaluator    │      │ Exit         │
 * └──────────────┘      └──────────────┘      └──────────────┘
 *                              ↑
 *                       ┌──────────────┐
 *                       │ Market Data  │
 *                       │ (Snapshot)   │
 *                       └──────────────┘
 *
 * @zone z3-exec
 * @dependencies None
 */

/**
 * LLM 응답의 conditions를 정규화
 * flat 형식 {"field":"x","op":"<","value":0} → nested {"x":{"op":"<","value":0}}
 * 배열 형식 [{field,op,value}, ...] → nested
 * 빈값/null → {}
 * @param {object|array} cond
 * @returns {object}
 */
export function normalizeConditions(cond) {
  if (!cond || typeof cond !== 'object') return {};
  const keys = Object.keys(cond);
  if (keys.length === 0) return {};

  // Reject placeholder shapes like {"field": {"op":"<","value":0}}.
  if (keys.length === 1 && keys[0] === 'field') {
    const maybeCondition = cond.field;
    if (maybeCondition && typeof maybeCondition === 'object' && 'op' in maybeCondition && 'value' in maybeCondition) {
      return {};
    }
  }

  // flat 형식: top-level에 field, op, value
  if (keys.includes('field') && keys.includes('op') && 'value' in cond) {
    const fieldName = cond.field;
    if (typeof fieldName === 'string' && fieldName) {
      return { [fieldName]: { op: cond.op, value: cond.value } };
    }
    return {};
  }

  // 배열 형식: [{field, op, value}, ...]
  if (Array.isArray(cond)) {
    const result = {};
    for (const item of cond) {
      if (item && typeof item === 'object' && item.field && item.op && 'value' in item) {
        result[item.field] = { op: item.op, value: item.value };
      }
    }
    return result;
  }

  return cond;
}

/**
 * entry_conditions가 유효한지 검증 (최소 1개 이상의 op/value 쌍 필요)
 * @param {object} cond
 * @returns {boolean}
 */
export function hasValidConditions(cond) {
  if (!cond || typeof cond !== 'object') return false;
  const keys = Object.keys(cond);
  if (keys.length === 0) return false;
  if (keys.length === 1 && keys[0] === 'field') return false;
  for (const v of Object.values(cond)) {
    if (v && typeof v === 'object' && 'op' in v && 'value' in v) return true;
  }
  return false;
}

/**
 * 조건 목록 평가
 * @param {object} conditions
 * @param {object} currentData
 * @param {string|null} direction - 'LONG', 'SHORT' or null
 * @returns {{met: boolean, details: Array}}
 */
export function evaluateConditions(conditions, currentData, direction) {
  if (!conditions || typeof conditions !== 'object') return { met: false, details: [] };

  // flat 형식 방어 (DB에 이미 저장된 데이터 대응)
  conditions = normalizeConditions(conditions);

  if (Object.keys(conditions).length === 0) {
    return { met: false, details: [{ field: 'EMPTY_CONDITIONS', operator: '==', expected: 'non-empty', actual: '{}', met: false }] };
  }

  const details = [];
  let allMet = true;

  // ── [심각한 충돌 감지 (Conflict Detection)] ──
  if (direction === 'LONG') {
    const priceDir = currentData['price_dir_1h'];
    const oiDir = currentData['oi_dir_1h'];

    if (priceDir === 'DOWN' && oiDir === 'UP') {
      details.push({
        field: 'CONFLICT_FILTER',
        operator: 'LONG_BLOCK',
        expected: 'NOT(PriceDOWN & OI_UP)',
        actual: 'CONFLICT_DETECTED',
        met: false,
        reason: 'Aggressive shorting detected. Catching a falling knife is prohibited.'
      });
      allMet = false;
    }
  }

  if (direction === 'SHORT') {
    const priceDir = currentData['price_dir_1h'];
    const oiDir = currentData['oi_dir_1h'];

    if (priceDir === 'UP' && oiDir === 'UP') {
      details.push({
        field: 'CONFLICT_FILTER',
        operator: 'SHORT_BLOCK',
        expected: 'NOT(PriceUP & OI_UP)',
        actual: 'CONFLICT_DETECTED',
        met: false,
        reason: 'Aggressive longing detected. Do not stand in front of a rising train.'
      });
      allMet = false;
    }
  }

  for (const [field, condition] of Object.entries(conditions)) {
    const currentValue = resolveValue(field, currentData);
    const result = evaluateSingle(condition, currentValue);

    details.push({
      field,
      operator: condition.op,
      expected: condition.value,
      actual: currentValue,
      met: result,
    });

    if (!result) allMet = false;
  }

  return { met: allMet, details };
}

/**
 * 데이터 객체에서 필드 경로에 해당하는 값 추출 (예: 'markPrice.fundingRate')
 * @param {string} field
 * @param {object} data
 * @returns {any}
 */
function resolveValue(field, data) {
  if (data[field] !== undefined) return data[field];

  const parts = field.split('.');
  let val = data;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

/**
 * 단일 조건 평가
 * @param {object} condition
 * @param {any} currentValue
 * @returns {boolean}
 */
function evaluateSingle(condition, currentValue) {
  if (!condition || condition.op === undefined) return false;
  if (currentValue === undefined || currentValue === null) return false;

  const { op, value } = condition;

  switch (op) {
    case '<':  return currentValue < value;
    case '>':  return currentValue > value;
    case '<=': return currentValue <= value;
    case '>=': return currentValue >= value;
    case '==': return currentValue === value;
    case '!=': return currentValue !== value;
    case 'in':
      return Array.isArray(value) && value.includes(currentValue);
    default:
      return false;
  }
}
