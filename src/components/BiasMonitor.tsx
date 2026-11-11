import { useEffect, useRef, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BellRing, Loader2, Save } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { BiasAlert, BiasInterval, BiasOverviewInterval, BiasSignal } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

const INTERVALS: BiasInterval[] = ['15m', '1h', '4h']
const UP = '#10b981'
const DOWN = '#ef4444'

function fmtFull(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function fmtX(ms: number, interval: BiasInterval) {
  const d = new Date(ms)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (interval === '4h') return md
  return `${md} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtNum(v: number) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toPrecision(3)
}

function Candle(props: {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: { open: number; close: number; high: number; low: number }
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props
  if (!payload || payload.high === payload.low || height <= 0) return <g />
  const { open, close, high, low } = payload
  const yy = (v: number) => y + ((high - v) / (high - low)) * height
  const color = close >= open ? UP : DOWN
  const cx = x + width / 2
  const bw = Math.max(2, Math.min(width * 0.65, 10))
  const top = yy(Math.max(open, close))
  const bottom = yy(Math.min(open, close))
  return (
    <g>
      <line x1={cx} x2={cx} y1={yy(high)} y2={yy(low)} stroke={color} strokeWidth={1} />
      <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(1, bottom - top)} fill={color} />
    </g>
  )
}

function PriceTooltip({ active, payload }: { active?: boolean; payload?: { payload: Record<string, number> }[] }) {
  if (!active || !payload?.length) return null
  const c = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{fmtFull(c.open_time)}</p>
      <p className="font-mono tabular-nums">开 {fmtNum(c.open)} / 高 {fmtNum(c.high)} / 低 {fmtNum(c.low)} / 收 {fmtNum(c.close)}</p>
      <p className="font-mono text-muted-foreground">MA20 {c.ma20 == null ? '—' : fmtNum(c.ma20)}</p>
    </div>
  )
}

function signalColor(signal: BiasSignal) {
  if (signal.strength === 'extreme') return signal.direction === 'negative' ? '#059669' : '#dc2626'
  return signal.direction === 'negative' ? '#34d399' : '#f87171'
}

function signalName(signal: BiasSignal) {
  return `${signal.strength === 'extreme' ? '强' : '放量'}${signal.direction === 'negative' ? '负乖离' : '正乖离'}`
}

function BiasCharts({ overview, interval, triggerPrice }: { overview: BiasOverviewInterval; interval: BiasInterval; triggerPrice?: number }) {
  const total = overview.candles.length
  const [visibleCount, setVisibleCount] = useState(total)
  const [endOffset, setEndOffset] = useState(0)
  const zoomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setVisibleCount(total)
    setEndOffset(0)
  }, [interval, total])

  useEffect(() => {
    const node = zoomRef.current
    if (!node) return
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      const factor = event.deltaY < 0 ? 0.8 : 1.25
      setVisibleCount((current) => {
        const next = Math.max(Math.min(40, total), Math.min(total, Math.round(current * factor)))
        setEndOffset((offset) => Math.min(offset, total - next))
        return next
      })
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [total])

  const allRows = overview.candles.map((c, i) => ({
    ...c,
    ma20: overview.indicators.ma20[i],
    bias: overview.indicators.bias[i],
    volume_ratio: overview.indicators.volume_ratio[i],
    rsi: overview.indicators.rsi[i],
  }))
  const count = Math.min(visibleCount, total)
  const end = total - endOffset
  const rows = allRows.slice(Math.max(0, end - count), end)
  const visibleStart = rows[0]?.open_time ?? 0
  const visibleSignals = overview.signals.filter((s) => s.open_time >= visibleStart && s.open_time <= (rows.at(-1)?.open_time ?? 0))
  const threshold = overview.settings.extreme_bias

  function zoom(factor: number) {
    setVisibleCount((current) => {
      const next = Math.max(Math.min(40, total), Math.min(total, Math.round(current * factor)))
      setEndOffset((offset) => Math.min(offset, total - next))
      return next
    })
  }

  function focusSignal(signal: BiasSignal) {
    const index = overview.candles.findIndex((c) => c.open_time === signal.open_time)
    if (index < 0) return
    const focusCount = Math.min(40, total)
    const start = Math.max(0, Math.min(total - focusCount, index - Math.floor(focusCount / 2)))
    setVisibleCount(focusCount)
    setEndOffset(total - start - focusCount)
  }

  const xAxis = (hide: boolean) => (
    <XAxis
      dataKey="open_time"
      type="number"
      domain={['dataMin', 'dataMax']}
      tickFormatter={(ms) => fmtX(ms, interval)}
      tick={hide ? false : { fontSize: 11, fill: '#71717a' }}
      minTickGap={48}
      axisLine={{ stroke: '#e4e4e7' }}
      tickLine={false}
      height={hide ? 0 : 22}
    />
  )

  return (
    <div className="space-y-4">
      <div ref={zoomRef} className="space-y-2" style={{ overscrollBehavior: 'contain' }}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
          <span>显示 {rows.length} / {total} 根<span className="hidden sm:inline"> · 滚轮缩放，点击下方信号可定位</span></span>
          <div className="flex items-center gap-3">
            <button type="button" className="text-sky-600 disabled:opacity-40" disabled={rows.length <= 40} onClick={() => zoom(0.8)}>放大</button>
            <button type="button" className="text-sky-600 disabled:opacity-40" disabled={rows.length >= total} onClick={() => zoom(1.25)}>缩小</button>
            {(endOffset > 0 || rows.length < total) && (
              <button type="button" className="text-sky-600" onClick={() => { setVisibleCount(total); setEndOffset(0) }}>恢复最近 {total} 根</button>
            )}
          </div>
        </div>

        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 16, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              {xAxis(false)}
              <YAxis domain={['auto', 'auto']} orientation="right" tick={{ fontSize: 11, fill: '#71717a' }} tickFormatter={fmtNum} axisLine={false} tickLine={false} width={58} />
              <Tooltip content={<PriceTooltip />} />
              <Bar dataKey={(r: { low: number; high: number }) => [r.low, r.high]} shape={<Candle />} isAnimationActive={false} />
              <Line type="monotone" dataKey="ma20" name="MA20" stroke="#0284c7" strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
              {triggerPrice !== undefined && (
                <ReferenceLine y={triggerPrice} stroke="#dc2626" strokeDasharray="5 4" label={{ value: `触发价 ${fmtNum(triggerPrice)}`, position: 'insideTopLeft', fontSize: 10, fill: '#dc2626' }} />
              )}
              {visibleSignals.map((s) => (
                <ReferenceDot
                  key={`price-${s.open_time}`}
                  x={s.open_time}
                  y={s.direction === 'negative' ? s.low : s.high}
                  r={s.strength === 'extreme' ? 5 : 4}
                  fill={signalColor(s)}
                  stroke="#fff"
                  strokeWidth={1}
                  label={{ value: signalName(s), position: s.direction === 'negative' ? 'bottom' : 'top', fontSize: 9, fill: signalColor(s) }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div>
          <p className="px-1 text-[11px] text-muted-foreground">BIAS20（%） · 强信号参考线 ±{threshold}%</p>
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                {xAxis(true)}
                <YAxis domain={['auto', 'auto']} orientation="right" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} width={58} />
                <Tooltip labelFormatter={(ms) => fmtFull(Number(ms))} formatter={(v) => [`${Number(v).toFixed(3)}%`, 'BIAS20']} contentStyle={{ fontSize: 12 }} />
                <ReferenceLine y={0} stroke="#a1a1aa" />
                <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="4 4" />
                <ReferenceLine y={-threshold} stroke="#f59e0b" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="bias" stroke="#8b5cf6" strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
                {visibleSignals.map((s) => <ReferenceDot key={`bias-${s.open_time}`} x={s.open_time} y={s.bias} r={3.5} fill={signalColor(s)} stroke="none" />)}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <p className="px-1 text-[11px] text-muted-foreground">成交量 / 前 20 根均量 · {overview.settings.volume_spike} 倍为异常参考</p>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                {xAxis(true)}
                <YAxis domain={[0, 'auto']} orientation="right" tick={{ fontSize: 10, fill: '#71717a' }} axisLine={false} tickLine={false} width={58} />
                <Tooltip labelFormatter={(ms) => fmtFull(Number(ms))} formatter={(v) => [`${Number(v).toFixed(2)}×`, '量比']} contentStyle={{ fontSize: 12 }} />
                <ReferenceLine y={overview.settings.volume_spike} stroke="#f59e0b" strokeDasharray="4 4" />
                <Bar dataKey="volume_ratio" isAnimationActive={false}>
                  {rows.map((r) => <Cell key={r.open_time} fill={(r.volume_ratio ?? 0) >= overview.settings.volume_spike ? '#f59e0b' : '#94a3b8'} fillOpacity={0.75} />)}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <p className="px-1 text-[11px] text-muted-foreground">RSI14 · 30 / 50 / 70</p>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                {xAxis(true)}
                <YAxis domain={[0, 100]} orientation="right" tick={{ fontSize: 10, fill: '#71717a' }} tickCount={3} axisLine={false} tickLine={false} width={58} />
                <Tooltip labelFormatter={(ms) => fmtFull(Number(ms))} formatter={(v) => [Number(v).toFixed(2), 'RSI14']} contentStyle={{ fontSize: 12 }} />
                <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="4 4" />
                <ReferenceLine y={50} stroke="#a1a1aa" strokeDasharray="2 4" />
                <ReferenceLine y={30} stroke="#10b981" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="rsi" stroke="#0ea5e9" strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">识别记录（{overview.signals.length}）· 点击定位到对应 K 线</p>
        {overview.signals.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">当前 600 根内没有符合初始条件的信号</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {[...overview.signals].reverse().slice(0, 30).map((s) => (
              <button key={s.open_time} type="button" onClick={() => focusSignal(s)} className="rounded-lg border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-50">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" style={{ color: signalColor(s) }}>{signalName(s)}</Badge>
                  <span className="font-medium">{fmtFull(s.open_time)}</span>
                </span>
                <span className="mt-1 block font-mono text-muted-foreground">BIAS {s.bias.toFixed(3)}% · 量 {s.volume_ratio.toFixed(2)}× · RSI {s.rsi.toFixed(1)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function BiasMonitor({
  alerts,
  unread,
  onChanged,
}: {
  alerts: BiasAlert[]
  unread: number
  onChanged: () => void
}) {
  const [interval, setInterval] = useState<BiasInterval>('15m')
  const [overview, setOverview] = useState<Partial<Record<BiasInterval, BiasOverviewInterval>>>({})
  const [status, setStatus] = useState<{ ok: boolean | null; error: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [triggerPrice, setTriggerPrice] = useState('')
  const [notifyWebhook, setNotifyWebhook] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyRead, setBusyRead] = useState(false)
  const dirtyRef = useRef(false)

  async function refresh(silent = false) {
    try {
      const r = await api.biasOverview()
      setOverview(r.intervals)
      setStatus(r.status)
      if (!dirtyRef.current) {
        setEnabled(r.config.enabled)
        setTriggerPrice(r.config.trigger_price?.toString() ?? '')
        setNotifyWebhook(r.config.notify_webhook)
      }
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    const load = async () => { if (active) await refresh() }
    void load()
    const timer = window.setInterval(() => { if (active) void refresh(true) }, 8000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  function editConfig(change: () => void) {
    dirtyRef.current = true
    change()
  }

  async function saveConfig() {
    const price = triggerPrice.trim() ? Number(triggerPrice) : null
    if (enabled && (price === null || !Number.isFinite(price) || price <= 0)) {
      toast.error('启用告警前请填写大于 0 的触发价格')
      return
    }
    setSaving(true)
    try {
      await api.saveBiasConfig({ enabled, trigger_price: price, notify_webhook: notifyWebhook })
      dirtyRef.current = false
      toast.success(`乖离率价格告警已${enabled ? '开启' : '关闭'}，不回放历史信号`)
      await refresh(true)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleRead(id: number) {
    try {
      await api.markBiasAlertRead(id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleReadAll() {
    setBusyRead(true)
    try {
      await api.markAllBiasAlertsRead()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyRead(false)
    }
  }

  const current = overview[interval]
  const activePrice = enabled && Number(triggerPrice) > 0 ? Number(triggerPrice) : undefined
  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="flex flex-col items-start gap-3 space-y-0 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">BTCUSDT 乖离率识别</CardTitle>
            <CardDescription>BIAS20＋异常量能＋RSI14；每 5 分钟刷新，仅对已收盘 K 线打标</CardDescription>
          </div>
          <Tabs value={interval} onValueChange={(v) => setInterval(v as BiasInterval)}>
            <TabsList>{INTERVALS.map((iv) => <TabsTrigger key={iv} value={iv}>{iv}</TabsTrigger>)}</TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            基础条件：BIAS 与 RSI 同向（负乖离 RSI≤50，正乖离 RSI≥50），且成交量≥前 20 根均量的 5 倍；再按周期阈值 15m 1.5% / 1h 2.5% / 4h 4% 与 RSI 30/70 极值标记强信号。绿色为负乖离，红色为正乖离。
          </div>
          {status?.ok === false && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">乖离率轮询异常：{status.error || '未知错误'}</p>}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载中…</div>
          ) : !current ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">暂无 {interval} 数据，等待下一轮检测（服务启动后约 1 分钟内有数据）</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{current.candles.length} 根 K 线</Badge>
                <Badge variant="outline">强信号 {current.signals.filter((s) => s.strength === 'extreme').length}</Badge>
                <Badge variant="outline">放量偏离 {current.signals.filter((s) => s.strength === 'watch').length}</Badge>
                <span className="ml-auto">更新于 {fmtTime(current.updated_at)}</span>
              </div>
              <BiasCharts overview={current} interval={interval} triggerPrice={activePrice} />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="space-y-1 py-4">
          <CardTitle className="text-base">乖离率价格告警</CardTitle>
          <CardDescription>已收盘 K 线满足上述乖离率识别条件，且最低价 ≤ 触发价格时告警；15m / 1h / 4h 分别去重</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="bias-trigger-price">触发价格（USDT）</Label>
              <Input id="bias-trigger-price" type="number" min="0" step="any" value={triggerPrice} placeholder="例如 73000" onChange={(e) => editConfig(() => setTriggerPrice(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label>通知方式</Label>
              <Select value={notifyWebhook ? '1' : '0'} onValueChange={(v) => editConfig(() => setNotifyWebhook(v === '1'))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">网页 + 饭碗</SelectItem>
                  <SelectItem value="0">仅网页</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 self-end rounded-md border border-border/60 px-3 py-2.5 text-sm">
              <Switch checked={enabled} onCheckedChange={(v) => editConfig(() => setEnabled(v))} />
              启用价格告警
            </label>
            <Button className="self-end bg-emerald-600 text-white hover:bg-emerald-500" onClick={saveConfig} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
              保存配置
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">保存后以当前最新已收盘 K 线为水位，只判断之后的新收盘 K 线，不回放 600 根历史信号；系统不会自动开启此配置。饭碗失败同样每 2 分钟重试，最多 3 次。</p>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex flex-col items-start gap-3 space-y-0 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">乖离率告警记录</CardTitle>
            {unread > 0 && <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{unread} 未读</Badge>}
          </div>
          {unread > 0 && (
            <Button variant="outline" size="sm" onClick={handleReadAll} disabled={busyRead}>
              {busyRead && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}全部已阅
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {alerts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">暂无告警记录</p>
          ) : alerts.map((a) => {
            const unreadRow = !a.read_at
            const negative = a.direction === 'negative'
            return (
              <div key={a.id} className={`rounded-lg border px-3 py-2.5 text-sm ${unreadRow ? 'border-amber-300 bg-amber-50/60' : 'border-border/50 text-zinc-500'}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Badge variant="outline" className={negative ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-red-300 bg-red-50 text-red-600'}>
                    {a.strength === 'extreme' ? '强' : '放量'}{negative ? '负乖离' : '正乖离'}
                  </Badge>
                  <span className="font-mono font-semibold">{a.symbol}</span>
                  <Badge variant="outline">{a.interval}</Badge>
                  <span className="text-xs">K 线 {fmtFull(a.open_time)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{fmtTime(a.created_at)}</span>
                    {unreadRow && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleRead(a.id)}>已阅</Button>}
                  </span>
                </div>
                <p className="mt-2 break-words font-mono text-xs leading-relaxed text-muted-foreground">
                  最低 {fmtNum(a.low)} ≤ 触发 {fmtNum(a.trigger_price)} · BIAS {a.bias.toFixed(3)}% · 量 {a.volume_ratio.toFixed(2)}× · RSI {a.rsi.toFixed(1)}
                </p>
                {a.webhook_ok === 0 && <p className="mt-1 text-xs text-red-500">饭碗发送失败：{a.webhook_error}</p>}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
