// Loader for the bomguard schema (Database/bomguard_postgres.sql). CLI entry
// point, run manually whenever NPI Files/MSF changes:
//
//   node BackEnd/scripts/load-bomguard-files.js --init     create schema (DROPS bomguard.*) + load
//   node BackEnd/scripts/load-bomguard-files.js            resync (upsert, keeps history)
//   node BackEnd/scripts/load-bomguard-files.js --dry-run  parse only, print what would load, no DB
//
// Walks <NPI_DATA_DIR>/MSF and mirrors it into Postgres:
//   Gen N folders -> bomguard.generation, every directory -> bomguard.folder,
//   MSF order folders -> bomguard.msf_order, every file -> bomguard.file.
// Everything runs in one transaction and upserts on rel_path, so a re-run
// only updates; rows no longer on disk are flagged is_present = false.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
// Same annon DB (10.251.231.77/annon) the backend uses. A dedicated Client
// rather than annonPool, which is forced read-only.
const { annonConnConfig } = require('../DB');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config', 'credentials', 'npi.env') });

const SCHEMA_SQL = path.join(__dirname, '..', '..', 'Database', 'bomguard_postgres.sql');
const SKIP_DIRS = new Set(['NpiLibrary']);

const args = new Set(process.argv.slice(2));
const INIT = args.has('--init');
const DRY_RUN = args.has('--dry-run');

const PN_RE = /M\d{7}-\d{3}/g;

// ---------- parsing ----------

