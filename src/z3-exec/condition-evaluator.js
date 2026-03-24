/**
 * Z3 Condition Evaluator — JSON 조건 파서/평가기
 *
 * execution_plan.entry_conditions JSON을 현재 데이터와 대조.
 * 지원 연산자: <, >, <=, >=, ==, in
 */

export function evaluateConditions(conditions, currentData, direction) {
  if (!conditions || typeof conditions !== 'object') return { met: false, details: [] };

  const details = [];
  let allMet = true;

  // ── [심각한 충돌 감지 (Conflict Detection)] ──
  // RIVERUSDT 사례 반성: 하락장(Price DOWN)에서 신규 숏 진입(OI UP) 시 롱 진입 금지
  if (direction === 'LONG') {
    const priceDir = currentData['price_dir_1h']; // 'UP','DOWN','FLAT'
    const oiDir = currentData['oi_dir_1h'];       // 'UP','DOWN','FLAT'
    
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

function resolveValue(field, data) {
  // 직접 필드
  if (data[field] !== undefined) return data[field];

  // 중첩 필드 (derivatives.funding_rate 등)
  const parts = field.split('.');
  let val = data;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

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
