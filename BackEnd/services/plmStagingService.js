// "Add To PLM" — staged/simulated only (plan decision #2). This module has no
// DB or network imports at all, so it cannot reach PLM or any database even
// by accident — same zero-import discipline server.js already uses for
// POST /api/bomguard-workflow/submit. The real PLM write endpoint's request
// schema is unconfirmed anywhere in this codebase — only a read-only lookup
// client exists (monica-automation/monica/plm_client.py, Python, not wired
// to this Node backend) — so this payload shape is a best-effort preview of
// what a registration call would plausibly need, not a confirmed API contract.

function buildPlmStagingPayload(row) {
  return {
    partNumber: row.cpn,
    requestedDescription: row.remark || null,
    level: row.level || null,
    location: row.location || null,
    type: row.type || null,
    revision: row.revision || null,
  };
}

function stageRows(rows) {
  return {
    stagedAt: new Date().toISOString(),
    note: 'STAGED ONLY — nothing was sent to PLM. The real PLM write endpoint is unconfirmed in this codebase; only a read-only lookup client exists (monica-automation/monica/plm_client.py).',
    rows: (rows || []).map(r => ({ ...r, plmPayload: buildPlmStagingPayload(r) })),
  };
}

module.exports = { stageRows, buildPlmStagingPayload };
