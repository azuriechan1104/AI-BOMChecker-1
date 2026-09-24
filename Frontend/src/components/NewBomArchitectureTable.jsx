import RawTable from './RawTable'

// Stage 6, terminal: the flat "New BOM Architecture" display (plan decision
// #3 — same Location/Type/Level/CPN/Revision/Remark shape TPG's own Test BOM
// tab and PartDetailTabs/RawTable already render, no new tree/hierarchy
// component). Nothing here writes to the mass-production database — the
// pipeline stops at this display, matching the user's explicit instruction.
export default function NewBomArchitectureTable({ rows, pnChecks, onBack, onReset }) {
  const architectureRows = rows.map(r => ({
    'Part Number': r.partNumber,
    Description: r.description || '—',
    Location: r.location || '—',
    'Model Ref': r.modelRef || '—',
    Status: pnChecks[r.id]?.status || '—',
  }))

  return (
    <div className="mo-result">
      <h3>New BOM Architecture</h3>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Final review — nothing has been written to the mass-production database. This pipeline stops here.
      </p>
      <div className="table-wrap"><RawTable rows={architectureRows} /></div>

      <div style={{ display: 'flex', gap: '.75rem', marginTop: '1.25rem', alignItems: 'center' }}>
        <button className="filter-btn" onClick={onBack}>‹ Back</button>
        <button className="search-btn" onClick={onReset}>Start Another BOM</button>
        <button
          className="search-btn"
          disabled
          title="Not implemented in this build — TPA approval stays a human, manual step."
        >
          Upload to MP (Mass Production)
        </button>
      </div>
    </div>
  )
}
