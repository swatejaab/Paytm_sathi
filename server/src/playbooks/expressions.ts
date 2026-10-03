// A tiny, safe expression language for declarative playbooks. No eval: a hand-written parser over
// numbers, strings, fact names, dotted paths, + - * /, comparisons, && ||, and a fixed function list.

type Value = number | string | boolean | null;
export type Scope = Record<string, unknown>;

const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  max: (...args) => Math.max(...args.map(Number)),
  min: (...args) => Math.min(...args.map(Number)),
  round: (value) => Math.round(Number(value)),
  days_between: (from, to) =>
    Math.round((Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)) / 86_400_000),
};

type Token = { type: 'num' | 'str' | 'id' | 'op' | 'punc'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|([A-Za-z_][\w.]*)|(&&|\|\||==|!=|>=|<=|[-+*/<>!])|([(),]))/y;
  let index = 0;
  while (index < source.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match || match[0].length === 0) {
      if (/^\s*$/.test(source.slice(index))) break;
      throw new Error(`Unexpected input in expression at "${source.slice(index, index + 12)}"`);
    }
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'num', value: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: 'str', value: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: 'id', value: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'op', value: match[4] });
    else if (match[5] !== undefined) tokens.push({ type: 'punc', value: match[5] });
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };

function resolvePath(scope: Scope, path: string): Value {
  let current: unknown = scope;
  for (const part of path.split('.')) {
    // Own properties only, so names like "constructor" or "__proto__" never reach the prototype chain.
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      throw new Error(`Unknown name "${path}" in expression`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || ['number', 'string', 'boolean'].includes(typeof current)) return current as Value;
  throw new Error(`"${path}" is not a scalar value`);
}

export function evaluate(source: string, scope: Scope): Value {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const primary = (): Value => {
    const token = next();
    if (!token) throw new Error('Unexpected end of expression');
    if (token.type === 'num') return Number(token.value);
    if (token.type === 'str') return token.value;
    if (token.type === 'op' && token.value === '-') return -Number(primary());
    if (token.type === 'op' && token.value === '!') return !primary();
    if (token.type === 'punc' && token.value === '(') {
      const value = binary(0);
      if (next()?.value !== ')') throw new Error('Missing ")"');
      return value;
    }
    if (token.type === 'id') {
      if (token.value === 'true' || token.value === 'false') return token.value === 'true';
      if (peek()?.value === '(') {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error(`Unknown function "${token.value}"`);
        next();
        const args: Value[] = [];
        while (peek()?.value !== ')') {
          args.push(binary(0));
          if (peek()?.value === ',') next();
        }
        next();
        return fn(...args);
      }
      return resolvePath(scope, token.value);
    }
    throw new Error(`Unexpected "${token.value}" in expression`);
  };

  const binary = (minPrecedence: number): Value => {
    let left = primary();
    for (;;) {
      const operator = peek();
      const precedence = operator?.type === 'op' ? PRECEDENCE[operator.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) break;
      next();
      const right = binary(precedence + 1);
      const a = left as never;
      const b = right as never;
      switch (operator!.value) {
        case '+': left = Number(a) + Number(b); break;
        case '-': left = Number(a) - Number(b); break;
        case '*': left = Number(a) * Number(b); break;
        case '/': left = Number(b) === 0 ? 0 : Number(a) / Number(b); break;
        case '<': left = a < b; break;
        case '>': left = a > b; break;
        case '<=': left = a <= b; break;
        case '>=': left = a >= b; break;
        case '==': left = a === b; break;
        case '!=': left = a !== b; break;
        case '&&': left = Boolean(a) && Boolean(b); break;
        case '||': left = Boolean(a) || Boolean(b); break;
      }
    }
    return left;
  };

  const result = binary(0);
  if (position < tokens.length) throw new Error(`Unexpected "${tokens[position]!.value}" in expression`);
  return result;
}

// "{name}" placeholders in text; numbers are shown Indian-style.
export function renderTemplate(template: string, scope: Scope): string {
  return template.replace(/\{([\w.]+)\}/g, (_, path: string) => {
    const value = resolvePath(scope, path);
    return typeof value === 'number' ? Math.round(value).toLocaleString('en-IN') : String(value);
  });
}

// "=expr" evaluates, "{path}" renders, anything else is literal.
export function resolveInputValue(value: unknown, scope: Scope): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('=')) return evaluate(value.slice(1), scope);
  return /\{[\w.]+\}/.test(value) ? renderTemplate(value, scope) : value;
}
