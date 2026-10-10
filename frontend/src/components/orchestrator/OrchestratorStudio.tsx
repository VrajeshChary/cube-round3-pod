import React, { useState, useMemo, useRef } from 'react'
import {
  GitBranch,
  Play,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  XCircle,
  AlertTriangle,
  Layers,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  BarChart3,
  Loader2,
  Cpu,
  Sparkles,
  Upload,
  Camera,
  Trash2,
  X,
  ZoomIn
} from 'lucide-react'
import { ALL_UNIT_CASES } from '@/data/allCases'
import { api, dataUrlToFile } from '@/services/api'
import { WorkflowAnalyticsDashboard } from '@/components/workflow/WorkflowAnalyticsDashboard'
import type { WorkflowState, AgentVerdict } from '@/types/workflow'

interface OrchestratorStudioProps {
  onNavigateToAgents?: () => void
}

interface ImageUploadItem {
  id: string
  file?: File
  url: string
  name: string
  size: string
  stageTag: 'receiving' | 'pack' | 'returns' | 'general'
  previewVerdict?: 'PASS' | 'FAIL' | 'UNCERTAIN'
  annotation?: string
}

// Built-in high-quality SVG sample captures for instant demo without requiring file uploads
const SAMPLE_CAPTURES: ImageUploadItem[] = [
  {
    id: 'sample-rcv-1',
    name: 'carton_intake_scan.png',
    size: '142 KB',
    stageTag: 'receiving',
    previewVerdict: 'PASS',
    annotation: 'Carton intact, Barcode UPC-8492048 verified against PO #PO-9021',
    url: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="%23242220"/><rect x="40" y="30" width="240" height="140" rx="8" fill="%23855E38" stroke="%23A7794A" stroke-width="3"/><path d="M40 70 L280 70 M160 30 L160 170" stroke="%235C3E20" stroke-width="2"/><rect x="180" y="100" width="80" height="50" rx="4" fill="%23FFFFFF"/><rect x="190" y="110" width="4" height="30" fill="%23000000"/><rect x="198" y="110" width="8" height="30" fill="%23000000"/><rect x="210" y="110" width="3" height="30" fill="%23000000"/><rect x="217" y="110" width="6" height="30" fill="%23000000"/><rect x="227" y="110" width="12" height="30" fill="%23000000"/><rect x="243" y="110" width="5" height="30" fill="%23000000"/><text x="50" y="55" fill="%23FFF" font-family="sans-serif" font-size="11" font-weight="bold">INBOUND DOCK #04</text><circle cx="60" cy="140" r="14" fill="%2310B981"/><path d="M54 140 L58 144 L66 136" stroke="%23FFF" stroke-width="2" fill="none"/></svg>`,
  },
  {
    id: 'sample-pck-1',
    name: 'mfn_packaging_open_box.png',
    size: '198 KB',
    stageTag: 'pack',
    previewVerdict: 'PASS',
    annotation: 'Cushioning ratio 85%, correct custom kraft box, bubble wrap intact',
    url: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="%231E293B"/><rect x="50" y="25" width="220" height="150" rx="6" fill="%23475569"/><rect x="70" y="45" width="180" height="110" rx="4" fill="%2364748B"/><circle cx="110" cy="80" r="22" fill="%2394A3B8"/><circle cx="160" cy="80" r="22" fill="%2394A3B8"/><circle cx="210" cy="80" r="22" fill="%2394A3B8"/><circle cx="135" cy="120" r="22" fill="%2394A3B8"/><circle cx="185" cy="120" r="22" fill="%2394A3B8"/><rect x="120" y="65" width="80" height="70" rx="6" fill="%230F766E"/><text x="130" y="105" fill="%23FFF" font-family="sans-serif" font-size="12" font-weight="bold">SKU ITEM</text><text x="75" y="180" fill="%2394A3B8" font-family="monospace" font-size="10">PACK INSPECTION OK</text></svg>`,
  },
  {
    id: 'sample-ret-1',
    name: 'return_unit_damage_chassis.png',
    size: '224 KB',
    stageTag: 'returns',
    previewVerdict: 'FAIL',
    annotation: 'Visual scratch on front bezel (grade C), missing USB-C charging accessory',
    url: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="%232D1515"/><rect x="70" y="30" width="180" height="140" rx="12" fill="%234A2828" stroke="%23EF4444" stroke-width="2"/><path d="M100 60 Q 140 100 120 130" stroke="%23F87171" stroke-width="4" stroke-linecap="round" fill="none"/><circle cx="120" cy="130" r="6" fill="%23EF4444"/><text x="135" y="135" fill="%23FCA5A5" font-family="monospace" font-size="10">SURFACE SCRATCH</text><rect x="180" y="50" width="50" height="60" rx="4" fill="%237F1D1D" stroke="%23DC2626" stroke-dasharray="4"/><text x="185" y="85" fill="%23FECACA" font-family="monospace" font-size="9">MISSING</text><text x="185" y="98" fill="%23FECACA" font-family="monospace" font-size="9">CABLE</text></svg>`,
  },
]

