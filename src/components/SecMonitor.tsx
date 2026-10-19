import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, FileText, Loader2, Plus, Trash2 } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { SecHit, SecStatus, SecTask } from '@/types'
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
import { toast } from 'sonner'

interface Props {
  hits: SecHit[]
  status: SecStatus | null
  onChanged: () => void
}

function CreateSecTaskDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [tickers, setTickers] = useState('')
  const [windowStart, setWindowStart] = useState('20:00')
  const [windowEnd, setWindowEnd] = useState('06:00')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const list = [...new Set(tickers.split(/[\s,，、;；]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))]
    if (list.length === 0) {
      toast.error('请至少填写一个标的代码')
      return
    }
    if (windowStart === windowEnd) {
      toast.error('开始与结束时间不能相同')
      return
    }
    setSubmitting(true)
    try {
      await api.createSecTask({
        tickers: list,
        window_start: windowStart,
        window_end: windowEnd,
        note: note.trim(),
      })
      toast.success('监听任务已创建')
      setOpen(false)
      setTickers('')
      setNote('')
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-emerald-600 text-white hover:bg-emerald-500">
          <Plus className="mr-1.5 h-4 w-4" />
          新建监听
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 SEC 财报监听</DialogTitle>
          <DialogDescription>
            在指定的北京时间窗口内监听 SEC EDGAR，一旦标的发布 10-Q / 10-K
            财报（含修订版）立即在页面弹出通知。窗口支持跨夜（如 20:00 – 次日 06:00）。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sec-tickers">标的代码（可多个）</Label>
            <Input
              id="sec-tickers"
              placeholder="例如 NVDA, AAPL, TSLA"
              value={tickers}
              onChange={(e) => setTickers(e.target.value)}
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">用逗号或空格分隔，创建时会用 SEC 官方名录校验</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="sec-start">开始时间（北京）</Label>
              <Input
                id="sec-start"
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sec-end">结束时间（北京）</Label>
              <Input
                id="sec-end"
                type="time"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sec-note">备注（可选）</Label>
            <Input
              id="sec-note"
              placeholder="例如：Q3 财报季"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              创建监听
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function SecMonitor({ hits, status, onChanged }: Props) {
  const [tasks, setTasks] = useState<SecTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [showBaseline, setShowBaseline] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshTasks = useCallback(async (silent = false) => {
    try {
      const r = await api.secTasks()
      setTasks(r.items)
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshTasks()
    timer.current = setInterval(() => refreshTasks(true), 5000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refreshTasks])

  async function handleDelete(id: number) {
    if (!window.confirm('确定删除该监听任务？已捕获的财报记录会保留。')) return
    setBusyId(id)
    try {
      await api.deleteSecTask(id)
      toast.success('监听任务已删除')
      await refreshTasks(true)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const freshHits = hits.filter((h) => !h.baseline)
  const baselineHits = hits.filter((h) => h.baseline)

  const hitRow = (h: SecHit) => (
    <div
      key={h.id}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2.5 text-sm"
    >
      <Badge
        variant="outline"
        className={
          h.form.startsWith('10-K')
            ? 'border-violet-200 bg-violet-50 text-violet-700'
            : 'border-sky-200 bg-sky-50 text-sky-700'
        }
      >
        {h.form}
      </Badge>
      <span className="font-bold">{h.ticker}</span>
      <span className="text-xs text-muted-foreground">申报日期 {h.filing_date}</span>
      <span className="text-xs text-muted-foreground">捕获于 {fmtTime(h.detected_at)}</span>
      {h.url && (
        <a
          href={h.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
        >
          查看 SEC 原文
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status === null
                ? 'bg-zinc-400'
                : status.in_window
                  ? status.ok === false
                    ? 'bg-red-500'
                    : 'bg-emerald-500'
                  : 'bg-zinc-400'
            }`}
          />
          {status === null
            ? 'SEC 监听状态加载中…'
            : status.in_window
              ? `窗口内监听中${status.watching.length ? `：${status.watching.join(', ')}` : ''}${
                  status.last_poll ? `｜上次轮询 ${fmtTime(status.last_poll)}` : ''
                }`
              : '当前在所有任务的窗口外，暂停请求 SEC'}
        </p>
        <CreateSecTaskDialog onCreated={() => refreshTasks(true)} />
      </div>

      {status?.in_window && status.ok === false && status.error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          SEC 轮询异常：{status.error}
        </p>
      )}

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-emerald-600" />
              监听任务
            </CardTitle>
            <CardDescription>
              窗口内每 15 秒抓一次 SEC 全市场最新申报 feed（每轮固定 2 个请求，所有标的共享）
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-muted-foreground">
            {tasks.length} 个
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              加载中…
            </div>
          ) : tasks.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              还没有监听任务，点击右上角「新建监听」开始
            </p>
          ) : (
            tasks.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2.5 text-sm"
              >
                <span className="flex flex-wrap gap-1">
                  {t.tickers.map((tk) => (
                    <Badge key={tk} variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                      {tk}
                    </Badge>
                  ))}
                </span>
                <span className="text-xs text-muted-foreground">
                  北京时间 {t.window_start} – {t.window_end}
                </span>
                {t.note && <span className="text-xs text-muted-foreground">｜{t.note}</span>}
                <span className="ml-auto">
                  {busyId === t.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                      onClick={() => handleDelete(t.id)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      删除
                    </Button>
                  )}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <CardTitle className="text-base">财报捕获记录</CardTitle>
          <Badge variant="outline" className="text-muted-foreground">
            {freshHits.length} 条
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {freshHits.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              还没有捕获到新财报。任务创建后新发布的 10-Q / 10-K 会第一时间出现在这里并弹窗提醒。
            </p>
          ) : (
            freshHits.map(hitRow)
          )}
          {baselineHits.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline"
                onClick={() => setShowBaseline((v) => !v)}
              >
                {showBaseline ? '收起' : '展开'}任务创建前的存量记录（{baselineHits.length} 条）
              </button>
              {showBaseline && (
                <div className="mt-2 space-y-2 opacity-60">{baselineHits.map(hitRow)}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
