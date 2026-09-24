import { useState, useEffect } from 'react'

let nextRowId = 1

// Recreates MonicaTPGenerator.exe's QVL tab, split into two independently
// usable portions (per feedback — either can be used on its own to stage
// info; neither depends on the other, and this tool never replaces going to
// the real TPG when the user wants to):
//
// Portion 1 — Model Reference * + Location * (both live: /api/models,
// /api/qvl-locations backed by SP_LocationTable_Query, confirmed live
// against C41A8_L10 to match the real dropdown's 90 entries exactly).
// Location is an editable combo, not a strict dropdown — confirmed live
// that QVL entries can exist at a value ("L10", a whole-assembly
// convention) that isn't in the per-component location list at all. Once
// both are picked, the real, live QVL Checking list loads for that exact
// scope (/api/qvl-list) and ADD/MODIFY/DELETE stage precise, scope-correct
// changes against it.
//
// Portion 2 — PN + Description, usable with or without Portion 1 filled:
//   2.1 "Check TPG" — cross-model existence check (no PLM check; that
//       capability doesn't exist in this backend), via the cached Golden
//       Template catalog crawl.
//   2.2 The same ADD/MODIFY (and DELETE, when a match exists) as Portion
//       1 — if Portion 1 is filled, staging is scope-precise; if not,
//       it stages an unscoped entry (Model Ref/Location blank) that can be
//       refined later, since this is a staging aid, not a replacement for
//       verifying in the real TPG.
export default function NewBomQvlStage({ inputs, onChange, rows, onRowsChange, plmStage, onStaged, onNext }) {
  const [models, setModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState(null)

  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(false)
  const [locationsError, setLocationsError] = useState(null)

  const [liveQvlRows, setLiveQvlRows] = useState([]) // [{PartNumber, Description}] for the selected Model+Location
  const [qvlLoading, setQvlLoading] = useState(false)
  const [qvlError, setQvlError] = useState(null)

  const [filterText, setFilterText] = useState('') // "Find PN" equivalent

  const [stageLoading, setStageLoading] = useState(false)
  const [stageError, setStageError] = useState(null)

  const [checkLoading, setCheckLoading] = useState(false)
  const [checkError, setCheckError] = useState(null)
  const [checkResult, setCheckResult] = useState(null) // checkPnAcrossQvl response

  useEffect(() => {
    fetch('/api/models')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setModels(json.models)
      })
      .catch(e => setModelsError(e.message))
      .finally(() => setModelsLoading(false))
  }, [])

  // Model Reference change -> reload its live Location list, reset downstream picks.
  useEffect(() => {
    if (!inputs.modelRef) {
      setLocations([])
      return
    }
    setLocationsLoading(true)
    setLocationsError(null)
    fetch('/api/qvl-locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelRef: inputs.modelRef }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setLocations(json.locations)
      })
      .catch(e => setLocationsError(e.message))
      .finally(() => setLocationsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.modelRef])

  // Model Reference + Location change -> reload the real, live QVL Checking list.
  useEffect(() => {
    if (!inputs.modelRef || !inputs.location) {
      setLiveQvlRows([])
      return
    }
    setQvlLoading(true)
    setQvlError(null)
    fetch('/api/qvl-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelRef: inputs.modelRef, location: inputs.location }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setLiveQvlRows(json.qvlList)
      })
      .catch(e => setQvlError(e.message))
      .finally(() => setQvlLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.modelRef, inputs.location])

  function set(key, value) {
    onChange({ [key]: value })
  }

  function handleModelChange(modelRef) {
    onChange({ modelRef, location: '' })
  }

  // Staged rows for the currently selected Model+Location scope only.
  const scopedStaged = inputs.location ? rows.filter(r => r.modelRef === inputs.modelRef && r.location === inputs.location) : []

  // Merge the real live QVL rows with staged ADD/MODIFY/DELETE overlays —
  // this is "what QVL would look like after these staged edits are applied."
  const mergedByPn = new Map()
  liveQvlRows.forEach(r => mergedByPn.set(r.partNumber.toLowerCase(), {
    partNumber: r.partNumber, description: r.description, staged: null,
  }))
  scopedStaged.forEach(r => {
    const key = r.partNumber.toLowerCase()
    if (r.action === 'DELETE') {
      const existing = mergedByPn.get(key) || { partNumber: r.partNumber, description: r.description }
      mergedByPn.set(key, { ...existing, staged: 'DELETE' })
    } else {
      mergedByPn.set(key, { partNumber: r.partNumber, description: r.description, staged: r.action })
    }
  })
  const mergedRows = [...mergedByPn.values()]
    .filter(r => !filterText.trim() || r.partNumber.toLowerCase().includes(filterText.trim().toLowerCase()) || (r.description || '').toLowerCase().includes(filterText.trim().toLowerCase()))
    .sort((a, b) => a.partNumber.localeCompare(b.partNumber))

  const pnLower = inputs.partNumber.trim().toLowerCase()
  const scopedMatch = inputs.location && pnLower ? mergedByPn.get(pnLower) : null
  const foundInScope = Boolean(scopedMatch) && scopedMatch.staged !== 'DELETE'

  // Mirrors the real exe: typing a PN that already has a scoped QVL/staged
  // entry auto-populates Description (still editable, for a MODIFY); typing
  // one with no scoped match clears it so a stale previous PN's text can't
  // be carried into a new manual entry by accident. Only applies once a
  // Location is picked — Portion 2 used alone relies on "Check TPG" instead.
  useEffect(() => {
    if (!inputs.location) return
    if (scopedMatch) {
      onChange({ description: scopedMatch.description || '' })
    } else if (pnLower) {
      onChange({ description: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnLower, inputs.modelRef, inputs.location, liveQvlRows, rows])

  async function checkTpg() {
    const pn = inputs.partNumber.trim()
    if (!pn) return
    setCheckLoading(true)
    setCheckError(null)
    setCheckResult(null)
    try {
      const res = await fetch('/api/new-bom/qvl-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumber: pn }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setCheckResult(json)
      const found = json.matches.find(m => m.inQvl)
      if (found && !inputs.description.trim()) {
        onChange({ description: found.description })
      }
    } catch (e) {
      setCheckError(e.message)
    } finally {
      setCheckLoading(false)
    }
  }

  function addOrModifyRow() {
    const pn = inputs.partNumber.trim()
    if (!pn) return
    const modelRef = inputs.modelRef || ''
    const location = inputs.location || ''
    const existingIdx = rows.findIndex(r => r.modelRef === modelRef && r.location === location && r.partNumber.toLowerCase() === pn.toLowerCase())
    // Scope-precise MODIFY-vs-ADD only makes sense once a Location's real
    // list has been loaded; unscoped entries (no Location picked) are
    // always ADD since there's no baseline to compare against.
    const action = location && liveQvlRows.some(r => r.partNumber.toLowerCase() === pn.toLowerCase()) ? 'MODIFY' : 'ADD'
    const newRow = {
      id: existingIdx >= 0 ? rows[existingIdx].id : `r${nextRowId++}`,
      partNumber: pn,
      description: inputs.description,
      action,
      modelRef,
      location,
    }
    if (existingIdx >= 0) {
      onRowsChange(rows.map((r, i) => (i === existingIdx ? newRow : r)))
    } else {
      onRowsChange([...rows, newRow])
    }
    onChange({ partNumber: '', description: '' })
    setCheckResult(null)
  }

  function deleteRow() {
    const pn = inputs.partNumber.trim()
    if (!pn || !inputs.location || !scopedMatch) return // scoped-only, needs a real match to remove
    const existingIdx = rows.findIndex(r => r.modelRef === inputs.modelRef && r.location === inputs.location && r.partNumber.toLowerCase() === pn.toLowerCase())
    const newRow = {
      id: existingIdx >= 0 ? rows[existingIdx].id : `r${nextRowId++}`,
      partNumber: pn,
      description: scopedMatch.description,
      action: 'DELETE',
      modelRef: inputs.modelRef,
      location: inputs.location,
    }
    if (existingIdx >= 0) {
      onRowsChange(rows.map((r, i) => (i === existingIdx ? newRow : r)))
    } else {
      onRowsChange([...rows, newRow])
    }
    onChange({ partNumber: '', description: '' })
  }

  function removeStagedRow(id) {
    onRowsChange(rows.filter(r => r.id !== id))
  }

  function pickRow(pn) {
    const row = mergedByPn.get(pn.toLowerCase())
    onChange({ partNumber: row.partNumber, description: row.description })
  }

  const activeCount = rows.filter(r => r.action !== 'DELETE').length

  async function stageToPlm() {
    const toStage = rows.filter(r => r.action !== 'DELETE')
    if (!toStage.length) return
    setStageLoading(true)
    setStageError(null)
    try {
      const res = await fetch('/api/new-bom/plm-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toStage.map(r => ({ cpn: r.partNumber, remark: r.description, location: r.location, modelRef: r.modelRef })) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onStaged(json)
    } catch (e) {
      setStageError(e.message)
    } finally {
      setStageLoading(false)
    }
  }

  return (
    <div className="mo-result">
      <h3>QVL</h3>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        Two independent ways to stage info — use either on its own, or both together. Nothing here
        is written to the live QVL; you can always go check the real TPG yourself at any time.
      </p>

      <div className="table-wrap" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
        <h3 style={{ marginTop: 0 }}>1. Model Reference &amp; Location</h3>
        <p className="hint" style={{ marginBottom: '.75rem' }}>For precise, scope-correct commodity / BOM info — loads the real, live QVL Checking list.</p>
        {modelsError && <p className="hint">⚠️ {modelsError}</p>}
        <div className="modal-fields">
          <div className="modal-form-field">
            <label>Model Reference</label>
            <select className="pn-select" value={inputs.modelRef} onChange={e => handleModelChange(e.target.value)} disabled={modelsLoading}>
              <option value="">{modelsLoading ? 'Loading…' : 'Select…'}</option>
              {models.map(m => <option key={m.modelRef} value={m.modelRef}>{m.modelRef}</option>)}
            </select>
          </div>
          <div className="modal-form-field">
            <label>Location</label>
            {/* Editable combo, not a strict dropdown — confirmed live that QVL
                entries can exist at a Location value (e.g. "L10", a whole-
                assembly convention) that isn't part of the per-component
                SP_LocationTable_Query list at all. <datalist> gives typeahead
                suggestions from that live list while still accepting any
                typed value, matching the real exe's editable combo box. */}
            <input
              className="pn-input"
              list="qvl-location-options"
              value={inputs.location}
              onChange={e => set('location', e.target.value)}
              placeholder={!inputs.modelRef ? 'Select a Model Reference first…' : (locationsLoading ? 'Loading…' : `Pick or type a Location (${locations.length} known)…`)}
              disabled={!inputs.modelRef || locationsLoading}
            />
            <datalist id="qvl-location-options">
              {locations.map(l => <option key={l.locationName} value={l.locationName}>{`${l.type} — ${l.remark}`}</option>)}
            </datalist>
          </div>
        </div>
        {locationsError && <p className="hint">⚠️ {locationsError}</p>}

        <h3 style={{ marginTop: '1.25rem' }}>QVL Checking {inputs.modelRef && inputs.location ? `— ${inputs.modelRef} / ${inputs.location}` : ''}</h3>
        {inputs.location && (
          <input
            className="pn-input"
            style={{ marginBottom: '.5rem', maxWidth: '20rem' }}
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Find PN or description…"
          />
        )}
        {qvlLoading && <p className="hint">Loading QVL Checking list…</p>}
        {qvlError && <p className="hint">⚠️ {qvlError}</p>}
        {!inputs.location && <p className="hint">Select a Model Reference and Location to see its live QVL Checking list.</p>}

        {inputs.location && !qvlLoading && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>PN</th><th>Description</th><th></th></tr></thead>
              <tbody>
                {mergedRows.map(r => (
                  <tr key={r.partNumber} className={r.staged === 'DELETE' ? 'crd-ref-row' : ''}>
                    <td className="mono" style={{ textDecoration: r.staged === 'DELETE' ? 'line-through' : 'none', cursor: 'pointer' }} onClick={() => pickRow(r.partNumber)}>
                      {r.partNumber}
                    </td>
                    <td style={{ textDecoration: r.staged === 'DELETE' ? 'line-through' : 'none' }}>{r.description || '—'}</td>
                    <td>{r.staged && <span className={r.staged === 'DELETE' ? 'badge-fail' : 'badge-warn'}>{r.staged}</span>}</td>
                  </tr>
                ))}
                {mergedRows.length === 0 && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>No entries for this Model/Location.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="table-wrap" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
        <h3 style={{ marginTop: 0 }}>2. Part Number &amp; Description</h3>
        <p className="hint" style={{ marginBottom: '.75rem' }}>
          Works on its own, with or without Section 1 filled in. <strong>Check TPG</strong> looks this
          PN up across every Model Reference; <strong>ADD / MODIFY</strong> stages it — scope-precise if
          Section 1 is filled, otherwise unscoped for now.
        </p>
        <div className="modal-fields">
          <div className="modal-form-field">
            <label>PN</label>
            <input
              className="pn-input mono"
              value={inputs.partNumber}
              onChange={e => { set('partNumber', e.target.value); setCheckResult(null) }}
              placeholder="e.g. M1374580-001$009"
            />
          </div>
          <div className="modal-form-field">
            <label>Description</label>
            <input
              className="pn-input"
              value={inputs.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Enter a description…"
            />
          </div>
        </div>

        {inputs.location && pnLower && (
          <p className="hint">
            {foundInScope
              ? (scopedMatch.staged ? `✅ Already on TPG data for ${inputs.modelRef}/${inputs.location} — staged for ${scopedMatch.staged}.` : `✅ Already on TPG data for ${inputs.modelRef}/${inputs.location}.`)
              : `⚠️ Not found in QVL for ${inputs.modelRef}/${inputs.location} — the description above will be added manually.`}
          </p>
        )}

        <div style={{ display: 'flex', gap: '.5rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
          <button className="filter-btn" onClick={checkTpg} disabled={checkLoading || !inputs.partNumber.trim()}>
            {checkLoading ? 'Checking…' : '2.1 Check TPG'}
          </button>
          <button className="search-btn" onClick={addOrModifyRow} disabled={!inputs.partNumber.trim()}>
            2.2 ADD / MODIFY
          </button>
          <button className="danger-btn" onClick={deleteRow} disabled={!inputs.partNumber.trim() || !inputs.location || !foundInScope}>
            DELETE
          </button>
        </div>

        {checkError && <p className="hint">⚠️ {checkError}</p>}
        {checkResult && (
          <div style={{ marginTop: '.75rem' }}>
            {checkResult.matches.some(m => m.inQvl) ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Model Ref</th><th>Location</th><th>Description</th></tr></thead>
                  <tbody>
                    {checkResult.matches.filter(m => m.inQvl).map(m => (
                      <tr key={m.modelRef}>
                        <td className="mono">{m.modelRef}</td>
                        <td>{m.location}</td>
                        <td>{m.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hint">Not found under any Model Reference's whole-assembly QVL entry (checked {checkResult.checkedModelCount} models). Note: this does not check every per-component Location, and PLM is not checked — no PLM read/write capability exists in this build.</p>
            )}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.5rem' }}>Staged Changes (all Model/Location scopes)</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>PN</th><th>Description</th><th>Model Ref</th><th>Location</th><th>Action</th><th></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="mono">{r.partNumber}</td>
                    <td>{r.description || '—'}</td>
                    <td>{r.modelRef || '—'}</td>
                    <td>{r.location || '—'}</td>
                    <td><span className={r.action === 'DELETE' ? 'badge-fail' : 'badge-warn'}>{r.action}</span></td>
                    <td><button className="danger-btn" onClick={() => removeStagedRow(r.id)}>Unstage</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="state-box" style={{ marginTop: '1rem' }}>
        <p>🔒 <strong>Add To PLM — staged only.</strong> Nothing is sent to PLM; this builds and shows exactly what would be submitted for the staged ADD/MODIFY rows.</p>
      </div>
      {stageError && <p className="hint">⚠️ {stageError}</p>}
      <button className="filter-btn" onClick={stageToPlm} disabled={stageLoading || !activeCount}>
        {stageLoading ? 'Building…' : plmStage ? 'Rebuild PLM Staging Payload' : 'Build PLM Staging Payload'}
      </button>

      <details style={{ marginTop: '1rem' }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>Optional context for TPG PN Check (MO / Gen / Model Token / MSF / paired L10-L11 MSPN)</summary>
        <div className="modal-fields" style={{ marginTop: '.75rem' }}>
          <div className="modal-form-field">
            <label>MO Number</label>
            <input className="pn-input" value={inputs.moNumber} onChange={e => set('moNumber', e.target.value)} placeholder="e.g. 10217019" />
          </div>
          <div className="modal-form-field">
            <label>Gen</label>
            <input className="pn-input" type="number" value={inputs.gen} onChange={e => set('gen', Number(e.target.value))} />
          </div>
          <div className="modal-form-field">
            <label>Model Token</label>
            <input className="pn-input" value={inputs.modelToken} onChange={e => set('modelToken', e.target.value)} placeholder="e.g. C41A8" />
          </div>
          <div className="modal-form-field">
            <label>MSF Number</label>
            <input className="pn-input mono" value={inputs.msfNumber} onChange={e => set('msfNumber', e.target.value)} placeholder="e.g. MSF-114846" />
          </div>
          <div className="modal-form-field">
            <label>L10 MSPN</label>
            <input className="pn-input mono" value={inputs.l10Mspn} onChange={e => set('l10Mspn', e.target.value)} placeholder="e.g. M1374580-001" />
          </div>
          <div className="modal-form-field">
            <label>L11 MSPN</label>
            <input className="pn-input mono" value={inputs.l11Mspn} onChange={e => set('l11Mspn', e.target.value)} placeholder="e.g. M1374581-001" />
          </div>
        </div>
      </details>

      <div style={{ marginTop: '1.25rem' }}>
        <button className="search-btn" disabled={!activeCount} onClick={onNext}>Next: TPG PN Check</button>
      </div>
    </div>
  )
}
