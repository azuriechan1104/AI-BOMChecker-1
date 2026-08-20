import { useState, useEffect, useRef } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'
import RawTable from './RawTable'

// Category columns are paginated so a page of the pivot always fits the
// viewport width instead of forcing a long horizontal scroll — Route and
// Grand Total stay fixed on every page since they summarize across ALL
// categories, not just the visible slice.
const CATEGORIES_PER_PAGE = 8

// Pivot table: route (rows) x category (columns), count of routes as the
// value — the same shape as the Excel pivot the NPI team builds from the
// sfcupnroute/sfcmodel categorization query. Grand Total row/column mirror
// Excel's pivot table default. Each non-zero cell is a drill-through into
// the raw rows behind that count, like double-clicking an Excel pivot cell.
function SummaryPivotTable({ summary, onCellClick }) {
  const { routes, categories, matrix, rowTotals, columnTotals, grandTotal } = summary
  const [page, setPage] = useState(0)

  // A new customer's summary always starts back on the first page of
  // categories, rather than keeping whatever page the previous one left off on.
  useEffect(() => { setPage(0) }, [summary])

  const pageCount = Math.max(1, Math.ceil(categories.length / CATEGORIES_PER_PAGE))
  const pagedCategories = categories.slice(page * CATEGORIES_PER_PAGE, (page + 1) * CATEGORIES_PER_PAGE)

  return (
    <>
      <div className="table-wrap">
        <table className="pivot-table">
          <thead>
            <tr>
              <th className="pivot-th-route">Route</th>
              {pagedCategories.map(c => <th key={c} className="pivot-th-angled"><span>{c}</span></th>)}
              <th className="pivot-th-angled"><span>Grand Total</span></th>
            </tr>
          </thead>
          <tbody>
            {routes.map(route => (
              <tr key={route}>
                <td className="pivot-route-cell">{route}</td>
                {pagedCategories.map(c => {
                  const count = matrix[route][c] || 0
                  return (
                    <td key={c} className="mono" style={{ textAlign: 'center' }}>
                      {count > 0
                        ? (
                          <button
                            type="button"
                            className="pivot-count-btn"
                            onClick={() => onCellClick(route, c)}
                          >
                            {count}
                          </button>
                        )
                        : ''}
                    </td>
                  )
                })}
                <td className="mono" style={{ textAlign: 'center', fontWeight: 700 }}>
                  <button type="button" className="pivot-count-btn" onClick={() => onCellClick(route, null)}>
                    {rowTotals[route]}
                  </button>
                </td>
              </tr>
            ))}
            <tr className="fpy-total-row">
              <td className="pivot-route-cell">Grand Total</td>
              {pagedCategories.map(c => (
                <td key={c} className="mono" style={{ textAlign: 'center' }}>
                  <button type="button" className="pivot-count-btn" onClick={() => onCellClick(null, c)}>
                    {columnTotals[c]}
                  </button>
                </td>
              ))}
              <td className="mono" style={{ textAlign: 'center' }}>
                <button type="button" className="pivot-count-btn" onClick={() => onCellClick(null, null)}>
                  {grandTotal}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="comparison-toolbar" style={{ marginTop: '.75rem' }}>
          <button type="button" className="filter-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            Previous
          </button>
          <span className="filter-hint">
            Categories {page * CATEGORIES_PER_PAGE + 1}–{Math.min((page + 1) * CATEGORIES_PER_PAGE, categories.length)} of {categories.length} · page {page + 1} of {pageCount}
          </span>
          <button type="button" className="filter-btn" disabled={page >= pageCount - 1} onClick={() => setPage(p => p + 1)}>
            Next
          </button>
        </div>
      )}
    </>
  )
}