function parseGenFolder(name) {
  const m = name.match(/^Gen\s*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

function isOrderFolderName(name) {
  return /^Gen\s*\d/i.test(name) && /MSF-\d{5,6}/i.test(name);
}

// "Gen 8.2_MSF-065963_L11_M1202868-001_L10_M1202869-001_DW (MSF-060977)"
// Tolerates: "Gen 9.1 _MSF", "Gen 8.3_ MSF", "MSF-060980 _L11", "$006" PN
// suffixes, "DW(MSF-...)" with no space, a missing "_L10_" marker (second PN
// is then L10), and trailing tags ("_S2295", "SLB", " (HH34)", "_AFD").
function parseOrderFolderName(name) {
  const gen = name.match(/^Gen\s*(\d+(?:\.\d+)?)/i);
  const msf = name.match(/MSF-(\d{5,6})/i);
  // "_DW (MSF-060977)", "_DW(MSF-...)", or a bare "_DW" followed by a tag
  // like "(MM34)" (still a DW, just with no parent MSF# in the name).
  const dw = name.match(/(?:^|[_\s])DW\b\s*(?:\(\s*MSF-(\d{5,6})\s*\))?/i);

  // Part numbers live before the DW group (the DW group only holds an MSF#).
  const pnZone = dw ? name.slice(0, dw.index) : name;
  const pns = [];
  let lastEnd = 0;
  for (const m of pnZone.matchAll(/(M\d{7}-\d{3})(\$\w+)?/g)) {
    pns.push({ pn: m[1], suffix: m[2] || null });
    lastEnd = m.index + m[0].length;
  }
  if (dw) lastEnd = dw.index + dw[0].length;
  if (!pns.length && !dw) lastEnd = msf ? msf.index + msf[0].length : 0;

  const tail = name.slice(lastEnd).replace(/^[\s_]+/, '').trim();

  return {
    msfNumber: msf ? `MSF-${msf[1]}` : null,
    genVersion: gen ? gen[1] : null,
    l11Pn: pns[0] ? pns[0].pn : null,
    l11PnSuffix: pns[0] ? pns[0].suffix : null,
    l10Pns: pns.slice(1).map(p => p.pn),
    isDw: !!dw,
    dwOfMsfNumber: dw && dw[1] ? `MSF-${dw[1]}` : null,
    suffix: tail || null,
  };
}

function parsePartNumber(fileName) {
  const m = fileName.match(PN_RE);
  return m ? m[0] : null;
}

// "_RevAJ.xlsx", "-RevA-SPEC", " RevH FAI", "REVB_SPEC", "REV AV.docx"
function parseRevision(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const m = base.match(/(?:^|[_\-\s])Rev\.?\s*([A-Za-z]{1,2}\d?)(?=[\s_\-.(]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

function classifyDocType(fileName, category, inOrder) {
  const n = fileName;
  if (/cross\s*table/i.test(n) || /cross\s*table/i.test(category || '')) return 'cross_table';
  if (inOrder && /\.xlsx$/i.test(n) && /^(id\d+\.)?M\d{7}-\d{3}_/i.test(n) && /RASSY/i.test(n)) return 'bom_master';
  if (/FAI|First Article/i.test(n) || /FAI/i.test(category || '')) return 'fai';
  if (/label/i.test(n)) return inOrder ? 'cable_labeling' : 'label_plan';
  if (/issue list|manufacturing list|PFMEA|findings/i.test(n) || /issue list/i.test(category || '')) return 'issue_list';
  if (/spec|SOP|instruction|guide|checklist|requirement/i.test(n)) return 'spec';
  return 'other';
}

// ---------- walk ----------

// Returns { folders: [...parents-first], files: [...] } with everything
// resolved except DB ids.
function walkMsf(msfRoot) {
  const folders = [];
  const files = [];

  function walk(absDir, ctx) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = path.relative(msfRoot, abs).split(path.sep).join('/');
      const depth = rel.split('/').length;

      if (e.isDirectory()) {
        if (depth === 1 && SKIP_DIRS.has(e.name)) continue;
        const genNumber = depth === 1 ? parseGenFolder(e.name) : null;
        const isOrder = isOrderFolderName(e.name);
        let kind = 'other';
        if (genNumber !== null) kind = 'generation';
        else if (isOrder) kind = 'msf_order';
        else if (depth === 2 && ctx.genNumber !== null) kind = 'category';

        const folder = {
          name: e.name,
          relPath: rel,
          parentRel: ctx.folderRel,
          depth,
          genNumber: genNumber !== null ? genNumber : ctx.genNumber,
          category: depth === 1 ? null : (depth === 2 && ctx.genNumber !== null ? e.name : ctx.category),
          kind,
          order: isOrder ? parseOrderFolderName(e.name) : null,
          parentOrderRel: ctx.orderRel,
        };
        folders.push(folder);
        walk(abs, {
          folderRel: rel,
          genNumber: folder.genNumber,
          category: folder.category,
          orderRel: isOrder ? rel : ctx.orderRel,
        });
      } else if (e.isFile()) {
        if (e.name.startsWith('~$')) continue;
        const stat = fs.statSync(abs);
        const ext = path.extname(e.name).replace('.', '').toLowerCase() || null;
        files.push({
          fileName: e.name,
          extension: ext,
          relPath: rel,
          folderRel: ctx.folderRel,
          genNumber: ctx.genNumber,
          orderRel: ctx.orderRel,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
          docType: classifyDocType(e.name, ctx.category, !!ctx.orderRel),
          partNumber: parsePartNumber(e.name),
          revision: parseRevision(e.name),
        });
      }
    }
  }

  walk(msfRoot, { folderRel: null, genNumber: null, category: null, orderRel: null });
  return { folders, files };
}

// ---------- db ----------

async function upsertGeneration(client, f) {
  const { rows } = await client.query(
    `INSERT INTO bomguard.generation (gen_number, folder_name, rel_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (gen_number) DO UPDATE SET folder_name = EXCLUDED.folder_name, rel_path = EXCLUDED.rel_path
     RETURNING id`,
    [f.genNumber, f.name, f.relPath]);
  return rows[0].id;
}

async function upsertFolder(client, f, parentId, generationId) {
  const { rows } = await client.query(
    `INSERT INTO bomguard.folder (parent_id, generation_id, name, rel_path, depth, category, folder_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (rel_path) DO UPDATE SET
       parent_id = EXCLUDED.parent_id, generation_id = EXCLUDED.generation_id, name = EXCLUDED.name,
       depth = EXCLUDED.depth, category = EXCLUDED.category, folder_kind = EXCLUDED.folder_kind,
       is_present = true, last_seen_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [parentId, generationId, f.name, f.relPath, f.depth, f.category, f.kind]);
  return rows[0];
}

async function upsertOrder(client, folderId, parentOrderId, o) {
  const { rows } = await client.query(
    `INSERT INTO bomguard.msf_order
       (folder_id, parent_order_id, msf_number, gen_version, l11_pn, l11_pn_suffix, l10_pns, is_dw, dw_of_msf_number, suffix)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (folder_id) DO UPDATE SET
       parent_order_id = EXCLUDED.parent_order_id, msf_number = EXCLUDED.msf_number,
       gen_version = EXCLUDED.gen_version, l11_pn = EXCLUDED.l11_pn, l11_pn_suffix = EXCLUDED.l11_pn_suffix,
       l10_pns = EXCLUDED.l10_pns, is_dw = EXCLUDED.is_dw, dw_of_msf_number = EXCLUDED.dw_of_msf_number,
       suffix = EXCLUDED.suffix
     RETURNING id`,
    [folderId, parentOrderId, o.msfNumber, o.genVersion, o.l11Pn, o.l11PnSuffix, o.l10Pns,
     o.isDw, o.dwOfMsfNumber, o.suffix]);
  return rows[0].id;
}

async function upsertFile(client, f, folderId, generationId, orderId) {
  const { rows } = await client.query(
    `INSERT INTO bomguard.file
       (folder_id, generation_id, msf_order_id, file_name, extension, rel_path, size_bytes, modified_at,
        doc_type, part_number, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (rel_path) DO UPDATE SET
       folder_id = EXCLUDED.folder_id, generation_id = EXCLUDED.generation_id,
       msf_order_id = EXCLUDED.msf_order_id, file_name = EXCLUDED.file_name, extension = EXCLUDED.extension,
       size_bytes = EXCLUDED.size_bytes, modified_at = EXCLUDED.modified_at, doc_type = EXCLUDED.doc_type,
       part_number = EXCLUDED.part_number, revision = EXCLUDED.revision,
       is_present = true, last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [folderId, generationId, orderId, f.fileName, f.extension, f.relPath, f.sizeBytes, f.modifiedAt,
     f.docType, f.partNumber, f.revision]);
  return rows[0].inserted;
}

async function load(client, { folders, files }) {
  const genIds = new Map();    // genNumber -> id
  const folderIds = new Map(); // relPath -> id
  const orderIds = new Map();  // relPath -> id
  const stats = { folderIns: 0, folderUpd: 0, orders: 0, fileIns: 0, fileUpd: 0 };

  for (const f of folders) {
    if (f.kind === 'generation') genIds.set(f.genNumber, await upsertGeneration(client, f));
  }

  // walkMsf emits parents before children, so parent ids are always known.
  for (const f of folders) {
    const generationId = f.genNumber !== null ? genIds.get(f.genNumber) ?? null : null;
    const parentId = f.parentRel ? folderIds.get(f.parentRel) : null;
    const row = await upsertFolder(client, f, parentId, generationId);
    folderIds.set(f.relPath, row.id);
    row.inserted ? stats.folderIns++ : stats.folderUpd++;

    if (f.order) {
      const parentOrderId = f.parentOrderRel ? orderIds.get(f.parentOrderRel) : null;
      orderIds.set(f.relPath, await upsertOrder(client, row.id, parentOrderId, f.order));
      stats.orders++;
    }
  }

  for (const f of files) {
    const inserted = await upsertFile(
      client, f,
      f.folderRel ? folderIds.get(f.folderRel) : null,
      f.genNumber !== null ? genIds.get(f.genNumber) ?? null : null,
      f.orderRel ? orderIds.get(f.orderRel) : null);
    inserted ? stats.fileIns++ : stats.fileUpd++;
  }

  // now() is fixed for the whole transaction, so anything not touched above
  // has an older last_seen_at and is no longer on disk.
  const goneFolders = await client.query(
    `UPDATE bomguard.folder SET is_present = false WHERE is_present AND last_seen_at < now()`);
  const goneFiles = await client.query(
    `UPDATE bomguard.file SET is_present = false WHERE is_present AND last_seen_at < now()`);
  stats.foldersMissing = goneFolders.rowCount;
  stats.filesMissing = goneFiles.rowCount;
  stats.generations = genIds.size;
  return stats;
}

// ---------- main ----------

function reportParseProblems(folders) {
  const bad = folders.filter(f => f.order && (!f.order.msfNumber || !f.order.l11Pn));
  for (const f of bad) console.warn(`WARN: could not fully parse order folder: ${f.relPath}`);
  return bad.length;
}

async function main() {
  const dataDir = process.env.NPI_DATA_DIR;
  if (!dataDir) throw new Error('NPI_DATA_DIR is not set (config/credentials/npi.env)');
  const msfRoot = path.join(dataDir, 'MSF');
  if (!fs.existsSync(msfRoot)) throw new Error(`MSF folder not found: ${msfRoot}`);

  const tree = walkMsf(msfRoot);
  const parseProblems = reportParseProblems(tree.folders);

  if (DRY_RUN) {
    for (const f of tree.folders.filter(x => x.order)) {
      const o = f.order;
      console.log(`${o.msfNumber}\tgen ${o.genVersion}\tL11 ${o.l11Pn}${o.l11PnSuffix || ''}\tL10 ${o.l10Pns.join(',')}` +
        `\t${o.isDw ? 'DW of ' + o.dwOfMsfNumber : ''}\t${o.suffix || ''}`);
    }
    const byType = {};
    for (const f of tree.files) byType[f.docType] = (byType[f.docType] || 0) + 1;
    console.log('\nfolders:', tree.folders.length, ' orders:', tree.folders.filter(x => x.order).length,
      ' files:', tree.files.length, ' parse problems:', parseProblems);
    console.log('files by doc_type:', byType);
    return;
  }

  const client = new Client(annonConnConfig);
  await client.connect();
  try {
    if (INIT) {
      console.log(`Creating schema from ${path.relative(process.cwd(), SCHEMA_SQL)} (drops bomguard.*)...`);
      await client.query(fs.readFileSync(SCHEMA_SQL, 'utf8'));
    }
    await client.query('BEGIN');
    const stats = await load(client, tree);
    await client.query('COMMIT');

    console.log(`Loaded ${msfRoot} -> ${annonConnConfig.host}/${annonConnConfig.database} (bomguard)`);
    console.log(`  generations : ${stats.generations}`);
    console.log(`  folders     : ${stats.folderIns} inserted, ${stats.folderUpd} updated, ${stats.foldersMissing} marked missing`);
    console.log(`  msf orders  : ${stats.orders}`);
    console.log(`  files       : ${stats.fileIns} inserted, ${stats.fileUpd} updated, ${stats.filesMissing} marked missing`);
    console.log(`  parse warns : ${parseProblems}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
}

module.exports = { parseOrderFolderName, parseRevision, classifyDocType, walkMsf };
