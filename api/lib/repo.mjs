import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read-only access to the parsed game files under json/.
 *
 * Records are loaded on first use and cached. Every lookup returns null
 * rather than throwing when a file is missing, because the game data has
 * plenty of dangling references and resolvers are expected to skip them.
 */
export class Repo {
  constructor(repoRoot) {
    this.root = path.join(repoRoot, 'json');
    this.cache = new Map();
    this.listings = new Map();
    this.tables = new Map();
  }

  /** Path of json/<source>/meta/<group>/. */
  groupDir(group, source = 'base') {
    return path.join(this.root, source, 'meta', group);
  }

  /** Map of SNO name -> file name for a group (empty if not checked out). */
  listGroup(group, source = 'base') {
    const key = `${source}/${group}`;

    if (!this.listings.has(key)) {
      const dir = this.groupDir(group, source);
      const names = new Map();

      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          const match = file.match(/^(.*)\.[^.]+\.json$/);

          if (match) {
            names.set(match[1], file);
          }
        }
      }

      this.listings.set(key, names);
    }

    return this.listings.get(key);
  }

  /** Forget cached listings, e.g. after more files were checked out. */
  refresh() {
    this.listings.clear();
    for (const [key, value] of this.cache) {
      if (value === null) this.cache.delete(key);
    }
  }

  /** All SNO names in a group, sorted. */
  names(group, source = 'base') {
    return [...this.listGroup(group, source).keys()].sort((a, b) => a.localeCompare(b));
  }

  /** One record, or null. */
  get(group, name, source = 'base') {
    if (!name) {
      return null;
    }

    const key = `${source}/${group}/${name}`;

    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    const file = this.listGroup(group, source).get(name);
    let record = null;

    if (file) {
      record = JSON.parse(readFileSync(path.join(this.groupDir(group, source), file), 'utf8'));
    }

    this.cache.set(key, record);

    return record;
  }

  /** Follows a DT_SNO / DT_SNO_NAME reference object. */
  deref(ref) {
    if (!ref || !ref.groupName || !ref.name) {
      return null;
    }

    return this.get(ref.groupName, ref.name);
  }

  /** A top-level table such as json/CoreTOC_flat.json. */
  table(name) {
    if (!this.tables.has(name)) {
      const file = path.join(this.root, `${name}.json`);
      this.tables.set(name, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
    }

    return this.tables.get(name);
  }

  /** English strings for a record: { Label: text } or null. Lookup is `<Group>_<name>`. */
  strings(group, name) {
    if (!name) {
      return null;
    }

    const record = this.get('StringList', `${group}_${name}`, 'enUS_Text');

    return record ? stringMap(record) : null;
  }

  /** English strings from a named string list such as ItemLabels. */
  stringList(name) {
    const record = this.get('StringList', name, 'enUS_Text');

    return record ? stringMap(record) : null;
  }

  /** Ordered entries of a named string list. */
  stringEntries(name) {
    const record = this.get('StringList', name, 'enUS_Text');

    return record ? (record.arStrings || []).map(s => ({ label: s.szLabel, text: s.szText })) : [];
  }

  /** Rows of a GameBalance table. */
  balance(name) {
    const record = this.get('GameBalance', name);

    return record?.ptData?.flatMap(table => table?.tEntries || []) || [];
  }

  /** Graph helpers over CoreTOC_flat / snoGroups / *SnoReferences. */
  get graph() {
    if (!this._graph) {
      this._graph = new SnoGraph(this);
    }

    return this._graph;
  }
}

class SnoGraph {
  constructor(repo) {
    this.toc = repo.table('CoreTOC_flat') || {};
    this.groups = repo.table('snoGroups') || {};
    this.outgoing = repo.table('outgoingSnoReferences') || {};
    this.incoming = repo.table('incomingSnoReferences') || {};
    this.byName = new Map();

    for (const [id, [name, group]] of Object.entries(this.toc)) {
      this.byName.set(`${this.groups[group]}/${name}`, Number(id));
    }
  }

  id(group, name) {
    return this.byName.get(`${group}/${name}`) ?? null;
  }

  describe(id) {
    const entry = this.toc[id];

    return entry ? { id: Number(id), name: entry[0], group: this.groups[entry[1]] } : null;
  }

  refsFrom(group, name) {
    const id = this.id(group, name);

    return id === null ? [] : (this.outgoing[id] || []).map(ref => this.describe(ref)).filter(Boolean);
  }

  refsTo(group, name) {
    const id = this.id(group, name);

    return id === null ? [] : (this.incoming[id] || []).map(ref => this.describe(ref)).filter(Boolean);
  }
}

function stringMap(record) {
  const result = {};

  for (const entry of record.arStrings || []) {
    result[entry.szLabel] = entry.szText;
  }

  return result;
}
