/**
 * Parser and evaluator for the game's formula strings, such as
 *   0.39+CurrentLegendaryRank()*0.01
 *   FloatRandomRangeWithIntervalUniqueAffixPityBonus(10, 40, 50)
 *   PowerTag.Barbarian_Earthquake."Script Formula 1" * (1 + SF_3)
 *
 * Evaluation runs at one end of every random range at a time: `pick` 0 takes
 * every roll at its low end and the lowest rank, `pick` 1 the high end. Doing
 * it this way keeps repeated uses of the same roll consistent, which plain
 * interval arithmetic would not. Callers evaluate both ends and sort them.
 *
 * Anything the evaluator can't know at build time (player stats, skill
 * ranks, server state) evaluates to null, and null spreads through the
 * expression.
 */

const cache = new Map();

export function parseFormula(source) {
  if (typeof source !== 'string') {
    return null;
  }

  if (!cache.has(source)) {
    let ast = null;

    try {
      ast = new Parser(tokenize(source)).parseAll();
    } catch {
      ast = null;
    }

    cache.set(source, ast);
  }

  return cache.get(source);
}

/**
 * ctx = {
 *   pick: 0 | 1,
 *   ident(name): number | null | undefined,   // undefined = unknown name
 *   call(name, args): number | null | undefined,
 * }
 */
export function evaluate(ast, ctx) {
  if (!ast) {
    return null;
  }

  switch (ast.type) {
    case 'num':
      return ast.value;
    case 'ident': {
      const value = ctx.ident?.(ast.name);
      return value === undefined ? null : value;
    }
    case 'unary': {
      const value = evaluate(ast.arg, ctx);
      if (value === null) return null;
      if (ast.op === '-') return -value;
      if (ast.op === '!') return value ? 0 : 1;
      return value;
    }
    case 'binary':
      return binary(ast.op, evaluate(ast.left, ctx), evaluate(ast.right, ctx));
    case 'ternary': {
      const test = evaluate(ast.test, ctx);

      if (test === null) {
        const a = evaluate(ast.then, ctx);
        const b = evaluate(ast.else, ctx);
        return a !== null && a === b ? a : null;
      }

      return evaluate(test ? ast.then : ast.else, ctx);
    }
    case 'call': {
      const args = ast.args.map(arg => evaluate(arg, ctx));
      const custom = ctx.call?.(ast.name, args, ast.args);

      if (custom !== undefined) {
        return custom;
      }

      return builtin(ast.name, args, ctx);
    }
    default:
      return null;
  }
}

/** Evaluates at both ends and returns { min, max } or null. */
export function evaluateRange(source, ctx) {
  const ast = typeof source === 'string' ? parseFormula(source) : source;
  const lo = evaluate(ast, { ...ctx, pick: 0 });
  const hi = evaluate(ast, { ...ctx, pick: 1 });

  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return null;
  }

  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/** True when the formula mentions any of the given identifiers or functions. */
export function mentions(source, names) {
  const ast = typeof source === 'string' ? parseFormula(source) : source;
  let found = false;

  walk(ast, node => {
    if ((node.type === 'ident' || node.type === 'call') && names.includes(node.name)) {
      found = true;
    }
  });

  return found;
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of [node.arg, node.left, node.right, node.test, node.then, node.else, ...(node.args || [])]) {
    walk(child, visit);
  }
}

function binary(op, a, b) {
  if (a === null || b === null) {
    return null;
  }

  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? null : a / b;
    case '%': return b === 0 ? null : a % b;
    case '^': return a ** b;
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '&&': return a && b ? 1 : 0;
    case '||': return a || b ? 1 : 0;
    default: return null;
  }
}

