import { renderPowerText } from '../power.mjs';
import { renderText } from '../text.mjs';
import { byName, compact, seasonNumber, text } from './common.mjs';

/**
 * Season tracking.
 *
 * The game files mark season-only content in several ways, from most to
 * least reliable:
 *   requirement     tRequirementsToBeActive.arSeasons on the record
 *   seasonFile      listed by a Season definition (e.g. its seasonal powers)
 *   seasonItemFlag  ItemDefinition.bSeasonItem (season realm only; season not named)
 *   namePrefix      internal name starts with S<n>_ (a naming habit, not a rule)
 *
 * Every resolved record gets a `season` block built from these, so a client
 * can tell season-only data apart and decide how much to trust each source.
 */
export class Seasons {
  constructor(game) {
    this.game = game;
    this.seasons = [];
    this.members = new Map(); // "Group/name" -> Set(season numbers)

    for (const id of game.repo.names('Season')) {
      const number = seasonNumber(id);
      const record = game.repo.get('Season', id);
      if (number === null || !record) continue;

      this.seasons.push({ id, number, record });

      for (const ref of [...(record.arCollectiblePowers || []), ...(record.arDungeons || []), record.snoSeasonNightmareSigil]) {
        if (ref?.groupName && ref?.name) this.addMember(ref.groupName, ref.name, number);
      }
    }

    this.seasons.sort((a, b) => a.number - b.number);
    this.current = this.seasons.at(-1)?.number ?? null;
  }

  addMember(group, name, number) {
    const key = `${group}/${name}`;
    if (!this.members.has(key)) this.members.set(key, new Set());
    this.members.get(key).add(number);
  }

  /**
   * Season block for a record.
   *   seasonal  true only when the data marks the record as season-only
   *             (season requirement, listed in a Season file, or bSeasonItem)
   *   seasons   which season(s); from the name prefix when the data doesn't say
   *   current   it belongs to the newest season in this build
   *   introducedInSeason  from an S<n>_ name prefix: when it was added, not
   *             a restriction (many S04_ affixes are permanent, for example)
   *   newInCurrentSeason  introducedInSeason is the newest season
   * extra: { requirements, seasonItem, alsoNames: [other names whose prefix counts], seasons: [extra numbers] }
   */
  tag(group, name, extra = {}) {
    const found = new Set();
    const sources = [];

    const fromRequirement = (extra.requirements?.arSeasons || []).map(ref => seasonNumber(ref?.name)).filter(n => n !== null);
    if (fromRequirement.length) {
      fromRequirement.forEach(n => found.add(n));
      sources.push('requirement');
    }

    const member = this.members.get(`${group}/${name}`);
    if (member?.size) {
      member.forEach(n => found.add(n));
      sources.push('seasonFile');
    }

    if (extra.seasonItem) sources.push('seasonItemFlag');

    if (extra.seasons?.length && sources.length) {
      extra.seasons.forEach(n => found.add(n));
      sources.push(extra.seasonsFrom ?? 'related');
    }

    let introduced;
    for (const candidate of [name, ...(extra.alsoNames || [])]) {
      const prefix = String(candidate ?? '').match(/^S(\d{1,2})_/i);
      if (prefix && Number(prefix[1]) > 0 && Number(prefix[1]) <= (this.current ?? 99)) {
        introduced = Number(prefix[1]);
        break;
      }
    }

    const isNew = introduced !== undefined && introduced === this.current ? true : undefined;

    if (!sources.length) {
      return compact({ seasonal: false, introducedInSeason: introduced, newInCurrentSeason: isNew });
    }

    if (!found.size && introduced) {
      found.add(introduced);
      sources.push('namePrefix');
    }

    const seasons = [...found].sort((a, b) => a - b);

    return compact({
      seasonal: true,
      seasons,
      current: seasons.includes(this.current) || undefined,
      source: sources,
      introducedInSeason: introduced,
      newInCurrentSeason: isNew,
    });
  }

