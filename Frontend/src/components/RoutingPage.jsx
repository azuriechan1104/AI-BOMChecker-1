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

function downloadCSV(header, csvRows, nameParts) {
  const csv = [header, ...csvRows]
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  const safeName = nameParts.filter(Boolean).join('-').replace(/[^a-z0-9-]+/gi, '_')
  a.href     = url
  a.download = `routing-detail-${safeName || 'export'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function exportDetailCSV(rows, customer, route, category) {
  downloadCSV(
    ['Model Family', 'Category', 'UPN', 'Description', 'Route', 'Update Time'],
    rows.map(r => [r.modelfamily, r.category, r.upn, r.description, r.route, r.updatetime]),
    [customer, route, category]
  )
}

function exportUpnCSV(rows, upn) {
  downloadCSV(
    ['UPN', 'Customer', 'Model Family', 'Category', 'Description', 'Route', 'Update Time'],
    rows.map(r => [r.upn, r.customer, r.modelfamily, r.category, r.description, r.route, r.updatetime]),
    ['upn', upn]
  )
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

// UPN search results: one row per sfcupnroute record whose UPN matched, flat
// rather than pivoted — a part-number lookup wants the route itself (plus the
// customer it belongs to), not a count.
function UpnResultsTable({ rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>UPN</th>
            <th>Customer</th>
            <th>Model Family</th>
            <th>Category</th>
            <th>Description</th>
            <th>Route</th>
            <th>Update Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.upn}-${r.route}-${i}`}>
              <td className="mono">{r.upn}</td>
              <td>{r.customer}</td>
              <td className="mono">{r.modelfamily}</td>
              <td>{r.category}</td>
              <td>{r.description}</td>
              <td className="mono">{r.route}</td>
              <td className="mono">{String(r.updatetime ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Mirrors the server's UPN_SEARCH_MIN_LENGTH — below it the box just waits
// instead of firing a query that would match most of the table.
const UPN_MIN_LENGTH = 2
const UPN_DEBOUNCE_MS = 350

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

  // The UPN box is the page's second entry point: search a part number
  // directly instead of drilling down from a customer.
  const [upnInput, setUpnInput]       = useState('')
  const [upnResult, setUpnResult]     = useState(null)
  const [upnLoading, setUpnLoading]   = useState(false)
  const [upnError, setUpnError]       = useState(null)
  const upnAbortRef = useRef(null)

  const upnTyped   = upnInput.trim()
  const upnMode    = upnTyped.length > 0
  const upnSearchable = upnTyped.length >= UPN_MIN_LENGTH

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
  useEffect(() => () => upnAbortRef.current?.abort(), [])

  // Debounced so a part number typed character by character issues one query
  // at the end rather than one per keystroke.
  useEffect(() => {
    upnAbortRef.current?.abort()
    if (!upnSearchable) {
      setUpnResult(null)
      setUpnError(null)
      setUpnLoading(false)
      return
    }

    setUpnLoading(true)
    const timer = setTimeout(() => {
      const controller = new AbortController()
      upnAbortRef.current = controller

      setUpnResult(null)
      setUpnError(null)
      fetch(`/api/routing/upn?upn=${encodeURIComponent(upnTyped)}`, { signal: controller.signal })
        .then(async res => {
          const json = await res.json()
          if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
          setUpnResult(json)
        })
        .catch(e => {
          if (e.name === 'AbortError') return
          setUpnError('Network error: ' + e.message)
        })
        // An aborted request means a newer search already took over and set
        // its own loading state — don't clear the spinner out from under it.
        .finally(() => { if (!controller.signal.aborted) setUpnLoading(false) })
    }, UPN_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [upnTyped, upnSearchable])

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

          {/* Shown even when the customer list failed to load: the UPN search
              doesn't depend on it, so a broken selector shouldn't take the
              part-number lookup down with it. */}
          {!loading && (
            <div className="comparison-toolbar">
              <span className="filter-hint">Customer</span>
              <ComboInput
                value={customerInput}
                onChange={setCustomerInput}
                options={customers}
                placeholder="Type or choose a customer…"
              />
              <span className="filter-hint">or UPN</span>
              <div className="col-filter">
                <input
                  type="text"
                  value={upnInput}
                  placeholder="Type a part number…"
                  onChange={e => setUpnInput(e.target.value)}
                />
              </div>
              {upnMode && (
                <button type="button" className="filter-btn" onClick={() => setUpnInput('')}>
                  Clear UPN
                </button>
              )}
            </div>
          )}
        </section>

        {/* A UPN search takes over the results area while it has text in it —
            the two searches answer different questions, so showing both a
            pivot and a part-number hit list at once would just be noise.
            Clearing the box returns to the selected customer's summary. */}
        {upnMode && (
          <>
            {!upnSearchable && (
              <StateBox
                type="empty"
                title="Keep Typing…"
                message={`Enter at least ${UPN_MIN_LENGTH} characters of a part number to search.`}
              />
            )}

            {upnSearchable && upnLoading && (
              <StateBox type="loading" title="Searching UPNs…" message={`Querying SFCS for part numbers matching “${upnTyped}”.`} />
            )}

            {upnSearchable && !upnLoading && upnError && <StateBox type="error" message={upnError} />}

            {upnSearchable && !upnLoading && !upnError && upnResult && upnResult.rows.length === 0 && (
              <StateBox
                type="empty"
                title="No Routes Found"
                message={`No sfcupnroute rows have a UPN containing “${upnTyped}”.`}
              />
            )}

            {upnSearchable && !upnLoading && !upnError && upnResult && upnResult.rows.length > 0 && (
              <>
                <h3 className="fpy-chart-title">Routing by UPN — “{upnTyped}”</h3>
                <div className="comparison-toolbar" style={{ margin: '0 0 .5rem' }}>
                  <span className="filter-hint">
                    {upnResult.rows.length} {upnResult.rows.length === 1 ? 'route' : 'routes'}
                    {upnResult.truncated && ` (first ${upnResult.limit} — narrow the search to see the rest)`}
                    {' · matches any UPN containing the text, across all model families'}
                  </span>
                  <button type="button" className="filter-btn" onClick={() => exportUpnCSV(upnResult.rows, upnTyped)}>
                    Export CSV
                  </button>
                </div>
                <UpnResultsTable rows={upnResult.rows} />
              </>
            )}
          </>
        )}

        {!upnMode && !loading && !error && !resolvedCustomer && (
          <StateBox
            type="empty"
            title="Select a Customer or Search a UPN to Begin"
            message="Type or pick a customer for its routing summary, or enter a part number in the UPN box — results load automatically."
          />
        )}

        {!upnMode && resolvedCustomer && summaryLoading && (
          <StateBox type="loading" title="Building Routing Summary…" message={`Querying SFCS for ${resolvedCustomer}.`} />
        )}

        {!upnMode && resolvedCustomer && !summaryLoading && summaryError && <StateBox type="error" message={summaryError} />}

        {!upnMode && resolvedCustomer && !summaryLoading && !summaryError && summary && summary.routes.length === 0 && (
          <StateBox type="empty" title="No Routes Found" message={`No sfcupnroute rows were found for ${resolvedCustomer}.`} />
        )}

        {!upnMode && resolvedCustomer && !summaryLoading && !summaryError && summary && summary.routes.length > 0 && (
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
