import { describeAffix } from '../affix.mjs';
import { CLASS_ORDER, RESOURCE_TYPES } from '../game.mjs';
import { byName, compact } from './common.mjs';
import { lootPools } from './bosses.mjs';

export function resolveClasses(game) {
  return CLASS_ORDER.map((name, index) => {
    const record = game.repo.get('PlayerClass', name);
    return compact({
      id: name,
      snoId: record?.__snoID__,
      index,
      name: game.nameOf('PlayerClass', name) ?? name,
      resource: RESOURCE_TYPES[record?.tPrimaryResource?.eType],
    });
  });
}

export function resolveItemTypes(game) {
  const { repo } = game;

  return repo.names('ItemType').map(id => {
    const type = repo.get('ItemType', id);
    return compact({
      id,
      snoId: type?.__snoID__,
      name: game.nameOf('ItemType', id) ?? id,
      labels: game.itemLabelNames(type?.arItemLabels),
      classes: game.classes(type?.fUsableByClass),
      season: game.seasons.tag('ItemType', id, { requirements: type?.tRequirementsToBeActive }),
    });
  }).sort(byName);
}

/** Every affix: legendary/unique powers, stat rolls, tempers, runes, … */
export function resolveAffixes(game, items = []) {
  const { repo } = game;
  const result = [];

  // An affix that only season-only items use is season-only too.
  const usedBy = new Map();
  for (const item of items) {
    for (const affix of [item.power, ...(item.affixes || []), ...(item.implicitAffixes || [])]) {
      if (!affix?.id) continue;
      if (!usedBy.has(affix.id)) usedBy.set(affix.id, []);
      usedBy.get(affix.id).push(item.season);
    }
  }

  for (const id of repo.names('Affix')) {
    const affix = repo.get('Affix', id);
    if (!affix) continue;

    const d = describeAffix(game, affix);

    result.push(compact({
      ...d,
      byRank: undefined,
      family: affix.gbidAffixFamily?.name,
      classes: game.classes(affix.fAllowedForPlayerClass),
      slots: game.itemLabelNames(affix.arAllowedItemLabels),
      category: affix.eMagicType === 1 ? game.aspectCategory(affix) : undefined,
      tempered: affix.bIsTemperedAffix ? true : undefined,
      itemPower: { min: affix.nItemPowerMin, max: affix.nItemPowerMax },
      skillTags: (affix.arAffixSkillTags || []).map(tag => tag?.name).filter(Boolean),
      passivePower: affix.snoPassivePower?.name,
      season: affixSeason(game, id, usedBy.get(id)),
    }));
  }

  return result;
}

function affixSeason(game, id, itemSeasons) {
  const own = game.seasons.tag('Affix', id);
  if (own.seasonal || !itemSeasons?.length || !itemSeasons.every(s => s?.seasonal)) return own;

  const seasons = [...new Set(itemSeasons.flatMap(s => s.seasons || []))].sort((a, b) => a - b);
  return compact({
    seasonal: true,
    seasons,
    current: seasons.includes(game.seasons.current) || undefined,
    source: ['usedOnlyBySeasonalItems'],
    introducedInSeason: own.introducedInSeason,
  });
}

/**
 * Loot information that exists in the client data. The game's treasure
 * classes (drop tables with weights) are server-side and not part of the
 * files, so this is: unique pools per boss/source, and boss hoard chests.
 */
export function resolveLoot(game, bosses) {
  return {
    note: 'Treasure-class drop tables are server-side and not in the game files. '
      + 'Pools list the uniques tagged for each source (ItemFamilies); chests list what opening a hoard costs.',
    pools: lootPools(game),
    chests: bosses.flatMap(boss => (boss.chests || []).map(chest => ({ boss: boss.id, bossName: boss.name, ...chest, pool: boss.loot?.pool }))),
  };
}
