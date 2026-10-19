import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BellRing,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { fmtPrice, fmtTime } from '@/lib/api'
import type { Monitor } from '@/types'
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

const STATUS_META: Record<Monitor['status'], { label: string; cls: string }> = {
  active: { label: '活跃', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  triggered: { label: '已触发', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  deleted: { label: '已删除', cls: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
}

interface Props {
  symbol: string
  monitors: Monitor[]
  price?: number
  onDelete: (id: number) => Promise<void>
  onRestore: (id: number) => Promise<void>
}

export default function MonitorGroup({ symbol, monitors, price, onDelete, onRestore }: Props) {
  const prevPrice = useRef<number | undefined>(undefined)
  const [tick, setTick] = useState<'up' | 'down' | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    if (price !== undefined && prevPrice.current !== undefined && price !== prevPrice.current) {
      setTick(price > prevPrice.current ? 'up' : 'down')
      const t = setTimeout(() => setTick(null), 600)
      return () => clearTimeout(t)
    }
    prevPrice.current = price
  }, [price])

  useEffect(() => {
    prevPrice.current = price
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  async function run(id: number, fn: (id: number) => Promise<void>) {
    setBusyId(id)
    try {
      await fn(id)
    } finally {
      setBusyId(null)
    }
  }

  const priceColor =
    tick === 'up' ? 'text-emerald-600' : tick === 'down' ? 'text-red-500' : 'text-zinc-700'

  return (
    <Card className="border-border/60">
      <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-bold tracking-wide">{symbol}</span>
          <span className={`font-mono text-sm tabular-nums transition-colors ${priceColor}`}>
            {price !== undefined ? fmtPrice(price) : '—'}
          </span>
        </div>
        <Badge variant="outline" className="text-muted-foreground">
          {monitors.length} 条监控
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {monitors.map((m) => {
          const meta = STATUS_META[m.status]
          const distance =
            price !== undefined && m.status === 'active'
              ? ((m.target_price - price) / price) * 100
              : null
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

              <span className="flex items-center gap-1 font-medium">
                {m.direction === 'above' ? (
                  <ArrowUpToLine className="h-4 w-4 text-emerald-600" />
                ) : (
                  <ArrowDownToLine className="h-4 w-4 text-red-500" />
                )}
                {m.direction === 'above' ? '≥' : '≤'}
                <span className="font-mono tabular-nums">{fmtPrice(m.target_price)}</span>
              </span>

              {distance !== null && (
                <span
                  className={`font-mono text-xs tabular-nums ${
                    distance >= 0 ? 'text-emerald-600' : 'text-red-500'
                  }`}
                >
                  距现价 {distance >= 0 ? '+' : ''}
                  {distance.toFixed(2)}%
                </span>
              )}

              {m.note && <span className="text-xs text-muted-foreground">｜{m.note}</span>}

              {m.status === 'triggered' && (
                <span className="text-xs text-muted-foreground">
                  ｜触发于 {fmtTime(m.triggered_at)}，K线极值 {fmtPrice(m.trigger_price)}
                  {m.webhook_ok === 1 && <span className="text-emerald-600">，通知已送达</span>}
                  {m.webhook_ok === 0 && (
                    <span className="text-red-500" title={m.webhook_error || ''}>
                      ，通知发送失败
                    </span>
                  )}
                </span>
              )}

              <span className="ml-auto flex items-center gap-1.5">
                {busyId === m.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}

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
                          {m.symbol} {m.direction === 'above' ? '≥' : '≤'}{' '}
                          {fmtPrice(m.target_price)} 将被永久删除，无法恢复。
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
  )
}
