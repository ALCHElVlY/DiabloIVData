import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluate, parseFormula } from './formula.mjs';
import { plainText } from './text.mjs';

/** Index order of fAllowedForPlayerClass / fUsableByClass arrays. */
export const CLASS_ORDER = ['Sorcerer', 'Druid', 'Barbarian', 'Rogue', 'Necromancer', 'Spiritborn', 'Paladin', 'Warlock'];

/** eDamageType. */
export const DAMAGE_TYPES = ['Physical', 'Fire', 'Lightning', 'Cold', 'Poison', 'Shadow'];

/** Resource types (PlayerClass.tPrimaryResource.eType, attribute parameter type 7). */
export const RESOURCE_TYPES = { 0: 'Mana', 1: 'Fury', 3: 'Energy', 4: 'Combo Points', 5: 'Spirit', 6: 'Essence', 7: 'Vigor', 9: 'Faith', 10: 'Wrath' };

/** ItemDefinition.eMagicType. */
export const ITEM_QUALITY = { 0: 'Common', 1: 'Legendary', 2: 'Unique', 3: 'Set', 4: 'Mythic' };

/** AffixDefinition.eCategory for legendary powers, used when the FILTER_ tag is missing. */
const ASPECT_CATEGORY = { 0: 'Offensive', 1: 'Defensive', 2: 'Utility', 3: 'Resource', 4: 'Mobility' };

const INTERNAL_LABELS = new Set(['PlayerEquippable', 'UseOnPickup', 'AutoPickup', '[Unknown]', '- None -', 'All']);

const CATEGORY_TAGS = {
  FILTER_Legendary_Offensive: 'Offensive',
  FILTER_Legendary_Defensive: 'Defensive',
  FILTER_Legendary_Utility: 'Utility',
  FILTER_Legendary_Resource: 'Resource',
  FILTER_Legendary_Movement: 'Mobility',
};

/** attributes.json eParameterType values this resolver knows how to name. */
const PARAM_DAMAGE_TYPE = 0;
const PARAM_SKILL_TAG = 32;
const PARAM_RESOURCE = 7;
const PARAM_SNO = new Set([5, 13, 23]);

/**
 * Shared lookups built once per build on top of Repo: class names, item
 * labels, skill tags, attribute descriptions, balance formulas and powers.
 */
export class Game {
  constructor(repo, repoRoot) {
    this.repo = repo;
    this.repoRoot = repoRoot;
    this.powerFormulaDepth = 0;
  }

  // ---- names ---------------------------------------------------------------

  classes(flags) {
    if (!Array.isArray(flags)) return [];
    const result = CLASS_ORDER.filter((_, i) => flags[i]);
    // Every class allowed means "any class": an empty list reads better.
    return result.length === CLASS_ORDER.length ? [] : result;
  }

  get itemLabels() {
    if (!this._itemLabels) {
      this._itemLabels = this.repo.stringEntries('ItemLabels');
    }
    return this._itemLabels;
  }

  /** arItemLabels / arAllowedItemLabels index -> { id, name }. */
  itemLabel(index) {
    const entry = this.itemLabels[index];
    return entry ? { id: entry.label, name: entry.text } : { id: String(index), name: String(index) };
  }

  /** Display names for a list of label indices, without engine-only labels. */
  itemLabelNames(indices) {
    return (indices || [])
      .map(index => this.itemLabel(index))
      .filter(label => !INTERNAL_LABELS.has(label.id))
      .map(label => label.name);
  }

  aspectCategory(affix) {
    for (const tag of affix.arAffixSkillTags || []) {
      if (tag && CATEGORY_TAGS[tag.name]) return CATEGORY_TAGS[tag.name];
    }
    return ASPECT_CATEGORY[affix.eCategory] ?? null;
  }

  /** "of Berserk Ripping" -> "Aspect of Berserk Ripping", "Skullbreaker's" -> "Skullbreaker's Aspect". */
  aspectName(raw) {
    const name = plainText(raw)?.trim();
    if (!name) return null;
    if (/aspect/i.test(name)) return name;
    return /^of\s/i.test(name) ? `Aspect ${name}` : `${name} Aspect`;
  }

  /** English name of any SNO record, trying the label variants groups use. */
  nameOf(group, name) {
    const strings = this.repo.strings(group, name);
    if (!strings) return null;
    const value = strings.Name ?? strings.name ?? strings.NAME ?? strings.Title ?? null;
    return value ? plainText(value) : null;
  }

