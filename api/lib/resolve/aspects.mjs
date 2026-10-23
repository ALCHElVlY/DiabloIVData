import { describeAffix } from '../affix.mjs';
import { byName, compact, seasons, text } from './common.mjs';

const SOURCE = { 0: 'drop', 2: 'dungeon', 4: 'seasonJourney' };

/**
 * Legendary aspects with their affix, text, values, slots and where the
 * Codex of Power entry comes from, merged from Aspect, Affix, Power,
 * TrackedReward, StringList and AttributeFormulas.
 */
export function resolveAspects(game) {
  const { repo } = game;
  const unlocks = codexUnlocks(game);
  const result = [];

  for (const id of repo.names('Aspect')) {
    const aspect = repo.get('Aspect', id);
    const affixRef = aspect?.snoAffix;
    const affix = repo.deref(affixRef);

    if (!affix) continue;

    const described = describeAffix(game, affix);
    const strings = repo.strings('Affix', affixRef.name);
    const classes = game.classes(affix.fAllowedForPlayerClass);
    const slots = game.itemLabelNames(affix.arAllowedItemLabels);

    result.push(compact({
      id,
      snoId: aspect.__snoID__,
      name: game.aspectName(strings?.Name) ?? id,
      class: classes.length === 1 ? classes[0] : (classes.length ? null : 'Generic'),
      classes,
      category: game.aspectCategory(affix),
      slots,
      description: described.description,
      descriptionMarkup: described.descriptionMarkup,
      keywords: described.keywords,
      values: described.values,
      ranks: described.ranks,
      byRank: described.byRank,
      codex: unlocks.get(id),
      skillTags: (affix.arAffixSkillTags || []).map(tag => tag?.name).filter(Boolean),
      itemPower: { min: affix.nItemPowerMin, max: affix.nItemPowerMax },
      affix: affixRef.name,
      passivePower: affix.snoPassivePower?.name,
      seasons: seasons(affix.tRequirementsToBeActive),
      unresolvedValues: described.unresolvedValues,
    }));
  }

  return result.sort(byName);
}

/** Aspect id -> { source, dungeon } from TrackedReward records. */
function codexUnlocks(game) {
  const { repo } = game;
  const map = new Map();

  for (const id of repo.names('TrackedReward')) {
    const reward = repo.get('TrackedReward', id);
    const aspect = reward?.snoAspect?.name;

    if (!aspect) continue;

    const entry = { source: SOURCE[reward.eSource] ?? String(reward.eSource) };

    // TR_ASP_Step_Mournfield -> World DGN_Step_Mournfield.
    if (reward.eSource === 2 && id.startsWith('TR_ASP_')) {
      const world = `DGN_${id.slice('TR_ASP_'.length)}`;
      const strings = repo.strings('World', world);

      if (strings?.Name) {
        entry.dungeon = { id: world, name: text(strings.Name) };
      }
    }

    // Prefer the most specific record when an aspect has several.
    const existing = map.get(aspect);
    if (!existing || (!existing.dungeon && entry.dungeon) || existing.source === 'seasonJourney') {
      map.set(aspect, entry);
    }
  }

  return map;
}
