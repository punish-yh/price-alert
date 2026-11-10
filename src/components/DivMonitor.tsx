import { useCallback, useEffect, useState } from 'react'
import { BellRing, Loader2, Save, TrendingDown, TrendingUp } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type {
  DivAlert,
  DivDetail,
  DivDirection,
  DivInterval,
  DivIntervalConfig,
  DivKind,
  DivOverviewInterval,
} from '@/types'
import DivCharts, { DIV_KIND_CN } from '@/components/DivCharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

const INTERVALS: DivInterval[] = ['1h', '4h', '1d']
const KINDS: DivKind[] = ['volume', 'rsi', 'obv', 'macd', 'macd_area']

function fmtNum(v: number) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toPrecision(3)
}

function fmtT(ms: number, interval: string) {
  const d = new Date(ms)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return interval === '1d' ? md : `${md} ${String(d.getHours()).padStart(2, '0')}:00`
}

function detailText(kind: DivKind, det: DivDetail, interval: string) {
  if (kind === 'macd_area') {
    return `价 ${fmtNum(det.p1)} → ${fmtNum(det.p2)}，面积 ${fmtNum(det.area1)} → ${fmtNum(det.area2)}`
  }
  return `${fmtT(det.p1_time, interval)} 价 ${fmtNum(det.p1_price)} → ${fmtT(det.p2_time, interval)} 价 ${fmtNum(det.p2_price)}，指标 ${fmtNum(det.v1)} → ${fmtNum(det.v2)}`
}

// ---------------- 配置面板 ----------------

