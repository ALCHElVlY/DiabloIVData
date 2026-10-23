import { evaluate, mentions, parseFormula } from './formula.mjs';
import { plainText, renderText } from './text.mjs';

const WEAPON_DAMAGE = ['Owner.Weapon_Damage_Min_Total', 'Owner.Weapon_Damage_Delta_Total'];

const RANDOM_FUNCTIONS = [
  'FloatRandomRangeWithInterval',
  'FloatRandomRangeWithIntervalUniqueAffixPityBonus',
  'FloatRangeWithIntervalUniqueAffixPityBonus',
  'SharedRandomFloat',
  'RandomInt',
  'RandomFloat',
];

/**
 * Resolves one AffixDefinition into readable values and text.
 *
 * options:
 *   itemPower  pick the AttributeFormulas bracket for this item power (default: highest)
 *   mythic     choose the {if:SF.IsMythic} branch
 *   rank       { min, max } legendary rank range (default 1..arMaxLegendaryRanks[0])
 */
export function describeAffix(game, affix, options = {}) {
  if (!affix) return null;

  const name = affixName(affix);
  const attributes = affix.ptItemAffixAttributes || [];
  const statics = affix.arStaticValues || [];
  const rankCaps = affix.arMaxLegendaryRanks || [];
  const usesRank = attributes.some(a => mentions(a.tAttribute?.szAttributeFormula?.value, ['CurrentLegendaryRank']));
  const rank = options.rank ?? { min: 1, max: Math.max(1, rankCaps[0] || 1) };

  const memo = [new Map(), new Map()];

  const staticValue = index => (index < statics.length ? Number(statics[index]) : null);

  const affixIdent = (identifier, pick, current) => {
    let m;

    if ((m = identifier.match(/^Affix_Value_(\d+)$/i))) return attributeValue(Number(m[1]) - 1, pick);
    if ((m = identifier.match(/^Affix_Flat_Value_(\d+)$/i))) return flatValue(Number(m[1]) - 1, pick);
    if ((m = identifier.match(/^Affix\."?Static[ _]Value[ _](\d+)"?$/i))) return staticValue(Number(m[1]));
    if ((m = identifier.match(/^__VALUE(\d?)__$/))) return current ? current(pick) : null;
    if (identifier === 'S14_Mythic_UniquePotency') return 0;
    if (/^(Owner|SF|Mod|Target|Player)\./i.test(identifier)) return null;

    const tag = game.resolvePowerTag(identifier, pick);
    if (tag !== undefined) return tag;

    // A bare attribute name refers to this affix's attribute of that name.
    const index = attributes.findIndex(a => {
      const attrName = a.tAttribute?.__eAttribute_name__;
      return attrName && (identifier === attrName || identifier.startsWith(`${attrName}#`));
    });

    if (index !== -1) return attributeValue(index, pick);

    return undefined;
  };

  const call = (fn, args, pick) => {
    if (fn === 'CurrentLegendaryRank') return pick ? rank.max : rank.min;
    if (fn === 'ExpectedLevelForIPower') return null;
    // Ancestral items scale some powers up; values here are for the base item.
    if (fn === 'AncestralAffixScalarOffense' || fn === 'AncestralAffixScalarDefense') return 1;
    if (fn === 'IPower') return options.itemPower ?? null;
    if (fn === 'Pin') return args.every(a => a !== null) ? Math.min(Math.max(args[0], args[1]), args[2]) : null;
    return undefined;
  };

  const context = (pick, current) => ({
    pick,
    ident: id => affixIdent(id, pick, current),
    call: (fn, args) => call(fn, args, pick),
  });

  function attributeFormula(index) {
    const tAttribute = attributes[index]?.tAttribute;
    if (!tAttribute) return null;

    if (tAttribute.gbidFormula?.name) {
      const brackets = game.attributeFormula(tAttribute.gbidFormula.name);
      if (brackets?.length) {
        const power = options.itemPower ?? Infinity;
        const usable = brackets.filter(b => b.itemPower <= power);
        return (usable.at(-1) ?? brackets[0]).formula;
      }
    }

    return tAttribute.szAttributeFormula?.value ?? null;
  }

  function attributeValue(index, pick) {
    if (memo[pick].has(index)) return memo[pick].get(index);
    memo[pick].set(index, null); // cycle guard
    const value = evaluate(parseFormula(attributeFormula(index)), context(pick));
    memo[pick].set(index, value);
    return value;
  }

  function flatValue(index, pick) {
    const source = attributes[index]?.tAttribute?.szFlatAttribLevelFormula?.value;
    return evaluate(parseFormula(source), context(pick));
  }

  const rangeOf = (fn) => {
    const lo = fn(0);
    const hi = fn(1);
    if (lo === null || hi === null || lo === undefined || hi === undefined || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return { min: round(Math.min(lo, hi)), max: round(Math.max(lo, hi)) };
  };

  // ---- values ----------------------------------------------------------------

  const values = attributes.map((entry, index) => {
    const tAttribute = entry.tAttribute || {};
    const attribute = tAttribute.__eAttribute_name__ ?? `Attribute_${tAttribute.eAttribute}`;
    const param = game.attributeParam(attribute, tAttribute.nParam);
    const formula = attributeFormula(index);
    const range = rangeOf(pick => attributeValue(index, pick));
    const value = { attribute, ...(param ? { param: param.name } : {}), ...(range || { min: null, max: null }) };

    if (tAttribute.gbidFormula?.name) {
      value.scaling = 'itemPower';
      value.formulaTable = tAttribute.gbidFormula.name;
      value.byItemPower = (game.attributeFormula(tAttribute.gbidFormula.name) || []).map(b => {
        const r = rangeOf(pick => evaluate(parseFormula(b.formula), context(pick)));
        return { fromItemPower: b.itemPower, ...(r || { min: null, max: null }) };
      });
    } else if (mentions(formula, ['CurrentLegendaryRank'])) {
      value.scaling = 'rank';
    } else if (mentions(formula, RANDOM_FUNCTIONS)) {
      value.scaling = 'roll';
    } else {
      value.scaling = 'fixed';
    }

    if (entry.bLowerIsBetter) value.lowerIsBetter = true;
    value.formula = formula;

    return value;
  });

  // ---- description -----------------------------------------------------------

  const strings = game.repo.strings('Affix', name);
  const template = strings?.Desc ?? strings?.desc ?? null;
  const valueOf = (current) => (expr) => {
    const ast = parseFormula(expr);
    if (!ast) return null;

    // "(weapon min + weapon delta) * X" is a damage number from the player's
    // weapon; report X as a share of weapon damage instead.
    if (mentions(ast, WEAPON_DAMAGE)) {
      const weaponContext = pick => {
        const base = context(pick, current);
        return {
          ...base,
          ident: id => {
            if (id === 'Owner.Weapon_Damage_Min_Total') return 1;
            if (id === 'Owner.Weapon_Damage_Delta_Total') return 0;
            if (id === 'Owner.Main_Hand_Damage_Percent_Bonus' || id.startsWith('Owner.Bonus_Percent_Per_Power')) return 0;
            return base.ident(id);
          },
        };
      };
      const range = rangeOf(pick => evaluate(ast, weaponContext(pick)));
      return range ? { ...range, weaponDamage: true } : null;
    }

    return rangeOf(pick => evaluate(ast, context(pick, current)));
  };

  let rendered;
  let rawTemplate;

  if (template) {
    rawTemplate = template;
    rendered = renderText(template, { value: valueOf(pick => attributeValue(0, pick)), mythic: options.mythic });
  } else {
    // Plain stat affixes have no text of their own; build it from AttributeDescriptions.
    const lines = [];
    const raw = [];
    const keywords = [];
    const unresolved = [];

    attributes.forEach((entry, index) => {
      const attribute = entry.tAttribute?.__eAttribute_name__;
      const param = game.attributeParam(attribute, entry.tAttribute?.nParam);
      const line = game.attributeTemplate(attribute, param?.key);
      if (!line) return;

      const current = pick => attributeValue(index, pick);
      const out = renderText(line, {
        value: valueOf(current),
        mythic: options.mythic,
        // Without a parameter, {VALUE1} is the value itself.
        text: param ? { VALUE1: param.name } : {},
      });

      raw.push(line);
      lines.push(out.text);
      keywords.push(...out.keywords);
      unresolved.push(...out.unresolved);
    });

    rawTemplate = raw.length ? raw.join('\n') : null;
    rendered = { text: lines.join('\n'), keywords: [...new Set(keywords)], unresolved };
  }

  const result = {
    id: name,
    snoId: affix.__snoID__,
    name: strings?.Name ? plainText(strings.Name) : null,
    description: rendered.text || null,
    keywords: rendered.keywords,
    values,
  };

  if (rawTemplate) result.descriptionMarkup = rawTemplate;
  if (rendered.unresolved.length) result.unresolvedValues = [...new Set(rendered.unresolved)];

  if (usesRank) {
    result.ranks = { min: rank.min, max: rank.max, caps: rankCaps.filter(Boolean) };
    result.byRank = byRank(rank, values, attributes, (r, i, pick) => {
      const saved = { ...rank };
      rank.min = r;
      rank.max = r;
      memo[0].clear();
      memo[1].clear();
      const v = attributeValue(i, pick);
      Object.assign(rank, saved);
      memo[0].clear();
      memo[1].clear();
      return v;
    });
  }

  return result;
}

function byRank(rank, values, attributes, valueAt) {
  const result = [];

  for (let r = rank.min; r <= rank.max; r++) {
    result.push({
      rank: r,
      values: values.map((v, i) => {
        if (v.scaling !== 'rank') return { attribute: v.attribute, min: v.min, max: v.max };
        const lo = valueAt(r, i, 0);
        const hi = valueAt(r, i, 1);
        return { attribute: v.attribute, min: lo === null ? null : round(Math.min(lo, hi)), max: hi === null ? null : round(Math.max(lo, hi)) };
      }),
    });
  }

  return result;
}

export function affixName(affix) {
  const file = affix?.__fileName__ || '';
  return file.split('/').pop().replace(/\.[^.]+$/, '');
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
