import { evaluate, parseFormula } from '../formula.mjs';
import { CLASS_ORDER, DAMAGE_TYPES } from '../game.mjs';
import { renderText } from '../text.mjs';
import { byName, compact, text } from './common.mjs';

/** SkillTreeReward.eType */
const REWARD_KIND = { 0: 'active', 1: 'modifier', 2: 'passive' };

/** SkillKit file per class (Paladin's is named Paladin_NEW). */
const SKILL_KITS = {
  Barbarian: 'Barbarian', Druid: 'Druid', Necromancer: 'Necromancer', Paladin: 'Paladin_NEW',
  Rogue: 'Rogue', Sorcerer: 'Sorcerer', Spiritborn: 'Spiritborn', Warlock: 'Warlock',
};

/**
 * Class skills and passives from each class SkillKit + SkillTreeRewards,
 * with names, tags, cost and descriptions from the Power records.
 *
 * Numbers are shown at skill rank 1 with no upgrades or items. Damage
 * numbers that the game computes per character ({payload:…}) show as "#".
 */
export function resolveSkills(game) {
  const { repo } = game;
  const rewards = new Map(repo.balance('SkillTreeRewards').map(r => [r.tHeader?.szName, r]));
  const tables = repo.balance('PowerFormulaTables').map(t => t.flValue || []);
  const skills = new Map();

  for (const className of CLASS_ORDER) {
    const kit = repo.get('SkillKit', SKILL_KITS[className]);
    if (!kit) continue;

    const add = (powerId, info) => {
      if (!powerId) return;
      const existing = skills.get(powerId);
      if (existing) {
        existing.requiredLevel = Math.min(existing.requiredLevel ?? Infinity, info.requiredLevel ?? Infinity);
        if (!Number.isFinite(existing.requiredLevel)) delete existing.requiredLevel;
        return;
      }
      skills.set(powerId, { className, ...info });
    };

    for (const entry of kit.arActiveSkillEntries || []) {
      add(entry.snoPower?.name, { kind: 'active', requiredLevel: entry.nLevelReq || undefined });
    }

    // Talent/passive rewards that no skill-tree node points at in this build.
    for (const [header, reward] of rewards) {
      if (reward.eType !== 2 || !reward.snoPower?.name) continue;
      if (!header.startsWith(`${className}_`) && !header.startsWith(`${SKILL_KITS[className]}_`)) continue;
      add(reward.snoPower.name, { kind: 'passive', maxRank: reward.dwMaxTalentRanks || undefined, inSkillTree: false });
    }

    for (const node of kit.arNodes || []) {
      const reward = rewards.get(node.gbidReward?.name);
      if (!reward?.snoPower?.name || reward.eType === 1) continue;
      skills.get(reward.snoPower.name) && delete skills.get(reward.snoPower.name).inSkillTree;
      add(reward.snoPower.name, {
        kind: REWARD_KIND[reward.eType] ?? 'other',
        maxRank: reward.dwMaxTalentRanks || undefined,
        requiredLevel: node.dwNodeRequiredPlayerLevel || undefined,
      });
    }
  }

  const result = [];

  for (const [powerId, info] of skills) {
    const power = repo.get('Power', powerId);
    const strings = repo.strings('Power', powerId);
    if (!power || !strings) continue;

    const render = template => renderPowerText(game, powerId, power, template, tables);
    const description = render(strings.desc ?? strings.Desc);
    const mods = Object.keys(strings)
      .map(label => label.match(/^Mod(\d+)_Name$/))
      .filter(Boolean)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(match => {
        const d = render(strings[`Mod${match[1]}_Description`]);
        return compact({ name: text(strings[match[0]]), description: d.text || null });
      });

    result.push(compact({
      id: powerId,
      snoId: power.__snoID__,
      name: text(strings.name ?? strings.Name) ?? powerId,
      class: info.className,
      kind: info.kind,
      category: game.skillTagName(power.tPrimaryTag?.gbidSkillTag?.name) ?? undefined,
      tags: (power.arSkillTags || [])
        .filter(t => t?.gbidSkillTag && !t.bSearchOnly)
        .map(t => game.skillTagName(t.gbidSkillTag.name) ?? t.gbidSkillTag.name),
      searchTags: (power.arSkillTags || [])
        .filter(t => t?.gbidSkillTag && t.bSearchOnly)
        .map(t => t.gbidSkillTag.name),
      damageType: power.eDamageType >= 0 ? DAMAGE_TYPES[power.eDamageType] : undefined,
      requiredLevel: info.requiredLevel,
      maxRank: info.maxRank,
      inSkillTree: info.inSkillTree,
      cooldownSeconds: rank1(game, powerId, power.tCooldownTime?.value, tables) || undefined,
      luckyHitChance: rank1(game, powerId, power.tCombatEffectChance?.value, tables) ?? undefined,
      description: description.text || null,
      keywords: description.keywords,
      modifiers: mods,
    }));
  }

  return result.sort((a, b) => a.class.localeCompare(b.class) || byName(a, b));
}

function powerContext(game, powerId, tables) {
  return {
    pick: 0,
    ident: name => {
      const sf = name.match(/^SF_(\d+)$/);
      if (sf) return evalFormula(game, powerId, game.repo.get('Power', powerId)?.ptScriptFormulas?.[Number(sf[1])]?.tFormula?.value, tables);
      if (name === 'sLevel') return 1;
      // Not upgraded, no item equipped.
      if (/^Mod\./.test(name) || /^Affix_Value_\d+#/.test(name)) return 0;
      const tag = game.resolvePowerTag(name, 0);
      return tag === undefined ? null : tag;
    },
    call: (fn, args) => {
      if (fn === 'Table') {
        const table = tables[args[0]];
        return table && args[1] !== null ? table[Math.min(Math.max(0, args[1]), table.length - 1)] ?? null : null;
      }
      if (fn === 'AffixIsEquipped' || fn === 'ItemIsEquipped' || fn === 'ParagonNodeIsPurchased' || fn === 'ParagonGlyphAffixIsActive') return 0;
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

function rank1(game, powerId, source, tables) {
  const value = evalFormula(game, powerId, source, tables);
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 1e4) / 1e4;
}

function renderPowerText(game, powerId, power, template, tables) {
  if (!template) return { text: '', keywords: [], unresolved: [] };

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
    // Inside a placeholder these are identifiers; outside, values of their own.
    .replace(/\[[^\[\]]*\]|\{(SF_\d+|Script Formula \d+|Combat Effect Chance|Resource Cost|Cooldown Time|Recharge Time|Charges)\}/gi, (whole, bare) => {
      if (bare) {
        const formula = formulaFor(bare);
        return formula ? `[${formula}]` : '#';
      }
      return whole.replace(token, (_, name) => formulaFor(name) ?? '0');
    })
    // Per-character numbers such as {payload:DAMAGE} or {dot:…}.
    .replace(/\{(?!if:|icon:|c:)[a-z]+:[^}]*\}/gi, '#');

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
