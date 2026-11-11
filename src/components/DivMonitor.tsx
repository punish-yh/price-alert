import { useCallback, useEffect, useState } from 'react'
import { BellRing, Loader2, Pencil, Plus, Save, Trash2, TrendingDown, TrendingUp } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type {
  DivAlert,
  DivDetail,
  DivDirection,
  DivInterval,
  DivKind,
  DivOverviewInterval,
  DivRule,
} from '@/types'
import DivCharts, { DIV_KIND_CN } from '@/components/DivCharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
const DIRECTION_CN: Record<DivRule['direction'], string> = {
  both: '顶 + 底双向',
  top: '仅顶背离',
  bottom: '仅底背离',
}

function emptyRule(): DivRule {
  return {
    id: 0,
    name: '',
    kinds: [...KINDS],
    min_count: 2,
    intervals: [...INTERVALS],
    direction: 'both',
    notify_webhook: true,
    enabled: true,
  }
}

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
    return `${fmtT(det.a1_start, interval)} → ${fmtT(det.a2_end, interval)}，价 ${fmtNum(det.p1)} → ${fmtNum(det.p2)}，面积 ${fmtNum(det.area1)} → ${fmtNum(det.area2)}`
  }
  return `${fmtT(det.p1_time, interval)} 价 ${fmtNum(det.p1_price)} → ${fmtT(det.p2_time, interval)} 价 ${fmtNum(det.p2_price)}，指标 ${fmtNum(det.v1)} → ${fmtNum(det.v2)}`
}

// ---------------- 自定义组合规则 ----------------

