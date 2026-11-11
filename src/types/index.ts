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

export type SecTaskState = 'pending' | 'listening' | 'acquired' | 'failed'

export interface SecTask {
  id: number
  tickers: string[]
  watch_date: string
  window_start: string
  window_end: string
  note: string
  /** 数据库状态（active/deleted） */
  status: 'active' | 'deleted'
  /** 实时推导的监听状态（未启动/监听中/已获取/监听失败） */
  task_status: SecTaskState
  hit_count: number
  /** 已捕获到财报的标的（全部命中后任务才算「已获取」） */
  hit_tickers: string[]
  /** 监听类型：仅 8-K（Item 2.02 业绩公告） */
  forms: string[]
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
  /** 已阅时间；null / 缺省表示未读 */
  read_at: string | null
}

export interface SecHitsResponse {
  items: SecHit[]
  status: SecStatus
  /** 未读的新财报条数（不含存量记录），用于侧边栏角标 */
  unread: number
}

export interface SecStatus {
  ok: boolean | null
  error: string
  last_poll: string | null
  in_window: boolean
  active_tasks: number
  watching: string[]
  poll_interval: number
}

// ---------------- 相关度计算（vs BTC） ----------------

export type CorrPriceSource = 'close' | 'oc2' | 'typical'
export type CorrInterval = '1h' | '4h' | '1d'

export interface CorrThresholds {
  /** 脱钩阈值：|r| ≤ 该值告警；null = 关闭 */
  decorr: number | null
  /** 突变阈值：|r − 上一根 r| ≥ 该值告警；null = 关闭 */
  shift: number | null
}

export interface CorrState {
  interval: string
  last_open_time: number
  last_r: number | null
  decorr_active: number
  last_shift_open: number
}

export interface CorrMonitor {
  id: number
  symbol: string
  price_source: CorrPriceSource
  notify_webhook: number
  thresholds: Partial<Record<CorrInterval, CorrThresholds>>
  status: 'active' | 'deleted'
  created_at: string
  updated_at: string
  /** 每周期最新相关性点 */
  latest: Partial<Record<CorrInterval, { open_time: number; r: number }>>
  states: Partial<Record<CorrInterval, CorrState>>
}

export interface CorrPollerStatus {
  ok: boolean | null
  error: string
  last_poll: string | null
  active: number
}

export interface CorrAlert {
  id: number
  monitor_id: number
  symbol: string
  interval: CorrInterval
  kind: 'decorr' | 'shift'
  r: number
  prev_r: number | null
  threshold: number
  open_time: number
  webhook_ok: number | null
  webhook_error: string
  read_at: string | null
  created_at: string
}

export interface CorrHistoryPoint {
  open_time: number
  r: number
}

// ---------------- BTC 背离监控 ----------------

export type DivInterval = '1h' | '4h' | '1d'
export type DivKind = 'volume' | 'rsi' | 'obv' | 'macd' | 'macd_area'
export type DivDirection = 'top' | 'bottom'

export interface DivCandle {
  open_time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 价格类背离详情（volume/rsi/obv/macd） */
export interface DivPriceDetail {
  p1_time: number
  p1_price: number
  p2_time: number
  p2_price: number
  v1: number
  v2: number
}

/** MACD 面积背离详情 */
export interface DivAreaDetail {
  a1_start: number
  a1_end: number
  a2_start: number
  a2_end: number
  p1: number
  p2: number
  area1: number
  area2: number
}

export type DivDetail = DivPriceDetail & DivAreaDetail & {
  /** 确认背离的右侧第 2 根收盘 K 线开盘时间；候选背离没有该字段 */
  confirmed_at?: number
}

export type DivHistorySignal = DivDetail & {
  direction: DivDirection
  kind: DivKind
  confirmed_at: number
}

export interface DivOverviewInterval {
  updated_at: string
  candles: DivCandle[]
  indicators: {
    rsi: (number | null)[]
    obv: number[]
    dif: (number | null)[]
    dea: (number | null)[]
    hist: (number | null)[]
    volume: number[]
  }
  /** 旧实时逻辑：每 5 分钟计算，包含正在走的 K 线，仅用于观察和画图 */
  candidates: {
    top: Partial<Record<DivKind, DivDetail>>
    bottom: Partial<Record<DivKind, DivDetail>>
  }
  /** 当前已收盘 K 线刚确认的背离，只有这一类可以触发告警 */
  divergences: {
    top: Partial<Record<DivKind, DivDetail>>
    bottom: Partial<Record<DivKind, DivDetail>>
  }
  /** 最近 365 根展示范围内及预热期识别出的历史确认信号，前端按可见范围过滤 */
  history: DivHistorySignal[]
}

export interface DivRule {
  id: number
  name: string
  kinds: DivKind[]
  min_count: number
  intervals: DivInterval[]
  direction: 'both' | DivDirection
  notify_webhook: boolean
  enabled: boolean
}

export interface DivAlert {
  id: number
  symbol: string
  interval: DivInterval
  direction: DivDirection
  kinds: DivKind[]
  details: Record<string, DivDetail>
  min_count: number
  rule_name: string
  webhook_ok: number | null
  webhook_error: string
  read_at: string | null
  created_at: string
}
