import { describeAffix } from '../affix.mjs';
import { renderText } from '../text.mjs';
import { byName, compact, itemTypeInfo, text } from './common.mjs';

const RUNE_TYPES = { ConditionRune: 'condition', EffectRune: 'effect' };
const RUNE_RARITY = { 0: 'Magic', 1: 'Rare', 2: 'Legendary' };

/**
 * Runes (condition and effect). Condition runes generate Offering when
 * their condition is met; effect runes spend it. `runicPower` is that amount.
 */
export function resolveRunes(game) {
  const { repo } = game;
  const result = [];

  for (const id of repo.names('Item')) {
    const item = repo.get('Item', id);
    const type = RUNE_TYPES[item?.snoItemType?.name];
    if (!type || !item.snoRunePower) continue;

    const strings = repo.strings('Item', id) || {};
    const description = renderText(strings.RuneDescription ?? '', {
      text: { s1: formatDynamic(item.flDynamicRuneValue) },
    });

    result.push(compact({
      id,
      snoId: item.__snoID__,
      name: text(strings.Name) ?? id,
      type,
      rarity: RUNE_RARITY[item.eRuneRarity],
      rarityLevel: item.eRuneRarity,
      runicPower: item.dwRunicPowerAmount || undefined,
      description: description.text || null,
      keywords: description.keywords,
      runewordPhrase: text(strings.RunewordPhrasePrefix ?? strings.RunewordPhraseSuffix),
      overflow: text(strings.RuneOverflowBehavior),
      classes: game.classes(item.fUsableByClass),
      power: item.snoRunePower.name,
      season: game.seasons.tag('Item', id, { requirements: item.tRequirementsToBeActive, seasonItem: item.bSeasonItem }),
    }));
  }

  return result.sort(byName);
}

/**
 * Horadric Cube rune word recipes: which runes, which bases, and the stats
 * of the resulting item, grouped by rune word.
 */
export function resolveRunewords(game) {
  const { repo } = game;
  const words = new Map();

  for (const recipeId of repo.names('Recipe')) {
    const match = recipeId.match(/_Craft_Runeword_(.+?)(_Ancestral)?$/);
    if (!match) continue;

    const recipe = repo.get('Recipe', recipeId);
    const itemId = `Runeword_${match[1]}`;
    const item = repo.get('Item', itemId) || repo.get('Item', `Runeword_${match[1].split('_')[0]}`);
    if (!recipe || !item) continue;

    const resolvedItemId = repo.get('Item', itemId) ? itemId : `Runeword_${match[1].split('_')[0]}`;
    const strings = repo.strings('Item', resolvedItemId) || {};
    const name = text(strings.Name) ?? match[1].split('_')[0];

    const runes = [];
    let baseLabels = [];

    for (const ingredient of recipe.arIngredients || []) {
      if (ingredient.snoItem?.name) {
        const runeId = ingredient.snoItem.name;
        runes.push({ id: runeId, name: game.nameOf('Item', runeId) ?? runeId, quantity: ingredient.nQuantity || 1 });
      } else if (ingredient.tItemDescription?.arItemLabels?.length) {
        baseLabels = game.itemLabelNames(ingredient.tItemDescription.arItemLabels);
      }
    }

    if (!words.has(name)) {
      words.set(name, {
        id: name.replace(/[^A-Za-z0-9]+/g, '_'),
        name,
        runes,
        runeOrder: text(strings.Description),
        bases: [],
        itemIds: new Set(),
      });
    }

    const word = words.get(name);
    word.bases.push(compact({
      recipe: recipeId,
      item: resolvedItemId,
      itemType: itemTypeInfo(game, item.snoItemType)?.name,
      baseLabels,
      ancestral: match[2] ? true : undefined,
      classes: game.classes(item.fUsableByClass),
    }));
    word.itemIds.add(resolvedItemId);
  }

  return [...words.values()].map(word => {
    const first = repo.get('Item', [...word.itemIds][0]);
    const stats = (first?.arForcedAffixes || []).map(ref => {
      const affix = repo.deref(ref);
      const d = affix && describeAffix(game, affix);
      return d && compact({ id: d.id, description: d.description, values: d.values.map(({ formula, byItemPower, ...v }) => v) });
    }).filter(Boolean);

    // Season-only rune words take their season from the season-only runes they need.
    const runeSeasons = word.runes.flatMap(rune => {
      const item = repo.get('Item', rune.id);
      const tag = game.seasons.tag('Item', rune.id, { requirements: item?.tRequirementsToBeActive, seasonItem: item?.bSeasonItem });
      return tag.seasonal ? tag.seasons || [] : [];
    });
    const seasonal = [...word.itemIds].map(id => {
      const item = repo.get('Item', id);
      return game.seasons.tag('Item', id, { requirements: item?.tRequirementsToBeActive, seasonItem: item?.bSeasonItem, seasons: runeSeasons, seasonsFrom: 'runes' });
    });

    return compact({
      id: word.id,
      name: word.name,
      runes: word.runes,
      runeOrder: word.runeOrder,
      stats,
      bases: word.bases,
      season: seasonal.find(s => s.seasonal) ?? seasonal[0],
    });
  }).sort(byName);
}

/** Tempering manuals: what each recipe can add, by tier. */
export function resolveTempering(game) {
  const { repo } = game;
  const groups = repo.stringList('ItemLabelGroups') || {};
  const result = [];

  for (const id of repo.names('Item')) {
    const item = repo.get('Item', id);
    if (item?.snoItemType?.name !== 'TemperManual') continue;

    const recipe = repo.deref(item.snoRecipe);
    const data = recipe?.temperingData;
    if (!data) continue;

    const strings = repo.strings('Item', id) || {};
    const affixes = (data.arTemperedAffixes || []).map(entry => {
      const affix = repo.deref(entry.snoAffix);
      if (!affix) return null;
      const d = describeAffix(game, affix);
      return compact({
        id: d.id,
        description: d.description,
        classes: game.classes(affix.fAllowedForPlayerClass),
        values: d.values.map(({ formula, byItemPower, ...v }) => v),
      });
    }).filter(Boolean);

    const classes = [...new Set(affixes.flatMap(a => a.classes || []))];
    const group = data.gbidItemLabelGroup?.name;
    const tier = id.match(/_Tier(\d+)$/);

    result.push(compact({
      id,
      snoId: item.__snoID__,
      name: text(strings.Name) ?? id,
      tier: tier ? Number(tier[1]) : undefined,
      category: group ? (text(groups[`${group}_Name`]) ?? group) : undefined,
      family: data.gbidRecipeFamily?.name,
      classes,
      appliesTo: text(strings.Description),
      affixes: affixes.map(({ classes: _, ...rest }) => rest),
      recipe: recipe ? item.snoRecipe.name : undefined,
      otherTiers: (data.arRecipesInFamily || []).map(ref => ref?.name).filter(Boolean),
      season: game.seasons.tag('Item', id, { requirements: item.tRequirementsToBeActive, seasonItem: item.bSeasonItem, alsoNames: [item.snoRecipe?.name] }),
    }));
  }

  return result.sort((a, b) => (a.family ?? '').localeCompare(b.family ?? '') || (a.tier ?? 0) - (b.tier ?? 0) || byName(a, b));
}

function formatDynamic(value) {
  if (!value) return '#';
  return String(Math.round(value * 100) / 100);
}
