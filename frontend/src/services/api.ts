import type {
  CatalogProduct,
  EvidenceBundle,
  HealthResponse,
  WarehouseReturnRecord,
  WorkflowState,
} from '@/types/workflow'

// Configurable API base URL, defaulting to Vite dev proxy /api or directly http://localhost:8100
const RAW_BASE_URL = import.meta.env.VITE_API_BASE_URL
export const API_BASE_URL = RAW_BASE_URL ? RAW_BASE_URL.replace(/\/+$/, '') : '/api'

export function resolveApiUrl(pathOrUrl: string): string {
  if (!pathOrUrl) return ''
  if (
    pathOrUrl.startsWith('http://') ||
    pathOrUrl.startsWith('https://') ||
    pathOrUrl.startsWith('blob:') ||
    pathOrUrl.startsWith('data:')
  ) {
    return pathOrUrl
  }
  // Strip redundant leading '/api' if present since API_BASE_URL handles the root
  const cleanPath = pathOrUrl.replace(/^\/?api\/?/, '/').replace(/^\/?/, '/')
  return `${API_BASE_URL}${cleanPath}`
}

export function dataUrlToFile(dataUrl: string, filename: string): File {
  if (dataUrl.startsWith('data:image/svg+xml')) {
    const rawSvg = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml(?:;utf8)?,/, ''))
    return new File([rawSvg], filename, { type: 'image/svg+xml' })
  }
  try {
    const arr = dataUrl.split(',')
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png'
    const bstr = atob(arr[1])
    let n = bstr.length
    const u8arr = new Uint8Array(n)
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n)
    }
    return new File([u8arr], filename, { type: mime })
  } catch {
    return new File([dataUrl], filename, { type: 'text/plain' })
  }
}

export async function resilientFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  const url = `${API_BASE_URL}${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`
  try {
    return await fetch(url, init)
  } catch (err: any) {
    if (import.meta.env.DEV && API_BASE_URL === '/api') {
      try {
        const directUrl = `http://127.0.0.1:8100${urlPath.startsWith('/') ? urlPath : `/${urlPath}`}`
        return await fetch(directUrl, init)
      } catch {
        // preserve original error
      }
    }
    throw err
  }
}

export class ApiError extends Error {
  status: number
  detail: string

  constructor(status: number, message: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail || message
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') {
        detail = data.detail
      } else if (data.detail && typeof data.detail === 'object') {
        detail = JSON.stringify(data.detail)
      } else if (data.message) {
        detail = data.message
      }
    } catch {
      const text = await res.text()
      if (text) detail = text
    }
    throw new ApiError(res.status, `Request failed (${res.status}): ${detail}`, detail)
  }
  return res.json()
}

export interface CreateWorkflowParams {
  org_id: string
  unit_id: string
  route?: string
  returned?: boolean
}

export interface OverrideParams {
  record_id: string
  new_verdict: 'PASS' | 'FAIL' | 'UNCERTAIN'
  actor: string
  reason: string
  new_outcome?: string
}

