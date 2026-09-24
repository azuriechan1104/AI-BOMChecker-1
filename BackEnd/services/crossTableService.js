const XLSX = require('xlsx');

// Parses the "MP L10"/"MP L11" sheets of a Cross Table workbook (confirmed
// live against NPI Files/MSF/Gen 11/Cross Table/(Confidential) C41A8 MP Cross
// Table_20260716.xlsx — see monica-automation/CONTEXT.md-style verification
// notes in the plan this module was built from). These sheets are NOT a
// simple flat table: a per-config metadata block sits above a real header
// row, and Level/Category are merged-cell-style (set only on the first row
// of each group, blank below). Every other Gen's Cross Table layout is
// unverified — this module is deliberately scoped to what was actually
// inspected, not generalized.

function normalizeCell(v) {
  return String(v ?? '').trim();
}

// Recognized "MP L10"/"MP L11" header columns, by lowercased header text.
// "Category" (MP L10) vs "Catergory" (MP L11, a confirmed real misspelling in
// the source file) both map to the same field.
const MP_HEADER_FIELD_MAP = {
  'level': 'level',
  'category': 'category',
  'catergory': 'category',
  'source': 'source',
  'alt. group': 'altGroup',
  'mspn': 'mspn',
  'description': 'description',
  'remark': 'remark',
  'coo': 'coo',
  'vendor': 'vendor',
  'mpn': 'mpn',
  'm/p': 'mp',
  'unit usage': 'unitUsage',
};

// Header row = the first row containing a cell that says "MSPN" *and* also
// contains "Level"/"Category" somewhere in the same row. The plain "contains
// MSPN" check alone is not enough — confirmed live: the per-config metadata
// block above the real header also has a row-label cell that says "MSPN" on
// its own (e.g. row 4 of "MP L10", labeling per-config MSPN values off to the
// right), with no Level/Category anywhere in that row. Requiring both
// together reliably skips that block and lands on the real header row. The
// WWPN column is always the column immediately right of MSPN — confirmed
// live: in "MP L11" that header cell does NOT contain the text "WWPN", it
// holds stray leftover data ("M1364033-001"), so WWPN must be found by
// position, never by matching its own header text.
function findMspnHeader(grid) {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    const mspnIdx = row.findIndex(c => normalizeCell(c).toLowerCase() === 'mspn');
    if (mspnIdx === -1) continue;
    const hasLevelOrCategory = row.some(c => {
      const h = normalizeCell(c).toLowerCase();
      return h === 'level' || h === 'category' || h === 'catergory';
    });
    if (hasLevelOrCategory) return { rowIndex: i, mspnIdx };
  }
  return null;
}

function parseMpSheet(ws, sheetName) {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const header = findMspnHeader(grid);
  if (!header) {
    return { sheetName, headerRowIndex: -1, columns: [], rows: [] };
  }
  const { rowIndex: headerRowIndex, mspnIdx } = header;
  const wwpnIdx = mspnIdx + 1;

  const colIndex = { mspn: mspnIdx };
  grid[headerRowIndex].forEach((cell, i) => {
    if (i === wwpnIdx) return; // this cell's own text is untrustworthy — position-based only
    const key = MP_HEADER_FIELD_MAP[normalizeCell(cell).toLowerCase()];
    if (key) colIndex[key] = i;
  });

  const rows = [];
  let lastLevel = '';
  let lastCategory = '';
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const row = grid[i];
    const mspn = normalizeCell(row[mspnIdx]);
    const wwpn = normalizeCell(row[wwpnIdx]);

    // Level/Category are merged-cell-style: a section-header row (e.g.
    // "L10 | Fan ", no MSPN/WWPN of its own) sets them for every component
    // row below it, until the next section-header row changes them again.
    const rawLevel = normalizeCell(row[colIndex.level]);
    const rawCategory = normalizeCell(row[colIndex.category]);
    if (rawLevel) lastLevel = rawLevel;
    if (rawCategory) lastCategory = rawCategory;

    if (!mspn && !wwpn) continue; // section-header-only or blank separator row

    rows.push({
      level: lastLevel,
      category: lastCategory,
      source: normalizeCell(row[colIndex.source]),
      altGroup: normalizeCell(row[colIndex.altGroup]),
      mspn,
      wwpn,
      description: normalizeCell(row[colIndex.description]),
      remark: normalizeCell(row[colIndex.remark]),
      coo: normalizeCell(row[colIndex.coo]),
      vendor: normalizeCell(row[colIndex.vendor]),
      mpn: normalizeCell(row[colIndex.mpn]),
      mp: normalizeCell(row[colIndex.mp]),
      unitUsage: normalizeCell(row[colIndex.unitUsage]),
    });
  }

  return { sheetName, headerRowIndex, columns: Object.keys(colIndex), rows };
}

