# d4data static API

A read-only JSON API over the parsed Diablo IV data in this repository, published to GitHub Pages
by [`publish-api.yml`](../.github/workflows/publish-api.yml).

The fork mirrors [DiabloTools/d4data](https://github.com/DiabloTools/d4data) through
[`sync-upstream.yml`](../.github/workflows/sync-upstream.yml). Every 6 hours that workflow calls
GitHub's "Sync fork" API and, if anything changed, rebuilds and redeploys the API.

**Base URL:** `https://alchelvly.github.io/DiabloIVData/api/v1/`

## How the data is split

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
| `manifest.json` | Every group and table, with paths, hashes, sizes and counts. |
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
3. For each bundle part you use, download it only if its `sha256` differs from your cached copy.
   Verify the hash after downloading.
4. Store the new `sourceCommit`.

`apiVersion` only changes when the API's shape breaks, and a new version is served under a new
path (`/api/v2/`). Data updates change `dataVersion` and `sourceCommit`, never `apiVersion`.

GitHub Pages serves the files gzip-compressed, so the bundles are small to download. For example,
each 50 MB `Power` part is under 2 MB over the wire. Most HTTP clients, including Go's `net/http`,
decompress them automatically.

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
curl -s https://alchelvly.github.io/DiabloIVData/api/v1/groups/base/Aspect.json
```

## Building locally

```bash
node api/build.mjs
```

This writes the site to `api/dist/`, which is gitignored. It needs only Node and git, and reads
the file list from git, so it also works from a sparse checkout. `node api/build.mjs
--print-sparse` prints the paths the build reads, which is how the workflow checks out only those.

## Notes

- The workflows add new files only, so syncing with upstream never conflicts. Don't edit
  upstream-owned files in this fork.
- `GITHUB_TOKEN` cannot change files under `.github/workflows/`. If an upstream update touches
  upstream's own workflow (`ci.yml`), the sync will fail. Use **Sync fork** on GitHub to bring that
  update in by hand.
