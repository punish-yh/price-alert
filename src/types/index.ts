export type MonitorStatus = 'active' | 'triggered' | 'deleted'
export type Direction = 'above' | 'below'
export type MonitorType = 'price' | 'ema_cross'

export interface Monitor {
  id: number
  symbol: string
  type: MonitorType
  direction: Direction
  target_price: number
  ema_period: number | null
  interval: string | null
  note: string
  status: MonitorStatus
  created_at: string
  updated_at: string
  triggered_at: string | null
  trigger_price: number | null
  webhook_ok: number | null
  webhook_error: string | null
}

export interface PricesResponse {
  prices: Record<string, number>
  updated_at: string | null
  poller_ok: boolean | null
  poller_error: string
  server_time: number
}

export interface TvForward {
  id: number
  received_at: string
  source_ip: string
  content_type: string
  raw_body: string
  summary: string
  forward_ok: number | null
  forward_error: string | null
}

export interface SecTask {
  id: number
  tickers: string[]
  window_start: string
  window_end: string
  note: string
  status: 'active' | 'deleted'
  created_at: string
  updated_at: string
}

export interface SecHit {
  id: number
  task_id: number
  ticker: string
  form: string
  filing_date: string
  accession: string
  primary_doc: string
  url: string
  baseline: number
  detected_at: string
}

export interface SecStatus {
  ok: boolean | null
  error: string
  last_poll: string | null
  in_window: boolean
  active_tasks: number
  watching: string[]
}