function builtin(name, args, ctx) {
  const lower = name.toLowerCase();
  const end = ctx.pick ? 1 : 0;
  const all = args.every(arg => arg !== null);

  switch (lower) {
    // (steps, min, max)
    case 'floatrandomrangewithinterval':
    case 'floatrandomrangewithintervaluniqueaffixpitybonus':
      return args.length >= 3 && args[1] !== null && args[2] !== null ? (end ? args[2] : args[1]) : null;
    // (sharedRoll, steps, min, max)
    case 'floatrangewithintervaluniqueaffixpitybonus':
      return args.length >= 4 && args[2] !== null && args[3] !== null ? (end ? args[3] : args[2]) : null;
    case 'randomint':
    case 'randomfloat':
    case 'rangefloat':
      return args.length >= 2 && args[0] !== null && args[1] !== null ? (end ? args[1] : args[0]) : null;
    case 'sharedrandomfloat':
      return end;
    case 'gettotalaffixbonus':
      return 1;
  }

  if (!all) {
    return null;
  }

  switch (lower) {
    case 'min': return args.length ? Math.min(...args) : null;
    case 'max': return args.length ? Math.max(...args) : null;
    case 'floor': return Math.floor(args[0]);
    case 'ceil': return Math.ceil(args[0]);
    case 'round': return Math.round(args[0]);
    case 'abs': return Math.abs(args[0]);
    case 'pow': return args[0] ** args[1];
    case 'sqrt': return Math.sqrt(args[0]);
    case 'clamp': return Math.min(Math.max(args[0], args[1]), args[2]);
    default: return null;
  }
}

function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const number = source.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?f?/);

    if (number) {
      tokens.push({ type: 'num', value: parseFloat(number[0]) });
      i += number[0].length;
      continue;
    }

    // Identifier path: Foo.Bar."Quoted Part"#Param
    const ident = source.slice(i).match(/^(?:[A-Za-z_][\w]*|"[^"]*")(?:\s*\.\s*(?:[A-Za-z_][\w]*|"[^"]*"))*(?:#[\w.]+)?/);

    if (ident) {
      const name = ident[0].replace(/\s*\.\s*/g, '.');
      tokens.push({ type: 'ident', value: name });
      i += ident[0].length;
      continue;
    }

    const op = source.slice(i).match(/^(==|!=|<=|>=|&&|\|\||[-+*/%^()<>?:,!])/);

    if (op) {
      tokens.push({ type: 'op', value: op[0] });
      i += op[0].length;
      continue;
    }

    throw new Error(`Unexpected "${ch}" in formula`);
  }

  return tokens;
}

const BINARY = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '^': 7,
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  expect(value) {
    const token = this.next();
    if (!token || token.value !== value) throw new Error(`Expected ${value}`);
  }

  parseAll() {
    const ast = this.parseTernary();
    if (this.pos !== this.tokens.length) throw new Error('Trailing tokens');
    return ast;
  }

  parseTernary() {
    const test = this.parseBinary(1);

    if (this.peek()?.value === '?') {
      this.next();
      const then = this.parseTernary();
      this.expect(':');
      return { type: 'ternary', test, then, else: this.parseTernary() };
    }

    return test;
  }

  parseBinary(minPrec) {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      const prec = token?.type === 'op' ? BINARY[token.value] : undefined;

      if (prec === undefined || prec < minPrec) {
        return left;
      }

      this.next();
      // ^ is right-associative.
      const right = this.parseBinary(token.value === '^' ? prec : prec + 1);
      left = { type: 'binary', op: token.value, left, right };
    }
  }

  parseUnary() {
    const token = this.peek();

    if (token?.type === 'op' && ['-', '+', '!'].includes(token.value)) {
      this.next();
      return { type: 'unary', op: token.value, arg: this.parseUnary() };
    }

    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.next();

    if (!token) throw new Error('Unexpected end');

    if (token.type === 'num') {
      return { type: 'num', value: token.value };
    }

    if (token.type === 'ident') {
      if (this.peek()?.value === '(') {
        this.next();
        const args = [];

        if (this.peek()?.value !== ')') {
          do {
            args.push(this.parseTernary());
          } while (this.peek()?.value === ',' && this.next());
        }

        this.expect(')');
        return { type: 'call', name: token.value, args };
      }

      return { type: 'ident', name: token.value };
    }

    if (token.value === '(') {
      const inner = this.parseTernary();
      this.expect(')');
      return inner;
    }

    throw new Error(`Unexpected ${token.value}`);
  }
}
