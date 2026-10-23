import { describeAffix } from '../affix.mjs';
import { ITEM_QUALITY } from '../game.mjs';
import { byName, compact, itemTypeInfo, seasons, text } from './common.mjs';

/**
 * Every item definition, with its English name, type, quality, classes and
 * all forced/inherent affixes resolved to text. Unique and mythic items carry
 * their unique power as `power`.
 */
export function resolveItems(game) {
  const { repo } = game;
  const families = familyNames(game);
  const items = [];

  for (const id of repo.names('Item')) {
    const item = repo.get('Item', id);
    if (!item) continue;
    items.push(resolveItem(game, id, item, families));
  }

  return items.sort(byName);
}

export function resolveItem(game, id, item, families = familyNames(game)) {
  const { repo } = game;
  const strings = repo.strings('Item', id) || {};
  const quality = ITEM_QUALITY[item.eMagicType] ?? String(item.eMagicType);
  const mythic = quality === 'Mythic';
  const itemPower = item.nFixedIPowerLevel || undefined;

  const describe = ref => {
    const affix = repo.deref(ref);
    if (!affix) return null;
    const d = describeAffix(game, affix, { mythic, itemPower });
    return compact({
      id: d.id,
      description: d.description,
      keywords: d.keywords,
      values: d.values.map(({ formula, byItemPower, ...v }) => v),
      unresolvedValues: d.unresolvedValues,
      hasOwnText: Boolean(repo.strings('Affix', d.id)?.Desc),
    });
  };

  const forced = (item.arForcedAffixes || []).map(describe).filter(Boolean);
  const inherent = (item.arInherentAffixes || []).map(describe).filter(Boolean);

  // The unique power is the forced affix with its own written text.
  let power;
  if (quality === 'Unique' || quality === 'Mythic' || quality === 'Set') {
    const index = forced.findIndex(a => a.hasOwnText);
    if (index !== -1) power = forced.splice(index, 1)[0];
  }

  const strip = list => list.map(({ hasOwnText, ...rest }) => rest);
  const lootPools = (item.arItemFamilies || []).map(ref => ref?.name).filter(Boolean);

  return compact({
    id,
    snoId: item.__snoID__,
    name: text(strings.Name) ?? null,
    quality,
    itemType: itemTypeInfo(game, item.snoItemType),
    classes: game.classes(item.fUsableByClass),
    requiredLevel: item.nExplicitRequiredLevel || undefined,
    itemPower,
    maxStack: item.nMaxStackSize > 1 ? item.nMaxStackSize : undefined,
    power: power && (({ hasOwnText, ...rest }) => rest)(power),
    affixes: strip(forced),
    implicitAffixes: strip(inherent),
    description: text(strings.Description),
    flavor: text(strings.Flavor),
    requirementText: text(strings.RequirementText),
    lootPools: lootPools.map(pool => ({ id: pool, name: families.get(pool) ?? pool })),
    baseItem: item.snoBaseItem?.name,
    setBonus: item.snoSetItemBonus?.name,
    seasons: seasons(item.tRequirementsToBeActive),
    charmRarity: item.eCharmRarity || undefined,
  });
}

/** ItemFamilies.gam: "DurielUniques" -> "Duriel". */
export function familyNames(game) {
  const map = new Map();

  for (const entry of game.repo.balance('ItemFamilies')) {
    const id = entry.tHeader?.szName;
    if (!id) continue;
    map.set(id, id.replace(/Uniques$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
  }

  return map;
}
