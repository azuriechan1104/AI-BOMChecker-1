const { fetchMoItem, parseMoItems } = require('./moApiClient');
const npiLibraryService = require('./npiLibraryService');
const crossTableService = require('./crossTableService');
const goldenTemplateService = require('./goldenTemplateService');
const { fetchAllModels, fetchQvlList } = require('./qvlService');
const { buildPartDetail } = require('./partDetailService');

// The only Gen/model combination with a hand-verified Cross Table parser —
// see crossTableService.js and build-npi-index.js's matching allowlist gate.
const SUPPORTED_CROSS_TABLE = { gen: 11, modelToken: 'C41A8' };

function bareCpn(pn) {
  return String(pn || '').trim().split('$')[0];
}

// "MO informations" check — does this candidate PN appear among the MO's
// released items? Reuses moApiClient verbatim, same live SFCS call
// /api/mo-lookup already makes.
async function checkMo(moNumber, candidatePn) {
  if (!moNumber) {
    return { checked: false, found: false, matchedRows: [], allRowCount: 0 };
  }
  const { xml } = await fetchMoItem(moNumber);
  const { rows } = parseMoItems(xml);
  const target = bareCpn(candidatePn).toLowerCase();
  const full = String(candidatePn || '').toLowerCase();
  const matchedRows = rows.filter(r => r.cpn.toLowerCase() === full || bareCpn(r.cpn).toLowerCase() === target);
  return { checked: true, found: matchedRows.length > 0, matchedRows, allRowCount: rows.length };
}

function getGen11C41A8CrossTable() {
  const { crossTables } = npiLibraryService.loadIndex();
  const entry = crossTables.find(c => Number(c.gen) === 11 && /C41A8/i.test(c.fileName));
  if (!entry) {
    throw Object.assign(
      new Error('Gen 11/C41A8 Cross Table entry not found in the NPI index — run build-npi-index.js.'),
      { status: 404 }
    );
  }
  return entry;
}

// Cross Table validation is scoped to exactly the one hand-verified case
// (decision #1) — any other Gen/model returns supported:false rather than a
// silent false-negative, so the UI can distinguish "not registered" from
// "we don't check this combination yet."
async function checkCrossTable(candidatePn, gen, modelToken) {
  const g = Number(gen);
  if (g !== SUPPORTED_CROSS_TABLE.gen || String(modelToken || '').toUpperCase() !== SUPPORTED_CROSS_TABLE.modelToken) {
    return {
      supported: false,
      found: false,
      message: `Cross Table validation is only implemented for Gen ${SUPPORTED_CROSS_TABLE.gen} / ${SUPPORTED_CROSS_TABLE.modelToken} today.`,
    };
  }

  const entry = getGen11C41A8CrossTable();
  if (!entry.mpSheets) {
    return {
      supported: true,
      found: false,
      message: 'Cross Table entry exists but has no parsed MP sheets — re-run build-npi-index.js.',
    };
  }

  for (const sheetName of Object.keys(entry.mpSheets)) {
    const match = crossTableService.lookupWwpnInMpSheet(entry.mpSheets[sheetName], candidatePn);
    if (match) {
      return { supported: true, found: true, sheet: sheetName, matchedRow: match };
    }
  }
  return { supported: true, found: false, sheet: null, matchedRow: null };
}

// Digits-only, off-by-at-most-1 comparison — the confirmed real discrepancy
// between an MO description's MSF number (e.g. MSF-114845) and the actual
// NPI order folder name for the same order (MSF-114846). Tried only after an
// exact match fails, and the result is flagged as a near match rather than
// silently treated as exact.
function isNearMsfNumber(a, b) {
  const da = String(a || '').match(/\d+/);
  const db = String(b || '').match(/\d+/);
  if (!da || !db) return false;
  const na = Number(da[0]);
  const nb = Number(db[0]);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) <= 1;
}

async function checkSku(msfNumber) {
  if (!msfNumber) {
    return { checked: false, found: false, sku: null, nearMatch: false };
  }
  const { skus } = npiLibraryService.loadIndex();
  for (const sku of skus) {
    if ((sku.orders || []).some(o => o.msfNumber === msfNumber)) {
      return { checked: true, found: true, sku, nearMatch: false };
    }
  }
  for (const sku of skus) {
    if ((sku.orders || []).some(o => isNearMsfNumber(o.msfNumber, msfNumber))) {
      return {
        checked: true, found: true, sku, nearMatch: true,
        message: `No exact match for ${msfNumber} — found a near match (off by one digit); verify this is the same order.`,
      };
    }
  }
  return { checked: true, found: false, sku: null, nearMatch: false };
}

