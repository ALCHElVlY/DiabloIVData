import { describeAffix } from '../affix.mjs';
import { evaluate, parseFormula } from '../formula.mjs';
import { CLASS_ORDER } from '../game.mjs';
import { renderPowerText } from '../power.mjs';
import { renderText } from '../text.mjs';
import { byName, compact, text } from './common.mjs';

const NODE_RARITY = { 1: 'Normal', 2: 'Magic', 3: 'Rare', 4: 'Legendary' };
const GLYPH_RARITY = { 0: 'Magic', 1: 'Rare', 2: 'Legendary' };

/** Internal class prefixes used in paragon file names. */
const CLASS_PREFIX = {
  Barb: 'Barbarian', Barbarian: 'Barbarian', Druid: 'Druid', Necro: 'Necromancer', Necromancer: 'Necromancer',
  Paladin: 'Paladin', Rogue: 'Rogue', Sorc: 'Sorcerer', Sorcerer: 'Sorcerer', Spirit: 'Spiritborn',
  Spiritborn: 'Spiritborn', Warlock: 'Warlock',
};

/** Paragon nodes with their stats, threshold bonus and legendary power text. */
export function resolveParagonNodes(game) {
  const { repo } = game;
  const result = [];

  for (const id of repo.names('ParagonNode')) {
    const node = repo.get('ParagonNode', id);
    if (!node || id === 'Axe Bad Data') continue;
    result.push(describeNode(game, id, node));
  }

  return result.sort(byName);
}

function describeNode(game, id, node) {
  const { repo } = game;
  const attributes = node.ptAttributes || [];
  const stats = attributes.length ? describeAttributes(game, id, attributes) : null;
  const bonusIndices = new Set(node.ptBonusAttributeIndices || []);
  const passive = node.snoPassivePower?.name;
  const passiveText = passive ? renderPowerText(game, passive, repo.strings('Power', passive)?.desc) : null;
  const rarity = NODE_RARITY[node.eRarityOverride] ?? (/_Normal_/.test(id) ? 'Normal' : undefined);

  let name = game.nameOf('ParagonNode', id) ?? (passive ? game.nameOf('Power', passive) : null);

  // Common stat nodes have no name of their own; the stat line is the name.
  if (!name && stats?.lines.length === 1) name = stats.lines[0].replace(/^[+\d.,–%\s]+/, '').trim() || null;

  return compact({
    id,
    snoId: node.__snoID__,
    name: name ?? id,
    rarity: node.bHasSocket ? 'Socket' : node.bIsGate ? 'Gate' : /^StartNode/.test(id) ? 'Start' : rarity,
    class: classFromId(id),
    stats: stats?.values.map((value, index) => compact({
      ...value,
      description: stats.lines[index],
      thresholdBonus: bonusIndices.has(index) ? true : undefined,
    })),
    threshold: (node.arThresholdSelector || []).map(ref => threshold(game, ref?.name)).filter(Boolean),
    description: passiveText?.text || stats?.lines.join('\n') || null,
    keywords: passiveText?.keywords,
    passivePower: passive,
    tags: (node.arSkillTags || []).map(t => t?.name).filter(Boolean),
    season: game.seasons.tag('ParagonNode', id),
  });
}

/** Paragon boards as a grid of node ids, with their legendary node and sockets. */
export function resolveParagonBoards(game) {
  const { repo } = game;
  const result = [];

  for (const id of repo.names('ParagonBoard')) {
    const board = repo.get('ParagonBoard', id);
    if (!board || id === 'Axe Bad Data') continue;

    const width = board.nWidth || 21;
    const entries = (board.arEntries || []).map(ref => ref?.name ?? null);
    const rows = [];
    for (let i = 0; i < entries.length; i += width) rows.push(entries.slice(i, i + width));

    const positions = name => entries
      .map((entry, index) => (entry === name ? { x: index % width, y: Math.floor(index / width) } : null))
      .filter(Boolean);

    const legendary = [...new Set(entries.filter(e => e && /_Legendary_/.test(e)))];
    const counts = {};
    for (const entry of entries) {
      if (!entry) continue;
      const kind = /Socket/.test(entry) ? 'socket' : /Gate/.test(entry) ? 'gate' : /StartNode/.test(entry) ? 'start'
        : /_Legendary_/.test(entry) ? 'legendary' : /_Rare_/.test(entry) ? 'rare' : /_Magic_/.test(entry) ? 'magic' : 'normal';
      counts[kind] = (counts[kind] || 0) + 1;
    }

    result.push(compact({
      id,
      snoId: board.__snoID__,
      name: game.nameOf('ParagonBoard', id) ?? id,
      class: classFromId(id),
      width,
      height: rows.length,
      legendaryNodes: legendary.map(n => ({ id: n, name: game.nameOf('ParagonNode', n) ?? n })),
      sockets: positions('Generic_Socket'),
      gates: positions('Generic_Gate'),
      nodeCounts: counts,
      grid: rows,
      season: game.seasons.tag('ParagonBoard', id),
    }));
  }

  return result.sort((a, b) => (a.class ?? '').localeCompare(b.class ?? '') || a.id.localeCompare(b.id));
}

