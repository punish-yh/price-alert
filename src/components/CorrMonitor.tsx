import { useCallback, useEffect, useRef, useState } from 'react'
import { BellRing, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, fmtTime } from '@/lib/api'
import type {
  CorrAlert,
  CorrInterval,
  CorrMonitor as CorrMonitorType,
  CorrPollerStatus,
  CorrPriceSource,
} from '@/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

const INTERVALS: { key: CorrInterval; window: number }[] = [
  { key: '1h', window: 24 },
  { key: '4h', window: 30 },
  { key: '1d', window: 14 },
]

const PRICE_SOURCES: { value: CorrPriceSource; label: string }[] = [
  { value: 'close', label: '收盘价' },
  { value: 'oc2', label: '(开+收)/2' },
  { value: 'typical', label: '典型价(高+低+收)/3' },
]

function priceSourceLabel(v: CorrPriceSource) {
  return PRICE_SOURCES.find((p) => p.value === v)?.label ?? v
}

function rText(r: number | undefined | null) {
  return r === undefined || r === null ? '—' : r.toFixed(4)
}

function rColor(r: number | undefined | null, decorrActive: boolean) {
  if (r === undefined || r === null) return 'text-zinc-400'
  if (decorrActive) return 'text-red-600'
  const abs = Math.abs(r)
  if (abs >= 0.7) return 'text-emerald-600'
  if (abs >= 0.4) return 'text-sky-600'
  return 'text-zinc-500'
}

function fmtX(ms: number, interval: string) {
  const d = new Date(ms)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (interval === '1d') return md
  return `${md} ${String(d.getHours()).padStart(2, '0')}:00`
}

// ---------------- 新建 / 编辑对话框 ----------------

type ThresholdDraft = { decorr: string; shift: string }

