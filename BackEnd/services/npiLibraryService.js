const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

// Same cap as wtsService — BOM Report sheets can run 30k+ rows.
const MAX_SHEET_ROWS = 5000;
const INDEXER_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-npi-index.js');

function getNpiDataDir() {
  const dir = (process.env.NPI_DATA_DIR || '').trim();
  return dir || null;
}

function getMsfRoot() {
  const dataDir = getNpiDataDir();
  return dataDir ? path.join(dataDir, 'MSF') : null;
}

function getIndexPath() {
  const msfRoot = getMsfRoot();
  return msfRoot ? path.join(msfRoot, 'NpiLibrary', 'index.json') : null;
}

// Reads MSF/NpiLibrary/index.json, written by build-npi-index.js. Mirrors
// wtsService.loadIndex()'s three-state distinction: dir not configured / dir
// configured but indexer hasn't run yet / has data.
function loadIndex() {
  const dataDir = getNpiDataDir();
  if (!dataDir) {
    return { dataDirConfigured: false, indexExists: false, generatedAt: null, warnings: [], skus: [], crossTables: [] };
  }
  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    return { dataDirConfigured: true, indexExists: false, generatedAt: null, warnings: [], skus: [], crossTables: [] };
  }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  return {
    dataDirConfigured: true,
    indexExists: true,
    generatedAt: raw.generatedAt || null,
    warnings: raw.warnings || [],
    skus: raw.skus || [],
    crossTables: raw.crossTables || [],
  };
}

// relPath is always server-generated (written by build-npi-index.js into
// index.json, never client-supplied), so this join is safe by construction —
// the containment check is defense-in-depth in case index.json is ever hand-edited.
function resolveRelPath(relPath) {
  const msfRoot = getMsfRoot();
  if (!msfRoot) {
    throw Object.assign(new Error('NPI_DATA_DIR is not configured.'), { status: 400 });
  }
  const rootResolved = path.resolve(msfRoot);
  const absPath = path.resolve(msfRoot, relPath);
  if (absPath !== rootResolved && !absPath.startsWith(rootResolved + path.sep)) {
    throw Object.assign(new Error('Invalid file path.'), { status: 400 });
  }
  if (!fs.existsSync(absPath)) {
    throw Object.assign(new Error(`File not found: ${relPath}`), { status: 404 });
  }
  return absPath;
}

// Looked up by itemNumber+revision (not bare fileName) because two order
// folders can hold same-named files at different physical paths — see plan.
function resolveSkuFile(itemNumber, revision) {
  const { skus } = loadIndex();
  const rec = skus.find(s => s.itemNumber === itemNumber && s.revision === revision);
  if (!rec) {
    throw Object.assign(new Error(`SKU not found: ${itemNumber} Rev ${revision}`), { status: 404 });
  }
  return resolveRelPath(rec.relPath);
}

function resolveCrossTableFile(gen, fileName) {
  const { crossTables } = loadIndex();
  const rec = crossTables.find(c => String(c.gen) === String(gen) && c.fileName === fileName);
  if (!rec) {
    throw Object.assign(new Error(`Cross table file not found: Gen ${gen} / ${fileName}`), { status: 404 });
  }
  return resolveRelPath(rec.relPath);
}

function assertXlsx(absPath) {
  if (!absPath.toLowerCase().endsWith('.xlsx')) {
    throw Object.assign(new Error('Only .xlsx files have sheets.'), { status: 400 });
  }
}

function listSheetNames(absPath) {
  assertXlsx(absPath);
  const wb = XLSX.readFile(absPath);
  return wb.SheetNames;
}

function readSheet(absPath, sheetName) {
  assertXlsx(absPath);
  const wb = XLSX.readFile(absPath);
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw Object.assign(new Error(`Sheet not found: ${sheetName}`), { status: 400 });
  }
  const allRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const truncated = allRows.length > MAX_SHEET_ROWS;
  const rows = truncated ? allRows.slice(0, MAX_SHEET_ROWS) : allRows;
  const columns = allRows.length > 0
    ? Object.keys(allRows[0])
    : (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(String);
  return { columns, rows, rowCount: allRows.length, colCount: columns.length, truncated };
}

