import React, { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Camera,
  CheckCircle2,
  Info,
  Loader2,
  Lock,
  Package,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { api } from '@/services/api'
import type {
  CatalogProduct,
  EvidenceBundle,
  EvidenceRecord,
  WarehouseReturnRecord,
  WorkflowState,
} from '@/types/workflow'
import { ReturnsReportView } from './ReturnsReportView'

interface ReturnsInspectorProps {
  onWorkflowComplete?: (workflow: WorkflowState) => void
  onNavigateToAgents?: () => void
}

interface ImagePreviewItem {
  id: string
  file?: File
  url: string
  name: string
  sizeBytes: number
  isBlob: boolean
}

const DEFAULT_CATALOG: CatalogProduct[] = [
  {
    sku: 'SKU-PHONE-5G',
    asin: 'B0DEMO-PHONE',
    display_name: 'Smartphone',
    title: 'Flagship 5G Smartphone 128GB',
    category: 'Electronics',
    expected_parts: ['smartphone', 'charging cable', 'sim ejector tool'],
  },
  {
    sku: 'SKU-HEADPHONES-ANC',
    asin: 'B0DEMO-HEADPHONES',
    display_name: 'Headphones',
    title: 'Wireless Over-Ear Noise-Cancelling Headphones',
    category: 'Electronics',
    expected_parts: ['headphones', 'audio cable', 'charging cable', 'carrying case'],
  },
  {
    sku: 'SKU-LAPTOP-14',
    asin: 'B0DEMO-LAPTOP',
    display_name: 'Laptop',
    title: 'Ultra-Slim 14-inch Laptop Notebook',
    category: 'Electronics',
    expected_parts: ['laptop', 'power adapter', 'power cord'],
  },
  {
    sku: 'SKU-SNEAKER-RUN',
    asin: 'B0DEMO-SNEAKER',
    display_name: 'Sneaker / shoes',
    title: 'Breathable Lightweight Running Shoes (Pair)',
    category: 'Clothing & Footwear',
    expected_parts: ['running shoes (pair)', 'shoelaces'],
  },
  {
    sku: 'SKU-TSHIRT-COTTON',
    asin: 'B0DEMO-TSHIRT',
    display_name: 'T-shirt / clothing',
    title: 'Classic 100% Organic Cotton Crewneck T-Shirt',
    category: 'Apparel & Clothing',
    expected_parts: ['t-shirt'],
  },
  {
    sku: 'SKU-BOTTLE-750',
    asin: 'B0DUMMY622',
    display_name: 'Water bottle',
    title: 'Insulated Stainless Steel Water Bottle 750ml',
    category: 'Kitchen & Dining',
    expected_parts: ['bottle', 'lid'],
  },
  {
    sku: 'SKU-MUG-11',
    asin: 'B0DUMMY351',
    display_name: 'Mug',
    title: 'Matte Ceramic Coffee Mug Set (11oz, Pack of 2)',
    category: 'Kitchen & Dining',
    expected_parts: ['mug x2'],
  },
  {
    sku: 'SKU-TOWEL-BLU',
    asin: 'B0DUMMY600',
    display_name: 'Towel',
    title: 'Ultra-Absorbent Microfiber Beach & Gym Towel (Navy)',
    category: 'Sports & Outdoors',
    expected_parts: ['towel'],
  },
  {
    sku: 'SKU-PUZZLE-500',
    asin: 'B0DUMMY729',
    display_name: 'Puzzle',
    title: '500-Piece Panoramic Landscape Jigsaw Puzzle',
    category: 'Toys & Games',
    expected_parts: ['puzzle pieces', 'poster'],
  },
  {
    sku: 'SKU-SERUM-30',
    asin: 'B0DUMMY031',
    display_name: 'Skincare serum',
    title: 'Vitamin C Glow Facial Serum 30ml',
    category: 'Beauty & Personal Care',
    expected_parts: ['bottle', 'dropper', 'leaflet'],
  },
  {
    sku: 'SKU-PROT-1KG',
    asin: 'B0DUMMY357',
    display_name: 'Protein powder',
    title: '100% Pure Whey Isolate Protein Powder 1kg Vanilla',
    category: 'Health & Household',
    expected_parts: ['tub', 'scoop'],
  },
  {
    sku: 'SKU-CABLE-USBC',
    asin: 'B0DUMMY261',
    display_name: 'USB cable',
    title: 'Braided Fast Charging USB-C to USB-C Cable (2m)',
    category: 'Electronics',
    expected_parts: ['cable'],
  },
  {
    sku: 'SKU-LAMP-LED',
    asin: 'B0DUMMY357',
    display_name: 'LED desk lamp',
    title: 'Dimmable Architect LED Desk Lamp with Clamp',
    category: 'Home & Office',
    expected_parts: ['lamp', 'usb cable', 'manual'],
  },
  {
    sku: 'SKU-CANDLE-3',
    asin: 'B0DUMMY964',
    display_name: 'Candle',
    title: 'Natural Soy Aromatherapy Candle Trio Gift Set',
    category: 'Home & Kitchen',
    expected_parts: ['candle x3', 'gift box'],
  },
  {
    sku: 'SKU-LEASH-6FT',
    asin: 'B0DUMMY205',
    display_name: 'Dog leash',
    title: 'Heavy-Duty Mountain Climbing Rope Dog Leash 6ft',
    category: 'Pet Supplies',
    expected_parts: ['leash'],
  },
]

export const ReturnsInspector: React.FC<ReturnsInspectorProps> = ({
  onWorkflowComplete,
}) => {
  // Product catalogue & selection state
  const [catalog, setCatalog] = useState<CatalogProduct[]>(DEFAULT_CATALOG)
  const [selectedProductSku, setSelectedProductSku] = useState<string>('')
  const [manualItemName, setManualItemName] = useState<string>('')
  const [manualItemSku, setManualItemSku] = useState<string>('')

  // Warehouse return records state
  const [warehouseRecords, setWarehouseRecords] = useState<WarehouseReturnRecord[]>([])
  const [selectedRecordId, setSelectedRecordId] = useState<string>('')
  const [warehouseImageNotice, setWarehouseImageNotice] = useState<string | null>(null)

  // Files & preview state (supports multiple uploads)
  const [previews, setPreviews] = useState<ImagePreviewItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  // Execution state & live timer
  const [analyzing, setAnalyzing] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [progressPercent, setProgressPercent] = useState(12)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null)

  const timerIntervalRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLSelectElement>(null)

  // Load catalog and warehouse records on mount
  useEffect(() => {
    let isMounted = true
    api.getCatalog()
      .then((items) => {
        if (isMounted && items.length > 0) {
          setCatalog(items)
        }
      })
      .catch(() => {
        // Fallback to DEFAULT_CATALOG already initialized
      })

    api.getWarehouseRecords()
      .then((records) => {
        if (isMounted && records.length > 0) {
          setWarehouseRecords(records)
        }
      })
      .catch(() => {
        // Non-blocking
      })

    return () => {
      isMounted = false
    }
  }, [])

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      previews.forEach((p) => {
        if (p.isBlob && p.url.startsWith('blob:')) {
          URL.revokeObjectURL(p.url)
        }
      })
      if (timerIntervalRef.current !== null) {
        window.clearInterval(timerIntervalRef.current)
        timerIntervalRef.current = null
      }
    }
  }, [previews])

  // Resolve current active product info
  const isOther = selectedProductSku === '__other__'
  const selectedProduct = catalog.find((p) => p.sku === selectedProductSku)

  const activeTitle = isOther
    ? manualItemName.trim() || 'Custom Item'
    : selectedProduct?.title || ''

  const activeDisplayName = isOther
    ? manualItemName.trim() || 'Other / enter item manually'
    : selectedProduct?.display_name || selectedProduct?.title || ''

  const activeSku = isOther
    ? manualItemSku.trim() || (manualItemName ? `SKU-${manualItemName.toUpperCase().replace(/\s+/g, '-').slice(0, 12)}` : 'SKU-CUSTOM')
    : selectedProduct?.sku || ''

  const activeAsin = selectedProduct?.asin || (isOther ? 'B0-CUSTOM' : '')
  const activeCategory = selectedProduct?.category || (isOther ? 'General Merchandise' : '')
  const activeExpectedParts = selectedProduct?.expected_parts || []

  const isProductSelected = selectedProductSku !== '' && (!isOther || manualItemName.trim() !== '')

  const startTimer = () => {
    const analysisStartedAt = Date.now()
    setElapsedSeconds(0)
    setProgressPercent(12)
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current)
    }
    timerIntervalRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - analysisStartedAt
      const elapsed = Math.floor(elapsedMs / 1000)
      setElapsedSeconds(elapsed)

      let pct = 12
      if (elapsedMs < 1000) {
        pct = 12 + Math.floor((elapsedMs / 1000) * 18)
      } else if (elapsedMs < 3000) {
        pct = 30 + Math.floor(((elapsedMs - 1000) / 2000) * 28)
      } else if (elapsedMs < 6000) {
        pct = 58 + Math.floor(((elapsedMs - 3000) / 3000) * 22)
      } else if (elapsedMs < 10000) {
        pct = 80 + Math.floor(((elapsedMs - 6000) / 4000) * 12)
      } else {
        pct = Math.min(96, 92 + Math.floor(((elapsedMs - 10000) / 10000) * 4))
      }
      setProgressPercent(pct)
    }, 150)
  }

  const stopTimer = () => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
    }
  }

  const formatTimer = (totalSecs: number): string => {
    const m = Math.floor(totalSecs / 60)
    const s = totalSecs % 60
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  const handleProductChange = (skuVal: string) => {
    setSelectedProductSku(skuVal)
    setFileError(null)
    setAnalysisError(null)
    setWarehouseImageNotice(null)
  }

  const handleSelectWarehouseRecord = async (recId: string) => {
    setSelectedRecordId(recId)
    setFileError(null)
    setAnalysisError(null)
    setWarehouseImageNotice(null)

    if (!recId) return

    const record = warehouseRecords.find((r) => r.record_id === recId)
    if (!record) return

    // Populate product selection
    const matchingProd = catalog.find((p) => p.sku === record.sku)
    if (matchingProd) {
      setSelectedProductSku(matchingProd.sku)
    } else {
      setSelectedProductSku('__other__')
      setManualItemName(record.product_name)
      setManualItemSku(record.sku)
    }

    // Check physical images
    if (record.images_available && record.available_images.length > 0) {
      // Clear previous blob URLs
      previews.forEach((p) => {
        if (p.isBlob && p.url.startsWith('blob:')) {
          URL.revokeObjectURL(p.url)
        }
      })

      // Fetch sample images as Files
      try {
        const fetchedItems: ImagePreviewItem[] = []
        for (const img of record.available_images) {
          const res = await fetch(img.url)
          const blob = await res.blob()
          const fileObj = new File([blob], img.filename, { type: blob.type || 'image/jpeg' })
          const blobUrl = URL.createObjectURL(blob)
          fetchedItems.push({
            id: `wh-${record.record_id}-${img.filename}`,
            file: fileObj,
            url: blobUrl,
            name: img.filename,
            sizeBytes: blob.size,
            isBlob: true,
          })
        }
        setPreviews(fetchedItems)
      } catch {
        // Direct link fallback
        setPreviews(
          record.available_images.map((img) => ({
            id: `wh-${record.record_id}-${img.filename}`,
            url: img.url,
            name: img.filename,
            sizeBytes: img.size_bytes || 0,
            isBlob: false,
          }))
        )
      }
    } else {
      // Physical captures are unavailable on disk
      setPreviews([])
      setWarehouseImageNotice(
        `Physical capture photos for warehouse record ${record.record_id} (${record.product_name}) are not stored on disk. Please upload an image of the returned item below.`
      )
    }
  }

  const handleAddFiles = (files: FileList | File[]) => {
    if (!isProductSelected) {
      dropdownRef.current?.focus()
      setFileError('Select the returned item first to continue.')
      return
    }

    setFileError(null)
    setAnalysisError(null)
    setWarehouseImageNotice(null)

    const validTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp']
    const newItems: ImagePreviewItem[] = []

    Array.from(files).forEach((file) => {
      const hasValidExt = /\.(jpe?g|png|webp)$/i.test(file.name)
      if (!validTypes.includes(file.type) && !hasValidExt) {
        setFileError(`File "${file.name}" is not a valid JPG or PNG image.`)
        return
      }

      const url = URL.createObjectURL(file)
      newItems.push({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        url,
        name: file.name,
        sizeBytes: file.size,
        isBlob: true,
      })
    })

    if (newItems.length > 0) {
      setPreviews((prev) => [...prev, ...newItems])
    }
  }

  const handleRemovePreview = (id: string) => {
    setPreviews((prev) => {
      const target = prev.find((p) => p.id === id)
      if (target && target.isBlob && target.url.startsWith('blob:')) {
        URL.revokeObjectURL(target.url)
      }
      return prev.filter((p) => p.id !== id)
    })
  }

  const handleClearAllImages = () => {
    previews.forEach((p) => {
      if (p.isBlob && p.url.startsWith('blob:')) {
        URL.revokeObjectURL(p.url)
      }
    })
    setPreviews([])
    setFileError(null)
    setAnalysisError(null)
    setWarehouseImageNotice(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (!isProductSelected) {
      dropdownRef.current?.focus()
      setFileError('Select the returned item first to continue.')
      return
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAddFiles(e.dataTransfer.files)
    }
  }

  const handleStartAnalysis = async () => {
    if (!isProductSelected) {
      dropdownRef.current?.focus()
      setFileError('Select the returned item first to continue.')
      return
    }

    if (previews.length === 0) {
      setFileError('Please upload at least one image of the returned item.')
      return
    }

    setAnalyzing(true)
    setAnalysisError(null)
    startTimer()

    const abortController = new AbortController()
    const timeoutHandle = window.setTimeout(() => {
      abortController.abort()
    }, 60000)

    try {
      // Collect File objects from previews
      const fileList: File[] = []
      for (const p of previews) {
        if (p.file) {
          fileList.push(p.file)
        } else {
          // Fetch from URL if loaded from sample
          const res = await fetch(p.url)
          const blob = await res.blob()
          fileList.push(new File([blob], p.name, { type: blob.type || 'image/jpeg' }))
        }
      }

      // Find record metadata if warehouse record was selected
      const record = warehouseRecords.find((r) => r.record_id === selectedRecordId)

      const resultBundle = await api.inspectReturn(
        {
          files: fileList,
          file: fileList[0] || null,
          sku: activeSku,
          asin: activeAsin || record?.asin,
          title: activeTitle,
          category: activeCategory || record?.category,
          expected_parts: activeExpectedParts.length > 0 ? activeExpectedParts : record?.expected_components,
          unit_id: record?.unit_id,
          order_id: record?.order_id,
          org_id: record?.org_id,
        },
        abortController.signal
      )

      setProgressPercent(100)
      await new Promise((r) => setTimeout(r, 350))
      stopTimer()
      setAnalyzing(false)
      setBundle(resultBundle)
    } catch (err: any) {
      stopTimer()
      setAnalyzing(false)

      let userMsg = 'Analysis could not be completed.'
      const status = err?.status ?? 0
      const detail = (err?.detail || err?.message || '').toLowerCase()

      if (
        status === 0 ||
        detail.includes('unable to connect') ||
        detail.includes('failed to fetch') ||
        detail.includes('network') ||
        detail.includes('connection refused')
      ) {
        userMsg = 'Unable to connect to Returns Manager.'
      } else if (
        status === 429 ||
        detail.includes('quota') ||
        detail.includes('resource_exhausted') ||
        detail.includes('temporarily unavailable')
      ) {
        userMsg = 'Vision analysis is temporarily unavailable. Human review is required.'
      } else if (
        status === 408 ||
        status === 504 ||
        detail.includes('timed out') ||
        detail.includes('timeout') ||
        err?.name === 'AbortError'
      ) {
        userMsg = 'Analysis timed out. Please try again.'
      } else if (
        status === 400 && detail.includes('select the returned item first')
      ) {
        userMsg = 'Select the returned item first to continue.'
      } else if (
        status === 400 ||
        status === 415 ||
        detail.includes('valid jpg or png') ||
        detail.includes('invalid image')
      ) {
        userMsg = 'Please upload a valid JPG or PNG image.'
      } else {
        userMsg = err?.detail || 'Analysis could not be completed.'
      }

      setAnalysisError(userMsg)
    } finally {
      window.clearTimeout(timeoutHandle)
    }
  }

  const handleResetForNewInspection = () => {
    setBundle(null)
    handleClearAllImages()
    setSelectedProductSku('')
    setManualItemName('')
    setManualItemSku('')
    setSelectedRecordId('')
    setWarehouseImageNotice(null)
  }

  const returnsRecord: EvidenceRecord | null = bundle
    ? Object.values(bundle.evidence).find((ev) => ev.stage === 'returns') || null
    : null

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      {/* ------------------------------------------------------------- */}
      {/* HEADER SECTION                                                */}
      {/* ------------------------------------------------------------- */}
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="h-px w-6 bg-teal-700" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-teal-800">
            WAREHOUSE INSPECTION // STAGE 04
          </span>
          <span className="h-px flex-1 bg-stone-300" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-stone-500">
            Automated Vision Audit
          </span>
        </div>
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-baseline">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
            Returns Manager
          </h1>
          <div className="flex items-center gap-2 font-mono text-xs text-stone-600">
            <span className="inline-block h-2 w-2 rounded-full bg-teal-600" />
            <span>Gemini Multimodal Vision</span>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-stone-600">
          Select the returned merchandise, upload inspection photographs, and verify condition against expected catalog specifications.
        </p>
      </header>

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 1: PRODUCT SELECTION & IMAGE UPLOAD                     */}
      {/* ------------------------------------------------------------- */}
      {!bundle && !analyzing && (
        <section aria-labelledby="inspection-setup-title" className="space-y-5">
          <h2 id="inspection-setup-title" className="sr-only">
            Select item and upload inspection images
          </h2>

          {/* 1. PRODUCT SELECTION SECTION */}
          <div className="rounded-2xl border border-stone-300/90 bg-white/95 p-6 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-stone-100 pb-3">
              <div>
                <label
                  htmlFor="returns-product-select"
                  className="font-heading text-base font-bold text-stone-900 block"
                >
                  Select item for return
                </label>
                <p className="text-xs text-stone-500 mt-0.5">
                  Choose the expected catalog item before uploading return photos.
                </p>
              </div>

              {warehouseRecords.length > 0 && (
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-stone-500 text-[11px]">Warehouse record:</span>
                  <select
                    id="warehouse-record-select"
                    value={selectedRecordId}
                    onChange={(e) => handleSelectWarehouseRecord(e.target.value)}
                    className="rounded-md border border-stone-300 bg-stone-50 px-2.5 py-1 text-xs text-stone-800 focus:border-teal-700 focus:outline-none focus:ring-1 focus:ring-teal-700"
                  >
                    <option value="">-- Choose sample capture --</option>
                    {warehouseRecords.map((r) => (
                      <option key={r.record_id} value={r.record_id}>
                        {r.record_id}: {r.display_name} ({r.unit_id})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* PRODUCT DROPDOWN */}
            <div className="space-y-3">
              <select
                id="returns-product-select"
                ref={dropdownRef}
                value={selectedProductSku}
                onChange={(e) => handleProductChange(e.target.value)}
                className="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-sm font-medium text-stone-900 shadow-2xs transition-colors hover:border-teal-700 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/20"
              >
                <option value="">-- Select returned item --</option>
                {catalog.map((item) => (
                  <option key={item.sku} value={item.sku}>
                    {item.display_name} — {item.title} ({item.sku})
                  </option>
                ))}
                <option value="__other__">Other / enter item manually</option>
              </select>

              {/* MANUAL ITEM INPUTS */}
              {isOther && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-stone-200 bg-[#FAF7F2] p-4">
                  <div>
                    <label htmlFor="manual-item-name" className="block font-mono text-[11px] font-bold uppercase tracking-wider text-stone-700">
                      Product Name *
                    </label>
                    <input
                      id="manual-item-name"
                      type="text"
                      value={manualItemName}
                      onChange={(e) => setManualItemName(e.target.value)}
                      placeholder="e.g. Mechanical Gaming Keyboard"
                      className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs text-stone-900 focus:border-teal-700 focus:outline-none focus:ring-1 focus:ring-teal-700"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-item-sku" className="block font-mono text-[11px] font-bold uppercase tracking-wider text-stone-700">
                      SKU (Optional)
                    </label>
                    <input
                      id="manual-item-sku"
                      type="text"
                      value={manualItemSku}
                      onChange={(e) => setManualItemSku(e.target.value)}
                      placeholder="e.g. SKU-KEYBOARD-RGB"
                      className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs text-stone-900 focus:border-teal-700 focus:outline-none focus:ring-1 focus:ring-teal-700"
                    />
                  </div>
                </div>
              )}

              {/* SELECTED ITEM DETAILS CARD */}
              {isProductSelected && (
                <div className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 font-mono text-xs text-teal-950 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-teal-800 shrink-0" aria-hidden="true" />
                      <strong className="text-sm font-semibold">{activeDisplayName}</strong>
                      {activeSku && (
                        <span className="rounded bg-teal-100 px-2 py-0.5 text-[10px] font-bold text-teal-900">
                          {activeSku}
                        </span>
                      )}
                    </div>
                    <div className="text-stone-600 text-[11px]">
                      <span>Category: {activeCategory}</span>
                      {activeAsin && <span> · ASIN: {activeAsin}</span>}
                    </div>
                    {activeExpectedParts.length > 0 && (
                      <div className="text-teal-900 text-[11px]">
                        <strong>Expected Components:</strong> {activeExpectedParts.join(', ')}
                      </div>
                    )}
                  </div>
                  <span className="rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-900 shrink-0 self-start sm:self-center">
                    Authoritative Baseline
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* WAREHOUSE SAMPLE UNAVAILABLE NOTICE */}
          {warehouseImageNotice && (
            <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs font-mono text-amber-950">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
              <span>{warehouseImageNotice}</span>
            </div>
          )}

          {/* 2. IMAGE UPLOAD AREA */}
          <div className="space-y-4">
            {!isProductSelected ? (
              // DISABLED STATE (REQUIREMENT 3)
              <div
                onClick={() => dropdownRef.current?.focus()}
                className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-stone-300 bg-stone-100/70 p-10 text-center transition-colors hover:border-stone-400"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stone-300 bg-white text-stone-400 shadow-2xs">
                  <Lock className="h-6 w-6" aria-hidden="true" />
                </div>
                <h3 className="mt-4 font-heading text-lg font-semibold text-stone-800">
                  Select the returned item first to continue.
                </h3>
                <p className="mt-1 text-sm text-stone-500 max-w-md">
                  Choose the product from the dropdown above to unlock return photo upload and Gemini inspection.
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 font-mono text-xs font-semibold text-stone-700 shadow-2xs">
                  Awaiting product selection
                </span>
              </div>
            ) : (
              // ENABLED UPLOAD BOX
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all ${
                  dragOver
                    ? 'border-teal-700 bg-teal-50/60 ring-4 ring-teal-700/10'
                    : 'border-stone-300/90 bg-white/80 hover:border-teal-700 hover:bg-stone-50/90'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/jpg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleAddFiles(e.target.files)
                    }
                  }}
                />

                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-stone-200 bg-[#FAF7F2] text-stone-600 shadow-sm transition-transform group-hover:scale-105 group-hover:text-teal-800">
                  <Upload className="h-6 w-6" aria-hidden="true" />
                </div>

                <h3 className="mt-3 font-heading text-lg font-semibold text-stone-900">
                  Drop return photos here
                </h3>
                <p className="mt-0.5 text-sm text-stone-600">
                  or click to upload one or multiple images
                </p>
                <span className="mt-2.5 rounded-full border border-stone-200 bg-stone-100/80 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-stone-600">
                  JPG, PNG, WEBP · Multiple files supported
                </span>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                  className="mt-5 inline-flex items-center gap-2 rounded-md border border-stone-900 bg-stone-950 px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white shadow-sm transition-colors hover:border-teal-800 hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
                >
                  <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                  Upload images
                </button>
              </div>
            )}
          </div>

          {/* 3. IMAGE PREVIEWS GRID WITH REMOVE CAPABILITY */}
          {previews.length > 0 && (
            <div className="rounded-2xl border border-stone-300/90 bg-white/95 p-6 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-stone-100 pb-3">
                <div>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-teal-800">
                    Visual Evidence Loaded
                  </span>
                  <h3 className="font-heading text-lg font-semibold text-stone-900">
                    Inspection Photos ({previews.length})
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs font-medium text-stone-700 hover:bg-stone-50"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add more photos
                  </button>
                  <button
                    type="button"
                    onClick={handleClearAllImages}
                    className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 font-mono text-xs font-medium text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Clear all
                  </button>
                </div>
              </div>

              {/* THUMBNAIL GRID */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {previews.map((item, idx) => (
                  <div
                    key={item.id}
                    className="group relative flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-stone-50 shadow-2xs"
                  >
                    <div className="relative aspect-video w-full overflow-hidden bg-stone-100 flex items-center justify-center">
                      <img
                        src={item.url}
                        alt={`Return capture ${idx + 1}`}
                        className="h-full w-full object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemovePreview(item.id)}
                        title="Remove photo"
                        className="absolute top-2 right-2 rounded-full bg-black/70 p-1.5 text-white transition-opacity hover:bg-rose-600 focus-visible:outline-none"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[9px] text-white">
                        Photo {idx + 1}
                      </span>
                    </div>
                    <div className="p-2.5 font-mono text-[11px] text-stone-700 flex items-center justify-between">
                      <span className="truncate max-w-[160px] font-medium">{item.name}</span>
                      {item.sizeBytes > 0 && (
                        <span className="text-[10px] text-stone-400">
                          {(item.sizeBytes / 1024 / 1024).toFixed(2)} MB
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* ACTION ROW: ANALYZE RETURN BUTTON */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-stone-100">
                <div className="font-mono text-xs text-stone-600">
                  Ready to audit: <strong>{activeDisplayName}</strong> with {previews.length} photo{previews.length > 1 ? 's' : ''}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleStartAnalysis}
                    disabled={analyzing || previews.length === 0}
                    className="inline-flex items-center gap-2 rounded-md border border-stone-900 bg-stone-950 px-6 py-3 font-mono text-xs font-bold uppercase tracking-wider text-white shadow-md transition-all hover:border-teal-800 hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-wait disabled:opacity-60"
                  >
                    <Sparkles className="h-4 w-4 text-teal-400" aria-hidden="true" />
                    Analyze return
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ERROR ALERTS */}
          {fileError && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
              <span>{fileError}</span>
            </div>
          )}

          {analysisError && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-950 shadow-sm">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden="true" />
              <div className="flex-1">
                <span className="font-semibold">{analysisError}</span>
                <div className="mt-2.5">
                  <button
                    type="button"
                    onClick={handleStartAnalysis}
                    className="font-mono text-xs font-bold uppercase underline underline-offset-4 hover:text-rose-950"
                  >
                    Retry Analysis
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 2: ANALYZING RETURN WITH LIVE ELAPSED TIMER            */}
      {/* ------------------------------------------------------------- */}
      {analyzing && (
        <section aria-live="polite" className="rounded-2xl border border-teal-800/30 bg-white/95 p-8 text-center shadow-md">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-teal-200 bg-teal-50 text-teal-800 shadow-xs">
            <Loader2 className="h-7 w-7 animate-spin spinner-spin text-teal-700" aria-hidden="true" />
          </div>

          <h2 className="mt-4 font-heading text-2xl font-bold tracking-tight text-stone-900">
            ANALYZING RETURN...
          </h2>
          <p className="mt-1 font-mono text-xs font-semibold uppercase tracking-wider text-teal-800">
            Inspecting {activeDisplayName} ({activeSku})
          </p>

          {/* REAL CLIENT ELAPSED TIMER (MM:SS) */}
          <div className="my-5 flex items-center justify-center">
            <div className="rounded-xl border border-stone-200 bg-[#FAF7F2] px-6 py-2.5 font-mono text-3xl font-bold tracking-widest text-stone-900 shadow-inner">
              {formatTimer(elapsedSeconds)}
            </div>
          </div>

          {/* DYNAMIC MOVING LOADING BAR */}
          <div className="mx-auto max-w-lg space-y-2">
            <div className="flex items-center justify-between font-mono text-[11px] font-bold uppercase tracking-wider">
              <span className="text-stone-500">Inspection Audit Progress</span>
              <span className="text-teal-800">{progressPercent}%</span>
            </div>

            <div className="relative h-4 w-full overflow-hidden rounded-full border border-stone-200 bg-stone-100 p-0.5 shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-600 via-teal-500 to-emerald-400 progress-animated-stripes shadow-sm transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-stone-500">
              <span className="truncate font-mono">
                {progressPercent < 30
                  ? 'Ingesting visual capture & validating clarity...'
                  : progressPercent < 60
                  ? 'Gemini Multimodal feature extraction active...'
                  : progressPercent < 80
                  ? 'Evaluating completeness & Amazon condition...'
                  : progressPercent < 98
                  ? 'Synthesizing warehouse disposition outcome...'
                  : 'Finalizing audit evidence record...'}
              </span>
              <span className="font-mono text-stone-400">{elapsedSeconds}s elapsed</span>
            </div>
          </div>

          {/* REAL-TIME AUDIT CRITERIA STATUS */}
          <div className="mx-auto mt-6 max-w-lg rounded-xl border border-stone-200 bg-[#FAF7F2] p-4 text-left">
            <span className="block font-mono text-[10px] font-bold uppercase tracking-wider text-stone-500">
              Active Vision Audit Checks:
            </span>
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs font-medium">
              {[
                { name: 'Product Identity', threshold: 25 },
                { name: 'Completeness', threshold: 50 },
                { name: 'Physical Condition', threshold: 68 },
                { name: 'Packaging & Seals', threshold: 78 },
                { name: 'Damage & Defects', threshold: 88 },
                { name: 'Warehouse Disposition', threshold: 96 },
              ].map((item) => {
                const isDone = progressPercent >= item.threshold
                const isCurrent = !isDone && progressPercent >= item.threshold - 20
                return (
                  <li
                    key={item.name}
                    className={`flex items-center gap-2 rounded-lg p-1.5 transition-colors ${
                      isDone
                        ? 'text-teal-950 font-semibold'
                        : isCurrent
                        ? 'text-teal-800 font-medium bg-teal-50/80'
                        : 'text-stone-400'
                    }`}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden="true" />
                    ) : isCurrent ? (
                      <span className="h-2 w-2 rounded-full bg-teal-600 animate-ping shrink-0" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-stone-300 shrink-0" />
                    )}
                    <span className="truncate">{item.name}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SCREEN 3: WORKFLOW REPORT (REUSABLE HIERARCHY COMPONENT)      */}
      {/* ------------------------------------------------------------- */}
      {bundle && returnsRecord && !analyzing && (
        <ReturnsReportView
          bundle={bundle}
          returnsRecord={returnsRecord}
          onReset={handleResetForNewInspection}
          onWorkflowUpdated={(updatedWf) => {
            setBundle((prev) => (prev ? { ...prev, workflow: updatedWf } : null))
            if (onWorkflowComplete) {
              onWorkflowComplete(updatedWf)
            }
          }}
        />
      )}
    </div>
  )
}

export default ReturnsInspector
