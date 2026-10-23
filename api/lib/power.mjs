import { evaluate, parseFormula } from './formula.mjs';
import { renderText } from './text.mjs';

/** PowerFormulaTables rows, for Table(index, level) lookups. */
export function powerTables(game) {
  if (!game._powerTables) game._powerTables = game.repo.balance('PowerFormulaTables').map(t => t.flValue || []);
  return game._powerTables;
}

function powerContext(game, powerId, tables) {
  return {
    pick: 0,
    ident: name => {
      const sf = name.match(/^SF_(\d+)$/);
      if (sf) return evalFormula(game, powerId, game.repo.get('Power', powerId)?.ptScriptFormulas?.[Number(sf[1])]?.tFormula?.value, tables);
      if (name === 'sLevel') return 1;
      // Not upgraded, no item equipped.
      if (/^Mod\./.test(name) || /^Affix_Value_\d+#/.test(name) || /_Equipped$/.test(name) || /^Socketable_Potency_/.test(name)) return 0;
      const tag = game.resolvePowerTag(name, 0);
      return tag === undefined ? null : tag;
    },
    call: (fn, args) => {
      if (fn === 'Table') {
        const table = tables[args[0]];
        return table && args[1] !== null ? table[Math.min(Math.max(0, args[1]), table.length - 1)] ?? null : null;
      }
      if (fn === 'AffixIsEquipped' || fn === 'ItemIsEquipped' || fn === 'ParagonNodeIsPurchased' || fn === 'ParagonGlyphAffixIsActive') return 0;
      // Seasonal powers at rank 1 in the first slot.
      if (fn === 'GetCollectiblePowerLevel') return 1;
      if (fn === 'GetCollectiblePowerEquippedSlotIndex') return 0;
      return undefined;
    },
  };
}

const depth = { n: 0 };

function evalFormula(game, powerId, source, tables) {
  if (!source || depth.n > 12) return null;
  depth.n++;
  try {
    return evaluate(parseFormula(source), powerContext(game, powerId, tables));
  } finally {
    depth.n--;
  }
}

/** A power formula's value at rank 1, rounded, or null. */
export function powerValue(game, powerId, source) {
  const value = evalFormula(game, powerId, source, powerTables(game));
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 1e4) / 1e4;
}

/**
 * Renders a Power's tooltip text (skills, paragon nodes, glyph bonuses,
 * seasonal powers). Numbers are at rank 1 with no upgrades or items;
 * per-character numbers ({payload:…}, {dot:…}) become "#".
 */
export function renderPowerText(game, powerId, template) {
  if (!template) return { text: '', keywords: [], unresolved: [] };

  const tables = powerTables(game);
  const power = game.repo.get('Power', powerId) || {};

  const cost = power.arResourceCosts?.[0];
  const costFormula = [cost?.tInitialCost?.value, cost?.tChannellingCost?.value].find(v => v && v !== '0');
  const luckyHit = power.tCombatEffectChance?.value;

  // Named values a tooltip can mention, as formulas.
  const named = {
    'combat effect chance': luckyHit,
    'resource cost': costFormula,
    'cooldown time': power.tCooldownTime?.value,
    'recharge time': power.tRechargeTime?.value,
    'charges': power.tMaxCharges?.value,
  };
  const token = /\{(SF_\d+|Script Formula \d+|Combat Effect Chance|Resource Cost|Cooldown Time|Recharge Time|Charges)\}/gi;
  const formulaFor = name => {
    const sf = name.match(/^(?:SF_|Script Formula )(\d+)$/i);
    return sf ? `SF_${sf[1]}` : named[name.toLowerCase()] ? `(${named[name.toLowerCase()]})` : null;
  };

  const prepared = template
    // {SF_4|1|} is a placeholder written with braces.
    .replace(/\{(SF_\d+)(\|[^{}]*)\}/g, '[$1$2]')
    // Inside a placeholder these are identifiers; outside, values of their own.
    .replace(/\[[^\[\]]*\]|\{(SF_\d+|Script Formula \d+|Combat Effect Chance|Resource Cost|Cooldown Time|Recharge Time|Charges)\}/gi, (whole, bare) => {
      if (bare) {
        const formula = formulaFor(bare);
        return formula ? `[${formula}]` : '#';
      }
      return whole.replace(token, (_, name) => formulaFor(name) ?? '0');
    })
    // Per-character numbers such as {payload:DAMAGE} or {dot:…}.
    .replace(/\{(?!if:|icon:|c:)[a-z_]+:[^}]*\}/gi, '#');

  return renderText(prepared, {
    value: expr => {
      const v = evalFormula(game, powerId, expr, tables);
      return v === null || !Number.isFinite(v) ? null : { min: v, max: v };
    },
    condition: name => {
      if (/^ADVANCED_TOOLTIP$/i.test(name)) return true;
      if (/^Mod\./.test(name)) return false;
      if (/^SF_\d+$/.test(name)) {
        const v = evalFormula(game, powerId, name, tables);
        return v === null ? undefined : Boolean(v);
      }
      return undefined;
    },
  });
}
