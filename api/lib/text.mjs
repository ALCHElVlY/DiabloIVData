/**
 * Turns the game's tooltip markup into plain text.
 *
 * Markup handled:
 *   {c_important}Berserking{/c}, {u}…{/u}, {b}…{/b}, {c:FF…}   colour/style tags (dropped)
 *   {icon:bullet, 1.2}                                            list bullet ("• ")
 *   {if:SF.IsMythic}…{else}…{/if}                                 branch chosen per item
 *   [Affix_Value_1*100|1%+|]                                      value placeholder
 *
 * Placeholder format flags (the part after the first "|"):
 *   digit  decimal places      %  percent sign      +  leading plus
 *   x      multiplicative bonus, shown as "[x]" like the in-game tooltip
 */

/**
 * @param {string} template
 * @param {object} options
 * @param {(expr: string) => ({min:number,max:number}|null)} options.value
 * @param {boolean} [options.mythic]
 * @param {Record<string,string>} [options.text]  text substitutions such as { VALUE1: 'Fire' }
 * @returns {{ text: string, keywords: string[], unresolved: string[] }}
 */
export function renderText(template, options = {}) {
  if (typeof template !== 'string' || template === '') {
    return { text: '', keywords: [], unresolved: [] };
  }

  const unresolved = [];
  let text = template.replace(/\r\n?/g, '\n');

  text = resolveConditionals(text, options);

  for (const [key, value] of Object.entries(options.text || {})) {
    text = text.replace(new RegExp(`\\{${key}\\}`, 'gi'), value);
  }

  // A bare {VALUE2} outside a placeholder is a value too.
  text = text.replace(/\[[^\[\]]*\]|\{(VALUE\d?)\}/gi, (whole, bare) => (bare ? `[{${bare}}]` : whole));

  text = text.replace(/\[([^\[\]]*)\]/g, (whole, inner, offset, all) => {
    // "[x]" and "[PH]" written literally in some strings.
    if (options.values === false || /^\s*(x|PH)\s*$/i.test(inner)) {
      return whole;
    }

    const [rawExpr, format = '', ...extra] = inner.split('|');
    let expr = rawExpr.trim();
    let scale = 1;

    for (const part of extra) {
      const scaled = part.trim().match(/^\*\s*([\d.]+)$/);
      if (scaled) scale *= Number(scaled[1]);
    }

    // "{VALUE}" style tokens inside the expression become identifiers.
    expr = expr.replace(/\{(VALUE\d?)\}/gi, (_, name) => `__${name.toUpperCase()}__`);

    // Quotes in the game data are often misplaced ("Static Value 0*100); rebuild them.
    expr = expr
      .replace(/"/g, '')
      .replace(/Affix\.\s*Affix[ _]Value[ _](\d+)/gi, 'Affix_Value_$1')
      .replace(/Affix\.\s*Static[ _]Value[ _](\d+)/gi, 'Affix."Static Value $1"')
      .replace(/\.\s*Script Formula (\d+)/gi, '."Script Formula $1"');

    const range = expr === '' ? null : options.value?.(expr);

    if (!range) {
      unresolved.push(rawExpr.trim());
      return `#${formatSuffix(format)}`;
    }

    if (range.weaponDamage) {
      return `(${formatRange({ min: range.min * 100 * scale, max: range.max * 100 * scale }, '%')} of weapon damage)`;
    }

    // "+[X|+%|]" would print the sign twice.
    const literalPlus = all[offset - 1] === '+' || /\+\s*\{c_[a-z]+\}$/i.test(all.slice(Math.max(0, offset - 20), offset));
    return formatRange({ min: range.min * scale, max: range.max * scale }, literalPlus ? format.replace(/[+~]/g, '') : format);
  });

  // A "[" left open by a typo in the game text.
  text = text.replace(/\[(?![^\[\]]*\])/g, '');

  const keywords = [];

  for (const match of text.matchAll(/\{c_important\}([\s\S]*?)\{\/c(?:_important)?\s*\}/gi)) {
    const clean = match[1].replace(/\{[^}]*\}/g, '').trim();
    if (clean && clean.length < 60) keywords.push(clean);
  }

  text = text
    .replace(/\{icon:\s*bullet[^}]*\}\s*/gi, '• ')
    .replace(/\{icon:[^}]*\}\s*/gi, '')
    .replace(/\{\/?(?:c|u|b|i)(?:[_:][^}]*)?\s*\}/gi, '')
    .replace(/\{\/?c_[^}]*\}/gi, '')
    .replace(/\{(?:Affix_Value_\d+)\}/gi, '#')
    // UI substitutions ({s1}) and branch markers left unbalanced in the source.
    .replace(/\{s\d+\}/gi, '#')
    .replace(/\{\/if\}|\{else\}/gi, '')
    // Plurals: "1 |4Shade Totem:Shade Totems;" -> "1 Shade Totem".
    .replace(/([\d][\d,.–]*|#)(\s*)\|4([^:;|\n]+):([^;|\n]+);/g, (_, n, space, one, many) => `${n}${space}${n === '1' ? one : many}`)
    // Single words without the closing ";" (some strings use ";" or "." as the separator).
    .replace(/([\d][\d,.–]*|#)(\s*)\|4([^:;\s]*)[:;]([^;\s.,)]*);?/g, (_, n, space, one, many) => `${n}${space}${n === '1' ? one : many}`)
    .replace(/\|4([^:;\s]*)[:;]([^;\s.,)]*);?/g, '$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { text, keywords: [...new Set(keywords.filter(Boolean))], unresolved };
}

/** Strips markup from a short label such as an item name. */
export function plainText(value) {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  return renderText(value, { values: false }).text;
}

export function formatRange(range, format = '') {
  const flags = parseFormat(format);
  const lo = formatNumber(range.min, flags.decimals);
  const hi = formatNumber(range.max, flags.decimals);
  const sign = flags.plus && range.min >= 0 ? '+' : '';
  const body = lo === hi ? lo : `${lo}–${hi}`;

  return `${sign}${body}${flags.percent ? '%' : ''}${flags.mult ? '[x]' : ''}`;
}

function formatSuffix(format) {
  const flags = parseFormat(format);
  return `${flags.percent ? '%' : ''}${flags.mult ? '[x]' : ''}`;
}

function parseFormat(format) {
  const digits = format.match(/\d/);

  // "~" is used on flat stats (Strength, Maximum Life): whole number with a sign.
  return {
    decimals: digits ? Number(digits[0]) : (format.includes('~') ? 0 : null),
    percent: format.includes('%'),
    plus: format.includes('+') || format.includes('~'),
    mult: /x/i.test(format),
  };
}

/** Rounds like the tooltip does; with no explicit precision, at most one decimal. */
export function formatNumber(value, decimals = null) {
  const places = decimals ?? 1;
  let rounded = Number(value.toFixed(places));
  // Don't round a real value away to 0; show two significant digits instead.
  if (rounded === 0 && value !== 0) rounded = Number(value.toPrecision(2));
  const text = rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(places, decimalsIn(rounded)),
  });

  return text === '-0' ? '0' : text;
}

function decimalsIn(value) {
  const text = String(value);
  return text.includes('e') ? 6 : (text.split('.')[1]?.length ?? 0);
}

function resolveConditionals(text, options) {
  // Innermost first, so nesting works.
  const pattern = /\{if:([^{}]*)\}((?:(?!\{if:)[\s\S])*?)\{\/if\}/i;
  let guard = 0;

  while (pattern.test(text) && guard++ < 200) {
    text = text.replace(pattern, (_, condition, body) => {
      const [then, otherwise = ''] = splitElse(body);
      return testCondition(condition.trim(), options) ? then : otherwise;
    });
  }

  return text;
}

function splitElse(body) {
  const index = body.search(/\{else\}/i);
  return index === -1 ? [body] : [body.slice(0, index), body.slice(index + '{else}'.length)];
}

function testCondition(condition, options) {
  const negated = condition.startsWith('!');
  const name = negated ? condition.slice(1) : condition;
  let result;

  if (/^SF\.IsMythic$/i.test(name)) {
    result = Boolean(options.mythic);
  } else if (options.condition) {
    result = options.condition(name);
  }

  // Unknown conditions show the first branch, which is the common case text.
  if (result === undefined) {
    return true;
  }

  return negated ? !result : result;
}
