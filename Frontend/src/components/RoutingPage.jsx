import { useState, useEffect, useMemo } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'

// Model picker: a "Model" button opens a small panel with two ComboInputs
// (Customer, Model) — each is simultaneously a free-text field and a
// type-ahead dropdown sourced from wymysfcs.sfcmodel (see
// BackEnd/services/routingService.js), so a model can be typed manually or
// picked from the list. Picking a Customer first narrows the Model
// suggestions to that customer's models.
function ModelPicker({ modelRows, customers, initialCustomer, initialModel, onConfirm, onCancel }) {
  const [customerFilter, setCustomerFilter] = useState(initialCustomer || '')
  const [modelInput, setModelInput]         = useState(initialModel || '')

  const modelOptions = useMemo(() => {
    const cq = customerFilter.trim().toLowerCase()
    const rows = cq ? modelRows.filter(r => (r.customer || '').toLowerCase().includes(cq)) : modelRows
    return [...new Set(rows.map(r => r.model))].sort()
  }, [modelRows, customerFilter])

  function resolveCustomer(model) {
    const mq = model.trim().toLowerCase()
    const match = modelRows.find(r => r.model.toLowerCase() === mq &&
      (!customerFilter.trim() || (r.customer || '').toLowerCase().includes(customerFilter.trim().toLowerCase())))
    return match ? match.customer : (customerFilter.trim() || null)
  }

  function handleSubmit(e) {
    e.preventDefault()
    const model = modelInput.trim()
    if (!model) return
    onConfirm({ model, customer: resolveCustomer(model) })
  }

  return (
    <form className="comparison-toolbar" onSubmit={handleSubmit}>
      <span className="filter-hint">Customer</span>
      <ComboInput
        value={customerFilter}
        onChange={setCustomerFilter}
        options={customers}
        placeholder="Any customer…"
      />
      <span className="filter-hint">Model</span>
      <ComboInput
        value={modelInput}
        onChange={setModelInput}
        options={modelOptions}
        placeholder="Type or choose a model…"
      />
      <button type="submit" className="filter-btn" disabled={!modelInput.trim()}>
        Use This Model
      </button>
      {onCancel && (
        <button type="button" className="filter-btn" onClick={onCancel}>
          Cancel
        </button>
      )}
    </form>
  )
}

export default function RoutingPage() {
  const [modelRows, setModelRows]   = useState([])
  const [customers, setCustomers]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [selected, setSelected]     = useState(null) // { model, customer }

  useEffect(() => {
    fetch('/api/routing/models')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setModelRows(json.models)
        setCustomers(json.customers)
      })
      .catch(e => setError('Network error: ' + e.message))
      .finally(() => setLoading(false))
  }, [])

  function handleConfirm(sel) {
    setSelected(sel)
    setPickerOpen(false)
  }

  return (
    <div className="app-body">
      <main>
        <section className="dashboard-section">
          <div className="section-title">Routing</div>

          {loading && <StateBox type="loading" title="Loading Models…" message="Querying SFCS for the model list." />}
          {!loading && error && <StateBox type="error" message={error} />}

          {!loading && !error && (
            <>
              <div className="filter-btns" style={{ marginBottom: pickerOpen ? '.75rem' : 0 }}>
                <button
                  type="button"
                  className={`filter-btn ${pickerOpen ? 'active' : ''}`}
                  onClick={() => setPickerOpen(o => !o)}
                >
                  Model{selected ? `: ${selected.model}` : ''}
                </button>
                {selected && !pickerOpen && (
                  <button type="button" className="filter-btn" onClick={() => setPickerOpen(true)}>
                    Change
                  </button>
                )}
              </div>

              {pickerOpen && (
                <ModelPicker
                  modelRows={modelRows}
                  customers={customers}
                  initialCustomer={selected?.customer}
                  initialModel={selected?.model}
                  onConfirm={handleConfirm}
                  onCancel={selected ? () => setPickerOpen(false) : null}
                />
              )}
            </>
          )}
        </section>

        {!loading && !error && !selected && (
          <StateBox
            type="empty"
            title="Select a Model to Begin"
            message="Click the Model button above, then type or pick a model (optionally narrowed by Customer)."
          />
        )}

        {selected && (
          <StateBox
            type="empty"
            title={`Routing Summary — ${selected.model}`}
            message={
              <>
                {selected.customer ? <>Customer: {selected.customer}<br /></> : null}
                The routing summary query for this model hasn't been wired up yet.
              </>
            }
          />
        )}
      </main>
    </div>
  )
}