  get skillTagStrings() {
    if (!this._skillTagStrings) this._skillTagStrings = this.repo.stringList('SkillTags') || {};
    return this._skillTagStrings;
  }

  skillTagName(tag) {
    if (!tag) return null;
    const label = this.skillTagStrings[`${tag}_TagName`];
    return label ? plainText(label) : null;
  }

  /** GBID hash (signed or unsigned) -> name, from json/GBID.json. */
  gbidName(type, hash) {
    const table = this.repo.table('GBID')?.[String(type)];
    if (!table) return null;
    const unsigned = hash < 0 ? hash + 2 ** 32 : hash;
    return table[String(unsigned)]?.[0] ?? null;
  }

  // ---- attributes ----------------------------------------------------------

  get attributes() {
    if (!this._attributes) {
      const file = path.join(this.repoRoot, 'attributes.json');
      this._attributes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    }
    return this._attributes;
  }

  get attributeDescriptions() {
    if (!this._attributeDescriptions) this._attributeDescriptions = this.repo.stringList('AttributeDescriptions') || {};
    return this._attributeDescriptions;
  }

  /**
   * Readable name for an attribute's nParam, e.g. a power, skill tag,
   * damage type or weapon requirement. Returns { key, name } where key is
   * the internal name used for "Attribute#Key" description lookups.
   */
  attributeParam(attributeName, param) {
    if (param === -1 || param === undefined || param === null) return null;

    const type = this.attributes[attributeName]?.eParameterType;

    if (type === PARAM_DAMAGE_TYPE) {
      const name = DAMAGE_TYPES[param] ?? String(param);
      return { key: name, name };
    }

    if (type === PARAM_RESOURCE) {
      const name = RESOURCE_TYPES[param] ?? `Resource ${param}`;
      return { key: name, name };
    }

    if (type === PARAM_SKILL_TAG) {
      const key = this.gbidName(56, param);
      return key ? { key, name: this.skillTagName(key) ?? key } : { key: String(param), name: String(param) };
    }

    const sno = this.repo.graph.describe(param);

    if (sno && (PARAM_SNO.has(type) || type === undefined)) {
      let name = this.nameOf(sno.group, sno.name);
      if (!name && sno.group === 'ItemRequirement') {
        name = plainText(this.repo.stringList('ItemRequirements')?.[sno.name] ?? '') || null;
      }
      return { key: sno.name, name: name ?? sno.name, sno: `${sno.group}/${sno.name}` };
    }

    return { key: String(param), name: String(param) };
  }

  /** Description template for an attribute, preferring the "Attribute#Param" variant. */
  attributeTemplate(attributeName, paramKey) {
    const table = this.attributeDescriptions;
    return (paramKey && table[`${attributeName}#${paramKey}`]) || table[attributeName] || null;
  }

  // ---- balance formulas ----------------------------------------------------

  /** AttributeFormulas.gam entry by name: [{ itemPower, formula }]. */
  attributeFormula(name) {
    if (!this._attributeFormulas) {
      this._attributeFormulas = new Map();
      for (const entry of this.repo.balance('AttributeFormulas')) {
        this._attributeFormulas.set(entry.tHeader?.szName, (entry.arRanges || []).map(range => ({
          itemPower: range.nItemPowerRangeStart,
          formula: range.tFormula?.value ?? null,
        })));
      }
    }
    return this._attributeFormulas.get(name) ?? null;
  }

  // ---- powers --------------------------------------------------------------

  /** Value of PowerTag.<power>."Script Formula N" (or SF_N inside a power), or null. */
  powerFormula(powerName, index, pick) {
    const power = this.repo.get('Power', powerName);
    const source = power?.ptScriptFormulas?.[index]?.tFormula?.value;

    if (!source || this.powerFormulaDepth > 8) return null;

    this.powerFormulaDepth++;
    try {
      return evaluate(parseFormula(source), this.powerContext(powerName, pick));
    } finally {
      this.powerFormulaDepth--;
    }
  }

  powerContext(powerName, pick) {
    return {
      pick,
      ident: name => {
        const sf = name.match(/^SF_(\d+)$/);
        if (sf) return this.powerFormula(powerName, Number(sf[1]), pick);
        return this.resolvePowerTag(name, pick);
      },
    };
  }

  /** PowerTag.X."Script Formula N" -> number, null (unknowable) or undefined (not a power tag). */
  resolvePowerTag(name, pick) {
    const match = name.match(/^PowerTag\.([^.]+)\."?Script Formula (\d+)"?$/);
    if (!match) return undefined;
    return this.powerFormula(match[1], Number(match[2]), pick);
  }
}