  /** "Prime Evil Powers" etc.: the season's name for its power set. */
  powerSetName(powerId) {
    for (const number of this.members.get(`CollectiblePower/${powerId}`) || []) {
      const season = this.seasons.find(s => s.number === number);
      const strings = season && this.game.repo.strings('Season', season.id);
      const name = strings?.SeasonalTabTooltip ?? strings?.CollectiblePowerItemTypeDescription_1;
      if (name) return text(name);
    }
    return undefined;
  }

  /** data/seasons.json */
  resolve(records) {
    const { game } = this;
    const powersBySeason = groupBy(records.seasonalPowers || [], p => p.season?.seasons || []);
    const itemsBySeason = groupBy(records.items || [], i => i.season?.seasons || []);

    return this.seasons.map(({ id, number, record }) => {
      const strings = game.repo.strings('Season', id) || {};
      const blessings = (record.arBlessings || []).map(ref => blessing(game, ref?.name)).filter(Boolean);

      return compact({
        id,
        number,
        name: text(strings.SeasonName),
        description: text(strings.SeasonDescription),
        flavor: text(strings.SeasonFlavor),
        current: number === this.current || undefined,
        blessings,
        powerSet: text(strings.SeasonalTabTooltip ?? strings.CollectiblePowerItemTypeDescription_1),
        leaderboardActivity: record.gbidSeasonalLeaderboardActivity?.name,
        journey: record.snoChapters?.name,
        powers: (powersBySeason.get(number) || []).map(p => ({ id: p.id, name: p.name, category: p.category })),
        items: (itemsBySeason.get(number) || []).map(i => ({ id: i.id, name: i.name, quality: i.quality, itemType: i.itemType?.name })),
      });
    });
  }
}

/** CollectiblePower group: seasonal powers (Prime Evil powers, Horadric powers, …). */
export function resolveSeasonalPowers(game, seasons) {
  const { repo } = game;
  const categories = repo.stringList('CollectiblePowerCategories') || {};
  const result = [];

  for (const id of repo.names('CollectiblePower')) {
    const record = repo.get('CollectiblePower', id);
    const strings = repo.strings('CollectiblePower', id);
    if (!record || !strings?.Name) continue;

    const powerId = record.snoPower?.name;
    const category = record.gbidCategory?.name;
    const description = powerId
      ? renderPowerText(game, powerId, strings.Description ?? strings.Desc)
      : renderText(strings.Description ?? strings.Desc ?? '');

    result.push(compact({
      id,
      snoId: record.__snoID__,
      name: text(strings.Name),
      set: seasons.powerSetName(id),
      category: category ? (text(categories[`${category}_DisplayName`]) || undefined) : undefined,
      categoryId: category,
      description: description.text || null,
      keywords: description.keywords,
      howToUnlock: text(strings.HowToUnlock),
      requirement: text(strings.InstructionsToEnable),
      passive: record.bIsPassivePower ? true : undefined,
      maxRank: record.arUpgradeCosts?.length || undefined,
      upgradeCosts: (record.arUpgradeCosts || []).map(c => ({ rank: c.dwRank, cost: c.dwCost })),
      tags: (record.arKeywordSkillTags || []).map(t => game.skillTagName(t?.name) ?? t?.name).filter(Boolean),
      power: powerId,
      season: seasons.tag('CollectiblePower', id),
    }));
  }

  return result.sort(byName);
}

function blessing(game, id) {
  if (!id) return null;
  const strings = game.repo.stringList('Blessings') || {};
  const entry = game.repo.balance('Blessings').find(b => b.tHeader?.szName === id);

  return compact({
    id,
    name: text(strings[`${id}_Name`]) ?? id,
    description: text(strings[`${id}_Description`]),
    levels: (entry?.arLevels || []).map((level, index) => ({
      level: index + 1,
      bonus: Math.round(level.flBonusPercentage * 1e4) / 1e4,
      pointsToUnlock: level.dwUpgradePointsToUnlock,
    })),
  });
}

function groupBy(list, keysOf) {
  const map = new Map();
  for (const item of list) {
    for (const key of keysOf(item)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
  }
  return map;
}