export const api = {
  getBaseUrl(): string {
    return API_BASE_URL
  },

  async getHealth(): Promise<HealthResponse> {
    try {
      const res = await resilientFetch('/health')
      return await handleResponse<HealthResponse>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Cannot reach orchestrator at ${API_BASE_URL}/health. Make sure uvicorn is running.`, err.message)
    }
  },

  async runWorkflow(params: CreateWorkflowParams): Promise<WorkflowState> {
    const payload: Record<string, any> = {
      org_id: params.org_id.trim(),
      unit_id: params.unit_id.trim(),
    }
    if (params.route && params.route !== 'auto') {
      payload.route = params.route
    }
    if (typeof params.returned === 'boolean') {
      payload.returned = params.returned
    }

    try {
      const res = await resilientFetch('/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return await handleResponse<WorkflowState>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to submit workflow to ${API_BASE_URL}/workflows. Check backend availability.`, err.message)
    }
  },

  async getWorkflow(workflowId: string): Promise<WorkflowState> {
    try {
      const res = await resilientFetch(`/workflows/${encodeURIComponent(workflowId)}`)
      return await handleResponse<WorkflowState>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to fetch workflow ${workflowId}`, err.message)
    }
  },

  async getWorkflowEvidence(workflowId: string): Promise<EvidenceBundle> {
    try {
      const res = await resilientFetch(`/workflows/${encodeURIComponent(workflowId)}/evidence`)
      return await handleResponse<EvidenceBundle>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to fetch evidence bundle for ${workflowId}`, err.message)
    }
  },

  async resumeWorkflow(workflowId: string): Promise<WorkflowState> {
    try {
      const res = await resilientFetch(`/workflows/${encodeURIComponent(workflowId)}/resume`, {
        method: 'POST',
      })
      return await handleResponse<WorkflowState>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to resume workflow ${workflowId}`, err.message)
    }
  },

  async submitOverride(workflowId: string, params: OverrideParams): Promise<WorkflowState> {
    try {
      const res = await resilientFetch(`/workflows/${encodeURIComponent(workflowId)}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      return await handleResponse<WorkflowState>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to apply override to ${workflowId}`, err.message)
    }
  },

  async inspectReturnImage(
    file?: File | null,
    signal?: AbortSignal,
    productMeta?: {
      sku?: string
      asin?: string
      title?: string
      category?: string
      expected_parts?: string[]
      unit_id?: string
      order_id?: string
      org_id?: string
    }
  ): Promise<EvidenceBundle> {
    return this.inspectReturn({ file, ...productMeta }, signal)
  },

  async inspectReturn(
    params: {
      files?: File[]
      file?: File | null
      sku?: string
      asin?: string
      title?: string
      category?: string
      expected_parts?: string[]
      unit_id?: string
      order_id?: string
      org_id?: string
    },
    signal?: AbortSignal
  ): Promise<EvidenceBundle> {
    try {
      const formData = new FormData()
      if (params.file) {
        formData.append('file', params.file)
      }
      if (params.files && params.files.length > 0) {
        params.files.forEach((f) => formData.append('files', f))
      }
      if (params.sku) formData.append('sku', params.sku)
      if (params.asin) formData.append('asin', params.asin)
      if (params.title) formData.append('title', params.title)
      if (params.category) formData.append('category', params.category)
      if (params.expected_parts && params.expected_parts.length > 0) {
        formData.append('expected_parts', JSON.stringify(params.expected_parts))
      }
      if (params.unit_id) formData.append('unit_id', params.unit_id)
      if (params.order_id) formData.append('order_id', params.order_id)
      if (params.org_id) formData.append('org_id', params.org_id)

      const res = await resilientFetch('/returns/inspect', {
        method: 'POST',
        body: formData,
        signal,
      })
      return await handleResponse<EvidenceBundle>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      if (err.name === 'AbortError') {
        throw new ApiError(408, 'Analysis timed out. Please try again.', 'timeout')
      }
      throw new ApiError(0, 'Unable to connect to Returns Manager.', err.message)
    }
  },

  async getCatalog(): Promise<CatalogProduct[]> {
    try {
      const res = await resilientFetch('/returns/catalog')
      return await handleResponse<CatalogProduct[]>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to load product catalogue`, err.message)
    }
  },

  async getWarehouseRecords(): Promise<WarehouseReturnRecord[]> {
    try {
      const res = await resilientFetch('/returns/warehouse-records')
      const records = await handleResponse<WarehouseReturnRecord[]>(res)
      return records.map((rec) => ({
        ...rec,
        available_images: (rec.available_images || []).map((img) => ({
          ...img,
          url: resolveApiUrl(img.url),
        })),
      }))
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to load warehouse returns records`, err.message)
    }
  },

  async getReturnSamples(): Promise<Array<{ filename: string; size_bytes: number; url: string }>> {
    try {
      const res = await resilientFetch('/returns/samples')
      const items = await handleResponse<Array<{ filename: string; size_bytes: number; url: string }>>(res)
      return items.map((item) => ({
        ...item,
        url: resolveApiUrl(item.url),
      }))
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, `Failed to load sample return images`, err.message)
    }
  },

  async inspectPackImage(
    params: {
      file?: File | null
      files?: File[]
      unit_id?: string
      sku?: string
      org_id?: string
    },
    signal?: AbortSignal
  ): Promise<EvidenceBundle> {
    try {
      const formData = new FormData()
      if (params.file) {
        formData.append('file', params.file)
      }
      if (params.files && params.files.length > 0) {
        params.files.forEach((f) => formData.append('files', f))
      }
      if (params.sku) formData.append('sku', params.sku)
      if (params.unit_id) formData.append('unit_id', params.unit_id)
      if (params.org_id) formData.append('org_id', params.org_id)

      const res = await resilientFetch('/pack/inspect', {
        method: 'POST',
        body: formData,
        signal,
      })
      return await handleResponse<EvidenceBundle>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      if (err.name === 'AbortError') {
        throw new ApiError(408, 'Analysis timed out. Please try again.', 'timeout')
      }
      throw new ApiError(0, 'Unable to connect to Pack Manager.', err.message)
    }
  },

  async inspectWorkflowWithImages(
    params: {
      file?: File | null
      files?: File[]
      unit_id: string
      org_id: string
      route?: string
      returned?: boolean | string
      stage_tags?: Record<string, string>
    },
    signal?: AbortSignal
  ): Promise<EvidenceBundle> {
    try {
      const formData = new FormData()
      if (params.file) {
        formData.append('file', params.file)
      }
      if (params.files && params.files.length > 0) {
        params.files.forEach((f) => formData.append('files', f))
      }
      formData.append('unit_id', params.unit_id)
      formData.append('org_id', params.org_id)
      if (params.route && params.route !== 'auto') {
        formData.append('route', params.route)
      }
      if (params.returned !== undefined && params.returned !== 'auto') {
        formData.append('returned', String(params.returned))
      }
      if (params.stage_tags) {
        formData.append('stage_tags', JSON.stringify(params.stage_tags))
      }

      const res = await resilientFetch('/workflows/inspect', {
        method: 'POST',
        body: formData,
        signal,
      })
      return await handleResponse<EvidenceBundle>(res)
    } catch (err: any) {
      if (err instanceof ApiError) throw err
      if (err.name === 'AbortError') {
        throw new ApiError(408, 'Pipeline analysis timed out. Please try again.', 'timeout')
      }
      throw new ApiError(0, 'Unable to connect to Orchestrator Pipeline.', err.message)
    }
  },
}

