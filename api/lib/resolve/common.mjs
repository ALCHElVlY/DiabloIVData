import { plainText } from '../text.mjs';

/** "Season 9" / "Season02" -> 9 / 2; Eternal -> null. */
export function seasonNumber(name) {
  const match = String(name ?? '').match(/Season\s*0*(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function seasons(requirements) {
  const list = (requirements?.arSeasons || [])
    .map(ref => ref?.name)
    .filter(Boolean)
    .map(name => ({ id: name, number: seasonNumber(name) }));

  return list.length ? list : undefined;
}

export function refName(ref) {
  return ref?.name ?? null;
}

/** ItemType SNO -> { id, name, labels }. */
export function itemTypeInfo(game, ref) {
  const id = refName(ref);
  if (!id) return null;

  const type = game.repo.get('ItemType', id);
  const labels = game.itemLabelNames(type?.arItemLabels);

  return {
    id,
    name: game.nameOf('ItemType', id) ?? id,
    ...(labels.length ? { labels } : {}),
  };
}

/** Drops nulls, empty arrays and empty objects so records stay readable. */
export function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact);
  }

  if (value && typeof value === 'object') {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      if (Array.isArray(item) && item.length === 0) continue;
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) continue;
      result[key] = compact(item);
    }

    return result;
  }

  return value;
}

export function text(value) {
  return value ? plainText(value) : null;
}

export function byName(a, b) {
  return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);
}