// "BOM review list" is a small ECO-level summary pairing an L10 MSPN with its
// L11 MSPN under one ECO + PFAM config string, flagged Aligned Y/N. Header
// text is matched by predicate rather than strict equality for one column
// whose full text wasn't confirmed character-for-character live (it was
// visually truncated during inspection) — startsWith keeps this resilient
// without guessing the exact trailing wording.
const BOM_REVIEW_HEADER_TESTS = [
  { test: h => h === 'eco', key: 'eco' },
  { test: h => h === 'pfam', key: 'pfam' },
  { test: h => h === 'l11 mspn', key: 'l11Mspn' },
  { test: h => h === 'l10 mspn', key: 'l10Mspn' },
  { test: h => h === 'eco released', key: 'ecoReleased' },
  { test: h => h.startsWith('cross table and sku'), key: 'crossTableSkuDocMaintained' },
  { test: h => h === 'me reviewed', key: 'meReviewed' },
  { test: h => h === 'ado', key: 'ado' },
  { test: h => h.startsWith('aligned'), key: 'aligned' },
  { test: h => h === 'remark', key: 'remark' },
];

function parseBomReviewList(ws) {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  let headerRowIndex = -1;
  let colIndex = {};
  for (let i = 0; i < grid.length; i++) {
    const idx = {};
    grid[i].forEach((cell, c) => {
      const h = normalizeCell(cell).toLowerCase();
      const hit = BOM_REVIEW_HEADER_TESTS.find(t => t.test(h));
      if (hit) idx[hit.key] = c;
    });
    if (idx.eco !== undefined && idx.l10Mspn !== undefined && idx.l11Mspn !== undefined) {
      headerRowIndex = i;
      colIndex = idx;
      break;
    }
  }
  if (headerRowIndex === -1) {
    return { columns: [], rows: [] };
  }

  const rows = [];
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const row = grid[i];
    const eco = normalizeCell(row[colIndex.eco]);
    if (!eco) continue;
    rows.push({
      eco,
      pfam: normalizeCell(row[colIndex.pfam]),
      l11Mspn: normalizeCell(row[colIndex.l11Mspn]),
      l10Mspn: normalizeCell(row[colIndex.l10Mspn]),
      ecoReleased: normalizeCell(row[colIndex.ecoReleased]),
      crossTableSkuDocMaintained: normalizeCell(row[colIndex.crossTableSkuDocMaintained]),
      meReviewed: normalizeCell(row[colIndex.meReviewed]),
      ado: normalizeCell(row[colIndex.ado]),
      aligned: normalizeCell(row[colIndex.aligned]),
      remark: normalizeCell(row[colIndex.remark]),
    });
  }
  return { columns: Object.keys(colIndex), rows };
}

function lookupWwpnInMpSheet(parsed, wwpn) {
  if (!parsed?.rows?.length) return null;
  const target = normalizeCell(wwpn).toLowerCase();
  if (!target) return null;
  return parsed.rows.find(r => r.wwpn.toLowerCase() === target) || null;
}

function bareCpn(pn) {
  return normalizeCell(pn).split('$')[0];
}

// Matches on whichever of l10Mspn/l11Mspn is given, by bare CPN (before "$").
function lookupEcoPairing(parsedBomReviewList, { l10Mspn, l11Mspn } = {}) {
  if (!parsedBomReviewList?.rows?.length) return null;
  const l10 = l10Mspn ? bareCpn(l10Mspn).toLowerCase() : null;
  const l11 = l11Mspn ? bareCpn(l11Mspn).toLowerCase() : null;
  if (!l10 && !l11) return null;

  return parsedBomReviewList.rows.find(r => {
    const rowL10 = bareCpn(r.l10Mspn).toLowerCase();
    const rowL11 = bareCpn(r.l11Mspn).toLowerCase();
    if (l10 && l11) return rowL10 === l10 && rowL11 === l11;
    if (l10) return rowL10 === l10;
    return rowL11 === l11;
  }) || null;
}

module.exports = { parseMpSheet, parseBomReviewList, lookupWwpnInMpSheet, lookupEcoPairing };