function RuleEditor({
  open,
  initial,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  initial: DivRule | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<DivRule>(emptyRule)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setDraft(initial ? { ...initial, kinds: [...initial.kinds], intervals: [...initial.intervals] } : emptyRule())
  }, [open, initial])

  function toggleKind(kind: DivKind, checked: boolean) {
    setDraft((old) => {
      const kinds = checked ? [...old.kinds, kind] : old.kinds.filter((k) => k !== kind)
      return { ...old, kinds, min_count: Math.min(old.min_count, Math.max(2, kinds.length)) }
    })
  }

  function toggleInterval(interval: DivInterval, checked: boolean) {
    setDraft((old) => ({
      ...old,
      intervals: checked ? [...old.intervals, interval] : old.intervals.filter((i) => i !== interval),
    }))
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      toast.error('请填写规则名称')
      return
    }
    if (draft.kinds.length === 0) {
      toast.error('请至少选择一种背离')
      return
    }
    if (draft.intervals.length === 0) {
      toast.error('请至少选择一个生效周期')
      return
    }
    if (draft.min_count > draft.kinds.length) {
      toast.error('数量阈值不能大于已选背离种类数')
      return
    }
    setSaving(true)
    try {
      await api.saveDivRule({ ...draft, name: draft.name.trim() })
      toast.success(`组合「${draft.name.trim()}」已保存，下一轮检测（5 分钟内）生效`)
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑告警组合' : '新建告警组合'}</DialogTitle>
          <DialogDescription>
            同一方向、同一周期内，所选成员中同时成立的背离种类数达到阈值时触发；解除后可再次告警
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="div-rule-name">规则名称</Label>
            <Input
              id="div-rule-name"
              value={draft.name}
              maxLength={50}
              placeholder="例如：RSI + MACD 共振"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>参与组合的背离种类</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                  <Checkbox checked={draft.kinds.includes(kind)} onCheckedChange={(v) => toggleKind(kind, v === true)} />
                  {DIV_KIND_CN[kind]}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>数量阈值</Label>
              <Select value={String(draft.min_count)} onValueChange={(v) => setDraft({ ...draft, min_count: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)} disabled={n > draft.kinds.length}>≥ {n} 种</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>告警方向</Label>
              <Select value={draft.direction} onValueChange={(v) => setDraft({ ...draft, direction: v as DivRule['direction'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">顶 + 底双向</SelectItem>
                  <SelectItem value="top">仅顶背离</SelectItem>
                  <SelectItem value="bottom">仅底背离</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
          </div>
          <div className="space-y-2">
            <Label>生效周期</Label>
            <div className="flex gap-4">
              {INTERVALS.map((iv) => (
                <label key={iv} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={draft.intervals.includes(iv)} onCheckedChange={(v) => toggleInterval(iv, v === true)} />
                  {iv}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
            启用这条规则
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            保存组合
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RulesPanel({ rules, onChanged }: { rules: DivRule[]; onChanged: () => void }) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<DivRule | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  async function toggleRule(rule: DivRule, enabled: boolean) {
    setBusyId(rule.id)
    try {
      await api.saveDivRule({ ...rule, enabled })
      toast.success(`已${enabled ? '启用' : '停用'}「${rule.name}」`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  async function removeRule(rule: DivRule) {
    if (!window.confirm(`删除组合「${rule.name}」？历史告警记录会保留。`)) return
    setBusyId(rule.id)
    try {
      await api.deleteDivRule(rule.id)
      toast.success('组合已删除')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <div className="space-y-3">
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
            暂无组合规则，背离检测和图表仍会运行，但不会触发告警
          </p>
        ) : (
          rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-border/60 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{rule.name}</span>
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">≥ {rule.min_count} 种</Badge>
                <Badge variant="outline">{DIRECTION_CN[rule.direction]}</Badge>
                <Badge variant="outline">{rule.intervals.join(' / ')}</Badge>
                <span className="text-xs text-muted-foreground">{rule.notify_webhook ? '网页 + 饭碗' : '仅网页'}</span>
                <span className="flex w-full flex-wrap items-center gap-1 sm:ml-auto sm:w-auto">
                  {busyId === rule.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Switch checked={rule.enabled} onCheckedChange={(v) => toggleRule(rule, v)} disabled={busyId !== null} />
                  <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => { setEditing(rule); setEditorOpen(true) }}>
                    <Pencil className="h-3.5 w-3.5" />编辑
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 px-2 text-red-500" onClick={() => removeRule(rule)} disabled={busyId !== null}>
                    <Trash2 className="h-3.5 w-3.5" />删除
                  </Button>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {rule.kinds.map((kind) => (
                  <Badge key={kind} variant="secondary">{DIV_KIND_CN[kind]}</Badge>
                ))}
              </div>
            </div>
          ))
        )}
        <Button variant="outline" size="sm" onClick={() => { setEditing(null); setEditorOpen(true) }}>
          <Plus className="mr-1.5 h-4 w-4" />新建组合
        </Button>
      </div>
      <RuleEditor open={editorOpen} initial={editing} onOpenChange={setEditorOpen} onSaved={onChanged} />
    </>
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
                  <li key={kind} className="break-words text-xs leading-relaxed">
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
  const [rules, setRules] = useState<DivRule[]>([])
  const [status, setStatus] = useState<{ ok: boolean | null; error: string } | null>(null)
  const [showHistory, setShowHistory] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busyRead, setBusyRead] = useState(false)

  const refresh = useCallback(async (silent = false) => {
    try {
      const r = await api.divOverview()
      setOverview(r.intervals)
      setRules(r.rules)
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
        <CardHeader className="flex flex-col items-start gap-3 space-y-0 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">BTCUSDT 背离监控</CardTitle>
            <CardDescription>
              每 5 分钟检测一次（含正在走的 K 线）；展示最近 365 根 K 线及全部当前、历史背离信号
            </CardDescription>
          </div>
          <Tabs value={interval} onValueChange={(v) => setInterval(v as DivInterval)}>
            <TabsList>
              {INTERVALS.map((iv) => (
                <TabsTrigger key={iv} value={iv}>{iv}</TabsTrigger>
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
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />加载中…
            </div>
          ) : !current ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              暂无 {interval} 数据，等待下一轮检测（服务启动后约 1 分钟内有数据）
            </p>
          ) : (
            <>
              <DivergenceBoard overview={current} interval={interval} />
              <div className="rounded-lg border border-border/50 p-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
                  <span>深色线＝当前信号，浅色虚线＝历史信号；文字标注背离种类</span>
                  <label className="flex items-center gap-2">
                    <Switch checked={showHistory} onCheckedChange={setShowHistory} />
                    显示历史背离（{current.history?.length ?? 0}）
                  </label>
                </div>
                <DivCharts overview={current} interval={interval} showHistory={showHistory} />
              </div>
              <p className="text-right text-xs text-muted-foreground">
                {current.candles.length} 根 K 线 · 数据更新于 {fmtTime(current.updated_at)}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="space-y-1 py-4">
          <CardTitle className="text-base">告警组合规则</CardTitle>
          <CardDescription>
            可创建多条规则，每条自由组合背离种类、数量阈值、生效周期和方向；网页告警必选，饭碗可单独关闭
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <RulesPanel rules={rules} onChanged={() => refresh(true)} />
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex flex-col items-start gap-3 space-y-0 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">背离告警记录</CardTitle>
            {unread > 0 && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{unread} 未读</Badge>
            )}
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
          ) : (
            alerts.map((a) => {
              const unreadRow = !a.read_at
              const top = a.direction === 'top'
              return (
                <div key={a.id} className={`rounded-lg border px-3 py-2.5 text-sm ${unreadRow ? 'border-amber-300 bg-amber-50/60' : 'border-border/50 text-zinc-500'}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <Badge variant="outline" className={top ? 'border-red-300 bg-red-50 text-red-600' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}>
                      {top ? '顶背离' : '底背离'}
                    </Badge>
                    <span className="font-mono font-semibold">{a.symbol}</span>
                    <Badge variant="outline" className="text-muted-foreground">{a.interval}</Badge>
                    <Badge variant="secondary">规则：{a.rule_name || '旧版默认组合'}</Badge>
                    <span className="text-xs text-muted-foreground">{a.kinds.length} 种 ≥ 阈值 {a.min_count}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{fmtTime(a.created_at)}</span>
                      {unreadRow && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => handleRead(a.id)}>已阅</Button>}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.kinds.map((kind) => (
                      <Badge key={kind} variant="outline" className={top ? 'border-red-200 text-red-600' : 'border-emerald-200 text-emerald-700'}>
                        {DIV_KIND_CN[kind]}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {a.kinds.map((kind) => {
                      const det = a.details[kind]
                      return det ? (
                        <p key={kind} className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                          {DIV_KIND_CN[kind]}：{detailText(kind, det, a.interval)}
                        </p>
                      ) : null
                    })}
                  </div>
                  {a.webhook_ok === 0 && <p className="mt-1 text-xs text-red-500">饭碗发送失败：{a.webhook_error}</p>}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}
