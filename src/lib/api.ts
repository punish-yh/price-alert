import type {
  Monitor,
  PricesResponse,
  SecHitsResponse,
  SecTask,
  TvForward,
} from '@/types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.headers || {}),
    },
  })
  if (res.status === 401 && !path.endsWith('/login')) {
    window.dispatchEvent(new Event('auth:expired'))
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string') msg = data.detail
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return res.json()
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: boolean; username: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/me'),
  monitors: () => request<{ items: Monitor[]; unread_triggered: number }>('/api/monitors'),
  markPriceTriggeredRead: () =>
    request<{ ok: boolean; unread_triggered: number }>('/api/monitors/read-triggered', {
      method: 'POST',
    }),
  createMonitor: (body: {
    symbol: string
    direction: 'above' | 'below'
    target_price: number
    note: string
  }) => request<Monitor>('/api/monitors', { method: 'POST', body: JSON.stringify(body) }),
  createEmaMonitor: (body: {
    symbol: string
    ema_period: number
    interval: string
    note: string
  }) =>
    request<Monitor>('/api/monitors', {
      method: 'POST',
      body: JSON.stringify({ ...body, type: 'ema_cross' }),
    }),
  updateMonitor: (
    id: number,
    body: {
      symbol: string
      direction: 'above' | 'below'
      target_price: number
      note: string
    }
  ) => request<Monitor>(`/api/monitors/${id}/update`, { method: 'POST', body: JSON.stringify(body) }),
  updateEmaMonitor: (
    id: number,
    body: { symbol: string; ema_period: number; interval: string; note: string }
  ) =>
    request<Monitor>(`/api/monitors/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ ...body, type: 'ema_cross' }),
    }),
  deleteMonitor: (id: number) =>
    request<{ ok: boolean; result: 'deleted' | 'purged' }>(`/api/monitors/${id}/delete`, {
      method: 'POST',
    }),
  restoreMonitor: (id: number) =>
    request<{ ok: boolean; monitor: Monitor }>(`/api/monitors/${id}/restore`, { method: 'POST' }),
  prices: () => request<PricesResponse>('/api/prices'),
  symbols: () => request<{ symbols: string[] }>('/api/symbols'),
  tvConfig: () => request<{ webhook_path: string }>('/api/tv/config'),
  tvForwards: () => request<{ items: TvForward[] }>('/api/tv/forwards'),
  deleteTvForward: (id: number) =>
    request<{ ok: boolean }>(`/api/tv/forwards/${id}/delete`, { method: 'POST' }),
  secTasks: () => request<{ items: SecTask[] }>('/api/sec/tasks'),
  createSecTask: (body: {
    tickers: string[]
    forms: string[]
    watch_date: string
    window_start: string
    window_end: string
    note: string
  }) => request<SecTask>('/api/sec/tasks', { method: 'POST', body: JSON.stringify(body) }),
  deleteSecTask: (id: number) =>
    request<{ ok: boolean }>(`/api/sec/tasks/${id}/delete`, { method: 'POST' }),
  updateSecTask: (
    id: number,
    body: {
      tickers: string[]
      forms: string[]
      watch_date: string
      window_start: string
      window_end: string
      note: string
    }
  ) => request<SecTask>(`/api/sec/tasks/${id}/update`, { method: 'POST', body: JSON.stringify(body) }),
  secHits: () => request<SecHitsResponse>('/api/sec/hits'),
  markSecHitRead: (id: number) =>
    request<{ ok: boolean; unread: number }>(`/api/sec/hits/${id}/read`, { method: 'POST' }),
  markAllSecHitsRead: () =>
    request<{ ok: boolean; marked: number; unread: number }>('/api/sec/hits/read-all', {
      method: 'POST',
    }),
}

/** 价格显示：小数值保留更多有效位 */
export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '—'
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return p.toLocaleString('en-US', { maximumFractionDigits: 8 })
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}
