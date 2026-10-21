import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { SecHit, SecStatus, SecTask, SecTaskState } from '@/types'
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

/** 今天（本地时区，即北京时间）的 YYYY-MM-DD，用作监听日期默认值 */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 当前时间 + minutesAhead 分钟后的 HH:MM（本地时区） */
function nowHM(minutesAhead = 0): string {
  const d = new Date(Date.now() + minutesAhead * 60_000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const TASK_STATUS_META: Record<SecTaskState, { label: string; cls: string }> = {
  pending: { label: '未启动', cls: 'border-zinc-300 bg-zinc-100 text-zinc-600' },
  listening: { label: '监听中', cls: 'border-sky-300 bg-sky-50 text-sky-700' },
  acquired: { label: '已获取', cls: 'border-emerald-300 bg-emerald-50 text-emerald-700' },
  failed: { label: '监听失败', cls: 'border-red-300 bg-red-50 text-red-600' },
}

function SecTaskDialog({ initial, onSaved }: { initial?: SecTask; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [tickers, setTickers] = useState('')
  const [watchDate, setWatchDate] = useState(todayStr)
  const [windowStart, setWindowStart] = useState('20:00')
  const [windowEnd, setWindowEnd] = useState('06:00')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 只在打开对话框时回填一次；任务列表每 3 秒刷新会换新 initial 对象，不能因此重置输入
  const initializedFor = useRef<string | null>(null)

  // 打开对话框时初始化：编辑用现有值；新建默认「监听日期=今天，窗口=未来 1~21 分钟」
  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    const key = initial ? `edit:${initial.id}` : 'new'
    if (initializedFor.current === key) return
    initializedFor.current = key
    setTickers(initial ? initial.tickers.join(', ') : '')
    setWatchDate(initial?.watch_date || todayStr())
    setWindowStart(initial?.window_start || nowHM(1))
    setWindowEnd(initial?.window_end || nowHM(21))
    setNote(initial?.note || '')
  }, [open, initial])

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
      const payload = {
        tickers: list,
        forms: ['8-K'],
        watch_date: watchDate,
        window_start: windowStart,
        window_end: windowEnd,
        note: note.trim(),
      }
      if (initial) {
        await api.updateSecTask(initial.id, payload)
        toast.success('监听任务已更新')
      } else {
        await api.createSecTask(payload)
        toast.success('监听任务已创建')
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
            新建监听
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑 SEC 财报监听' : '新建 SEC 财报监听'}</DialogTitle>
          <DialogDescription>
            只在指定的「日期 + 北京时间窗口」内监听 SEC EDGAR，窗口支持跨夜（如 20:00 –
            次日 06:00）。标的发布 8-K 业绩公告（含 Item 2.02 的业绩发布稿，追涨最敏感的信号；
            其余 8-K 公告不通知）即视为已获取，页面弹窗提醒；窗口结束仍未捕获则标记为监听失败。
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
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="sec-date">监听日期（北京）</Label>
              <Input
                id="sec-date"
                type="date"
                value={watchDate}
                onChange={(e) => setWatchDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sec-start">开始时间</Label>
              <Input
                id="sec-start"
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sec-end">结束时间</Label>
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
              {initial ? '保存修改' : '创建监听'}
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
  const [markingId, setMarkingId] = useState<number | null>(null)
  const [markingAll, setMarkingAll] = useState(false)
  const [showBaseline, setShowBaseline] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshTasks = useCallback(async (silent = false) => {
    try {
      const r = await api.secTasks()
      // 按「监听日期 + 开始时间」升序：最先触发的排在最上面
      setTasks(
        [...r.items].sort(
          (a, b) =>
            `${a.watch_date} ${a.window_start}`.localeCompare(`${b.watch_date} ${b.window_start}`) ||
            a.id - b.id
        )
      )
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshTasks()
    timer.current = setInterval(() => refreshTasks(true), 3000)
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

  async function handleMarkRead(id: number) {
    setMarkingId(id)
    try {
      await api.markSecHitRead(id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '标记已阅失败')
    } finally {
      setMarkingId(null)
    }
  }

  async function handleMarkAllRead() {
    setMarkingAll(true)
    try {
      const r = await api.markAllSecHitsRead()
      if (r.marked > 0) toast.success(`已将 ${r.marked} 条财报标记为已阅`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '标记已阅失败')
    } finally {
      setMarkingAll(false)
    }
  }

  const freshHits = hits.filter((h) => !h.baseline)
  const baselineHits = hits.filter((h) => h.baseline)
  const unreadCount = freshHits.filter((h) => !h.read_at).length

  const hitRow = (h: SecHit) => {
    const unread = !h.read_at
    return (
      <div
        key={h.id}
        className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm ${
          h.baseline
            ? 'border-border/50'
            : unread
              ? 'border-amber-200/70 bg-amber-50/30'
              : 'border-border/50 opacity-65'
        }`}
      >
        <Badge
          variant="outline"
          className={
            h.form.startsWith('8-K')
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : h.form.startsWith('10-K')
                ? 'border-violet-200 bg-violet-50 text-violet-700'
                : 'border-sky-200 bg-sky-50 text-sky-700'
          }
        >
          {h.form.startsWith('8-K') ? `${h.form.split('/')[0]} 业绩` : h.form}
        </Badge>
        <span className="font-bold">{h.ticker}</span>
        <span className="text-xs text-muted-foreground">申报日期 {h.filing_date}</span>
        <span className="text-xs text-muted-foreground">捕获于 {fmtTime(h.detected_at)}</span>
        <span className="ml-auto flex items-center gap-2">
          {h.url && (
            <a
              href={h.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"
            >
              查看 SEC 原文
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {!h.baseline &&
            (unread ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 border-amber-300 bg-white px-2 text-xs text-amber-700 hover:bg-amber-50"
                disabled={markingId !== null || markingAll}
                onClick={() => handleMarkRead(h.id)}
              >
                {markingId === h.id ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCheck className="mr-1 h-3.5 w-3.5" />
                )}
                已阅
              </Button>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-xs text-zinc-400"
                title={h.read_at ? `已阅于 ${fmtTime(h.read_at)}` : ''}
              >
                <Check className="h-3 w-3" />
                已阅
              </span>
            ))}
        </span>
      </div>
    )
  }

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
        <SecTaskDialog onSaved={() => refreshTasks(true)} />
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
              窗口内每 {Math.round(status?.poll_interval ?? 15)} 秒抓一次 SEC 全市场最新 8-K 申报 feed——每轮 1
              个请求即覆盖全部标的（与标的数量无关）；SEC 10 req/s 为共享突发限速，轮询快慢由 SEC_POLL_INTERVAL 调节
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
            tasks.map((t) => {
              const meta = TASK_STATUS_META[t.task_status] ?? TASK_STATUS_META.pending
              return (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2.5 text-sm"
                >
                  <Badge variant="outline" className={meta.cls}>
                    {t.task_status === 'acquired' && <CheckCircle2 className="mr-1 h-3 w-3" />}
                    {meta.label}
                  </Badge>
                  <span className="flex flex-wrap gap-1">
                    {t.tickers.map((tk) => (
                      <Badge key={tk} variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                        {tk}
                      </Badge>
                    ))}
                    {t.forms.map((fm) => (
                      <Badge key={fm} variant="outline" className="text-muted-foreground">
                        {fm === '8-K' ? '8-K 业绩' : fm}
                      </Badge>
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.watch_date} 北京时间 {t.window_start} – {t.window_end}
                  </span>
                  {t.task_status === 'acquired' && t.hit_count > 0 && (
                    <span className="text-xs text-emerald-600">已捕获 {t.hit_count} 份</span>
                  )}
                  {t.note && <span className="text-xs text-muted-foreground">｜{t.note}</span>}
                  <span className="ml-auto flex items-center gap-1.5">
                    <SecTaskDialog initial={t} onSaved={() => refreshTasks(true)} />
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
              )
            })
          )}
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="grid-cols-[1fr_auto] items-center space-y-0 py-4">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">财报捕获记录</CardTitle>
            {unreadCount > 0 && (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                未读 {unreadCount}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                disabled={markingAll || markingId !== null}
                onClick={handleMarkAllRead}
              >
                {markingAll ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCheck className="mr-1 h-3.5 w-3.5" />
                )}
                全部已阅
              </Button>
            )}
            <Badge variant="outline" className="text-muted-foreground">
              {freshHits.length} 条
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {freshHits.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              还没有捕获到新财报。任务创建后新发布的 8-K 业绩公告会第一时间出现在这里并弹窗提醒。
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