function CorrDialog({ initial, onSaved }: { initial?: CorrMonitorType; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [priceSource, setPriceSource] = useState<CorrPriceSource>('close')
  const [notifyWebhook, setNotifyWebhook] = useState('1')
  const [draft, setDraft] = useState<Record<CorrInterval, ThresholdDraft>>({
    '1h': { decorr: '0.3', shift: '' },
    '4h': { decorr: '0.3', shift: '' },
    '1d': { decorr: '0.3', shift: '' },
  })
  const [submitting, setSubmitting] = useState(false)
  // 只在打开对话框时回填一次；父组件轮询刷新会换新 initial 对象，不能因此重置输入
  const initializedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    const key = initial ? `edit:${initial.id}` : 'new'
    if (initializedFor.current === key) return
    initializedFor.current = key
    setSymbol(initial?.symbol || '')
    setPriceSource(initial?.price_source || 'close')
    setNotifyWebhook(initial ? String(initial.notify_webhook) : '1')
    const next = {} as Record<CorrInterval, ThresholdDraft>
    for (const { key: iv } of INTERVALS) {
      const th = initial?.thresholds?.[iv]
      next[iv] = {
        decorr: th?.decorr != null ? String(th.decorr) : initial ? '' : '0.3',
        shift: th?.shift != null ? String(th.shift) : '',
      }
    }
    setDraft(next)
  }, [open, initial])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol.trim()) {
      toast.error('请填写交易对')
      return
    }
    const thresholds: Record<string, { decorr: number | null; shift: number | null }> = {}
    for (const { key: iv } of INTERVALS) {
      const d = draft[iv]
      const decorr = d.decorr.trim() === '' ? null : Number(d.decorr)
      const shift = d.shift.trim() === '' ? null : Number(d.shift)
      if (decorr !== null && (!(decorr > 0) || decorr > 1)) {
        toast.error(`${iv} 脱钩阈值需在 (0, 1] 区间`)
        return
      }
      if (shift !== null && (!(shift > 0) || shift > 2)) {
        toast.error(`${iv} 突变阈值需在 (0, 2] 区间`)
        return
      }
      // 两类告警都留空 = 该周期只记录历史曲线，不告警
      thresholds[iv] = { decorr, shift }
    }
    setSubmitting(true)
    try {
      const payload = {
        symbol: symbol.trim().toUpperCase(),
        price_source: priceSource,
        notify_webhook: notifyWebhook === '1',
        thresholds,
      }
      if (initial) {
        await api.updateCorrMonitor(initial.id, payload)
        toast.success('相关度监控已更新')
      } else {
        await api.createCorrMonitor(payload)
        toast.success('相关度监控已创建，首次将回填最近 100 个历史相关性点')
      }
      setOpen(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {initial ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          onClick={() => setOpen(true)}
        >
          <Pencil className="mr-1 h-3.5 w-3.5" />
          编辑
        </Button>
      ) : (
        <DialogTrigger asChild>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-500">
            <Plus className="mr-1.5 h-4 w-4" />
            新建相关度监控
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑相关度监控' : '新建相关度监控'}</DialogTitle>
          <DialogDescription>
            计算该交易对与 BTC 对数收益率的滚动 Pearson 相关系数，K 线收盘时更新。
            固定窗口：1h=24 根、4h=30 根、1d=14 根；每周期保留最近 100 个历史点。
            阈值留空表示关闭该类告警。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="corr-symbol">交易对</Label>
              <Input
                id="corr-symbol"
                placeholder="如 ETHUSDT"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={!!initial}
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-2">
              <Label>价格源（防插针）</Label>
              <Select value={priceSource} onValueChange={(v) => setPriceSource(v as CorrPriceSource)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRICE_SOURCES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>告警通知方式</Label>
            <Select value={notifyWebhook} onValueChange={setNotifyWebhook}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">网页弹窗 + 饭碗告警</SelectItem>
                <SelectItem value="0">仅网页弹窗</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>各周期告警阈值</Label>
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <div className="grid grid-cols-[64px_1fr_1fr] items-center gap-2 text-xs text-muted-foreground">
                <span>周期</span>
                <span>脱钩告警：|r| ≤ 阈值</span>
                <span>突变告警：|Δr| ≥ 阈值</span>
              </div>
              {INTERVALS.map(({ key: iv, window }) => (
                <div key={iv} className="grid grid-cols-[64px_1fr_1fr] items-center gap-2">
                  <span className="text-sm font-medium">
                    {iv}
                    <span className="ml-1 text-xs text-muted-foreground">{window}根</span>
                  </span>
                  <Input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    placeholder="如 0.30"
                    value={draft[iv].decorr}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [iv]: { ...d[iv], decorr: e.target.value } }))
                    }
                  />
                  <Input
                    type="number"
                    step="0.05"
                    min="0"
                    max="2"
                    placeholder="如 0.40"
                    value={draft[iv].shift}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [iv]: { ...d[iv], shift: e.target.value } }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting} className="bg-emerald-600 text-white hover:bg-emerald-500">
              {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {initial ? '保存修改' : '创建监控'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- 历史相关性折线图 ----------------

function CorrHistoryChart({
  monitorId,
  interval,
  decorrTh,
  refreshKey,
}: {
  monitorId: number
  interval: CorrInterval
  decorrTh: number | null
  refreshKey: unknown
}) {
  const [points, setPoints] = useState<{ open_time: number; r: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .corrHistory(monitorId, interval)
      .then((r) => {
        if (!cancelled) setPoints(r.items)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // refreshKey 变化（监控配置更新/新收盘）时重新拉取
  }, [monitorId, interval, refreshKey])

  if (loading) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载历史曲线…
      </div>
    )
  }
  if (points.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        暂无历史点，等待回填或下一根 K 线收盘
      </div>
    )
  }
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis
            dataKey="open_time"
            tickFormatter={(ms) => fmtX(ms, interval)}
            tick={{ fontSize: 11, fill: '#71717a' }}
            minTickGap={48}
            axisLine={{ stroke: '#e4e4e7' }}
            tickLine={false}
          />
          <YAxis
            domain={[-1, 1]}
            tick={{ fontSize: 11, fill: '#71717a' }}
            tickCount={5}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            labelFormatter={(ms) => fmtX(Number(ms), interval)}
            formatter={(value) => [Number(value).toFixed(4), '相关性 r']}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <ReferenceLine y={0} stroke="#a1a1aa" strokeDasharray="4 4" />
          {decorrTh !== null && (
            <>
              <ReferenceLine y={decorrTh} stroke="#f87171" strokeDasharray="4 4" />
              <ReferenceLine y={-decorrTh} stroke="#f87171" strokeDasharray="4 4" />
            </>
          )}
          <Line
            type="monotone"
            dataKey="r"
            stroke="#0284c7"
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------- 单个监控卡片 ----------------

function MonitorCard({ m, onChanged }: { m: CorrMonitorType; onChanged: () => void }) {
  const [chartInterval, setChartInterval] = useState<CorrInterval>('1h')
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.deleteCorrMonitor(m.id)
      toast.success(`${m.symbol} 相关度监控已删除`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="flex-row items-center justify-between space-y-0 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-base">{m.symbol}</CardTitle>
          <span className="text-xs text-muted-foreground">vs BTCUSDT</span>
          <Badge variant="outline" className="text-muted-foreground">
            {priceSourceLabel(m.price_source)}
          </Badge>
          <Badge variant="outline" className="text-muted-foreground">
            {m.notify_webhook ? '网页+饭碗' : '仅网页'}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <CorrDialog initial={m} onSaved={onChanged} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                删除
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>删除 {m.symbol} 的相关度监控？</AlertDialogTitle>
                <AlertDialogDescription>
                  删除后停止计算与告警，历史曲线和告警记录仍保留在数据库中。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>确认删除</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {INTERVALS.map(({ key: iv, window }) => {
            const latest = m.latest?.[iv]
            const st = m.states?.[iv]
            const th = m.thresholds?.[iv]
            const decorrActive = !!st?.decorr_active
            return (
              <div key={iv} className="rounded-lg border border-border/50 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    {iv} · {window} 根窗口
                  </span>
                  {decorrActive && (
                    <Badge variant="outline" className="border-red-300 bg-red-50 text-red-600">
                      脱钩中
                    </Badge>
                  )}
                </div>
                <p className={`mt-1 font-mono text-2xl font-bold tabular-nums ${rColor(latest?.r, decorrActive)}`}>
                  {rText(latest?.r)}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>脱钩 {th?.decorr != null ? `≤ ${th.decorr}` : '关闭'}</span>
                  <span>突变 {th?.shift != null ? `≥ ${th.shift}` : '关闭'}</span>
                </div>
                {latest && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    更新于 {fmtX(latest.open_time, iv)}
                  </p>
                )}
              </div>
            )
          })}
        </div>
        <div className="rounded-lg border border-border/50 p-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <p className="text-xs text-muted-foreground">
              历史相关性（最近 100 点，虚线为 0 轴{chartInterval && m.thresholds?.[chartInterval]?.decorr != null ? '与脱钩阈值' : ''}）
            </p>
            <Tabs value={chartInterval} onValueChange={(v) => setChartInterval(v as CorrInterval)}>
              <TabsList className="h-7">
                {INTERVALS.map(({ key: iv }) => (
                  <TabsTrigger key={iv} value={iv} className="px-2.5 text-xs">
                    {iv}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <CorrHistoryChart
            monitorId={m.id}
            interval={chartInterval}
            decorrTh={m.thresholds?.[chartInterval]?.decorr ?? null}
            refreshKey={`${m.updated_at}-${m.latest?.[chartInterval]?.open_time ?? 0}`}
          />
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- 主组件 ----------------

export default function CorrMonitor({
  alerts,
  unread,
  onChanged,
}: {
  alerts: CorrAlert[]
  unread: number
  onChanged: () => void
}) {
  const [monitors, setMonitors] = useState<CorrMonitorType[]>([])
  const [status, setStatus] = useState<CorrPollerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyRead, setBusyRead] = useState(false)

  const refreshMonitors = useCallback(async (silent = false) => {
    try {
      const r = await api.corrMonitors()
      setMonitors(r.items)
      setStatus(r.status)
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshMonitors()
    const t = setInterval(() => refreshMonitors(true), 8000)
    return () => clearInterval(t)
  }, [refreshMonitors])

  function refreshAll() {
    refreshMonitors(true)
    onChanged()
  }

  async function handleRead(id: number) {
    try {
      await api.markCorrAlertRead(id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleReadAll() {
    setBusyRead(true)
    try {
      await api.markAllCorrAlertsRead()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyRead(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <div className="space-y-1">
            <CardTitle className="text-base">相关度监控（vs BTC）</CardTitle>
            <CardDescription>
              对数收益率滚动 Pearson 相关系数，K 线收盘更新；固定窗口 1h=24 根 / 4h=30 根 / 1d=14
              根；脱钩 = |r| ≤ 阈值，突变 = |r−上一根 r| ≥ 阈值（4 根 K 线冷却）
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-muted-foreground">
              {monitors.length} 个
            </Badge>
            <CorrDialog onSaved={refreshAll} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {status?.ok === false && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              相关度轮询异常：{status.error || '未知错误'}
            </p>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              加载中…
            </div>
          ) : monitors.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              还没有相关度监控，点击右上角「新建相关度监控」开始
            </p>
          ) : (
            monitors.map((m) => <MonitorCard key={m.id} m={m} onChanged={refreshAll} />)
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">相关度告警记录</CardTitle>
            {unread > 0 && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                {unread} 未读
              </Badge>
            )}
          </div>
          {unread > 0 && (
            <Button variant="outline" size="sm" onClick={handleReadAll} disabled={busyRead}>
              {busyRead && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              全部已阅
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {alerts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              暂无告警记录
            </p>
          ) : (
            alerts.map((a) => {
              const unreadRow = !a.read_at
              return (
                <div
                  key={a.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm ${
                    unreadRow ? 'border-amber-300 bg-amber-50/60' : 'border-border/50 text-zinc-500'
                  }`}
                >
                  <Badge
                    variant="outline"
                    className={
                      a.kind === 'decorr'
                        ? 'border-red-300 bg-red-50 text-red-600'
                        : 'border-violet-300 bg-violet-50 text-violet-700'
                    }
                  >
                    {a.kind === 'decorr' ? '脱钩' : '突变'}
                  </Badge>
                  <span className="font-mono font-semibold">{a.symbol}</span>
                  <Badge variant="outline" className="text-muted-foreground">
                    {a.interval}
                  </Badge>
                  <span className="font-mono tabular-nums">
                    {a.kind === 'decorr'
                      ? `r=${a.r.toFixed(4)}，|r| ≤ ${a.threshold}`
                      : `r ${a.prev_r?.toFixed(4) ?? '—'} → ${a.r.toFixed(4)}，|Δr| ≥ ${a.threshold}`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    K线 {fmtX(a.open_time, a.interval)} · 记录于 {fmtTime(a.created_at)}
                  </span>
                  {a.webhook_ok === 0 && (
                    <span className="text-xs text-red-500">饭碗发送失败：{a.webhook_error}</span>
                  )}
                  <span className="ml-auto">
                    {unreadRow && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleRead(a.id)}
                      >
                        已阅
                      </Button>
                    )}
                  </span>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