// Copies the about-to-be-overwritten file into
// MSF/NpiLibrary/upload-backups/ before a replace-upload touches it — kept
// outside the Gen N tree the indexer walks (see build-npi-index.js's
// walkXlsxFiles) so backups never get picked up as stray ancillary files or
// duplicate SKU masters. One-shot safety net, not real version history: a
// second upload of the same SKU won't build on this backup, it just adds one.
function backupBeforeOverwrite(absPath, relPath) {
  const msfRoot = getMsfRoot();
  const backupDir = path.join(msfRoot, 'NpiLibrary', 'upload-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = relPath.split('/').join('__');
  fs.copyFileSync(absPath, path.join(backupDir, `${stamp}__${safeName}`));
}

function assertXlsxUpload(originalName) {
  if (!/\.xlsx$/i.test(originalName || '')) {
    throw Object.assign(new Error('Only .xlsx files are accepted.'), { status: 400 });
  }
}

// A full reindex walks every Gen 8-11 SKU + Cross Table (measured: multiple
// CPU-bound minutes, since it's the same synchronous XLSX parsing as the CLI
// run) — running that in-process after every upload would peg Node's single
// event loop and freeze the whole app for every other user, not just the
// uploader. Spawning the existing CLI script as its own OS process keeps the
// rebuild off the server's event loop entirely; it's fire-and-forget, so
// index.json (and anything reading it) stays briefly stale after an upload
// until this finishes. rebuildInFlight coalesces overlapping uploads into a
// single rebuild instead of racing two indexers over the same index.json.
let rebuildInFlight = false;
function rebuildIndexInBackground() {
  if (rebuildInFlight) return;
  rebuildInFlight = true;
  // detached + unref: confirmed by testing that without this, a `pm2
  // restart` (or the ecosystem config's watch:true auto-restart) while a
  // reindex is in flight kills the child too (exit code 3221225786 /
  // STATUS_CONTROL_C_EXIT on Windows) — safe (index.json is only written
  // once, at the very end, so a killed run just leaves the old file in
  // place) but silently stale. Detaching lets the reindex outlive a server
  // restart instead.
  const child = spawn(process.execPath, [INDEXER_SCRIPT], {
    cwd: path.dirname(INDEXER_SCRIPT),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.unref();
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', err => {
    rebuildInFlight = false;
    console.error('NPI Library background reindex failed to start:', err.message);
  });
  child.on('exit', code => {
    rebuildInFlight = false;
    if (code !== 0) console.error(`NPI Library background reindex exited with code ${code}: ${stderr.trim()}`);
  });
}

// Overwrites an existing SKU's BOM master file in place (same relPath the
// index already points to) after checking the upload really is a BOM master
// for THIS itemNumber+revision — catches "picked the wrong file" before it
// clobbers anything. Kicks off a background reindex afterward (see
// rebuildIndexInBackground) so index.json eventually reflects the new
// content/mtime without a manual indexer run — GET /api/npi/index may still
// show the pre-upload data for a bit while that finishes.
function replaceSkuFile(itemNumber, revision, buffer, originalName) {
  assertXlsxUpload(originalName);
  const absPath = resolveSkuFile(itemNumber, revision);
  const relPath = path.relative(getMsfRoot(), absPath).split(path.sep).join('/');

  // Cheap check first (sheet names only, no cell data) — same split
  // build-npi-index.js uses (getSheetNamesCheap before parseSkuMaster's full
  // read). Rejecting an obviously-wrong file here matters: without it, a
  // mis-clicked upload of e.g. a 20MB+ Cross Table onto a SKU endpoint does a
  // full XLSX parse before the sheet check ever runs, blocking Node's single
  // event loop — and the whole app with it — for the entire request.
  let cheapNames;
  try {
    cheapNames = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  } catch (e) {
    throw Object.assign(new Error(`Uploaded file could not be read as an Excel workbook: ${e.message}`), { status: 400 });
  }
  if (!cheapNames.includes('Part Properties') || !cheapNames.includes('Bom Report')) {
    throw Object.assign(new Error('Uploaded file is missing "Part Properties"/"Bom Report" sheets — doesn\'t look like a SKU BOM master.'), { status: 400 });
  }

  // Only Part Properties' Name/Value rows are needed for the itemNumber/
  // revision check below — restricting the parse to that one sheet skips the
  // (often 30k+ row) Bom Report entirely. Measured on a real 6MB SKU master:
  // ~1s restricted vs ~15s unrestricted, and the file being written to disk
  // is the original upload buffer, not anything re-serialized from wb here.
  const wb = XLSX.read(buffer, { type: 'buffer', sheets: ['Part Properties'] });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Part Properties'], { header: 1, raw: false, defval: '' });
  const flat = {};
  for (const r of rows) {
    const name = String(r[0] || '').trim();
    if (name) flat[name] = String(r[1] ?? '').trim();
  }
  if (flat['Item Number'] !== itemNumber || flat['Part Revision'] !== revision) {
    throw Object.assign(new Error(
      `Uploaded file is ${flat['Item Number'] || '(unknown)'} Rev ${flat['Part Revision'] || '(unknown)'}, not ${itemNumber} Rev ${revision}.`
    ), { status: 400 });
  }

  backupBeforeOverwrite(absPath, relPath);
  fs.writeFileSync(absPath, buffer);
  rebuildIndexInBackground();
  return { reindexing: true };
}

// Same shape as replaceSkuFile but for Cross Table files. Cross Table layout
// isn't standardized across Gens (see build-npi-index.js's Gen-11-only
// mpSheets parsing), so there's no reliable itemNumber-style field to
// cross-check the upload against beyond "it's a real .xlsx".
function replaceCrossTableFile(gen, fileName, buffer, originalName) {
  assertXlsxUpload(originalName);
  const absPath = resolveCrossTableFile(gen, fileName);
  const relPath = path.relative(getMsfRoot(), absPath).split(path.sep).join('/');

  try {
    XLSX.read(buffer, { type: 'buffer', bookSheets: true });
  } catch (e) {
    throw Object.assign(new Error(`Uploaded file could not be read as an Excel workbook: ${e.message}`), { status: 400 });
  }

  backupBeforeOverwrite(absPath, relPath);
  fs.writeFileSync(absPath, buffer);
  rebuildIndexInBackground();
  return { reindexing: true };
}

// NpiLibrary is the app's own state (index.json, upload-backups) rather than
// real NPI content — kept out of the raw folder browser/upload so a user
// can't navigate into or write over it by mistake.
const RESERVED_TOP_LEVEL = new Set(['NpiLibrary']);

function assertBrowsable(absPath) {
  const topSegment = path.relative(getMsfRoot(), absPath).split(path.sep)[0];
  if (RESERVED_TOP_LEVEL.has(topSegment)) {
    throw Object.assign(new Error('This folder is used internally by the app and isn\'t browsable.'), { status: 403 });
  }
}

// Lists one folder under MSF_ROOT for the raw file browser (independent of
// index.json — this walks the real filesystem live, so it works even before
// an index has ever been built). relPath === '' lists MSF_ROOT itself.
function listFolder(relPath) {
  const absDir = resolveRelPath(relPath || '.');
  if (!fs.statSync(absDir).isDirectory()) {
    throw Object.assign(new Error('Not a folder.'), { status: 400 });
  }
  assertBrowsable(absDir);

  const entries = fs.readdirSync(absDir, { withFileTypes: true }).map(d => {
    const abs = path.join(absDir, d.name);
    const stat = fs.statSync(abs);
    return {
      name: d.name,
      type: d.isDirectory() ? 'dir' : 'file',
      sizeBytes: d.isDirectory() ? null : stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  });
  entries.sort((a, b) => (
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })
  ));

  return { path: path.relative(getMsfRoot(), absDir).split(path.sep).join('/'), entries };
}

