// Stage 5: aggregates each row's pnCheck.status/issues into a pass/review
// count, styled like this app's existing PASS/WARNING/FAIL comparison
// presentation (/api/compare's overallScore/overallStatus).
export default function NewBomValidationSummary({ rows, pnChecks, onBack, onNext }) {
  const results = rows.map(r => pnChecks[r.id]).filter(Boolean)
  const okCount = results.filter(c => c.status === 'OK').length
  const reviewCount = results.filter(c => c.status === 'REVIEW').length
  const overallStatus = reviewCount === 0 ? 'PASS' : 'REVIEW'

  return (
    <div className="mo-result">
      <h3>Validation</h3>
      <div className={`state-box ${overallStatus === 'PASS' ? '' : 'error'}`} style={{ marginBottom: '1rem' }}>
        <div className="icon">{overallStatus === 'PASS' ? '✅' : '⚠️'}</div>
        <h3>{overallStatus === 'PASS' ? 'All rows passed' : `${reviewCount} row(s) need review`}</h3>
        <p>{okCount} OK · {reviewCount} REVIEW · {rows.length} total row(s)</p>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>CPN</th><th>Status</th><th>Issues</th></tr></thead>
          <tbody>
            {rows.map(r => {
              const c = pnChecks[r.id]
              return (
                <tr key={r.id}>
                  <td className="mono">{r.partNumber}</td>
                  <td>{c ? <span className={c.status === 'OK' ? 'badge-pass' : 'badge-warn'}>{c.status}</span> : '—'}</td>
                  <td>{c?.issues?.join('; ') || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: '.75rem', marginTop: '1.25rem' }}>
        <button className="filter-btn" onClick={onBack}>‹ Back</button>
        <button className="search-btn" onClick={onNext}>Next: New BOM Architecture</button>
      </div>
    </div>
  )
}
