import { Game } from '../game.mjs';
import { Repo } from '../repo.mjs';
import { resolveAspects } from './aspects.mjs';
import { bossActorFiles, resolveBosses } from './bosses.mjs';
import { resolveAffixes, resolveClasses, resolveItemTypes, resolveLoot } from './catalog.mjs';
import { resolveItems } from './items.mjs';
import { resolveSkills } from './skills.mjs';

/**
 * json/ groups the resolved endpoints read, beyond the top-level tables.
 * Used for the sparse checkout in CI.
 */
export const RESOLVER_GROUPS = [
  'base/Affix',
  'base/Aspect',
  'base/GameBalance',
  'base/Item',
  'base/ItemType',
  'base/PlayerClass',
  'base/Power',
  'base/Recipe',
  'base/SkillKit',
  'base/TrackedReward',
  'enUS_Text/StringList',
];

/** Root-level files the resolver reads. */
export const RESOLVER_FILES = ['attributes.json'];

export function createGame(repoRoot) {
  const repo = new Repo(repoRoot);
  return new Game(repo, repoRoot);
}

/** Individual files to fetch before resolving: [{ group, name }] under json/base/meta. */
export function extraFiles(game) {
  return bossActorFiles(game);
}

/**
 * Builds every readable endpoint. Returns [{ name, description, data }].
 * `data` is an array of records, or an object for loot.
 */
export function resolveAll(game, log = () => {}) {
  const timed = (name, fn) => {
    const start = Date.now();
    const data = fn();
    log(`  ${name}: ${Array.isArray(data) ? data.length : Object.keys(data).length} in ${Date.now() - start} ms`);
    return data;
  };

  const items = timed('items', () => resolveItems(game));
  const bosses = timed('bosses', () => resolveBosses(game));

  return [
    { name: 'aspects', description: 'Legendary aspects: name, class, category, slots, text, values by rank, Codex source', data: timed('aspects', () => resolveAspects(game)) },
    { name: 'uniques', description: 'Unique and mythic items with their unique power, stats and boss loot pools', data: items.filter(i => i.quality === 'Unique' || i.quality === 'Mythic') },
    { name: 'items', description: 'Every item definition, resolved', data: items },
    { name: 'affixes', description: 'Every affix with text and value ranges', data: timed('affixes', () => resolveAffixes(game)) },
    { name: 'skills', description: 'Class skills and passives with text at rank 1', data: timed('skills', () => resolveSkills(game)) },
    { name: 'bosses', description: 'Lair and pinnacle bosses: location, altar, keys, hoards and unique drops', data: bosses },
    { name: 'loot', description: 'Unique loot pools per source and boss hoard chests', data: timed('loot', () => resolveLoot(game, bosses)) },
    { name: 'item-types', description: 'Item types with names and labels', data: timed('item-types', () => resolveItemTypes(game)) },
    { name: 'classes', description: 'Player classes and their index in class arrays', data: resolveClasses(game) },
  ];
}