// "Previous CPN" check — decision #4 covers both halves:
//  (a) duplicate/conflict: is this bare CPN already known under a different
//      encoded variant anywhere in QVL (goldenTemplateService's catalog).
//  (b) prior revision/variant: same resolveCpnDetail fallback Golden
//      Template already uses.
//  (c) ECO pairing: does the L10/L11 MSPN pair already have an aligned ECO
//      entry in the Gen 11/C41A8 "BOM review list" (when that data is
//      available — silently skipped otherwise, this is a bonus signal).
async function checkPreviousCpn(candidatePn, l10Mspn, l11Mspn) {
  const cpn = bareCpn(candidatePn);
  const catalog = await goldenTemplateService.getCatalog();
  const entry = catalog.entries.find(e => e.cpn === cpn);

  const duplicateFound = Boolean(entry) && !entry.variants.includes(candidatePn);
  const priorRevisionDetail = entry
    ? await goldenTemplateService.resolveCpnDetail(cpn, entry.variants)
    : null;

  let ecoPairing = null;
  if (l10Mspn || l11Mspn) {
    try {
      const entry11 = getGen11C41A8CrossTable();
      if (entry11.bomReviewList) {
        ecoPairing = crossTableService.lookupEcoPairing(entry11.bomReviewList, { l10Mspn, l11Mspn });
      }
    } catch {
      // Cross Table entry not available — ECO pairing just stays null.
    }
  }

  return {
    duplicateFound,
    existingVariants: entry ? entry.variants : [],
    existingModelRefs: entry ? entry.modelRefs : [],
    priorRevisionDetail,
    ecoPairing,
  };
}

// Cross-model "has this PN already been uploaded to TPG" check — the QVL
// stage's standalone PN+Description portion needs this to work without
// first requiring a Model Reference/Location pick (that's the separate,
// precisely-scoped portion). Reuses goldenTemplateService's already-cached
// catalog (built by crawling every Model Reference's QVL list) rather than
// a fresh crawl per call. Note: the catalog itself only reflects each
// model's coarse Level location (L10/L11), the same one PN's own QVL entry
// used in the earlier verified sample — it will not find a PN registered
// only under a granular per-component Location (BIOS #0, DIMM_A, ...)
// that's never been checked at the whole-assembly level; that precise case
// is what the Model Reference + Location portion is for.
//
// PLM is not checked here — no live PLM read/write capability exists
// anywhere in this Node backend (only a read-only Python client in
// monica-automation/monica/plm_client.py, not wired up here); callers
// should disclose that rather than imply a PLM check happened.
async function checkPnAcrossQvl(pn) {
  const cpn = bareCpn(pn);
  const [models, catalog] = await Promise.all([fetchAllModels(), goldenTemplateService.getCatalog()]);
  const entry = catalog.entries.find(e => e.cpn === cpn);

  const matches = [];
  if (entry) {
    for (const modelRef of entry.modelRefs) {
      const model = models.find(m => m.modelRef === modelRef);
      if (!model) continue;
      const qvlRows = await fetchQvlList(modelRef, model.location);
      const full = String(pn).toLowerCase();
      const match =
        qvlRows.find(r => (r.PartNumber || '').toLowerCase() === full) ||
        qvlRows.find(r => bareCpn(r.PartNumber).toLowerCase() === cpn.toLowerCase());
      matches.push({
        modelRef,
        location: model.location,
        inQvl: Boolean(match),
        description: match ? match.Description : null,
        matchedPartNumber: match ? match.PartNumber : null,
      });
    }
  }

  return { partNumber: pn, bareCpn: cpn, matches, checkedModelCount: models.length };
}

async function runTpgPnCheck({ moNumber, candidatePn, gen, modelToken, l10Mspn, l11Mspn, msfNumber }) {
  const [moCheck, crossTableCheck, skuCheck, previousCpnCheck, partDetail] = await Promise.all([
    checkMo(moNumber, candidatePn),
    checkCrossTable(candidatePn, gen, modelToken),
    checkSku(msfNumber),
    checkPreviousCpn(candidatePn, l10Mspn, l11Mspn),
    buildPartDetail(candidatePn),
  ]);
  // bomExists reuses partDetail's own SysBom read rather than a second,
  // identical query (buildPartDetail already SELECTs bom.dbo.SysBom).
  const bomExists = partDetail.location.rows.length > 0;

  const issues = [];
  if (moCheck.checked && !moCheck.found) {
    issues.push(`Part number not found among MO ${moNumber}'s released items.`);
  }
  if (crossTableCheck.supported && !crossTableCheck.found) {
    issues.push('Part number not found in the Cross Table (unregistered/new — needs review).');
  }
  if (previousCpnCheck.duplicateFound) {
    issues.push(`Bare CPN already assigned to a different encoded variant elsewhere: ${previousCpnCheck.existingVariants.join(', ')}.`);
  }

  const status = issues.length === 0 ? 'OK' : 'REVIEW';
  return { candidatePn, moCheck, crossTableCheck, skuCheck, previousCpnCheck, bomExists, partDetail, status, issues };
}

module.exports = {
  runTpgPnCheck,
  checkMo,
  checkCrossTable,
  checkSku,
  checkPreviousCpn,
  checkPnAcrossQvl,
  SUPPORTED_CROSS_TABLE,
};
