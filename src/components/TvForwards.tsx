import { useCallback, useEffect, useState } from 'react'
import { BellRing, Check, Copy, Loader2, Pencil, Plus, Radio, Save, Trash2 } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { TvComboAlert, TvComboRule, TvCondition, TvForward } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

const FILTER_CN: Record<string, string> = {
  wave: '波段过滤器',
  trend: '趋势过滤器',
  any: '任意过滤器',
}
const DIRECTION_CN: Record<string, string> = {
  bullish: '所有看涨信号',
  bearish: '所有看跌信号',
  breakout: '突破预警',
}
const INTERVALS = ['15m', '1h', '4h', '1d'] as const
const SIGNAL_INTERVALS = ['1d', '4h', '1h', '15m'] as const

const WAVE_TEMPLATE = `【波段过滤器】
币种：{{exchange}}:{{ticker}}
周期：{{interval}}
触发时间：{{timenow}}（UTC）
信号组：所有看涨信号
提示：出现看涨组信号，请打开图表查看。`
const TREND_TEMPLATE = `【趋势过滤器】
币种：{{exchange}}:{{ticker}}
周期：{{interval}}
触发时间：{{timenow}}（UTC）
信号组：所有看跌信号
提示：出现看跌组信号，请打开图表查看。`

function conditionText(condition: TvCondition) {
  return `${FILTER_CN[condition.filter_type]} ${condition.interval} ${DIRECTION_CN[condition.direction]}`
}

function fmtUtc(value: string) {
  if (!value) return '—'
  return `${new Date(value).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false })} UTC`
}

function DirectionBadge({ direction }: { direction: string }) {
  const className = direction === 'bullish'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : direction === 'breakout'
      ? 'border-sky-200 bg-sky-50 text-sky-700'
      : 'border-red-200 bg-red-50 text-red-600'
  return (
    <Badge variant="outline" className={className}>
      {DIRECTION_CN[direction] || direction || '旧版消息'}
    </Badge>
  )
}

function SignalBadges({ signal }: { signal: TvForward }) {
  return (
    <>
      <Badge variant="secondary">{FILTER_CN[signal.filter_type] || '未解析'}</Badge>
      <DirectionBadge direction={signal.direction} />
      {signal.interval && <Badge variant="outline">{signal.interval}</Badge>}
    </>
  )
}

function emptyRule(): TvComboRule {
  return {
    id: 0,
    name: '',
    symbol: '',
    conditions: [
      { filter_type: 'trend', interval: '4h', direction: 'bearish' },
      { filter_type: 'trend', interval: '15m', direction: 'bearish' },
    ],
    notify_webhook: true,
    enabled: true,
  }
}

