import { useState } from 'react'
import TabBar from './TabBar'
import NewBomQvlStage from './NewBomQvlStage'
import NewBomPnCheckPanel from './NewBomPnCheckPanel'
import NewBomValidationSummary from './NewBomValidationSummary'
import NewBomArchitectureTable from './NewBomArchitectureTable'

// QVL (PN + Description, ADD/MODIFY-staged, Add-To-PLM preview folded in —
// mirrors MonicaTPGenerator.exe's QVL tab as one screen) -> TPG PN Check ->
// Validation -> New BOM Architecture. Stops there — no write to the
// mass-production DB, no TPA/"Upload to MP" step. See
// C:\Users\ym2309004\.claude\plans\i-want-you-to-streamed-jellyfish.md for
// the original design rationale (the QVL/Add-Remove/Add-To-PLM stages were
// later consolidated into one, per real-tool alignment feedback).
const STAGES = [
  { id: 'qvl', label: 'QVL' },
  { id: 'pn-check', label: 'TPG PN Check' },
  { id: 'validation', label: 'Validation' },
  { id: 'architecture', label: 'New BOM Architecture' },
]

const INITIAL_INPUTS = {
  modelRef: '', location: '', moNumber: '', gen: 11, modelToken: 'C41A8',
  partNumber: '', description: '', l10Mspn: '', l11Mspn: '', msfNumber: '',
}

export default function CreateNewBomPage() {
  const [stage, setStage] = useState('qvl')
  const [furthest, setFurthest] = useState(0)
  const [inputs, setInputs] = useState(INITIAL_INPUTS)
  const [rows, setRows] = useState([]) // {id, partNumber, description, action, location, modelRef}
  const [plmStage, setPlmStage] = useState(null)
  const [pnChecks, setPnChecks] = useState({})

  // DELETE-staged rows are a record of "would be removed," not a new part
  // number to validate — only ADD/MODIFY rows go on to TPG PN Check /
  // Validation / New BOM Architecture.
  const activeRows = rows.filter(r => r.action !== 'DELETE')

  function goTo(id) {
    const idx = STAGES.findIndex(s => s.id === id)
    if (idx <= furthest) setStage(id)
  }

  function advance(id) {
    const idx = STAGES.findIndex(s => s.id === id)
    setFurthest(f => Math.max(f, idx))
    setStage(id)
  }

  function updateInputs(patch) {
    setInputs(prev => ({ ...prev, ...patch }))
  }

  function reset() {
    setStage('qvl')
    setFurthest(0)
    setInputs(INITIAL_INPUTS)
    setRows([])
    setPlmStage(null)
    setPnChecks({})
  }

  return (
    <>
      <TabBar tabs={STAGES} activeTab={stage} onSwitch={goTo} />
      <div className="app-body">
        <main>
          {stage === 'qvl' && (
            <NewBomQvlStage
              inputs={inputs}
              onChange={updateInputs}
              rows={rows}
              onRowsChange={setRows}
              plmStage={plmStage}
              onStaged={setPlmStage}
              onNext={() => advance('pn-check')}
            />
          )}
          {stage === 'pn-check' && (
            <NewBomPnCheckPanel
              rows={activeRows}
              inputs={inputs}
              pnChecks={pnChecks}
              onChecked={results => setPnChecks(prev => ({ ...prev, ...results }))}
              onBack={() => goTo('qvl')}
              onNext={() => advance('validation')}
            />
          )}
          {stage === 'validation' && (
            <NewBomValidationSummary
              rows={activeRows}
              pnChecks={pnChecks}
              onBack={() => goTo('pn-check')}
              onNext={() => advance('architecture')}
            />
          )}
          {stage === 'architecture' && (
            <NewBomArchitectureTable
              rows={activeRows}
              pnChecks={pnChecks}
              onBack={() => goTo('validation')}
              onReset={reset}
            />
          )}
        </main>
      </div>
    </>
  )
}
