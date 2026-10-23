import { CLASS_ORDER, DAMAGE_TYPES } from '../game.mjs';
import { powerValue, renderPowerText } from '../power.mjs';
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

    const render = template => renderPowerText(game, powerId, template);
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
      image: game.images.get(power.hIconNormal),
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
      cooldownSeconds: powerValue(game, powerId, power.tCooldownTime?.value) || undefined,
      luckyHitChance: powerValue(game, powerId, power.tCombatEffectChance?.value) ?? undefined,
      description: description.text || null,
      keywords: description.keywords,
      modifiers: mods,
      season: game.seasons.tag('Power', powerId),
    }));
  }

  return result.sort((a, b) => a.class.localeCompare(b.class) || byName(a, b));
}
