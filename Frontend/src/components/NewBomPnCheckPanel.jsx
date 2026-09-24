import { useState, useEffect } from 'react'
import RawTable from './RawTable'
import PartDetailTabs from './PartDetailTabs'

function StatusBadge({ status }) {
  if (status === 'OK') return <span className="badge-pass">OK</span>
  if (status === 'REVIEW') return <span className="badge-warn">REVIEW</span>
  return <span className="badge-grey">not checked</span>
}

// Stage 4: TPG PN Check — fans out POST /api/new-bom/pn-check per line item
// (MO informations + Cross Table/SKU from NPI Documents + previous CPN, per
// the user's requested process flow), then shows the evidence behind each
// row's status so a reviewer can see why, not just pass/fail. Each row also
// carries the same Test BOM detail MonicaTPGenerator.exe's Test BOM tab
// shows (Data/CRD Spec/FRU Spec/Rack SKU) via PartDetailTabs, so a reviewer
// can see the full existing BOM behind a candidate PN without leaving this
// stage.
export default function NewBomPnCheckPanel({ rows, inputs, pnChecks, onChecked, onBack, onNext }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Rows are expanded by default the moment a check result exists for them
  // (fresh or cached from a prior visit) — "collapsed" tracks the opt-out,
  // not the opt-in, so a reviewer sees every row's full evidence, including
  // the Test BOM tab, without an extra click after landing on this stage.
  const [collapsed, setCollapsed] = useState(new Set())

  function toggle(id) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function runChecks() {
    setLoading(true)
    setError(null)
    try {
      const entries = await Promise.all(rows.map(async r => {
        const res = await fetch('/api/new-bom/pn-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            moNumber: inputs.moNumber,
            candidatePn: r.partNumber,
            gen: inputs.gen,
            modelToken: inputs.modelToken,
            l10Mspn: inputs.l10Mspn,
            l11Mspn: inputs.l11Mspn,
            msfNumber: inputs.msfNumber,
          }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        return [r.id, json]
      }))
      onChecked(Object.fromEntries(entries))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const allChecked = rows.length > 0 && rows.every(r => pnChecks[r.id])

  // Auto-run on arrival from QVL (via "Next: TPG PN Check") so the evidence
  // is already on screen — no extra click needed. Component remounts fresh
  // each time this stage is entered (CreateNewBomPage conditionally renders
  // it), so this only fires once per arrival, and the allChecked guard skips
  // it entirely when every row already has a cached result from a prior visit.
  useEffect(() => {
    if (rows.length && !allChecked) {
      runChecks()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="mo-result">
      <h3>TPG PN Check</h3>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Checks each candidate part number against MO released items, the Cross Table (Gen 11/C41A8
        only), SKU/MSF order data, and previous-CPN duplicate/revision history — runs automatically
        on arrival. Each row shows its full Test BOM (Data / CRD Spec / FRU Spec / Rack SKU), same as
        TPG's own Test BOM tab; click a row to collapse it.
      </p>

      {error && <div className="state-box error" style={{ marginBottom: '1rem' }}><p>⚠️ {error}</p></div>}

      <button className="search-btn" onClick={runChecks} disabled={loading || !rows.length}>
        {loading ? 'Checking…' : allChecked ? 'Re-run Checks' : 'Run TPG PN Check'}
      </button>

      {rows.map(r => {
        const check = pnChecks[r.id]
        return (
          <div key={r.id} className="table-wrap" style={{ marginTop: '1rem' }}>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '.5rem .75rem', cursor: 'pointer' }}
              onClick={() => toggle(r.id)}
            >
              <span className="mono">{r.partNumber || '(no PN)'}</span>
              <StatusBadge status={check?.status} />
            </div>
            {check && !collapsed.has(r.id) && (
              <div style={{ padding: '0 .75rem .75rem' }}>
                {check.issues.length > 0 && (
                  <ul>{check.issues.map((iss, i) => <li key={i}>⚠️ {iss}</li>)}</ul>
                )}

                <p><strong>MO check:</strong>{' '}
                  {check.moCheck.checked ? (check.moCheck.found ? '✅ found' : '❌ not found') : 'skipped'}
                  {' '}({check.moCheck.allRowCount} MO row(s))
                </p>
                {check.moCheck.matchedRows?.length > 0 && <RawTable rows={check.moCheck.matchedRows} />}

                <p style={{ marginTop: '.75rem' }}><strong>Cross Table check:</strong>{' '}
                  {!check.crossTableCheck.supported
                    ? check.crossTableCheck.message
                    : (check.crossTableCheck.found ? `✅ found in ${check.crossTableCheck.sheet}` : '❌ not found')}
                </p>
                {check.crossTableCheck.matchedRow && <RawTable rows={[check.crossTableCheck.matchedRow]} />}

                <p style={{ marginTop: '.75rem' }}><strong>SKU / MSF check:</strong>{' '}
                  {check.skuCheck.checked
                    ? (check.skuCheck.found ? `✅ found${check.skuCheck.nearMatch ? ' (near match — verify)' : ''}` : '❌ not found')
                    : 'skipped'}
                </p>
                {check.skuCheck.sku && (
                  <RawTable rows={[{
                    itemNumber: check.skuCheck.sku.itemNumber,
                    revision: check.skuCheck.sku.revision,
                    businessGroup: check.skuCheck.sku.businessGroup,
                    role: check.skuCheck.sku.role,
                  }]} />
                )}

                <p style={{ marginTop: '.75rem' }}><strong>Previous CPN:</strong>{' '}
                  {check.previousCpnCheck.duplicateFound ? '⚠️ duplicate/conflict' : '✅ no conflict'}
                </p>
                {check.previousCpnCheck.existingVariants?.length > 0 && (
                  <p className="hint">Known variants: {check.previousCpnCheck.existingVariants.join(', ')}</p>
                )}
                {check.previousCpnCheck.ecoPairing && (
                  <p className="hint">
                    ECO pairing: {check.previousCpnCheck.ecoPairing.eco} ({check.previousCpnCheck.ecoPairing.pfam}) — Aligned: {check.previousCpnCheck.ecoPairing.aligned}
                  </p>
                )}

                <p style={{ marginTop: '.75rem' }}><strong>BOM already exists:</strong> {check.bomExists ? 'Yes' : 'No'}</p>

                {check.partDetail && (
                  <div style={{ marginTop: '.75rem' }}>
                    <p><strong>Test BOM (TPG):</strong></p>
                    <PartDetailTabs partDetail={check.partDetail} />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: '.75rem', marginTop: '1.25rem' }}>
        <button className="filter-btn" onClick={onBack}>‹ Back</button>
        <button className="search-btn" disabled={!allChecked} onClick={onNext}>Next: Validation</button>
      </div>
    </div>
  )
}
