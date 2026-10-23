# d4data static API

A read-only JSON API over the parsed Diablo IV data in this repository, published to GitHub Pages
by [`publish-api.yml`](../.github/workflows/publish-api.yml).

The fork mirrors [DiabloTools/d4data](https://github.com/DiabloTools/d4data) through
[`sync-upstream.yml`](../.github/workflows/sync-upstream.yml). Every 6 hours that workflow calls
GitHub's "Sync fork" API and, if anything changed, rebuilds and redeploys the API.

**Base URL:** `https://alchelvly.github.io/DiabloIVData/api/v1/`

The API has two layers:

- **Readable data** (`data/…`): one record per aspect, item, boss and so on, with every
  cross-reference followed, English text filled in and values computed. Start here.
- **Raw files** (`groups/…`, `index/…`, `tables/…`): the parser's output exactly as it is in
  `json/`, for anything the readable layer doesn't cover.

## Readable data

| Path | Records | What's in it |
|---|---|---|
| `data/aspects.json` | ~600 | Legendary aspects: name, class, category, allowed slots, description with value ranges, values per rank, where the Codex entry comes from |
| `data/uniques.json` | ~1,200 | Unique and mythic items: unique power text, stat affixes, item type, classes, which boss loot pools they are in |
| `data/items.json` | ~12,000 | Every item definition resolved the same way (bases, legendaries, consumables, keys, charms, …) |
| `data/affixes.json` | ~6,300 | Every affix: text, value ranges, item-power brackets for stat rolls, slots, classes |
| `data/skills.json` | ~500 | Class skills and passives: name, tags, cost, cooldown, description, modifiers |
| `data/bosses.json` | ~10 | Lair and pinnacle bosses: lair, altar, keys, hoard chests, unique drop pool |
| `data/loot.json` | — | Unique loot pools for each source, and every boss hoard with its key cost |
| `data/item-types.json` | ~160 | Item types with English names and labels |
| `data/classes.json` | 8 | Classes, with the index used by per-class arrays |

Each file is a JSON array (`loot.json` is an object). `manifest.json` lists them under `data`
with the same `path`, `sha256`, `bytes` and `records` fields as the bundles, so the update
steps below work for them too.

### Where each record comes from

Nothing in these files is typed in by hand. Each one is assembled from several game files:

- **Aspects:** `Aspect` → its `Affix` (values, slots, classes, category tags) → the affix's
  English `StringList` (name and description) → `TrackedReward` (Codex source) → `World`
  strings (dungeon name).
- **Items:** `Item` → `ItemType` (+ `ItemLabels`) → each forced and inherent `Affix` → its
  strings, or `AttributeDescriptions` for plain stat affixes → `AttributeFormulas` for
  item-power brackets → `ItemFamilies` for loot pools.
- **Bosses:** the boss's `Boss_*` quest → its monster, altar and hoard actors → the lair's
  `World` and `LevelArea` → the summoning `Recipe` → `ItemFamilies` for the unique pool.
- **Skills:** each class `SkillKit` + `SkillTreeRewards` → `Power` (tags, cost, formulas) →
  the power's strings.

### Example: one aspect

```json
{
  "id": "Asp_Legendary_Barb_001",
  "name": "Aspect of Berserk Ripping",
  "class": "Barbarian",
  "category": "Offensive",
  "slots": ["Weapon", "Gloves", "Amulet", "Ring"],
  "description": "While Berserking, your direct damage inflicts 40–55% bonus Bleeding damage over 5 seconds.",
  "keywords": ["Berserking"],
  "values": [
    { "attribute": "Affix_Value_1", "min": 0.4, "max": 0.55, "scaling": "rank",
      "formula": "0.39+CurrentLegendaryRank()*0.01" }
  ],
  "ranks": { "min": 1, "max": 16, "caps": [16, 13, 21, 16] },
  "byRank": [{ "rank": 1, "values": [{ "attribute": "Affix_Value_1", "min": 0.4, "max": 0.4 }] }, "…"],
  "codex": { "source": "dungeon", "dungeon": { "id": "DGN_Step_Mournfield", "name": "Mournfield" } },
  "affix": "legendary_barb_001"
}
```

### Example: one boss

```json
{
  "id": "Boss_WT4_Duriel",
  "name": "Duriel",
  "displayName": "Tormented Echo of Duriel",
  "location": { "world": { "id": "Boss_WT4_Duriel", "name": "Gaping Crevasse" } },
  "altar": { "id": "Boss_WT4_Duriel", "name": "Pestilent Altar" },
  "summon": [{ "recipe": "BossSummoning_UberDuriel",
    "requires": [{ "item": "BossSummoning_Greater_LairKey", "name": "Greater Lair Key", "quantity": 1 }] }],
  "chests": [{ "id": "EGB_Chest_Duriel_Tormented", "name": "Duriel's Hoard",
    "requires": [{ "item": "BossSummoning_Greater_LairKey", "name": "Greater Lair Key", "quantity": 1 }] }],
  "loot": { "pool": "DurielUniques",
    "uniques": [{ "id": "Ring_Unique_Sorc_100", "name": "Blue Rose", "quality": "Unique", "classes": ["Sorcerer"] }, "…"] }
}
```

### Reading the values

- **`description`** is plain text. Colour and style tags are removed and placeholders are
  replaced by numbers. A range such as `40–55%` covers every possible roll or rank.
  `descriptionMarkup` keeps the original text with its tags, if you want to render colours.
- **`[x]`** after a number means a multiplicative bonus, as in the game's tooltips.
- **`#`** stands for a number the game works out per character while you play (your weapon
  damage, attack speed, skill damage). Those placeholders are listed in `unresolvedValues`.
- **`(… of weapon damage)`** marks damage that scales with your weapon. The share is shown,
  not a fixed number.
- **`values[]`** holds each affix value as `min`/`max` in the game's own units (0.4 = 40%).
  `scaling` says what moves it:
  - `rank`: the aspect rank. `byRank` lists the values at every rank.
  - `roll`: a random roll when the item drops.
  - `itemPower`: item power. `byItemPower` (in `affixes.json`) lists every bracket, and the
    top-level `min`/`max` use the highest one (or the item's fixed item power).
  - `fixed`: always the same.
- **`ranks.caps`** are the per-aspect rank caps from the data (`arMaxLegendaryRanks`). Ranges
  use 1 to the first cap. The game files don't say what the other caps are for.
- **Skill numbers** are at rank 1, with no upgrades, items or paragon applied.
- **Ancestral items** boost some powers (`AncestralAffixScalar…`). Values here are for the
  base item.

### Limits of the game data

- **Drop tables.** The game files don't include treasure classes, the tables of drop weights.
  Blizzard keeps them on the server. Loot here is the pool of uniques tagged for each source
  (`ItemFamilies`) plus what each hoard costs to open. Drop chances aren't in the data.
- **Monster stats.** Health and damage scaling for bosses are server-side too.
- **World bosses** and other bosses without a `Boss_*` quest aren't in `bosses.json` yet. Their
  unique pools are still in `loot.json` (for example `AstarothUniques`, `WorldUniques`).
- Some records are leftovers or placeholders in the game files (names like `[PH]` or `[WIP]`).
  They are included as-is.

The resolver code lives in [`lib/`](lib): `formula.mjs` evaluates the game's formulas,
`text.mjs` renders tooltip markup, `affix.mjs` describes any affix, and `resolve/` builds each
endpoint.

## How the raw files are split

The `json/` tree has about 850,000 files (around 18 GB), far more than GitHub Pages can host.
It is published in three ways:

| Kind | What | Where |
|---|---|---|
| **Bundled groups** | Gameplay groups (items, affixes, aspects, powers, paragon, English strings, …) | One file per group on Pages: `groups/<source>/<Group>.json` |
| **Indexed groups** | Every other group (textures, actors, scenes, sounds, …) | Name list on Pages: `index/<source>/<Group>.json`. Files come from GitHub, pinned to the commit. |
| **Tables** | Top-level files such as `snoGroups`, `GBID`, `eGameBalanceType` | Small ones: `tables/<name>.json`. Files over 5 MB are linked to GitHub instead. |

The bundled list is `BUNDLED_GROUPS` in [`build.mjs`](build.mjs). Move a group into it to publish
the whole group on Pages.

## Endpoints

| Path | Description |
|---|---|
| `latest.json` | Small version stamp. Poll this to check for updates. |
| `manifest.json` | Every readable endpoint, group and table, with paths, hashes, sizes and counts. |
| `data/<name>.json` | A readable endpoint (see [Readable data](#readable-data)). |
| `groups/<source>/<Group>.json` | A bundled group: `{ "<snoName>": record, … }`. |
| `groups/<source>/<Group>.<n>.json` | Part `n` (from 1) of a bundle bigger than 50 MB. Today only `base/Power` is split. |
| `index/<source>/<Group>.json` | Sorted SNO names in an indexed group. |
| `tables/<name>.json` | A small top-level table. |

`<source>` is the folder under `json/`: `base`, `enUS_Text` or `enUS_Speech`. Groups are keyed
`<source>/<Group>` because a few names, such as `wWiseSoundBank`, exist in more than one source.

Each record is the same as its file in `json/<source>/meta/<Group>/<snoName>.<ext>.json`, only
minified. Records keep the parser's metadata fields (`__fileName__`, `__snoID__`, `__type__`, …).

### `latest.json`

```json
{
  "apiVersion": 1,
  "dataVersion": "3.1.3.73224",
  "d4Build": 73224,
  "sourceCommit": "ea1636f03fe4e007c7e3596650f7a8f31516f2f2",
  "generatedAt": "2026-10-19T03:23:47.571Z",
  "manifest": "manifest.json"
}
```

### `manifest.json`

```json
{
  "apiVersion": 1,
  "dataVersion": "3.1.3.73224",
  "d4Build": 73224,
  "sourceCommit": "…",
  "generatedAt": "…",
  "tables": {
    "snoGroups": { "path": "tables/snoGroups.json", "sha256": "…", "bytes": 2990, "records": 167 },
    "CoreTOC_flat": { "rawUrl": "https://raw.githubusercontent.com/…/json/CoreTOC_flat.json", "bytes": 53807282 }
  },
  "groups": {
    "base/Item": {
      "fileExtension": "itm",
      "files": 11725,
      "rawBaseUrl": "https://raw.githubusercontent.com/ALCHElVlY/DiabloIVData/<sourceCommit>/json/base/meta/Item/",
      "parts": [{ "path": "groups/base/Item.json", "sha256": "…", "bytes": 46712015, "records": 11725 }]
    },
    "base/Texture": {
      "fileExtension": "tex",
      "files": 141849,
      "rawBaseUrl": "https://raw.githubusercontent.com/ALCHElVlY/DiabloIVData/<sourceCommit>/json/base/meta/Texture/",
      "index": "index/base/Texture.json"
    }
  }
}
```

A bundled group has `parts`, and an indexed group has `index`. All `path` and `index` values are
relative to the base URL. `sha256` is the hash of the exact bytes served.

### Common groups

| Group | Contents |
|---|---|
| `base/Item` | Item definitions: base type (`snoItemType`), actor, flags, costs, requirements |
| `base/ItemType` | Item type hierarchy |
| `base/Affix` | Affixes, including legendary and unique powers |
| `base/Aspect` | Legendary aspects, each pointing at its affix |
| `base/Power` | Skills and powers (largest group, 4 parts) |
| `base/SkillKit`, `base/GenericSkillTree` | Class skill trees |
| `base/PlayerClass` | Classes |
| `base/ParagonBoard`, `ParagonNode`, `ParagonGlyph`, `ParagonGlyphAffix`, `ParagonThreshold` | Paragon system |
| `base/GameBalance` | Balance tables, referenced by `DT_GBID` fields |
| `base/Recipe` | Crafting recipes |
| `base/Season` | Season definitions |
| `base/MonsterAffix`, `base/DungeonAffix` | Monster and dungeon modifiers |
| `enUS_Text/StringList` | English text for everything above (see below) |

## Keeping a client up to date

1. GET `latest.json`. If `sourceCommit` matches your cached value, you're done.
2. Otherwise GET `manifest.json`.
3. For each `data` file or bundle part you use, download it only if its `sha256` differs from your cached copy.
   Verify the hash after downloading.
4. Store the new `sourceCommit`.

`apiVersion` only changes when the API's shape breaks, and a new version is served under a new
path (`/api/v2/`). Data updates change `dataVersion` and `sourceCommit`, never `apiVersion`.

GitHub Pages serves the files gzip-compressed.

## Files from indexed groups

To fetch one file from an indexed group:

1. Pick a name from `index/<source>/<Group>.json`.
2. Build the URL from the group's `rawBaseUrl`, the URL-encoded name, then `.<fileExtension>.json`.

The `rawBaseUrl` is pinned to `sourceCommit`, so the files always match the rest of the manifest.

## English names

`enUS_Text/StringList` entries are keyed `<Group>_<snoName>`. Each one holds an `arStrings`
array of `{ szLabel, szText }`:

```js
strings['Item_1HAxe_Legendary_Generic_001'].arStrings
// [{ szLabel: 'Name', szText: 'Bearded Axe', … }]
```

The same pattern covers `Affix_…`, `Power_…`, `ParagonNode_…`, `Recipe_…` and others. Labels
vary by group (`Name`, `name`, `Desc`, …). Aspects get their text through the affix they
reference. `szText` can contain formatting tags such as `{c_mythic}` and `{if:…}`.

## Examples

```bash
curl -s https://alchelvly.github.io/DiabloIVData/api/v1/latest.json
curl -s https://alchelvly.github.io/DiabloIVData/api/v1/data/aspects.json
curl -s https://alchelvly.github.io/DiabloIVData/api/v1/data/bosses.json
```

## Building locally

```bash
node api/build.mjs
```

This writes the site to `api/dist/`, which is gitignored. It needs only Node and git, and reads
the file list from git, so it also works from a sparse checkout. `node api/build.mjs
--print-sparse` prints the paths the build reads, which is how the workflow checks out only those.
In a sparse checkout the build also adds the few dozen single `Actor` files the boss resolver
needs, with `git sparse-checkout add`.

## Notes

- The workflows add new files only, so syncing with upstream never conflicts. Don't edit
  upstream-owned files in this fork.
- `GITHUB_TOKEN` cannot change files under `.github/workflows/`. If an upstream update touches
  upstream's own workflow (`ci.yml`), the sync will fail. Use **Sync fork** on GitHub to bring that
  update in by hand.
