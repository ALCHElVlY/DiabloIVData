import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOLVER_FILES, RESOLVER_GROUPS, createGame, extraFiles, resolveAll } from './lib/resolve/index.mjs';

const API_VERSION = 1;
const PART_LIMIT_BYTES = 50 * 1024 * 1024;
const TABLE_LIMIT_BYTES = 5 * 1024 * 1024;

/** Groups bundled onto Pages, as "<source>/<group>" under json/<source>/meta/. */
const BUNDLED_GROUPS = [
  'base/Affix',
  'base/Aspect',
  'base/CollectiblePower',
  'base/DungeonAffix',
  'base/GameBalance',
  'base/GenericSkillTree',
  'base/Item',
  'base/ItemRequirement',
  'base/ItemType',
  'base/Jewelry',
  'base/MonsterAffix',
  'base/ParagonBoard',
  'base/ParagonGlyph',
  'base/ParagonGlyphAffix',
  'base/ParagonNode',
  'base/ParagonThreshold',
  'base/PlayerClass',
  'base/Power',
  'base/PowerModifier',
  'base/Recipe',
  'base/Season',
  'base/SetItemBonus',
  'base/SkillKit',
  'enUS_Text/StringList',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'api', 'dist');
const apiRoot = path.join(distRoot, 'api', `v${API_VERSION}`);

async function main() {
  const tree = readTree();

  if (process.argv.includes('--print-sparse')) {
    printSparsePatterns(tree);
    return;
  }

  const version = await readVersion();
  const sourceCommit = git('rev-parse', 'HEAD').trim();
  const rawRoot = `https://raw.githubusercontent.com/${readRepository()}/${sourceCommit}/`;

  await rm(distRoot, { recursive: true, force: true });

  const manifest = {
    apiVersion: API_VERSION,
    dataVersion: version.dataVersion,
    d4Build: version.d4Build,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    tables: await buildTables(tree.tables, rawRoot),
    groups: {},
  };

  let bundledBytes = 0;

  for (const [key, group] of [...tree.groups].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = {
      fileExtension: group.extension,
      files: group.files.length,
      rawBaseUrl: `${rawRoot}json/${group.source}/meta/${group.name}/`,
    };

    if (BUNDLED_GROUPS.includes(key)) {
      entry.parts = await buildBundle(key, group);
      bundledBytes += entry.parts.reduce((sum, part) => sum + part.bytes, 0);
    } else {
      entry.index = await buildIndex(key, group);
    }

    manifest.groups[key] = entry;
  }

  const missing = BUNDLED_GROUPS.filter(key => !tree.groups.has(key));

  if (missing.length > 0) {
    throw new Error(`Bundled groups not found under json/: ${missing.join(', ')}`);
  }

  manifest.data = await buildResolved(tree, manifest);

  await writeJson(path.join(apiRoot, 'manifest.json'), manifest);
  await writeJson(path.join(apiRoot, 'latest.json'), {
    apiVersion: manifest.apiVersion,
    dataVersion: manifest.dataVersion,
    d4Build: manifest.d4Build,
    sourceCommit: manifest.sourceCommit,
    generatedAt: manifest.generatedAt,
    manifest: 'manifest.json',
  });
  await writeFile(path.join(distRoot, 'index.html'), renderIndex(manifest));
  await writeFile(path.join(distRoot, '.nojekyll'), '');

  console.log(`Built API v${API_VERSION} for data ${manifest.dataVersion} (${sourceCommit.slice(0, 7)})`);
  console.log(`${BUNDLED_GROUPS.length} bundled groups (${(bundledBytes / 1024 / 1024).toFixed(1)} MB), `
    + `${tree.groups.size - BUNDLED_GROUPS.length} indexed groups, `
    + `${Object.keys(manifest.data).length} resolved endpoints -> ${path.relative(repoRoot, distRoot)}`);
}

/**
 * Lists json/ from git trees rather than the working tree, so the build
 * works from a sparse checkout that only contains the files it publishes.
 */
function readTree() {
  const output = git('ls-tree', '-r', '--name-only', '-z', 'HEAD', 'json/');
  const tables = [];
  const groups = new Map();

  for (const file of output.split('\0')) {
    if (!file) {
      continue;
    }

    const parts = file.split('/');

    // json/<source>/meta/<group>/<name>.<ext>.json
    if (parts.length === 5 && parts[2] === 'meta') {
      const [, source, , name, fileName] = parts;
      const key = `${source}/${name}`;
      const match = fileName.match(/^(.*)\.([^.]+)\.json$/);

      if (!groups.has(key)) {
        groups.set(key, { source, name, extension: match ? match[2] : null, files: [] });
      }

      groups.get(key).files.push({ path: file, name: match ? match[1] : fileName.replace(/\.json$/, '') });
    } else if (file.endsWith('.json') && !file.includes('/meta/')) {
      tables.push({ path: file });
    }
  }

  return { tables, groups };
}

function printSparsePatterns(tree) {
  const patterns = ['/api/', '/buildVersion.txt', ...RESOLVER_FILES.map(file => `/${file}`)];

  for (const table of tree.tables) {
    patterns.push(`/${table.path}`);
  }

  for (const key of new Set([...BUNDLED_GROUPS, ...RESOLVER_GROUPS])) {
    const group = tree.groups.get(key);

    if (group) {
      patterns.push(`/json/${group.source}/meta/${group.name}/`);
    }
  }

  console.log(patterns.join('\n'));
}

/**
 * Writes the readable, cross-referenced endpoints under data/. Single files
 * the resolvers need from large groups (a few dozen Actor records) are added
 * to a sparse checkout first.
 */