function RuleEditor({
  open,
  initial,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  initial: TvComboRule | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<TvComboRule>(emptyRule)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(initial
        ? { ...initial, conditions: initial.conditions.map((condition) => ({ ...condition })) }
        : emptyRule())
    }
  }, [open, initial])

  function updateCondition(index: number, change: Partial<TvCondition>) {
    setDraft((old) => ({
      ...old,
      conditions: old.conditions.map((condition, i) => i === index ? { ...condition, ...change } : condition),
    }))
  }

  async function save() {
    if (!draft.name.trim()) {
      toast.error('请填写组合名称')
      return
    }
    if (!draft.symbol.trim()) {
      toast.error('请填写与 TradingView 一致的币种代码')
      return
    }
    const keys = draft.conditions.map((c) => `${c.filter_type}|${c.interval}|${c.direction}`)
    if (new Set(keys).size !== keys.length) {
      toast.error('组合中存在重复条件')
      return
    }
    setSaving(true)
    try {
      await api.saveTvRule({ ...draft, name: draft.name.trim(), symbol: draft.symbol.trim().toUpperCase() })
      toast.success('TV 组合告警已保存，不自动生成或回放历史告警')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑 TV 组合告警' : '新建 TV 组合告警'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tv-rule-name">组合名称</Label>
              <Input id="tv-rule-name" value={draft.name} maxLength={50} placeholder="例如：4h + 15m 看跌共振" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tv-rule-symbol">币种代码</Label>
              <Input id="tv-rule-symbol" value={draft.symbol} placeholder="例如 BTCUSDT.P（需与 TV 一致）" onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>组合条件（全部满足）</Label>
              <Button variant="outline" size="sm" disabled={draft.conditions.length >= 16} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { filter_type: 'wave', interval: '15m', direction: 'bullish' }] })}>
                <Plus className="mr-1 h-3.5 w-3.5" />添加条件
              </Button>
            </div>
            {draft.conditions.map((condition, index) => (
              <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border border-border/60 p-3 sm:grid-cols-[1fr_0.65fr_1fr_auto]">
                <Select value={condition.filter_type} onValueChange={(v) => updateCondition(index, { filter_type: v as TvCondition['filter_type'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wave">波段过滤器</SelectItem>
                    <SelectItem value="trend">趋势过滤器</SelectItem>
                    <SelectItem value="any">任意过滤器</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={condition.interval} onValueChange={(v) => updateCondition(index, { interval: v as TvCondition['interval'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{INTERVALS.map((interval) => <SelectItem key={interval} value={interval}>{interval}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={condition.direction} onValueChange={(v) => updateCondition(index, { direction: v as TvCondition['direction'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bullish">所有看涨信号</SelectItem>
                    <SelectItem value="bearish">所有看跌信号</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon" aria-label="删除条件" disabled={draft.conditions.length <= 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>通知方式</Label>
              <Select value={draft.notify_webhook ? '1' : '0'} onValueChange={(v) => setDraft({ ...draft, notify_webhook: v === '1' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">网页 + 饭碗</SelectItem>
                  <SelectItem value="0">仅网页</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 self-end rounded-md border border-border/60 px-3 py-2.5 text-sm">
              <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />启用这条组合
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-500" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}保存组合
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ComboStatus({ alert }: { alert: TvComboAlert }) {
  if (alert.webhook_ok === 1) return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">饭碗已送达</Badge>
  if (alert.webhook_ok === 0) return <Badge variant="outline" className="border-red-200 bg-red-50 text-red-600" title={alert.webhook_error}>饭碗发送失败</Badge>
  return <Badge variant="outline">网页已记录</Badge>
}

export default function TvForwards() {
  const [webhookUrl, setWebhookUrl] = useState('')
  const [items, setItems] = useState<TvForward[]>([])
  const [active, setActive] = useState<TvForward[]>([])
  const [rules, setRules] = useState<TvComboRule[]>([])
  const [comboAlerts, setComboAlerts] = useState<TvComboAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TvComboRule | null>(null)

  const refresh = useCallback(async (silent = false) => {
    try {
      const result = await api.tvOverview()
      setItems(result.items)
      setActive(result.active)
      setRules(result.rules)
      setComboAlerts(result.combo_alerts)
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    api.tvConfig()
      .then((config) => setWebhookUrl(`${window.location.origin}${config.webhook_path}`))
      .catch(() => setWebhookUrl(''))
    refresh()
    const timer = window.setInterval(() => refresh(true), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败，请手动选择复制')
    }
  }

  async function deleteForward(id: number) {
    setBusyId(id)
    try {
      await api.deleteTvForward(id)
      await refresh(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleRule(rule: TvComboRule, enabled: boolean) {
    setBusyId(rule.id)
    try {
      await api.saveTvRule({ ...rule, enabled })
      await refresh(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  async function deleteRule(rule: TvComboRule) {
    if (!window.confirm(`删除组合「${rule.name}」？已有触发记录会保留。`)) return
    setBusyId(rule.id)
    try {
      await api.deleteTvRule(rule.id)
      await refresh(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const currentActive = active.filter((signal) => Date.parse(signal.valid_until) > Date.now())
  const { signalGroups, breakoutGroups } = (() => {
    const groups = new Map<string, {
      exchange: string
      symbol: string
      filterType: string
      directionalSignals: Partial<Record<string, TvForward>>
    }>()
    const breakouts = new Map<string, {
      exchange: string
      symbol: string
      signals: Partial<Record<string, TvForward>>
    }>()
    for (const signal of [...items, ...currentActive]) {
      if (!signal.exchange || signal.parse_error) continue
      if (signal.direction === 'breakout') {
        const key = `${signal.exchange}:${signal.symbol}`
        if (!breakouts.has(key)) {
          breakouts.set(key, { exchange: signal.exchange, symbol: signal.symbol, signals: {} })
        }
        continue
      }
      if (!signal.filter_type) continue
      const key = `${signal.exchange}:${signal.symbol}|${signal.filter_type}`
      if (!groups.has(key)) {
        groups.set(key, {
          exchange: signal.exchange,
          symbol: signal.symbol,
          filterType: signal.filter_type,
          directionalSignals: {},
        })
      }
    }
    for (const signal of currentActive) {
      if (signal.direction === 'breakout') {
        const group = breakouts.get(`${signal.exchange}:${signal.symbol}`)
        if (group && (!group.signals[signal.interval] || signal.id > group.signals[signal.interval]!.id)) {
          group.signals[signal.interval] = signal
        }
        continue
      }
      const group = groups.get(`${signal.exchange}:${signal.symbol}|${signal.filter_type}`)
      if (group && (!group.directionalSignals[signal.interval] || signal.id > group.directionalSignals[signal.interval]!.id)) {
        group.directionalSignals[signal.interval] = signal
      }
    }
    return {
      signalGroups: [...groups.values()].sort((a, b) =>
        `${a.exchange}:${a.symbol}`.localeCompare(`${b.exchange}:${b.symbol}`) || a.filterType.localeCompare(b.filterType)
      ),
      breakoutGroups: [...breakouts.values()].sort((a, b) =>
        `${a.exchange}:${a.symbol}`.localeCompare(`${b.exchange}:${b.symbol}`)
      ),
    }
  })()

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4 text-emerald-600" />TradingView Webhook 地址</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">{webhookUrl || '加载中…'}</code>
            <Button variant="outline" size="sm" onClick={copyUrl} disabled={!webhookUrl}>
              {copied ? <Check className="mr-1.5 h-4 w-4 text-emerald-500" /> : <Copy className="mr-1.5 h-4 w-4" />}复制
            </Button>
          </div>
          <details className="mt-3 rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium text-zinc-700">查看两种告警消息格式</summary>
            <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-mono leading-relaxed">{WAVE_TEMPLATE}</pre>
              <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-mono leading-relaxed">{TREND_TEMPLATE}</pre>
            </div>
            <p className="mt-2 leading-relaxed">周期支持 15m、1h、4h、1d 及 TradingView 数字周期 15、60、240、1440；信号组支持所有看涨、所有看跌和突破预警。突破预警仅展示，不参与组合告警。</p>
          </details>
        </CardContent>
      </Card>

      <Tabs defaultValue="active" className="gap-4">
        <TabsList className="grid h-10 w-full grid-cols-3">
          <TabsTrigger value="active">当前有效</TabsTrigger>
          <TabsTrigger value="rules">组合告警</TabsTrigger>
          <TabsTrigger value="history">接收历史</TabsTrigger>
        </TabsList>

        <TabsContent value="history">
          <Card className="border-border/60">
            <CardHeader className="space-y-1 py-4">
              <CardTitle className="text-base">接收到的告警历史</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载中…</div>
              ) : items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">还没有接收记录</p>
              ) : items.map((record) => (
                <div key={record.id} className={`rounded-lg border px-3 py-3 text-sm ${record.parse_error ? 'border-red-200 bg-red-50/40' : 'border-border/50'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {record.filter_type ? <SignalBadges signal={record} /> : <Badge variant="outline">{record.parse_error ? '解析失败' : '旧版转发'}</Badge>}
                    <span className="font-mono font-semibold">{record.exchange ? `${record.exchange}:${record.symbol}` : record.summary}</span>
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      接收于 {fmtTime(record.received_at)}
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busyId === record.id} onClick={() => deleteForward(record.id)}>
                        {busyId === record.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    </span>
                  </div>
                  {record.parse_error ? (
                    <p className="mt-2 text-xs text-red-600">{record.parse_error}</p>
                  ) : record.filter_type ? (
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">触发：{fmtUtc(record.trigger_time)}　有效至：{fmtTime(record.valid_until)}</p>
                  ) : null}
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">查看原始消息{record.source_ip ? ` · 来源 ${record.source_ip}` : ''}</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 font-mono leading-relaxed">{record.raw_body}</pre>
                  </details>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="active">
          <Card className="border-border/60">
            <CardHeader className="space-y-1 py-4">
              <CardTitle className="text-base">当前有效的信号</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {signalGroups.length === 0 && breakoutGroups.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">还没有收到可展示的信号</p>
              ) : (
                <div className="space-y-4">
                  {signalGroups.length > 0 && (
                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                      {signalGroups.map((group) => (
                        <div key={`${group.exchange}:${group.symbol}|${group.filterType}`} className="rounded-lg border border-border/60 px-3 py-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={group.filterType === 'wave'
                                ? 'border-sky-200 bg-sky-50 text-sky-700'
                                : 'border-violet-200 bg-violet-50 text-violet-700'}
                            >
                              {FILTER_CN[group.filterType]}
                            </Badge>
                            <span className="font-mono font-semibold">{group.exchange}:{group.symbol}</span>
                          </div>
                          <div className="mt-3 grid grid-cols-[2.5rem_1fr] items-center gap-2">
                            <span className="text-xs text-muted-foreground">方向</span>
                            <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
                              {SIGNAL_INTERVALS.map((interval) => {
                                const signal = group.directionalSignals[interval]
                                const direction = signal?.direction
                                const color = direction === 'bullish'
                                  ? 'bg-emerald-500'
                                  : direction === 'bearish'
                                    ? 'bg-red-500'
                                    : 'bg-zinc-300'
                                const status = signal ? DIRECTION_CN[direction || ''] : '未触发'
                                return (
                                  <div
                                    key={interval}
                                    className="flex items-center justify-center gap-1.5 rounded-md bg-zinc-50 px-1.5 py-2"
                                    title={signal ? `${interval} ${status}｜有效至 ${fmtTime(signal.valid_until)}` : `${interval} 方向信号未触发`}
                                  >
                                    <span className={`h-3 w-3 shrink-0 rounded-full ${color}`} aria-label={`${interval} ${status}`} />
                                    <span className="text-xs font-medium text-zinc-600">{interval}</span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {breakoutGroups.length > 0 && (
                    <div className={signalGroups.length > 0 ? 'border-t border-border/60 pt-4' : ''}>
                      <p className="mb-2 text-sm font-medium text-zinc-700">突破预警</p>
                      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        {breakoutGroups.map((group) => (
                          <div key={`${group.exchange}:${group.symbol}`} className="rounded-lg border border-amber-200/70 bg-amber-50/20 px-3 py-3 text-sm">
                            <span className="font-mono font-semibold">{group.exchange}:{group.symbol}</span>
                            <div className="mt-3 grid grid-cols-4 gap-1.5 sm:gap-2">
                              {SIGNAL_INTERVALS.map((interval) => {
                                const signal = group.signals[interval]
                                const status = signal ? '突破预警' : '未触发'
                                return (
                                  <div
                                    key={interval}
                                    className="flex items-center justify-center gap-1.5 rounded-md bg-zinc-50 px-1.5 py-2"
                                    title={signal ? `${interval} 突破预警｜有效至 ${fmtTime(signal.valid_until)}` : `${interval} 突破预警未触发`}
                                  >
                                    <span
                                      className={`h-3 w-3 shrink-0 rounded-full ${signal ? 'bg-amber-400' : 'bg-zinc-300'}`}
                                      aria-label={`${interval} ${status}`}
                                    />
                                    <span className="text-xs font-medium text-zinc-600">{interval}</span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <Card className="border-border/60">
            <CardHeader className="space-y-1 py-4">
              <CardTitle className="text-base">当前配置的组合告警</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {rules.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">暂无组合规则，系统不会自动创建或发送组合告警</p>
              ) : rules.map((rule) => (
                <div key={rule.id} className="rounded-lg border border-border/60 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.name}</span>
                    <Badge variant="secondary" className="font-mono">{rule.symbol}</Badge>
                    <Badge variant="outline">{rule.conditions.length} 个条件</Badge>
                    <span className="text-xs text-muted-foreground">{rule.notify_webhook ? '网页 + 饭碗' : '仅网页'}</span>
                    <span className="ml-auto flex items-center gap-1">
                      {busyId === rule.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      <Switch checked={rule.enabled} disabled={busyId !== null} onCheckedChange={(enabled) => toggleRule(rule, enabled)} />
                      <Button variant="ghost" size="sm" onClick={() => { setEditing(rule); setEditorOpen(true) }}><Pencil className="h-3.5 w-3.5" />编辑</Button>
                      <Button variant="ghost" size="sm" className="text-red-500" onClick={() => deleteRule(rule)}><Trash2 className="h-3.5 w-3.5" />删除</Button>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {rule.conditions.map((condition, index) => <Badge key={index} variant="outline">{conditionText(condition)}</Badge>)}
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}><Plus className="mr-1.5 h-4 w-4" />新建组合告警</Button>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardHeader className="space-y-1 py-4">
              <CardTitle className="flex items-center gap-2 text-base"><BellRing className="h-4 w-4 text-amber-500" />组合触发记录</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {comboAlerts.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">暂无组合触发记录</p>
              ) : comboAlerts.map((alert) => (
                <div key={alert.id} className="rounded-lg border border-border/50 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <ComboStatus alert={alert} />
                    <span className="font-medium">{alert.rule_name}</span>
                    <Badge variant="secondary" className="font-mono">{alert.symbol}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{fmtTime(alert.created_at)}</span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {alert.signals.map((signal, index) => (
                      <p key={`${signal.id}-${index}`} className="break-words text-xs leading-relaxed text-muted-foreground">
                        {FILTER_CN[signal.filter_type]} · {signal.interval} · {signal.signal_group}｜触发 {fmtUtc(signal.trigger_time)}｜有效至 {fmtTime(signal.valid_until)}
                      </p>
                    ))}
                  </div>
                  {alert.webhook_ok === 0 && <p className="mt-2 text-xs text-red-500">{alert.webhook_error}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RuleEditor open={editorOpen} initial={editing} onOpenChange={setEditorOpen} onSaved={() => refresh(true)} />
    </div>
  )
}
