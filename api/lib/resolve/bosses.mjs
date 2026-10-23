import { ITEM_QUALITY } from '../game.mjs';
import { plainText } from '../text.mjs';
import { byName, compact, text } from './common.mjs';
import { familyNames } from './items.mjs';

const ACTOR_MONSTER = 1;
const GIZMO_CHEST = 106;        // Unique Operator Chest: opened with a key item
const GIZMO_RECIPE_EVENT = 110; // opened by paying a recipe (Belial's Hoard)

/**
 * Lair and pinnacle bosses, built from their Boss_* quests: the quest links
 * the boss monster, its altar, its hoard chest(s), the lair world and the
 * summoning recipe. Unique drops come from ItemFamilies, matched to the boss
 * by name ("Duriel's Hoard" <-> DurielUniques).
 *
 * The client data has no treasure-class tables (drop rates live on the
 * server), so loot is the pool of uniques tagged for that boss.
 */
export function resolveBosses(game) {
  const { repo } = game;
  const graph = repo.graph;
  const quests = bossQuests(game);
  const pools = lootPools(game);
  const actorUse = new Map();

  for (const refs of quests.values()) {
    for (const ref of refs) {
      if (ref.group === 'Actor') actorUse.set(ref.name, (actorUse.get(ref.name) || 0) + 1);
    }
  }

  const bosses = [];

  for (const [questId, refs] of quests) {
    const of = group => unique(refs.filter(r => r.group === group).map(r => r.name));
    const questStrings = repo.strings('Quest', questId) || repo.strings('Quest', `${questId}_Primary`) || {};

    const monsters = [];
    const chests = [];
    const altars = [];

    for (const actorId of of('Actor')) {
      const actor = repo.get('Actor', actorId);
      const name = game.nameOf('Actor', actorId);
      const gizmo = actor?.ptGizmoData?.[0];

      if (actor?.eType === ACTOR_MONSTER) {
        // Belial can turn up in every lair; keep him only in his own quest.
        if (!name || (actorUse.get(actorId) > 3 && !/belial/i.test(questId))) continue;
        monsters.push({ id: actorId, name });
      } else if (actor?.eActorGizmoType === GIZMO_CHEST
        || (actor?.eActorGizmoType === GIZMO_RECIPE_EVENT && /hoard|chest|cache/i.test(name ?? ''))) {
        chests.push(chestInfo(game, actorId, actor));
      } else if (gizmo && name && /altar/i.test(name)) {
        altars.push({ id: actorId, name });
      }
    }

    const worlds = of('World').map(id => ({ id, name: game.nameOf('World', id) }));
    const areas = of('LevelArea').map(id => ({ id, name: game.nameOf('LevelArea', id) }));
    const recipes = unique([
      ...of('Recipe'),
      ...worlds.flatMap(w => graph.refsFrom('World', w.id).filter(r => r.group === 'Recipe').map(r => r.name)),
    ]).filter(id => /^BossSummoning_/i.test(id));

    const chestRecipes = new Set(of('Actor').flatMap(a => (repo.get('Actor', a)?.ptGizmoData?.[0]?.arRecipes || []).map(r => r?.name)));
    const summon = recipes.filter(id => !chestRecipes.has(id)).map(id => recipeInfo(game, id)).filter(Boolean);
    const name = bossName(questId, questStrings, monsters, chests);
    const pool = matchPool(pools, [name, ...monsters.map(m => m.name), ...chests.map(c => c.name)]);

    if (!monsters.length && !chests.length) continue;

    bosses.push(compact({
      id: questId,
      name: name?.replace(/^(?:Tormented )?Echo of (?:the )?/i, '').replace(/^the /i, ''),
      displayName: name,
      quest: text(questStrings.Name),
      monsters,
      location: { world: worlds[0], areas, otherWorlds: worlds.slice(1) },
      altar: altars[0],
      summon,
      chests,
      loot: pool && {
        pool: pool.id,
        uniques: pool.items,
      },
    }));
  }

  return bosses.sort(byName);
}