function ConfigPanel({
  interval,
  config,
  onSaved,
}: {
  interval: DivInterval
  config: DivIntervalConfig
  onSaved: () => void
}) {
  const [minCount, setMinCount] = useState(String(config.min_count))
  const [notify, setNotify] = useState(config.notify_webhook ? '1' : '0')
  const [enabled, setEnabled] = useState<Record<DivKind, boolean>>({ ...config.enabled })
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // 切换周期或配置更新时重置草稿
  useEffect(() => {
    setMinCount(String(config.min_count))
    setNotify(config.notify_webhook ? '1' : '0')
    setEnabled({ ...config.enabled })
    setDirty(false)
  }, [interval, config])

  async function handleSave() {
    const enabledCount = KINDS.filter((k) => enabled[k]).length
    if (enabledCount < Number(minCount)) {
      toast.error(`只启用了 ${enabledCount} 种背离，低于数量阈值 ${minCount}，组合永远无法满足`)
      return
    }
    setSaving(true)
    try {
      await api.updateDivConfig({
        interval,
        min_count: Number(minCount),
        notify_webhook: notify === '1',
        enabled,
      })
      toast.success(`${interval} 告警配置已保存，下一轮检测（5 分钟内）生效`)
      setDirty(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">数量阈值：同方向同时触发几种背离才告警</Label>
          <Select
            value={minCount}
            onValueChange={(v) => {
              setMinCount(v)
              setDirty(true)
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[2, 3, 4, 5].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  ≥ {n} 种
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">通知方式</Label>
          <Select
            value={notify}
            onValueChange={(v) => {
              setNotify(v)
              setDirty(true)
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">网页弹窗 + 饭碗告警</SelectItem>
              <SelectItem value="0">仅网页弹窗</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {KINDS.map((k) => (
          <label key={k} className="flex items-center gap-1.5 text-sm">
            <Switch
              checked={enabled[k]}
              onCheckedChange={(v) => {
                setEnabled((e) => ({ ...e, [k]: v }))
                setDirty(true)
              }}
            />
            {DIV_KIND_CN[k]}
          </label>
        ))}
        <Button
          size="sm"
          className="ml-auto h-8 bg-emerald-600 text-white hover:bg-emerald-500"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          保存 {interval} 配置
        </Button>
      </div>
    </div>
  )
}

// ---------------- 当前背离状态 ----------------

function DivergenceBoard({ overview, interval }: { overview: DivOverviewInterval; interval: DivInterval }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {(['top', 'bottom'] as DivDirection[]).map((direction) => {
        const items = Object.entries(overview.divergences[direction]) as [DivKind, DivDetail][]
        const top = direction === 'top'
        return (
          <div key={direction} className="rounded-lg border border-border/50 px-3 py-2.5">
            <p className={`mb-1.5 flex items-center gap-1 text-sm font-semibold ${top ? 'text-red-600' : 'text-emerald-600'}`}>
              {top ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
              {top ? '顶背离' : '底背离'}（当前 {items.length} 种）
            </p>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无</p>
            ) : (
              <ul className="space-y-1">
                {items.map(([kind, det]) => (
                  <li key={kind} className="text-xs">
                    <span className={`mr-1.5 inline-block rounded px-1.5 py-0.5 font-medium ${top ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
                      {DIV_KIND_CN[kind]}
                    </span>
                    <span className="font-mono text-muted-foreground">{detailText(kind, det, interval)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------- 主组件 ----------------

export default function DivMonitor({
  alerts,
  unread,
  onChanged,
}: {
  alerts: DivAlert[]
  unread: number
  onChanged: () => void
}) {
  const [interval, setInterval] = useState<DivInterval>('1h')
  const [overview, setOverview] = useState<Partial<Record<DivInterval, DivOverviewInterval>>>({})
  const [config, setConfig] = useState<Record<DivInterval, DivIntervalConfig> | null>(null)
  const [status, setStatus] = useState<{ ok: boolean | null; error: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyRead, setBusyRead] = useState(false)

  const refresh = useCallback(async (silent = false) => {
    try {
      const r = await api.divOverview()
      setOverview(r.intervals)
      setConfig(r.config)
      setStatus(r.status)
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // 注意：本组件的周期状态 setter 也叫 setInterval，定时器必须用 window 前缀避免被遮蔽
    const t = window.setInterval(() => refresh(true), 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  async function handleRead(id: number) {
    try {
      await api.markDivAlertRead(id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleReadAll() {
    setBusyRead(true)
    try {
      await api.markAllDivAlertsRead()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyRead(false)
    }
  }

  const current = overview[interval]

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <div className="space-y-1">
            <CardTitle className="text-base">BTCUSDT 背离监控</CardTitle>
            <CardDescription>
              每 5 分钟检测一次（含正在走的 K 线）；摆动点左右各 3 根确认，后一个摆动点取即时极值；
              同方向背离种类数达到阈值才告警，解除后重新武装
            </CardDescription>
          </div>
          <Tabs value={interval} onValueChange={(v) => setInterval(v as DivInterval)}>
            <TabsList>
              {INTERVALS.map((iv) => (
                <TabsTrigger key={iv} value={iv}>
                  {iv}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {status?.ok === false && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              背离轮询异常：{status.error || '未知错误'}
            </p>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              加载中…
            </div>
          ) : !current ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              暂无 {interval} 数据，等待下一轮检测（服务启动后约 1 分钟内有数据）
            </p>
          ) : (
            <>
              <DivergenceBoard overview={current} interval={interval} />
              <div className="rounded-lg border border-border/50 p-2">
                <DivCharts overview={current} interval={interval} />
              </div>
              <p className="text-right text-xs text-muted-foreground">
                数据更新于 {fmtTime(current.updated_at)}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="space-y-1 py-4">
          <CardTitle className="text-base">{interval} 告警配置</CardTitle>
          <CardDescription>
            顶背离与底背离分别计数；只统计已启用的背离种类。例：阈值 ≥ 2 表示同一方向至少 2
            种背离同时成立才告警
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {config?.[interval] && (
            <ConfigPanel interval={interval} config={config[interval]} onSaved={() => refresh(true)} />
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">背离告警记录</CardTitle>
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
              const top = a.direction === 'top'
              return (
                <div
                  key={a.id}
                  className={`rounded-lg border px-3 py-2.5 text-sm ${
                    unreadRow ? 'border-amber-300 bg-amber-50/60' : 'border-border/50 text-zinc-500'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge
                      variant="outline"
                      className={top ? 'border-red-300 bg-red-50 text-red-600' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}
                    >
                      {top ? '顶背离' : '底背离'}
                    </Badge>
                    <span className="font-mono font-semibold">{a.symbol}</span>
                    <Badge variant="outline" className="text-muted-foreground">
                      {a.interval}
                    </Badge>
                    <span>
                      {a.kinds.map((k) => DIV_KIND_CN[k]).join('、')}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        （{a.kinds.length} 种 ≥ 阈值 {a.min_count}）
                      </span>
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{fmtTime(a.created_at)}</span>
                      {unreadRow && (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleRead(a.id)}>
                          已阅
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {a.kinds.map((k) => {
                      const det = a.details[k]
                      return det ? (
                        <p key={k} className="font-mono text-[11px] text-muted-foreground">
                          {DIV_KIND_CN[k]}：{detailText(k, det, a.interval)}
                        </p>
                      ) : null
                    })}
                  </div>
                  {a.webhook_ok === 0 && (
                    <p className="mt-1 text-xs text-red-500">饭碗发送失败：{a.webhook_error}</p>
                  )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