/**
 * Paragon glyphs and their affixes. Glyph bonuses grow with glyph level:
 * `atLevel1` and `perLevel` give the scalar; descriptions show level 1.
 */
export function resolveParagonGlyphs(game) {
  const { repo } = game;
  const result = [];

  for (const id of repo.names('ParagonGlyph')) {
    const glyph = repo.get('ParagonGlyph', id);
    if (!glyph || id === 'Axe Bad Data') continue;

    result.push(compact({
      id,
      snoId: glyph.__snoID__,
      name: game.nameOf('ParagonGlyph', id) ?? id,
      rarity: GLYPH_RARITY[glyph.eRarity],
      classes: game.classes(glyph.fUsableByClass),
      affixes: (glyph.arAffixes || []).map(ref => glyphAffix(game, ref?.name)).filter(Boolean),
      season: game.seasons.tag('ParagonGlyph', id, { requirements: glyph.tRequirementsToBeActive }),
    }));
  }

  return result.sort(byName);
}

function glyphAffix(game, id) {
  if (!id) return null;
  const { repo } = game;
  const affix = repo.get('ParagonGlyphAffix', id);
  if (!affix) return null;

  const strings = repo.strings('ParagonGlyphAffix', id) || {};
  const start = affix.flStartingBonusScalar;
  const step = affix.flAddedBonusScalarPerLevel;
  const passive = affix.snoBonusPassivePower?.name;

  let description;

  if (strings.Desc) {
    const rendered = renderText(strings.Desc, {
      value: expr => {
        if (!/GlyphAffixScalar/i.test(expr) || start === undefined) return null;
        // Multiplicative bonuses are stored as fractions; additive ones as percent.
        const scale = affix.eBonusOperation === 4 && start < 1 ? 100 : 1;
        const v = start * scale;
        return { min: v, max: v };
      },
    });
    description = rendered.text;
  } else if (passive) {
    description = renderPowerText(game, passive, repo.strings('Power', passive)?.desc).text;
  }

  return compact({
    id,
    description: description || null,
    kind: passive ? 'bonus' : affix.eBonusOperation === 4 ? 'legendary' : 'additive',
    requiresRarity: GLYPH_RARITY[affix.eRequiredRarity],
    atLevel1: start ? round(start) : undefined,
    perLevel: step ? round(step) : undefined,
    threshold: (affix.arThresholdSelector || []).map(ref => threshold(game, ref?.name)).filter(Boolean),
    passivePower: passive,
  });
}

function threshold(game, id) {
  const record = id && game.repo.get('ParagonThreshold', id);
  if (!record) return null;

  return compact({
    id,
    requires: (record.ptThresholds || []).map(t => {
      const formula = t.tThresholdValueFormula?.value;
      // Board thresholds grow with the board's position: "230 + (75 * ParagonBoardEquipIndex)".
      const at = index => evaluate(parseFormula(formula), { ident: name => (name === 'ParagonBoardEquipIndex' ? index : null) });
      const base = at(0);
      const step = base === null ? null : at(1) - base;
      return compact({
        stat: (t.tThresholdAttribute?.__eAttribute_name__ ?? '').replace(/_(Core|Total)$/, ''),
        amount: base ?? formula,
        perBoardIndex: step || undefined,
      });
    }),
    classes: game.classes(record.arUsableByClass),
  });
}

/** Describes a list of AttributeSpecifiers by reusing the affix describer. */
function describeAttributes(game, id, attributes) {
  const fake = {
    __fileName__: `base/meta/ParagonNode/${id}.pgn`,
    ptItemAffixAttributes: attributes.map(tAttribute => ({ tAttribute })),
    arStaticValues: [],
    arMaxLegendaryRanks: [],
  };
  const d = describeAffix(game, fake);
  const lines = (d.description || '').split('\n');

  return {
    lines: attributes.map((_, i) => lines[i] ?? null),
    // Values that depend on the paragon power budget show as null, with the formula kept.
    values: d.values.map(({ byItemPower, formulaTable, scaling, formula, ...v }) => (v.min === null ? { ...v, formula } : v)),
  };
}

function classFromId(id) {
  const prefix = id.replace(/^Paragon_/, '').split('_')[0].replace(/^StartNode/, '');
  return CLASS_PREFIX[prefix] ?? (CLASS_ORDER.includes(prefix) ? prefix : undefined);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