/** ItemFamilies -> the unique/mythic items tagged with each. */
export function lootPools(game) {
  const { repo } = game;
  const names = familyNames(game);
  const pools = new Map([...names].map(([id, name]) => [id, { id, name, items: [] }]));

  for (const id of repo.names('Item')) {
    const item = repo.get('Item', id);

    for (const family of item?.arItemFamilies || []) {
      const pool = pools.get(family?.name);
      if (!pool) continue;
      pool.items.push(compact({
        id,
        name: game.nameOf('Item', id),
        quality: ITEM_QUALITY[item.eMagicType],
        classes: game.classes(item.fUsableByClass),
        itemType: item.snoItemType?.name,
      }));
    }
  }

  for (const pool of pools.values()) pool.items.sort(byName);

  return [...pools.values()];
}

/** Boss_* quests (Primary/Secondary parts merged) -> outgoing references. */
function bossQuests(game) {
  const graph = game.repo.graph;
  const quests = new Map();

  for (const [id, [name, group]] of Object.entries(graph.toc)) {
    if (graph.groups[group] !== 'Quest' || !/^Boss_/.test(name) || /_ArenaTransferPortal$/.test(name)) continue;

    const base = name.replace(/_(Primary|Secondary)$/, '');
    const refs = (graph.outgoing[id] || []).map(ref => graph.describe(ref)).filter(Boolean);

    quests.set(base, [...(quests.get(base) || []), ...refs]);
  }

  return quests;
}

/** Actor ids every boss quest needs, so a sparse checkout can fetch them first. */
export function bossActorFiles(game) {
  const names = new Set();

  for (const refs of bossQuests(game).values()) {
    for (const ref of refs) {
      if (ref.group === 'Actor') names.add(ref.name);
    }
  }

  return [...names].map(name => ({ group: 'Actor', name }));
}

function chestInfo(game, id, actor) {
  const raw = game.repo.strings('Actor', id)?.Name ?? '';
  const [title, ...rest] = raw.split(/\r?\n/);
  const gizmo = actor?.ptGizmoData?.[0];
  const lock = gizmo?.tLockData;
  const keyId = lock?.snoGizmoLockItemRequiredToOperate?.name;
  let requires = keyId ? [{
    item: keyId,
    name: game.nameOf('Item', keyId),
    quantity: lock.nGizmoLockItemCountRequiredToOperate || 1,
  }] : undefined;

  if (!requires && gizmo?.arRecipes?.length) {
    requires = gizmo.arRecipes.flatMap(ref => recipeInfo(game, ref?.name)?.requires || []);
  }

  return compact({
    id,
    name: plainText(title) || id,
    requires,
    note: rest.length ? plainText(rest.join('\n')) : undefined,
    unlockedBy: gizmo?.tConditionData?.snoGizmoCondition?.name,
  });
}

function recipeInfo(game, id) {
  const recipe = id ? game.repo.get('Recipe', id) : null;
  if (!recipe) return null;

  return compact({
    recipe: id,
    requires: (recipe.arIngredients || []).filter(i => i.snoItem).map(i => ({
      item: i.snoItem.name,
      name: game.nameOf('Item', i.snoItem.name),
      quantity: i.nQuantity,
    })),
  });
}

function bossName(questId, questStrings, monsters, chests) {
  for (const value of Object.values(questStrings)) {
    const match = String(value).match(/to summon (?:the )?(.+?)\s*$/i);
    if (match && (!/belial/i.test(match[1]) || /belial/i.test(questId))) return plainText(match[1]);
  }

  return monsters[0]?.name ?? chests[0]?.name ?? null;
}

function matchPool(pools, names) {
  const normal = s => String(s ?? '').toLowerCase().replace(/'s\b/g, '').replace(/\bthe\b/g, '').replace(/[^a-z]/g, '');
  const candidates = names.map(n => normal(String(n ?? '').replace(/^(Tormented )?Echo of /i, '').replace(/'s Hoard.*$/i, ''))).filter(Boolean);

  // Candidates are in priority order: the boss name first, then monsters, then chests.
  for (const candidate of candidates) {
    for (const pool of pools) {
      const key = normal(pool.name);
      if (!key || key === 'world') continue;
      if (candidate.includes(key) || key.includes(candidate)) return pool;
    }
  }

  return null;
}

function unique(list) {
  return [...new Set(list)];
}