async function buildResolved(tree) {
  const game = createGame(repoRoot);

  ensureFiles(tree, extraFiles(game));
  game.repo.refresh();

  console.log('Resolving readable data:');
  const endpoints = resolveAll(game, message => console.log(message));
  const result = {};

  for (const endpoint of endpoints) {
    const relative = `data/${endpoint.name}.json`;
    const records = Array.isArray(endpoint.data) ? endpoint.data.length : undefined;
    const bytes = await writeJson(path.join(apiRoot, relative), endpoint.data);

    result[endpoint.name] = {
      path: relative,
      description: endpoint.description,
      sha256: sha256(bytes),
      bytes: bytes.length,
      ...(records === undefined ? {} : { records }),
    };
  }

  return result;
}

/** Checks out individual json/ files that a sparse checkout is missing. */
function ensureFiles(tree, refs) {
  const missing = [];

  for (const ref of refs) {
    const file = tree.groups.get(`base/${ref.group}`)?.files.find(f => f.name === ref.name);

    if (file && !existsSync(path.join(repoRoot, file.path))) {
      missing.push(`/${file.path}`);
    }
  }

  if (missing.length === 0) {
    return;
  }

  console.log(`Checking out ${missing.length} extra files for the resolver`);

  try {
    execFileSync('git', ['sparse-checkout', 'add', '--stdin'], { cwd: repoRoot, input: missing.join('\n'), stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (error) {
    console.warn(`Could not check out extra files (${error.message}); some boss details will be missing.`);
  }
}

async function readVersion() {
  const dataVersion = (await readFile(path.join(repoRoot, 'buildVersion.txt'), 'utf8')).trim();
  const build = Number(dataVersion.split('.').pop());

  return {
    dataVersion,
    d4Build: Number.isInteger(build) ? build : null,
  };
}

/** Returns "owner/repo" for building commit-pinned raw.githubusercontent.com URLs. */
function readRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  const match = git('remote', 'get-url', 'origin').trim().match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);

  if (!match) {
    throw new Error('Could not determine the GitHub repository; set GITHUB_REPOSITORY.');
  }

  return match[1];
}

/** Copies small top-level files; links large ones to the pinned commit. */
async function buildTables(tables, rawRoot) {
  const result = {};

  for (const table of tables.sort((a, b) => a.path.localeCompare(b.path))) {
    const key = table.path.slice('json/'.length, -'.json'.length);
    const { size } = await stat(path.join(repoRoot, table.path));

    if (size > TABLE_LIMIT_BYTES) {
      result[key] = { rawUrl: rawRoot + encodePath(table.path), bytes: size };
      continue;
    }

    const data = JSON.parse(await readFile(path.join(repoRoot, table.path), 'utf8'));
    const relative = `tables/${key}.json`;

    result[key] = describe(relative, await writeJson(path.join(apiRoot, relative), data), data);
  }

  return result;
}

/** Merges a group into { name: record } bundles of at most PART_LIMIT_BYTES each. */
async function buildBundle(key, group) {
  const files = [...group.files].sort((a, b) => a.name.localeCompare(b.name));
  const batches = [[]];
  let batchBytes = 0;

  for (const file of files) {
    const record = JSON.stringify(JSON.parse(await readFile(path.join(repoRoot, file.path), 'utf8')));
    const entry = `${JSON.stringify(file.name)}:${record}`;

    if (batches.at(-1).length > 0 && batchBytes + entry.length > PART_LIMIT_BYTES) {
      batches.push([]);
      batchBytes = 0;
    }

    batches.at(-1).push(entry);
    batchBytes += entry.length + 1;
  }

  // A single-part bundle keeps the plain name; multi-part bundles are numbered from 1.
  const parts = [];

  for (const [i, batch] of batches.entries()) {
    const relative = `groups/${key}${batches.length > 1 ? `.${i + 1}` : ''}.json`;
    const bytes = Buffer.from(`{${batch.join(',')}}`, 'utf8');

    await writeBytes(path.join(apiRoot, relative), bytes);
    parts.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length, records: batch.length });
  }

  return parts;
}

/** Writes the sorted list of file names for a group fetched from raw URLs. */
async function buildIndex(key, group) {
  const relative = `index/${key}.json`;
  const names = group.files.map(file => file.name).sort();

  await writeJson(path.join(apiRoot, relative), names);

  return relative;
}

function describe(relative, bytes, data) {
  return {
    path: relative,
    sha256: sha256(bytes),
    bytes: bytes.length,
    records: Array.isArray(data) ? data.length : Object.keys(data).length,
  };
}

/** Writes minified JSON and returns the exact bytes written. */
async function writeJson(file, data) {
  const bytes = Buffer.from(JSON.stringify(data), 'utf8');

  await writeBytes(file, bytes);

  return bytes;
}

async function writeBytes(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

function encodePath(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
}

function renderIndex(manifest) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>d4data API</title>
</head>
<body>
<h1>d4data API v${manifest.apiVersion}</h1>
<p>Data version ${manifest.dataVersion}, built from commit <code>${manifest.sourceCommit}</code>.</p>
<ul>
<li><a href="api/v${manifest.apiVersion}/latest.json">latest.json</a></li>
<li><a href="api/v${manifest.apiVersion}/manifest.json">manifest.json</a></li>
</ul>
<h2>Readable data</h2>
<ul>
${Object.entries(manifest.data || {}).map(([name, entry]) => `<li><a href="api/v${manifest.apiVersion}/${entry.path}">${name}</a> - ${entry.description}</li>`).join('\n')}
</ul>
</body>
</html>
`;
}

await main();
