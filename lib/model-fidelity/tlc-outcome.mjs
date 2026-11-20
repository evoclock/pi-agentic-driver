// Classifies captured TLC evidence. Execution and artifact publication belong to T06b.
const completed = /Model checking completed\. No error has been found\./;
const violation = /Error: (?:Invariant|Temporal property|Property) ([A-Za-z][A-Za-z0-9_]*) is violated\./g;
const trace = /(?:The behavior up to this point is:|The following behavior constitutes a counter-example:)[\s\S]*?State 1:/;
const limit = /(?:Too many states|maximum number of states|State space limit exceeded)/i;

export function classifyTlcOutcome(input) {
  const {
    stdout = '', stderr = '', exitCode = null, signal = null, errorCode = null,
    timedOut = false, truncated = false, stateLimitHit = false,
    budgetExhausted = false, properties = [],
  } = input;
  if (!Array.isArray(properties) || properties.some(p => typeof p !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(p)) || new Set(properties).size !== properties.length) {
    throw new TypeError('properties must be unique TLC property names');
  }
  const output = `${stdout}\n${stderr}`;
  const named = [...output.matchAll(violation)].map(match => match[1]);
  const hasTrace = trace.test(output);
  const completedRun = exitCode === 0 && !signal && !errorCode && !timedOut && !truncated && !stateLimitHit && !budgetExhausted;
  let status;
  if (budgetExhausted && !stdout && !stderr && exitCode === null) status = 'not-run';
  else if (errorCode === 'ENOENT' || errorCode === 'JAVA_UNAVAILABLE' || errorCode === 'CHECKER_UNAVAILABLE') status = 'unavailable';
  else if (timedOut || truncated || stateLimitHit || budgetExhausted || limit.test(output)) status = 'incomplete';
  else if (named.length && hasTrace && exitCode !== null && !signal && !errorCode) status = 'counterexample';
  else if (completedRun && completed.test(output) && !/Error:/.test(output)) status = 'no-counterexample';
  else if (exitCode !== null || errorCode) status = 'error';
  else status = 'incomplete';

  const violated = status === 'counterexample' ? [...new Set(named)] : [];
  const checked = status === 'no-counterexample' ? [...properties] : violated.filter(name => properties.includes(name));
  const unchecked = properties.filter(name => !checked.includes(name));
  return {
    status,
    completion: status === 'no-counterexample' || status === 'counterexample' ? 'completed' : status === 'not-run' ? 'not-run' : 'incomplete',
    properties: properties.map(name => ({ name, status: status === 'no-counterexample' ? 'no-counterexample' : checked.includes(name) ? 'counterexample' : 'unchecked' })),
    checked, unchecked,
    counterexampleProperties: violated,
    limits: { timeout: Boolean(timedOut), output: Boolean(truncated), states: Boolean(stateLimitHit || limit.test(output)), budget: Boolean(budgetExhausted) },
    exitCode, signal, errorCode,
  };
}