function exportDetailCSV(rows, customer, route, category) {
  const header = ['Model Family', 'Category', 'UPN', 'Description', 'Route', 'Update Time']
  const csvRows = rows.map(r => [r.modelfamily, r.category, r.upn, r.description, r.route, r.updatetime])

  const csv = [header, ...csvRows]
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  const safeName = [customer, route, category].filter(Boolean).join('-').replace(/[^a-z0-9-]+/gi, '_')
  a.href     = url
  a.download = `routing-detail-${safeName || 'export'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// Drill-through modal for one pivot number: the raw sfcupnroute rows behind
// a Customer, narrowed to its Route and/or Category when the clicked number
// was a specific cell rather than a row/column/grand total — a null route
// or category means "every route" / "every category" for that total, with
// a CSV export of just those rows.
function cellLabel(cell) {
  return `${cell.route || 'All Routes'} · ${cell.category || 'All Categories'}`
}

function CellDetailModal({ cell, customer, onClose }) {
  const [rows, setRows]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    setRows(null)
    setError(null)
    setLoading(true)
    const params = new URLSearchParams({ customer })
    if (cell.route) params.set('route', cell.route)
    if (cell.category) params.set('category', cell.category)
    fetch(`/api/routing/detail?${params}`, { signal: controller.signal })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows)
      })
      .catch(e => {
        if (e.name === 'AbortError') return
        setError('Network error: ' + e.message)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [customer, cell.route, cell.category])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: '1100px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{cellLabel(cell)}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
            {rows && rows.length > 0 && (
              <button
                type="button"
                className="filter-btn"
                onClick={() => exportDetailCSV(rows, customer, cell.route, cell.category)}
              >
                Export CSV
              </button>
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="modal-body">
          {loading && <StateBox type="loading" title="Loading Detail…" message={`Querying SFCS for ${cellLabel(cell)}.`} />}
          {!loading && error && <StateBox type="error" message={error} />}
          {!loading && !error && rows && rows.length === 0 && (
            <StateBox type="empty" title="No Rows Found" message="No sfcupnroute rows matched this cell." />
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <div className="table-wrap">
              <RawTable rows={rows} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function RoutingPage() {
  const [customers, setCustomers]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  const [customerInput, setCustomerInput] = useState('')
  const [resolvedCustomer, setResolvedCustomer] = useState(null)

  const [summary, setSummary]               = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError]     = useState(null)
  const abortRef = useRef(null)

  const [detailCell, setDetailCell] = useState(null) // { route, category }

  useEffect(() => {
    fetch('/api/routing/models')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setCustomers(json.customers)
      })
      .catch(e => setError('Network error: ' + e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Auto-resolve: no submit button — as soon as the typed/clicked text
  // exactly matches a known customer (case-insensitive), pull the summary.
  useEffect(() => {
    const trimmed = customerInput.trim()
    if (!trimmed) {
      setResolvedCustomer(null)
      return
    }
    const match = customers.find(c => c.toLowerCase() === trimmed.toLowerCase())
    if (!match) return
    setResolvedCustomer(match)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSummary(null)
    setSummaryError(null)
    setSummaryLoading(true)
    fetch(`/api/routing/summary?customer=${encodeURIComponent(match)}`, { signal: controller.signal })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setSummary(json)
      })
      .catch(e => {
        if (e.name === 'AbortError') return
        setSummaryError('Network error: ' + e.message)
      })
      .finally(() => setSummaryLoading(false))
  }, [customerInput, customers])

  return (
    <div className="app-body">
      <main>
        <section className="dashboard-section">
          <div className="section-title">NPI Routing</div>

          {loading && <StateBox type="loading" title="Loading Customers…" message="Querying SFCS for the customer list." />}
          {!loading && error && <StateBox type="error" message={error} />}

          {!loading && !error && (
            <div className="comparison-toolbar">
              <span className="filter-hint">Customer</span>
              <ComboInput
                value={customerInput}
                onChange={setCustomerInput}
                options={customers}
                placeholder="Type or choose a customer…"
              />
            </div>
          )}
        </section>

        {!loading && !error && !resolvedCustomer && (
          <StateBox
            type="empty"
            title="Select a Customer to Begin"
            message="Type or pick a customer above — the summary loads automatically."
          />
        )}

        {resolvedCustomer && summaryLoading && (
          <StateBox type="loading" title="Building Routing Summary…" message={`Querying SFCS for ${resolvedCustomer}.`} />
        )}

        {resolvedCustomer && !summaryLoading && summaryError && <StateBox type="error" message={summaryError} />}

        {resolvedCustomer && !summaryLoading && !summaryError && summary && summary.routes.length === 0 && (
          <StateBox type="empty" title="No Routes Found" message={`No sfcupnroute rows were found for ${resolvedCustomer}.`} />
        )}

        {resolvedCustomer && !summaryLoading && !summaryError && summary && summary.routes.length > 0 && (
          <>
            <h3 className="fpy-chart-title">Routing Summary — {resolvedCustomer}</h3>
            <p className="filter-hint" style={{ margin: '0 0 .5rem' }}>Click any number — including row/column/grand totals — to see its underlying routes.</p>
            <SummaryPivotTable summary={summary} onCellClick={(route, category) => setDetailCell({ route, category })} />
          </>
        )}

        {detailCell && (
          <CellDetailModal cell={detailCell} customer={resolvedCustomer} onClose={() => setDetailCell(null)} />
        )}
      </main>
    </div>
  )
}
