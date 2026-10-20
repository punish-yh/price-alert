import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BellRing,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { api, fmtPrice, fmtTime } from '@/lib/api'
import type { Monitor, MonitorStatus } from '@/types'
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
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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

const EMA_PERIODS = [21, 55, 100, 200]
const EMA_INTERVALS = ['15m', '1h', '4h', '1d']

const TABS: { value: MonitorStatus; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'triggered', label: '已触发' },
  { value: 'deleted', label: '已删除' },
]

const STATUS_META: Record<MonitorStatus, { label: string; cls: string }> = {
  active: { label: '活跃', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  triggered: { label: '已触发', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  deleted: { label: '已删除', cls: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
}

function EmaDialog({ initial, onSaved }: { initial?: Monitor; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [interval, setInterval_] = useState('1h')
  const [emaPeriod, setEmaPeriod] = useState('55')
  const [note, setNote] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    api
      .symbols()
      .then((r) => setSymbols(r.symbols))
      .catch(() => setSymbols([]))
  }, [open])

  useEffect(() => {
    if (!open) return
    setSymbol(initial?.symbol || '')
    setInterval_(initial?.interval || '1h')
    setEmaPeriod(initial ? String(initial.ema_period) : '55')
    setNote(initial?.note || '')
  }, [open, initial])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol.trim()) {
      toast.error('请填写交易对')
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        symbol: symbol.trim().toUpperCase(),
        ema_period: Number(emaPeriod),
        interval,
        note: note.trim(),
      }
      if (initial) {
        await api.updateEmaMonitor(initial.id, payload)
        toast.success('EMA 监控已更新')
      } else {
        await api.createEmaMonitor(payload)
        toast.success('EMA 监控已创建，将在下一根 K 线收盘后开始判定')
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
            新建 EMA 监控
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑 EMA 均线监控' : '新建 EMA 均线监控'}</DialogTitle>
          <DialogDescription>
            在选定周期的每根 K 线收盘时检查一次：收盘价上穿、下穿，或影线触及（插针）所选 EMA
            均线即触发一次告警。价格为现货与 USDT 永续合约按成交额加权的综合价。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ema-symbol">交易对</Label>
            <Input
              id="ema-symbol"
              placeholder="例如 BTCUSDT"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              list="ema-symbol-list"
              autoComplete="off"
              required
            />
            <datalist id="ema-symbol-list">
              {symbols.slice(0, 500).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>K 线周期</Label>
              <Select value={interval} onValueChange={setInterval_}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMA_INTERVALS.map((i) => (
                    <SelectItem key={i} value={i}>
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>EMA 均线</Label>
              <Select value={emaPeriod} onValueChange={setEmaPeriod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMA_PERIODS.map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      EMA{p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ema-note">备注（可选）</Label>
            <Input
              id="ema-note"
              placeholder="例如：4h 级别趋势分界"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {initial ? '保存修改' : '创建监控'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface Props {
  monitors: Monitor[]
  prices: Record<string, number>
  onDelete: (id: number) => Promise<void>
  onRestore: (id: number) => Promise<void>
  onChanged: () => void
}

export default function EmaMonitors({ monitors, prices, onDelete, onRestore, onChanged }: Props) {
  const [tab, setTab] = useState<MonitorStatus>('active')
  const [busyId, setBusyId] = useState<number | null>(null)

  const counts = useMemo(() => {
    const c: Record<MonitorStatus, number> = { active: 0, triggered: 0, deleted: 0 }
    for (const m of monitors) c[m.status] += 1
    return c
  }, [monitors])

  const groups = useMemo(() => {
    const filtered = monitors.filter((m) => m.status === tab)
    const map = new Map<string, Monitor[]>()
    for (const m of filtered) {
      const arr = map.get(m.symbol) || []
      arr.push(m)
      map.set(m.symbol, arr)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [monitors, tab])

  async function run(id: number, fn: (id: number) => Promise<void>) {
    setBusyId(id)
    try {
      await fn(id)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as MonitorStatus)}>
          <TabsList className="bg-white">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
                <span className="ml-1.5 rounded-full bg-zinc-100 px-1.5 text-xs tabular-nums text-zinc-600">
                  {counts[t.value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <EmaDialog onSaved={onChanged} />
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-20 text-zinc-500">
          <Activity className="h-8 w-8 opacity-40" />
          <p>
            {tab === 'active'
              ? '还没有活跃的 EMA 监控，点击右上角「新建 EMA 监控」开始'
              : `暂无${TABS.find((t) => t.value === tab)?.label}的监控`}
          </p>
        </div>
      ) : (
        groups.map(([symbol, items]) => (
          <Card key={symbol} className="border-border/60">
            <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
              <div className="flex items-baseline gap-3">
                <span className="text-lg font-bold tracking-wide">{symbol}</span>
                <span className="font-mono text-sm tabular-nums text-zinc-700">
                  {prices[symbol] !== undefined ? fmtPrice(prices[symbol]) : '—'}
                </span>
              </div>
              <Badge variant="outline" className="text-muted-foreground">
                {items.length} 条监控
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {items.map((m) => {
                const meta = STATUS_META[m.status]
                return (
                  <div
                    key={m.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2.5 text-sm ${
                      m.status === 'deleted' ? 'opacity-55' : ''
                    }`}
                  >
                    <Badge variant="outline" className={meta.cls}>
                      {m.status === 'triggered' && <BellRing className="mr-1 h-3 w-3" />}
                      {meta.label}
                    </Badge>

                    <span className="flex items-center gap-1.5 font-medium">
                      <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
                        {m.interval}
                      </Badge>
                      <Badge variant="outline" className="border-violet-200 bg-violet-50 text-violet-700">
                        EMA{m.ema_period}
                      </Badge>
                      <span className="text-xs text-muted-foreground">上穿 / 下穿 / 插针</span>
                    </span>

                    {m.note && <span className="text-xs text-muted-foreground">｜{m.note}</span>}

                    {m.status === 'triggered' && (
                      <span className="text-xs text-muted-foreground">
                        ｜触发于 {fmtTime(m.triggered_at)}，收盘价 {fmtPrice(m.trigger_price)}
                        {m.webhook_ok === 1 && <span className="text-emerald-600">，通知已送达</span>}
                        {m.webhook_ok === 0 && (
                          <span className="text-red-500" title={m.webhook_error || ''}>
                            ，通知发送失败
                          </span>
                        )}
                      </span>
                    )}

                    <span className="ml-auto flex items-center gap-1.5">
                      {busyId === m.id && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      )}
                      {m.status === 'active' && <EmaDialog initial={m} onSaved={onChanged} />}
                      {m.status !== 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                          disabled={busyId !== null}
                          onClick={() => run(m.id, onRestore)}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" />
                          重新激活
                        </Button>
                      )}
                      {m.status !== 'deleted' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                          disabled={busyId !== null}
                          onClick={() => run(m.id, onDelete)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          删除
                        </Button>
                      )}
                      {m.status === 'deleted' && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-red-500 hover:bg-red-50 hover:text-red-600"
                              disabled={busyId !== null}
                            >
                              <XCircle className="mr-1 h-3.5 w-3.5" />
                              彻底删除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>彻底删除这条监控？</AlertDialogTitle>
                              <AlertDialogDescription>
                                {m.symbol} {m.interval} EMA{m.ema_period} 穿越监控将被永久删除，无法恢复。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => run(m.id, onDelete)}
                              >
                                彻底删除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </span>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}
