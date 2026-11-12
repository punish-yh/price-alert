import { useCallback, useEffect, useState } from 'react'
import { BellRing, Check, Copy, Loader2, Pencil, Plus, Radio, Save, Trash2 } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { TvComboAlert, TvComboRule, TvCondition, TvForward } from '@/types'
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
}
const INTERVALS = ['15m', '1h', '4h', '1d'] as const

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
  const bullish = direction === 'bullish'
  return (
    <Badge variant="outline" className={bullish ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-600'}>
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
          <DialogDescription>同一币种的全部条件同时处于有效窗口时触发；每个条件可独立选择过滤器、周期和方向</DialogDescription>
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

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4 text-emerald-600" />TradingView Webhook 地址</CardTitle>
          <CardDescription>地址保持不变。收到消息后只解析并维护有效信号，不再逐条直接转发；满足下方组合后才告警。</CardDescription>
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
            <p className="mt-2 leading-relaxed">周期仅支持 15m、1h、4h、1d；有效期按 UTC 触发时间对齐至下一自然周期边界。</p>
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
              <CardDescription>保留原始消息、结构化结果和解析失败原因；旧版记录也会继续保留</CardDescription>
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
              <CardDescription>同一币种、过滤器、周期和方向只展示最新一条；到期后自动移出，无需手动清理</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {currentActive.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">当前没有处于有效期内的信号</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {currentActive.map((signal) => (
                    <div key={signal.id} className="rounded-lg border border-border/60 px-3 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2"><SignalBadges signal={signal} /></div>
                      <p className="mt-2 font-mono font-semibold">{signal.exchange}:{signal.symbol}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">触发：{fmtUtc(signal.trigger_time)}<br />有效至：{fmtTime(signal.valid_until)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <Card className="border-border/60">
            <CardHeader className="space-y-1 py-4">
              <CardTitle className="text-base">当前配置的组合告警</CardTitle>
              <CardDescription>全部条件同时有效才触发；同一组合窗口只告警一次，任一条件失效后重新武装</CardDescription>
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
              <CardDescription>记录每次触发时实际命中的周期、过滤器、方向与有效窗口</CardDescription>
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