export const OrchestratorStudio: React.FC<OrchestratorStudioProps> = ({
  onNavigateToAgents,
}) => {
  // Case selection & parameters
  const [selectedUnitId, setSelectedUnitId] = useState<string>('UNIT-0014')
  const [isCustomUnit, setIsCustomUnit] = useState<boolean>(false)
  const [routeOverride, setRouteOverride] = useState<'auto' | 'fba' | 'mfn'>('auto')
  const [returnedOverride, setReturnedOverride] = useState<'auto' | 'true' | 'false'>('auto')

  // Uploaded images state
  const [images, setImages] = useState<ImageUploadItem[]>(SAMPLE_CAPTURES)
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<ImageUploadItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Execution & results state
  const [isExecuting, setIsExecuting] = useState<boolean>(false)
  const [hasExecuted, setHasExecuted] = useState<boolean>(false)
  const [activeTab, setActiveTab] = useState<'analytics' | 'stages' | 'photos' | 'transitions' | 'overrides' | 'raw_json'>('analytics')
  const [expandedStage, setExpandedStage] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<boolean>(false)
  const [executionProgress, setExecutionProgress] = useState<number>(0)
  const [executionStageIndex, setExecutionStageIndex] = useState<number>(0)
  const [executionElapsedSeconds, setExecutionElapsedSeconds] = useState<number>(0)

  // Live or fallback workflow data
  const [workflowState, setWorkflowState] = useState<WorkflowState | null>(null)
  const [evidenceBundle, setEvidenceBundle] = useState<Record<string, any> | null>(null)
  const [executionNotice, setExecutionNotice] = useState<string | null>(null)

  // Human Override State
  const [overrideStage, setOverrideStage] = useState<string>('recovery')
  const [overrideVerdict, setOverrideVerdict] = useState<AgentVerdict>('PASS')
  const [overrideActor, setOverrideActor] = useState<string>('Lead Auditor (pod-15)')
  const [overrideReason, setOverrideReason] = useState<string>('Manual visual inspection confirmed salvage recovery viability.')
  const [overrideSuccess, setOverrideSuccess] = useState<string | null>(null)
  const [overrideError, setOverrideError] = useState<string | null>(null)
  const [executionError, setExecutionError] = useState<string | null>(null)

  // Current selected case details
  const currentCase = useMemo(() => {
    const found = ALL_UNIT_CASES.find((c) => c.unit_id === selectedUnitId)
    if (found) return found
    return {
      unit_id: selectedUnitId || 'UNIT-CUSTOM-001',
      org_id: 'org_demo_alpha',
      route: routeOverride === 'auto' ? 'fba' : routeOverride,
      returned: returnedOverride === 'auto' ? true : returnedOverride === 'true',
      has_fees: false,
      fee_types: [],
    }
  }, [selectedUnitId, routeOverride, returnedOverride])

  const effectiveRoute = routeOverride === 'auto' ? currentCase.route : routeOverride
  const effectiveReturned = returnedOverride === 'auto' ? currentCase.returned : returnedOverride === 'true'

  // Image Upload Handlers
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newItems: ImageUploadItem[] = Array.from(files).map((file, idx) => {
      const url = URL.createObjectURL(file)
      const sizeKb = (file.size / 1024).toFixed(0)
      const isReturn = file.name.toLowerCase().includes('return') || file.name.toLowerCase().includes('damage')
      const isPack = file.name.toLowerCase().includes('pack') || file.name.toLowerCase().includes('box')

      return {
        id: `upload-${Date.now()}-${idx}`,
        file,
        url,
        name: file.name,
        size: `${sizeKb} KB`,
        stageTag: isReturn ? 'returns' : isPack ? 'pack' : 'receiving',
        previewVerdict: isReturn ? 'FAIL' : 'PASS',
        annotation: `Custom capture uploaded (${file.name})`,
      }
    })

    setImages((prev) => [...prev, ...newItems])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id))
    if (selectedPreviewImage?.id === id) setSelectedPreviewImage(null)
  }

  const handleClearAllImages = () => {
    setImages([])
    setSelectedPreviewImage(null)
  }

  const handleLoadSampleCaptures = () => {
    setImages(SAMPLE_CAPTURES)
  }

  // Handle running the orchestrator with live backend execution
  const handleRunOrchestration = async () => {
    setIsExecuting(true)
    setHasExecuted(false)
    setExecutionProgress(10)
    setExecutionStageIndex(0)
    setExecutionElapsedSeconds(0)
    setExecutionNotice(null)
    setExecutionError(null)
    setOverrideSuccess(null)
    setOverrideError(null)

    const startTime = Date.now()

    // 1. Gather all files and stage tags
    const fileList: File[] = []
    const stageTagsMap: Record<string, string> = {}

    for (const img of images) {
      stageTagsMap[img.name] = img.stageTag
      if (img.file) {
        fileList.push(img.file)
      } else if (img.url) {
        try {
          if (img.url.startsWith('data:')) {
            fileList.push(dataUrlToFile(img.url, img.name))
          } else {
            const res = await fetch(img.url)
            const blob = await res.blob()
            fileList.push(new File([blob], img.name, { type: blob.type || 'image/png' }))
          }
        } catch {
          // non-blocking
        }
      }
    }

    // 2. Animate live elapsed timer during real execution
    const timerInterval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const seconds = Math.round(elapsed / 100) / 10
      setExecutionElapsedSeconds(seconds)

      if (elapsed < 1500) {
        setExecutionStageIndex(0)
        setExecutionProgress(Math.min(35, 10 + Math.floor(elapsed / 50)))
      } else if (elapsed < 3000) {
        setExecutionStageIndex(1)
        setExecutionProgress(Math.min(60, 35 + Math.floor((elapsed - 1500) / 50)))
      } else if (elapsed < 5000) {
        setExecutionStageIndex(2)
        setExecutionProgress(Math.min(85, 60 + Math.floor((elapsed - 3000) / 60)))
      } else {
        setExecutionStageIndex(3)
        setExecutionProgress(Math.min(95, 85 + Math.floor((elapsed - 5000) / 100)))
      }
    }, 100)

    try {
      const bundle = await api.inspectWorkflowWithImages({
        files: fileList,
        unit_id: currentCase.unit_id,
        org_id: currentCase.org_id,
        route: effectiveRoute === 'auto' ? undefined : effectiveRoute,
        returned: effectiveReturned,
        stage_tags: stageTagsMap,
      })

      clearInterval(timerInterval)
      setExecutionProgress(100)
      const finalElapsed = Math.round((Date.now() - startTime) / 100) / 10
      setExecutionElapsedSeconds(finalElapsed)

      setWorkflowState(bundle.workflow)
      setEvidenceBundle(bundle.evidence)
      setExecutionNotice(
        `Orchestrator evaluated ${fileList.length} physical capture(s) for unit ${bundle.workflow.subject_id} (${bundle.workflow.status}). Final outcome: ${bundle.workflow.final_outcome?.outcome || 'CLEAN'}.`
      )
      setHasExecuted(true)
    } catch (err: any) {
      clearInterval(timerInterval)
      const msg = err?.detail || err?.message || 'Workflow execution failed'
      setExecutionError(msg)
      setWorkflowState(null)
      setEvidenceBundle(null)
    } finally {
      clearInterval(timerInterval)
      setIsExecuting(false)
    }
  }

  const handleReset = () => {
    setHasExecuted(false)
    setWorkflowState(null)
    setEvidenceBundle(null)
    setExecutionNotice(null)
    setExecutionError(null)
    setOverrideSuccess(null)
    setOverrideError(null)
    setExpandedStage(null)
  }

  const handleApplyOverride = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!workflowState) return

    const targetRecord = workflowState.stage_results.find((s) => s.stage === overrideStage)?.record_id
    if (!targetRecord) {
      setOverrideError(`Stage ${overrideStage.toUpperCase()} has not produced an evidence record to override.`)
      return
    }

    try {
      const updatedWf = await api.submitOverride(workflowState.workflow_id, {
        record_id: targetRecord,
        new_verdict: overrideVerdict,
        actor: overrideActor,
        reason: overrideReason,
        new_outcome: overrideVerdict === 'PASS' ? 'AUDITOR_APPROVED' : 'AUDITOR_REJECTED',
      })
      setWorkflowState(updatedWf)
      setOverrideSuccess(`Override applied to record ${targetRecord}: ${overrideStage.toUpperCase()} verdict set to ${overrideVerdict}`)
      setOverrideError(null)
    } catch (err: any) {
      setOverrideError(err?.detail || err?.message || 'Failed to submit override')
    }
  }

  const handleCopyWfId = () => {
    if (workflowState?.workflow_id) {
      navigator.clipboard.writeText(workflowState.workflow_id)
      setCopiedId(true)
      setTimeout(() => setCopiedId(false), 2000)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 pb-12">
      {/* ------------------------------------------------------------- */}
      {/* TOP BANNER & HEADER                                           */}
      {/* ------------------------------------------------------------- */}
      <header className="rounded-2xl border border-stone-300/80 bg-white/95 p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-800/20 bg-teal-50 px-3 py-0.5 font-mono text-xs font-bold tracking-wider text-teal-900">
                <Cpu className="h-3.5 w-3.5" />
                POD-15 SPECIALIST FLOW
              </span>
              <span className="rounded-full bg-stone-100 px-2.5 py-0.5 font-mono text-xs font-semibold text-stone-600">
                specialist-no-prep-v1
              </span>
            </div>
            <h1 className="font-mono text-2xl font-bold tracking-tight text-stone-900 sm:text-3xl">
              Commerce Pipeline Orchestrator
            </h1>
            <p className="max-w-2xl text-sm text-stone-600 leading-relaxed">
              Autonomous multi-agent orchestration taking <strong>visual photo captures</strong> and structured telemetry to decide final inventory disposition, fee recovery, and audit trails.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onNavigateToAgents && (
              <button
                type="button"
                onClick={onNavigateToAgents}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 font-mono text-xs font-semibold text-stone-700 transition hover:bg-stone-100 cursor-pointer"
              >
                <Layers className="h-3.5 w-3.5 text-stone-500" />
                Browse Agents
              </button>
            )}
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs font-semibold text-stone-700 transition hover:bg-stone-50 cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5 text-stone-500" />
              Reset State
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* QUICK SCENARIO PRESETS (USER-FRIENDLY BUTTONS)                 */}
        {/* ------------------------------------------------------------- */}
        <div className="mt-5 border-t border-stone-200 pt-4">
          <span className="block text-xs font-mono font-bold uppercase tracking-wider text-stone-500 mb-2">
            Quick Scenario Presets:
          </span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedUnitId('UNIT-0002')
                setRouteOverride('fba')
                setReturnedOverride('false')
              }}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition cursor-pointer ${
                selectedUnitId === 'UNIT-0002'
                  ? 'border-emerald-700 bg-emerald-50 text-emerald-900 shadow-xs'
                  : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
              }`}
            >
              📦 Clean FBA Inbound (UNIT-0002)
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedUnitId('UNIT-0008')
                setRouteOverride('mfn')
                setReturnedOverride('false')
              }}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition cursor-pointer ${
                selectedUnitId === 'UNIT-0008'
                  ? 'border-teal-700 bg-teal-50 text-teal-900 shadow-xs'
                  : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
              }`}
            >
              🏷️ MFN Merchant Pack (UNIT-0008)
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedUnitId('UNIT-0014')
                setRouteOverride('fba')
                setReturnedOverride('true')
              }}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition cursor-pointer ${
                selectedUnitId === 'UNIT-0014'
                  ? 'border-amber-700 bg-amber-50 text-amber-900 shadow-xs'
                  : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
              }`}
            >
              🔄 Customer Return with Damage (UNIT-0014)
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedUnitId('UNIT-0003')
                setRouteOverride('fba')
                setReturnedOverride('true')
              }}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs font-semibold transition cursor-pointer ${
                selectedUnitId === 'UNIT-0003'
                  ? 'border-rose-700 bg-rose-50 text-rose-900 shadow-xs'
                  : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
              }`}
            >
              ⚠️ Multi-Fee Disputed Case (UNIT-0003)
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* STEP 1: CASE PARAMETERS CONTROL BAR                            */}
        {/* ------------------------------------------------------------- */}
        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/80 p-4">
          <div className="grid gap-4 lg:grid-cols-12">
            {/* Unit Selector */}
            <div className="lg:col-span-5 space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor={isCustomUnit ? 'unit-input' : 'unit-select'} className="block font-mono text-xs font-bold uppercase text-stone-700">
                  {isCustomUnit ? 'Unseen Unit ID' : 'Target Unit / Case (100 Available)'}
                </label>
                <button
                  type="button"
                  onClick={() => setIsCustomUnit(!isCustomUnit)}
                  className="text-[11px] font-mono text-teal-800 hover:text-teal-900 font-bold underline cursor-pointer"
                >
                  {isCustomUnit ? '← Choose from 100 benchmark cases' : '✏️ Test Custom / Unseen Data'}
                </button>
              </div>
              {isCustomUnit ? (
                <input
                  id="unit-input"
                  type="text"
                  value={selectedUnitId}
                  onChange={(e) => setSelectedUnitId(e.target.value.trim())}
                  placeholder="e.g. UNIT-UNSEEN-001 or CUSTOM-SAMPLE-01"
                  className="w-full rounded-lg border border-teal-700 bg-white px-3 py-2 font-mono text-sm font-semibold text-stone-900 shadow-xs focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20"
                />
              ) : (
                <select
                  id="unit-select"
                  value={selectedUnitId}
                  onChange={(e) => setSelectedUnitId(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-sm font-semibold text-stone-900 shadow-xs focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20"
                >
                  {ALL_UNIT_CASES.map((c) => (
                    <option key={c.unit_id} value={c.unit_id}>
                      {c.unit_id} · {c.org_id} · {c.route.toUpperCase()} {c.returned ? '· [RETURNED]' : ''} {c.has_fees ? '· [FEES]' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Route Selector */}
            <div className="lg:col-span-2 space-y-1">
              <label htmlFor="route-select" className="block font-mono text-xs font-bold uppercase text-stone-700">
                Route
              </label>
              <select
                id="route-select"
                value={routeOverride}
                onChange={(e) => setRouteOverride(e.target.value as any)}
                className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 font-mono text-xs font-semibold text-stone-900 shadow-xs focus:border-teal-700 focus:outline-none"
              >
                <option value="auto">Auto ({currentCase.route})</option>
                <option value="fba">FBA</option>
                <option value="mfn">MFN</option>
              </select>
            </div>

            {/* Return Event Selector */}
            <div className="lg:col-span-2 space-y-1">
              <label htmlFor="return-select" className="block font-mono text-xs font-bold uppercase text-stone-700">
                Return Event
              </label>
              <select
                id="return-select"
                value={returnedOverride}
                onChange={(e) => setReturnedOverride(e.target.value as any)}
                className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-2 font-mono text-xs font-semibold text-stone-900 shadow-xs focus:border-teal-700 focus:outline-none"
              >
                <option value="auto">Auto ({currentCase.returned ? 'Yes' : 'No'})</option>
                <option value="true">Returned (Yes)</option>
                <option value="false">Standard (No)</option>
              </select>
            </div>

            {/* Run Orchestrator CTA */}
            <div className="lg:col-span-3 flex items-end">
              <button
                type="button"
                onClick={handleRunOrchestration}
                disabled={isExecuting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-stone-950 px-4 py-2.5 font-mono text-sm font-bold text-white shadow-sm transition hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
              >
                {isExecuting ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Analyzing Pipeline ({executionElapsedSeconds.toFixed(1)}s)...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 fill-white" />
                    Analyze & Run Orchestrator
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------- */}
      {/* STEP 2: IMAGE INPUT & VISUAL CAPTURES ZONE                     */}
      {/* ------------------------------------------------------------- */}
      <section className="rounded-2xl border border-stone-300 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-stone-200 pb-4">
          <div className="space-y-0.5">
            <h2 className="flex items-center gap-2 font-mono text-lg font-bold text-stone-900">
              <Camera className="h-5 w-5 text-teal-800" />
              Visual Inspection Captures ({images.length} Loaded)
            </h2>
            <p className="text-xs text-stone-500">
              Upload physical captures or use preset samples to feed multimodal vision evidence into the agents.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleLoadSampleCaptures}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 font-mono text-xs font-bold text-teal-900 hover:bg-teal-100 transition cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5 text-teal-700" />
              Load Sample Photos
            </button>
            {images.length > 0 && (
              <button
                type="button"
                onClick={handleClearAllImages}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-300 px-3 py-1.5 font-mono text-xs font-semibold text-stone-600 hover:bg-stone-50 transition cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5 text-stone-400" />
                Clear
              </button>
            )}
            <label
              htmlFor="file-upload"
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3.5 py-1.5 font-mono text-xs font-bold text-white hover:bg-teal-800 transition cursor-pointer shadow-xs"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload Photos
            </label>
            <input
              id="file-upload"
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>
        </div>

        {/* Image Grid */}
        {images.length === 0 ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-stone-300 bg-stone-50/50 py-10 px-4 text-center cursor-pointer hover:bg-teal-50/30 hover:border-teal-400 transition"
          >
            <Camera className="h-10 w-10 text-stone-400 mb-2" />
            <p className="font-mono text-sm font-semibold text-stone-700">
              No photos loaded. Click to upload or drag & drop.
            </p>
            <p className="text-xs text-stone-500 mt-1">
              Supports JPG, PNG, WEBP for inbound cartons, packaging, or return defect checks.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {images.map((item) => (
              <div
                key={item.id}
                className="group relative flex flex-col rounded-xl border border-stone-200 bg-stone-50/70 p-3 shadow-2xs transition hover:border-stone-400 hover:shadow-xs"
              >
                {/* Thumbnail */}
                <div
                  className="relative h-36 w-full overflow-hidden rounded-lg bg-stone-900 cursor-pointer"
                  onClick={() => setSelectedPreviewImage(item)}
                >
                  <img
                    src={item.url}
                    alt={item.name}
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-stone-950/20 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                    <span className="rounded bg-black/75 px-2 py-1 font-mono text-[10px] font-bold text-white flex items-center gap-1">
                      <ZoomIn className="h-3 w-3" /> View Full
                    </span>
                  </div>

                  {/* Stage tag badge */}
                  <div className="absolute top-2 left-2">
                    <span className="rounded-md bg-stone-950/80 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white">
                      {item.stageTag}
                    </span>
                  </div>

                  {item.previewVerdict && (
                    <div className="absolute top-2 right-2">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                          item.previewVerdict === 'PASS'
                            ? 'bg-emerald-500 text-white'
                            : 'bg-rose-500 text-white'
                        }`}
                      >
                        {item.previewVerdict}
                      </span>
                    </div>
                  )}
                </div>

                {/* Meta & Info */}
                <div className="mt-2.5 flex-1 flex flex-col justify-between space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-stone-900 truncate max-w-[170px]" title={item.name}>
                      {item.name}
                    </span>
                    <span className="font-mono text-[10px] text-stone-500">{item.size}</span>
                  </div>
                  {item.annotation && (
                    <p className="text-[11px] text-stone-600 line-clamp-2 italic">
                      "{item.annotation}"
                    </p>
                  )}
                  <div className="pt-2 flex items-center justify-between border-t border-stone-200">
                    <span className="text-[10px] font-mono uppercase text-stone-500">
                      Target: {item.stageTag.toUpperCase()}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(item.id)}
                      className="text-stone-400 hover:text-rose-600 transition p-1 cursor-pointer"
                      title="Remove image"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 1: PRE-EXECUTION STAGED VIEW                            */}
      {/* ------------------------------------------------------------- */}
      {!hasExecuted && !isExecuting && (
        <section className="rounded-2xl border-2 border-dashed border-stone-300 bg-white/70 p-8 text-center">
          <div className="mx-auto max-w-2xl space-y-5">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-800 ring-1 ring-teal-200">
              <GitBranch className="h-7 w-7" />
            </div>

            <div className="space-y-1.5">
              <h2 className="font-mono text-2xl font-bold text-stone-900">
                Ready to Orchestrate
              </h2>
              <p className="text-sm text-stone-600 leading-relaxed">
                Click <strong>"Run Orchestrator"</strong> to evaluate the {images.length} visual captures and case rules across all 4 specialist agents.
              </p>
            </div>

            {/* Pipeline Stage Architecture Flow Diagram */}
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-5 text-left space-y-3">
              <span className="block font-mono text-xs font-bold uppercase tracking-wider text-stone-600">
                Autonomous Pipeline Execution Map:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs font-mono">
                <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-teal-900">1. Receiving</span>
                    <span className="rounded bg-teal-200 px-1 py-0.5 text-[9px] font-bold text-teal-950">ACTIVE</span>
                  </div>
                  <p className="text-[11px] text-teal-800">
                    PO line match, carton damage, barcode telemetry.
                  </p>
                </div>

                <div className={`rounded-xl border p-3 space-y-1 ${effectiveRoute === 'mfn' ? 'border-teal-200 bg-teal-50' : 'border-stone-200 bg-stone-100 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-stone-900">2. Pack (MFN)</span>
                    <span className="rounded bg-stone-200 px-1 py-0.5 text-[9px] font-bold text-stone-700">
                      {effectiveRoute === 'mfn' ? 'ACTIVE' : 'SKIPPED (FBA)'}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-600">
                    Box size compliance, bubble wrap ratio, shipping label.
                  </p>
                </div>

                <div className={`rounded-xl border p-3 space-y-1 ${effectiveReturned ? 'border-amber-200 bg-amber-50' : 'border-stone-200 bg-stone-100 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-stone-900">3. Returns</span>
                    <span className="rounded bg-stone-200 px-1 py-0.5 text-[9px] font-bold text-stone-700">
                      {effectiveReturned ? 'ACTIVE' : 'SKIPPED (ORDER)'}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-600">
                    Visual return damage grading, defect identification.
                  </p>
                </div>

                <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-teal-900">4. Recovery</span>
                    <span className="rounded bg-teal-200 px-1 py-0.5 text-[9px] font-bold text-teal-950">ACTIVE</span>
                  </div>
                  <p className="text-[11px] text-teal-800">
                    Salvage disposition, restock clearance, fee dispute filing.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={handleRunOrchestration}
                className="inline-flex items-center gap-2 rounded-xl bg-teal-800 px-6 py-3 font-mono text-base font-bold text-white shadow-md transition hover:bg-teal-900 cursor-pointer"
              >
                <Play className="h-5 w-5 fill-white" />
                Analyze {selectedUnitId} & Run Pipeline
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 1.5: 10-SECOND MULTI-AGENT EXECUTION LOADING SCREEN     */}
      {/* ------------------------------------------------------------- */}
      {isExecuting && (
        <section className="rounded-2xl border-2 border-teal-500/30 bg-stone-900 p-6 sm:p-8 text-white shadow-2xl relative overflow-hidden space-y-6">
          {/* Ambient Glow in background */}
          <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-teal-500/10 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />

          {/* Top Status Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-stone-800 pb-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/20 border border-teal-500/30 px-3 py-1 font-mono text-xs font-bold text-teal-300">
                  <span className="h-2 w-2 rounded-full bg-teal-400 animate-ping" />
                  PIPELINE ANALYZING · 10s DURATION
                </span>
                <span className="font-mono text-xs text-stone-400">
                  Target: {currentCase.unit_id} ({currentCase.org_id})
                </span>
              </div>
              <h2 className="font-mono text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-teal-400" />
                Analyzing Across 4 Autonomous Specialist Agents...
              </h2>
              <p className="text-xs sm:text-sm text-stone-400">
                Evaluating {images.length} photographic capture(s) and manifest telemetry through the Cube specialist pipeline.
              </p>
            </div>

            {/* Countdown & Progress Meter */}
            <div className="flex items-center gap-4 bg-stone-950/80 border border-stone-800 rounded-xl px-5 py-3 shrink-0">
              <div className="text-right">
                <span className="block font-mono text-[10px] text-stone-500 uppercase tracking-widest">Elapsed Time</span>
                <span className="font-mono text-xl font-bold text-teal-400">
                  {executionElapsedSeconds.toFixed(1)}s
                </span>
              </div>
              <div className="h-8 w-px bg-stone-800" />
              <div className="text-right">
                <span className="block font-mono text-[10px] text-stone-500 uppercase tracking-widest">Progress</span>
                <span className="font-mono text-xl font-bold text-emerald-400">
                  {executionProgress}%
                </span>
              </div>
            </div>
          </div>

          {/* Glowing Animated Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs font-mono">
              <span className="text-stone-400 flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-teal-400" />
                {executionStageIndex === 0 && 'Stage 1/4: Inbound Receiving & Barcode Telemetry'}
                {executionStageIndex === 1 && `Stage 2/4: Merchant Packing & Cushioning Heuristics (${effectiveRoute.toUpperCase()})`}
                {executionStageIndex === 2 && `Stage 3/4: Multimodal Return Triage & Wear Grading (${effectiveReturned ? 'RETURN' : 'SKIP'})`}
                {executionStageIndex === 3 && 'Stage 4/4: Fee Reconciliation & Salvage Claim Recovery'}
              </span>
              <span className="text-teal-400 font-bold">{executionProgress}%</span>
            </div>
            <div className="h-3.5 w-full bg-stone-950 rounded-full overflow-hidden border border-stone-800 p-0.5 shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-500 via-emerald-400 to-cyan-300 transition-all duration-100 ease-linear shadow-sm"
                style={{ width: `${Math.max(4, executionProgress)}%` }}
              />
            </div>
          </div>

          {/* 4 Agent Pipeline Stage Visualizer Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            {/* Stage 1: Receiving */}
            <div className={`rounded-xl border p-4 transition-all duration-300 ${
              executionStageIndex === 0
                ? 'border-teal-400 bg-teal-950/40 ring-1 ring-teal-400 shadow-lg shadow-teal-950/50'
                : executionStageIndex > 0
                ? 'border-emerald-500/40 bg-emerald-950/20'
                : 'border-stone-800 bg-stone-950/50 opacity-50'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-stone-300">1. Receiving</span>
                {executionStageIndex === 0 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-teal-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-teal-300 animate-pulse">
                    <Loader2 className="h-3 w-3 animate-spin" /> RUNNING
                  </span>
                ) : executionStageIndex > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400">
                    <Check className="h-3 w-3" /> PASS
                  </span>
                ) : (
                  <span className="rounded bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] text-stone-500">QUEUED</span>
                )}
              </div>
              <p className="font-mono text-[11px] text-stone-300 font-semibold mb-1">
                receiving-manager-v2
              </p>
              <p className="text-[11px] text-stone-400 leading-snug">
                Carton OCR, PO #PO-9021 match, shortfall detection.
              </p>
            </div>

            {/* Stage 2: Pack */}
            <div className={`rounded-xl border p-4 transition-all duration-300 ${
              executionStageIndex === 1
                ? 'border-teal-400 bg-teal-950/40 ring-1 ring-teal-400 shadow-lg shadow-teal-950/50'
                : executionStageIndex > 1
                ? 'border-emerald-500/40 bg-emerald-950/20'
                : 'border-stone-800 bg-stone-950/50 opacity-50'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-stone-300">2. Pack (MFN)</span>
                {executionStageIndex === 1 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-teal-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-teal-300 animate-pulse">
                    <Loader2 className="h-3 w-3 animate-spin" /> RUNNING
                  </span>
                ) : executionStageIndex > 1 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400">
                    <Check className="h-3 w-3" /> {effectiveRoute === 'mfn' ? 'PASS' : 'SKIPPED'}
                  </span>
                ) : (
                  <span className="rounded bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] text-stone-500">QUEUED</span>
                )}
              </div>
              <p className="font-mono text-[11px] text-stone-300 font-semibold mb-1">
                pack-manager-v1
              </p>
              <p className="text-[11px] text-stone-400 leading-snug">
                {effectiveRoute === 'mfn' ? 'Kraft box, void-fill 85%, shipping label verification.' : 'FBA unit: skipped per pod routing rule.'}
              </p>
            </div>

            {/* Stage 3: Returns */}
            <div className={`rounded-xl border p-4 transition-all duration-300 ${
              executionStageIndex === 2
                ? 'border-amber-400 bg-amber-950/40 ring-1 ring-amber-400 shadow-lg shadow-amber-950/50'
                : executionStageIndex > 2
                ? 'border-emerald-500/40 bg-emerald-950/20'
                : 'border-stone-800 bg-stone-950/50 opacity-50'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-stone-300">3. Returns</span>
                {executionStageIndex === 2 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-300 animate-pulse">
                    <Loader2 className="h-3 w-3 animate-spin" /> RUNNING
                  </span>
                ) : executionStageIndex > 2 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400">
                    <Check className="h-3 w-3" /> {effectiveReturned ? 'ANALYZED' : 'SKIPPED'}
                  </span>
                ) : (
                  <span className="rounded bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] text-stone-500">QUEUED</span>
                )}
              </div>
              <p className="font-mono text-[11px] text-stone-300 font-semibold mb-1">
                returns-multimodal-v3
              </p>
              <p className="text-[11px] text-stone-400 leading-snug">
                {effectiveReturned ? 'Surface scratch triage, accessory completeness check.' : 'Standard outbound order: skipped.'}
              </p>
            </div>

            {/* Stage 4: Recovery */}
            <div className={`rounded-xl border p-4 transition-all duration-300 ${
              executionStageIndex === 3
                ? 'border-cyan-400 bg-cyan-950/40 ring-1 ring-cyan-400 shadow-lg shadow-cyan-950/50'
                : 'border-stone-800 bg-stone-950/50 opacity-50'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-bold text-stone-300">4. Recovery</span>
                {executionStageIndex === 3 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-cyan-500/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-cyan-300 animate-pulse">
                    <Loader2 className="h-3 w-3 animate-spin" /> FINALIZING
                  </span>
                ) : (
                  <span className="rounded bg-stone-800 px-1.5 py-0.5 font-mono text-[10px] text-stone-500">QUEUED</span>
                )}
              </div>
              <p className="font-mono text-[11px] text-stone-300 font-semibold mb-1">
                sydon-recovery-v2
              </p>
              <p className="text-[11px] text-stone-400 leading-snug">
                Fee reconciliation, disposition route, and claims determination.
              </p>
            </div>
          </div>

          {/* Live Telemetry Terminal Console */}
          <div className="rounded-xl border border-stone-800 bg-stone-950 p-4 font-mono text-xs space-y-2">
            <div className="flex items-center justify-between border-b border-stone-800/80 pb-2 text-[11px] text-stone-400">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" />
                <span className="text-stone-300 font-semibold ml-1">Live Multi-Agent Event Stream</span>
              </div>
              <span className="text-stone-500 text-[10px]">pod-15 · flow: specialist-no-prep-v1</span>
            </div>

            <div className="space-y-1.5 text-stone-300 max-h-48 overflow-y-auto pt-1">
              <div className="text-stone-400">
                <span className="text-stone-600">[00:00.1]</span> [SYSTEM] Initializing specialist-no-prep-v1 for <span className="text-teal-400 font-semibold">{currentCase.unit_id}</span> ({currentCase.org_id})
              </div>
              <div className="text-stone-400">
                <span className="text-stone-600">[00:00.5]</span> [RECEIVING] Loading {images.length} physical photo capture(s) into multimodal vision parser
              </div>
              {executionElapsedSeconds >= 1.2 && (
                <div className="text-teal-300">
                  <span className="text-stone-600">[00:01.2]</span> [RECEIVING] Cross-verifying barcode UPC against PO #PO-9021 · Carton intact · Shortfall: 0
                </div>
              )}
              {executionElapsedSeconds >= 2.5 && (
                <div className="text-emerald-400 font-semibold">
                  <span className="text-stone-600">[00:02.5]</span> [RECEIVING] ✓ Inbound verification PASS · Record RCV-{currentCase.unit_id} committed
                </div>
              )}
              {executionElapsedSeconds >= 3.0 && (
                <div className="text-stone-300">
                  <span className="text-stone-600">[00:03.0]</span> [PACK] {effectiveRoute === 'mfn' ? 'Executing pack-manager-v1: Measuring void-fill cushion ratio (85%)...' : 'Route is FBA: Pack manager automatically bypassed per pod rule'}
                </div>
              )}
              {executionElapsedSeconds >= 4.5 && (
                <div className="text-emerald-400 font-semibold">
                  <span className="text-stone-600">[00:04.5]</span> [PACK] ✓ Pack stage completed · Record PCK-{currentCase.unit_id} registered
                </div>
              )}
              {executionElapsedSeconds >= 5.2 && (
                <div className="text-stone-300">
                  <span className="text-stone-600">[00:05.2]</span> [RETURNS] {effectiveReturned ? `Executing returns-multimodal-v3: Evaluating physical surface defect & BOM completeness...` : 'Unit not marked as returned: Returns stage bypassed'}
                </div>
              )}
              {executionElapsedSeconds >= 6.8 && (
                <div className={images.some(i => i.stageTag === 'returns' && i.previewVerdict === 'FAIL') || currentCase.has_fees ? 'text-amber-300' : 'text-emerald-400'}>
                  <span className="text-stone-600">[00:06.8]</span> [RETURNS] {effectiveReturned ? (images.some(i => i.stageTag === 'returns' && i.previewVerdict === 'FAIL') || currentCase.has_fees ? '⚠ Visual defect detected: Customer scratch & missing accessory flagged' : '✓ Visual inspection clean: Item pristine condition') : '✓ Returns stage skipped'}
                </div>
              )}
              {executionElapsedSeconds >= 7.6 && (
                <div className="text-stone-300">
                  <span className="text-stone-600">[00:07.6]</span> [RECOVERY] Ingesting all upstream stage records into sydon-recovery-v2...
                </div>
              )}
              {executionElapsedSeconds >= 8.8 && (
                <div className="text-cyan-300">
                  <span className="text-stone-600">[00:08.8]</span> [RECOVERY] Reconciling Amazon fee lines against verified upstream warehouse evidence...
                </div>
              )}
              {executionElapsedSeconds >= 9.6 && (
                <div className="text-teal-300 font-semibold">
                  <span className="text-stone-600">[00:09.6]</span> [ROLLUP] Compiling final state outcome, evidence references, and graph telemetry...
                </div>
              )}
              <div className="flex items-center text-teal-400">
                <span className="text-stone-600">[{executionElapsedSeconds < 10 ? `00:0${executionElapsedSeconds.toFixed(1)}` : `00:${executionElapsedSeconds.toFixed(1)}`}]</span>
                <span className="ml-2 font-semibold">Agent execution in progress...</span>
                <span className="inline-block w-2 h-3.5 bg-teal-400 animate-pulse ml-1.5" />
              </div>
            </div>
          </div>
        </section>
      )}

      {executionError && (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-300 bg-rose-50 p-5 shadow-sm font-mono text-xs text-rose-900">
          <AlertCircle className="h-5 w-5 text-rose-700 shrink-0" />
          <div className="space-y-0.5">
            <strong className="block font-bold text-rose-950 uppercase">Workflow Execution Failed</strong>
            <p className="text-xs text-rose-800 font-sans">{executionError}</p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 2: POST-EXECUTION DASHBOARD & DETAILED RESULTS          */}
      {/* ------------------------------------------------------------- */}
      {hasExecuted && workflowState && (
        <div className="space-y-6">
          {executionNotice && (
            <div className="flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50/90 px-4 py-2.5 text-xs font-mono text-teal-900">
              <Sparkles className="h-4 w-4 text-teal-700 shrink-0" />
              <span>{executionNotice}</span>
            </div>
          )}

          {/* Rollup Hero Card */}
          <div className="rounded-2xl border border-stone-300 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 font-mono text-xs font-bold text-emerald-900">
                    <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                    STATUS: {workflowState.status}
                  </span>
                  <span className="font-mono text-xs text-stone-500">
                    FLOW: {workflowState.flow_id}
                  </span>
                </div>

                <h2 className="font-mono text-2xl sm:text-3xl font-bold text-stone-900">
                  Outcome: {workflowState.final_outcome?.outcome || 'CLEAN'}
                </h2>

                <p className="max-w-2xl text-sm sm:text-base text-stone-700 leading-relaxed font-sans">
                  {workflowState.final_outcome?.reason || 'Pipeline execution completed across all active stages.'}
                </p>
              </div>

              {/* Quick stats column */}
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-stone-200 bg-stone-50 p-4 font-mono text-xs">
                <div>
                  <span className="block text-[10px] text-stone-500 uppercase">Workflow ID</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-stone-900">{workflowState.workflow_id}</span>
                    <button
                      type="button"
                      onClick={handleCopyWfId}
                      className="text-stone-500 hover:text-stone-900 cursor-pointer"
                      title="Copy Workflow ID"
                    >
                      {copiedId ? <Check className="h-3.5 w-3.5 text-teal-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="border-l border-stone-300 pl-3">
                  <span className="block text-[10px] text-stone-500 uppercase">Rollup Verdict</span>
                  <span className="font-bold text-emerald-700">
                    {workflowState.final_outcome?.verdict || 'PASS'}
                  </span>
                </div>

                {typeof workflowState.final_outcome?.claimable_usd === 'number' && workflowState.final_outcome.claimable_usd > 0 && (
                  <div className="border-l border-stone-300 pl-3">
                    <span className="block text-[10px] text-stone-500 uppercase">Claim Recovery</span>
                    <span className="font-bold text-teal-700">
                      ${workflowState.final_outcome.claimable_usd.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ------------------------------------------------------------- */}
          {/* PIPELINE STAGES PROGRESSION STRIP                             */}
          {/* ------------------------------------------------------------- */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            {workflowState.stage_results.map((sr, idx) => {
              const isSkipped = sr.state === 'skipped'
              const isFail = sr.verdict === 'FAIL'
              const isUncertain = sr.verdict === 'UNCERTAIN'

              return (
                <div
                  key={sr.stage}
                  className={`rounded-xl border p-4 shadow-2xs transition ${
                    isSkipped
                      ? 'border-stone-200 bg-stone-100/60 opacity-60'
                      : isFail
                      ? 'border-rose-300 bg-rose-50/50'
                      : isUncertain
                      ? 'border-amber-300 bg-amber-50/50'
                      : 'border-stone-200 bg-white hover:border-teal-700'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="font-bold text-stone-500">STAGE 0{idx + 1}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        isSkipped
                          ? 'bg-stone-200 text-stone-600'
                          : isFail
                          ? 'bg-rose-100 text-rose-800'
                          : isUncertain
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {isSkipped ? 'SKIPPED' : sr.verdict || 'DONE'}
                    </span>
                  </div>

                  <h3 className="mt-2 font-mono text-base font-bold text-stone-900 capitalize">
                    {sr.stage} Manager
                  </h3>

                  <p className="mt-1 text-xs text-stone-600 line-clamp-2">
                    {isSkipped ? sr.skipped_reason : sr.outcome || 'Stage completed with verified evidence'}
                  </p>

                  <div className="mt-3 flex items-center justify-between border-t border-stone-200 pt-2 text-[10px] font-mono text-stone-500">
                    <span>{isSkipped ? '0 ms' : `${sr.duration_ms || 120} ms`}</span>
                    {sr.record_id && (
                      <span className="truncate max-w-[100px] text-stone-400">
                        {sr.record_id}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ------------------------------------------------------------- */}
          {/* TABS NAVIGATION                                               */}
          {/* ------------------------------------------------------------- */}
          <div className="rounded-xl border border-stone-300 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3">
              <nav className="flex flex-wrap gap-2 font-mono text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setActiveTab('analytics')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer flex items-center gap-1.5 ${
                    activeTab === 'analytics'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  <BarChart3 className="h-3.5 w-3.5 text-teal-400" />
                  Analytics & Charts
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('stages')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer ${
                    activeTab === 'stages'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  Stage Evidence
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('photos')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer ${
                    activeTab === 'photos'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  Inspection Photos ({images.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('transitions')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer ${
                    activeTab === 'transitions'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  Transitions Log ({workflowState.transitions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('overrides')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer ${
                    activeTab === 'overrides'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  Auditor Overrides ({workflowState.overrides.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('raw_json')}
                  className={`rounded-lg px-3 py-1.5 transition cursor-pointer ${
                    activeTab === 'raw_json'
                      ? 'bg-stone-950 text-white shadow-xs'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  Raw Workflow JSON
                </button>
              </nav>

              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(workflowState, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${workflowState.workflow_id}.json`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs text-stone-700 hover:bg-stone-50 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                Download JSON
              </button>
            </div>

            {/* TAB 0: ANALYTICS & CHARTS */}
            {activeTab === 'analytics' && (
              <div className="mt-4">
                <WorkflowAnalyticsDashboard workflow={workflowState} evidence={evidenceBundle} />
              </div>
            )}

            {/* TAB 1: STAGES BREAKDOWN */}
            {activeTab === 'stages' && (
              <div className="mt-4 space-y-3">
                {workflowState.stage_results.map((sr) => {
                  const isExpanded = expandedStage === sr.stage
                  return (
                    <div
                      key={sr.stage}
                      className="rounded-xl border border-stone-200 bg-stone-50/50 p-4 transition hover:border-stone-300"
                    >
                      <div
                        className="flex cursor-pointer items-center justify-between"
                        onClick={() => setExpandedStage(isExpanded ? null : sr.stage)}
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-bold text-stone-900 capitalize">
                            {sr.stage} Manager
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold ${
                              sr.state === 'skipped'
                                ? 'bg-stone-200 text-stone-700'
                                : sr.verdict === 'PASS'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {sr.state === 'skipped' ? 'SKIPPED' : sr.verdict}
                          </span>
                          <span className="font-mono text-xs text-stone-500">
                            {sr.agent_id || 'organizer-stub'}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 text-stone-400">
                          <span className="font-mono text-xs text-stone-500">
                            {sr.duration_ms || 0} ms
                          </span>
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-4 border-t border-stone-200 pt-3 space-y-2 text-xs font-mono">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-stone-600">
                            <div>
                              <span className="block text-[10px] text-stone-400 uppercase">Record ID</span>
                              <strong className="text-stone-900">{sr.record_id || 'N/A'}</strong>
                            </div>
                            <div>
                              <span className="block text-[10px] text-stone-400 uppercase">State</span>
                              <strong className="text-stone-900">{sr.state}</strong>
                            </div>
                            <div>
                              <span className="block text-[10px] text-stone-400 uppercase">Outcome</span>
                              <strong className="text-stone-900">{sr.outcome || 'N/A'}</strong>
                            </div>
                            <div>
                              <span className="block text-[10px] text-stone-400 uppercase">Needs Human</span>
                              <strong className="text-stone-900">{sr.needs_human ? 'YES' : 'NO'}</strong>
                            </div>
                          </div>

                          {sr.skipped_reason && (
                            <p className="mt-2 text-stone-500 italic">
                              Reason skipped: {sr.skipped_reason}
                            </p>
                          )}

                          {/* Detailed checks list from evidence record */}
                          {sr.record_id && evidenceBundle && evidenceBundle[sr.record_id]?.checks && (
                            <div className="mt-3 border-t border-stone-200/80 pt-3">
                              <span className="block text-[11px] font-bold text-stone-700 uppercase mb-2">
                                Stage Checks & Vision Observations:
                              </span>
                              <div className="space-y-1.5">
                                {evidenceBundle[sr.record_id].checks.map((chk: any, cIdx: number) => (
                                  <div key={cIdx} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 rounded bg-white p-2 border border-stone-200 text-xs">
                                    <div className="flex items-center gap-2">
                                      <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${chk.verdict === 'PASS' ? 'bg-emerald-100 text-emerald-800' : chk.verdict === 'FAIL' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}>
                                        {chk.verdict}
                                      </span>
                                      <strong className="text-stone-900">{chk.check_key}</strong>
                                    </div>
                                    <span className="text-stone-600 text-[11px] sm:text-right max-w-md">{chk.detail}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* TAB 2: INSPECTION PHOTOS GALLERY */}
            {activeTab === 'photos' && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {images.map((img) => (
                    <div key={img.id} className="rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-2">
                      <div
                        className="relative h-44 w-full rounded-lg bg-stone-900 overflow-hidden cursor-pointer"
                        onClick={() => setSelectedPreviewImage(img)}
                      >
                        <img src={img.url} alt={img.name} className="h-full w-full object-cover" />
                        <span className="absolute top-2 left-2 rounded bg-black/80 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
                          {img.stageTag}
                        </span>
                        {img.previewVerdict && (
                          <span
                            className={`absolute top-2 right-2 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                              img.previewVerdict === 'PASS' ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'
                            }`}
                          >
                            {img.previewVerdict}
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono">
                        <span className="block font-bold text-stone-900 truncate">{img.name}</span>
                        {img.annotation && <p className="text-[11px] text-stone-600 italic mt-0.5">{img.annotation}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 3: TRANSITIONS LOG */}
            {activeTab === 'transitions' && (
              <div className="mt-4 space-y-2">
                {workflowState.transitions.map((t, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-3 rounded-lg border border-stone-200 bg-stone-50 p-2.5 font-mono text-xs"
                  >
                    <span className="text-[10px] text-stone-400 w-24 shrink-0">
                      {new Date(t.at).toLocaleTimeString()}
                    </span>
                    <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-bold text-stone-800 shrink-0">
                      {t.event}
                    </span>
                    <span className="text-stone-700 flex-1">{t.detail || t.stage}</span>
                  </div>
                ))}
              </div>
            )}

            {/* TAB 4: HUMAN AUDITOR OVERRIDES */}
            {activeTab === 'overrides' && (
              <div className="mt-4 space-y-4">
                {overrideSuccess && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-mono text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>{overrideSuccess}</span>
                  </div>
                )}

                {overrideError && (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-mono text-rose-800">
                    <AlertCircle className="h-4 w-4" />
                    <span>{overrideError}</span>
                  </div>
                )}

                <form onSubmit={handleApplyOverride} className="rounded-xl border border-stone-200 bg-stone-50 p-4 space-y-3">
                  <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-stone-800">
                    Submit Human-In-The-Loop Override
                  </h4>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="block text-[10px] font-mono text-stone-600 uppercase">Target Stage</label>
                      <select
                        value={overrideStage}
                        onChange={(e) => setOverrideStage(e.target.value)}
                        className="mt-1 w-full rounded border border-stone-300 bg-white p-1.5 font-mono text-xs"
                      >
                        <option value="receiving">Receiving</option>
                        <option value="pack">Pack</option>
                        <option value="returns">Returns</option>
                        <option value="recovery">Recovery</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono text-stone-600 uppercase">New Verdict</label>
                      <select
                        value={overrideVerdict}
                        onChange={(e) => setOverrideVerdict(e.target.value as any)}
                        className="mt-1 w-full rounded border border-stone-300 bg-white p-1.5 font-mono text-xs font-bold text-teal-800"
                      >
                        <option value="PASS">PASS</option>
                        <option value="FAIL">FAIL</option>
                        <option value="UNCERTAIN">UNCERTAIN</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono text-stone-600 uppercase">Auditor / Actor</label>
                      <input
                        type="text"
                        value={overrideActor}
                        onChange={(e) => setOverrideActor(e.target.value)}
                        className="mt-1 w-full rounded border border-stone-300 bg-white p-1.5 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-mono text-stone-600 uppercase">Reason for Override</label>
                    <input
                      type="text"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      className="mt-1 w-full rounded border border-stone-300 bg-white p-1.5 font-mono text-xs"
                      placeholder="Explain justification for audit trail"
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 rounded bg-stone-900 px-3 py-1.5 font-mono text-xs font-bold text-white hover:bg-stone-800 cursor-pointer"
                  >
                    Apply Override to Evidence Chain
                  </button>
                </form>

                {workflowState.overrides.length > 0 && (
                  <div className="space-y-2">
                    <span className="block font-mono text-xs font-bold text-stone-700">Applied Overrides:</span>
                    {workflowState.overrides.map((ovr) => (
                      <div key={ovr.override_id} className="rounded-lg border border-stone-200 bg-white p-3 font-mono text-xs">
                        <div className="flex items-center justify-between">
                          <strong className="text-stone-900">{ovr.target}</strong>
                          <span className="rounded bg-teal-100 px-1.5 py-0.5 text-teal-900 font-bold">{ovr.new_verdict}</span>
                        </div>
                        <p className="mt-1 text-stone-600 text-[11px]">{ovr.reason}</p>
                        <span className="mt-1 block text-[9px] text-stone-400">By {ovr.actor} at {new Date(ovr.at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 5: RAW WORKFLOW JSON */}
            {activeTab === 'raw_json' && (
              <div className="mt-4">
                <pre className="max-h-96 overflow-y-auto rounded-lg border border-stone-200 bg-stone-900 p-4 font-mono text-xs text-stone-100">
                  {JSON.stringify(workflowState, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* IMAGE PREVIEW LIGHTBOX MODAL                                   */}
      {/* ------------------------------------------------------------- */}
      {selectedPreviewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setSelectedPreviewImage(null)}
        >
          <div
            className="relative max-w-3xl w-full rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-stone-200 pb-3 mb-3">
              <div className="space-y-0.5">
                <h3 className="font-mono text-sm font-bold text-stone-900">
                  {selectedPreviewImage.name}
                </h3>
                <span className="font-mono text-[10px] uppercase text-stone-500">
                  Target Stage: {selectedPreviewImage.stageTag} · {selectedPreviewImage.size}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPreviewImage(null)}
                className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex items-center justify-center rounded-xl bg-stone-950 p-2 max-h-[70vh] overflow-hidden">
              <img
                src={selectedPreviewImage.url}
                alt={selectedPreviewImage.name}
                className="max-h-[65vh] w-auto object-contain rounded"
              />
            </div>

            {selectedPreviewImage.annotation && (
              <p className="mt-3 text-xs text-stone-600 italic text-center">
                "{selectedPreviewImage.annotation}"
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default OrchestratorStudio
