const { sql, query } = require('../DB');

// Read-only: SP_LocationTable_Model_Distinct → [{ModelRef, Level}].
// Extracted from GET /api/models — also the source list the Golden Template
// catalog crawl iterates over.
async function fetchAllModels() {
  const result = await query('EXEC BOM.dbo.SP_LocationTable_Model_Distinct');
  return result.recordset.map(r => ({ modelRef: r.ModelRef, location: r.Level }));
}

// Read-only: SP_QVL_Query_DESC(ModelRef, Location) → [{ModelRef, Location, PartNumber, Description}].
// Shared by /api/mo-lookup (fixed L10/L11 models), /api/qvl-list (any model
// from /api/models), and the Golden Template catalog crawl (every model).
async function fetchQvlList(modelRef, location) {
  const qvlResult = await query(
    'EXEC BOM.dbo.SP_QVL_Query_DESC @ModelRef = @modelRef, @Location = @location',
    [
      { name: 'modelRef', type: sql.NVarChar, value: modelRef },
      { name: 'location', type: sql.NVarChar, value: location }
    ]
  );
  return qvlResult.recordset;
}

// Read-only: SP_LocationTable_Query(@ModelRef) → the live per-model Location
// list TPG's own QVL/Test BOM tabs use to populate their Location dropdown —
// confirmed live 2026-09-16 against C41A8_L10 (90 rows: ASSETTAG, BIOS #0,
// BIOS #0.PFM, BMC #0, ..., VR), exactly matching the real exe. Location
// here is a per-component code (BIOS #0, DIMM_A, CRD, ...), not "L10"/"L11"
// — those are themselves just two of the many valid Location values for a
// model, not a separate categorical axis. Supersedes the stale, 9-model
// MonicaTPGenerator.xml fixture (@BOM-Based-APP/New MTPG/MonicaTPGenerator.xml)
// for this purpose — that file predates C41A8/C2195/etc. entirely.
async function fetchLocationTable(modelRef) {
  const result = await query(
    'EXEC BOM.dbo.SP_LocationTable_Query @ModelRef = @modelRef',
    [{ name: 'modelRef', type: sql.NVarChar, value: modelRef }]
  );
  return result.recordset.map(r => ({
    locationName: r.LocationName,
    type: r.Type,
    remark: r.Remark,
    isRootDev: r.IsRootDev,
    isTreeMode: r.IsTreeMode,
  }));
}

module.exports = { fetchAllModels, fetchQvlList, fetchLocationTable };