function resolveBrowseFile(relPath) {
  const absPath = resolveRelPath(relPath);
  if (fs.statSync(absPath).isDirectory()) {
    throw Object.assign(new Error('That path is a folder, not a file.'), { status: 400 });
  }
  assertBrowsable(absPath);
  return absPath;
}

// No auth on this app (see server.js) and this endpoint accepts ANY file
// type into ANY existing folder under MSF_ROOT, so it blocks the file types
// that would actually be dangerous to have land on a shared server — not a
// content allowlist, since real NPI folders legitimately hold docx/pdf/pptx/
// csv/png alongside the xlsx files the rest of this service cares about.
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.jar', '.sh', '.reg',
]);
const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// Uploads into an existing folder under a name the caller doesn't control
// the server-side resolution of (see the re-containment check below) —
// unlike replaceSkuFile/replaceCrossTableFile, this can create a brand-new
// file, so callers must opt into overwrite explicitly (409 otherwise) rather
// than silently clobbering something with the same name.
function uploadToFolder(relPath, buffer, originalName, overwrite) {
  const absDir = resolveRelPath(relPath || '.');
  if (!fs.statSync(absDir).isDirectory()) {
    throw Object.assign(new Error('Not a folder.'), { status: 400 });
  }
  assertBrowsable(absDir);

  const baseName = path.basename(String(originalName || '')).trim();
  if (!baseName) {
    throw Object.assign(new Error('No filename given.'), { status: 400 });
  }
  const ext = path.extname(baseName).toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
    throw Object.assign(new Error(`"${ext}" files can't be uploaded here.`), { status: 400 });
  }
  const safeName = baseName.replace(WINDOWS_INVALID_FILENAME_CHARS, '_');

  // baseName is already separator-free (path.basename), so this should be
  // unreachable — kept as defense-in-depth rather than trusting that.
  const dirResolved = path.resolve(absDir);
  const absTarget = path.resolve(absDir, safeName);
  if (absTarget !== dirResolved && !absTarget.startsWith(dirResolved + path.sep)) {
    throw Object.assign(new Error('Invalid file name.'), { status: 400 });
  }

  if (fs.existsSync(absTarget) && !overwrite) {
    throw Object.assign(new Error(`"${safeName}" already exists in this folder.`), { status: 409 });
  }

  fs.writeFileSync(absTarget, buffer);
  // Only .xlsx under Gen N ever feeds index.json (see build-npi-index.js's
  // walkXlsxFiles) — skip the reindex for everything else.
  const reindexing = ext === '.xlsx';
  if (reindexing) rebuildIndexInBackground();
  return { ok: true, name: safeName, reindexing };
}

module.exports = {
  getNpiDataDir,
  getMsfRoot,
  getIndexPath,
  loadIndex,
  resolveSkuFile,
  resolveCrossTableFile,
  listSheetNames,
  readSheet,
  replaceSkuFile,
  replaceCrossTableFile,
  listFolder,
  resolveBrowseFile,
  uploadToFolder,
};
