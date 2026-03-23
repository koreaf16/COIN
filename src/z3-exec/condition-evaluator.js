/**
 * Z3 Condition Evaluator — JSON 조건 파서/평가기
 *
 * execution_plan.entry_conditions JSON을 현재 데이터와 대조.
 * 지원 연산자: <, >, <=, >=, ==, in
 */

export function evaluateConditions(conditions, currentData) {
  if (!conditions || typeof conditions !== 'object') return { met: false, details: [] };

  const details = [];
  let allMet = true;

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
