import { useEffect, useRef, useState } from 'react'
import { Loader2, Pencil, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
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
import { toast } from 'sonner'
import type { Direction, Monitor, MonitorType } from '@/types'

const EMA_PERIODS = [21, 55, 100, 200]
const EMA_INTERVALS = ['15m', '1h', '4h', '1d']

interface Props {
  prices: Record<string, number>
  initial?: Monitor
  onSaved: () => void
}

/** 价格 / EMA 监控新建对话框；initial 传入时为价格监控编辑 */
export default function MonitorDialog({ prices, initial, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [monitorType, setMonitorType] = useState<MonitorType>('price')
  const [symbol, setSymbol] = useState('')
  const [direction, setDirection] = useState<Direction>('above')
  const [price, setPrice] = useState('')
  const [interval, setInterval] = useState('1h')
  const [emaPeriod, setEmaPeriod] = useState('55')
  const [note, setNote] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  // 只在打开对话框时回填一次；父组件每 3 秒刷新会换新 initial 对象，不能因此重置输入
  const initializedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .symbols()
      .then((r) => setSymbols(r.symbols))
      .catch(() => setSymbols([]))
  }, [open])

  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    // 同一次打开只回填一次：刷新轮询会替换 initial 对象，但不应覆盖用户正在输入的内容
    const key = initial ? `edit:${initial.id}` : 'new'
    if (initializedFor.current === key) return
    initializedFor.current = key
    setMonitorType('price')
    setSymbol(initial?.symbol || '')
    setDirection(initial?.direction || 'above')
    setPrice(initial ? String(initial.target_price) : '')
    setInterval('1h')
    setEmaPeriod('55')
    setNote(initial?.note || '')
  }, [open, initial])

  const currentPrice = prices[symbol.trim().toUpperCase()]
  // 输入时按子串过滤（交易对数量已超 500，全量渲染 datalist 会截断 Z 开头等尾部标的）
  const symbolOptions = symbol.trim()
    ? symbols.filter((s) => s.includes(symbol.trim().toUpperCase())).slice(0, 100)
    : symbols.slice(0, 100)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol.trim()) {
      toast.error('请填写交易对')
      return
    }
    const target = Number(price)
    if (monitorType === 'price' && (!target || target <= 0)) {
      toast.error('请填写正确的目标价')
      return
    }
    setSubmitting(true)
    try {
      const normalizedSymbol = symbol.trim().toUpperCase()
      if (initial) {
        await api.updateMonitor(initial.id, {
          symbol: normalizedSymbol,
          direction,
          target_price: target,
          note: note.trim(),
        })
        toast.success('监控已更新')
      } else if (monitorType === 'ema_cross') {
        await api.createEmaMonitor({
          symbol: normalizedSymbol,
          ema_period: Number(emaPeriod),
          interval,
          note: note.trim(),
        })
        toast.success('EMA 监控已创建，将在下一根 K 线收盘后开始判定')
      } else {
        await api.createMonitor({
          symbol: normalizedSymbol,
          direction,
          target_price: target,
          note: note.trim(),
        })
        toast.success('价格监控已创建')
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
            新建监控
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑价格监控' : '新建监控'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {!initial && (
            <div className="space-y-2">
              <Label>监控类型</Label>
              <Select value={monitorType} onValueChange={(v) => setMonitorType(v as MonitorType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="price">价格监控</SelectItem>
                  <SelectItem value="ema_cross">EMA 均线监控</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="symbol">交易对</Label>
            <Input
              id="symbol"
              placeholder="例如 BTCUSDT"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              list="symbol-list"
              autoComplete="off"
              required
            />
            <datalist id="symbol-list">
              {symbolOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {monitorType === 'price' && currentPrice !== undefined && (
              <button
                type="button"
                className="text-xs text-emerald-500 hover:underline"
                onClick={() => setPrice(String(currentPrice))}
              >
                当前价 {currentPrice}（点击填入）
              </button>
            )}
          </div>
          {!initial && monitorType === 'ema_cross' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>K 线周期</Label>
                <Select value={interval} onValueChange={setInterval}>
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
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>触发方向</Label>
                <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="above">大于</SelectItem>
                    <SelectItem value="below">小于</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="price">目标价 (USDT)</Label>
                <Input
                  id="price"
                  type="number"
                  step="any"
                  min="0"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  required
                />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="note">备注（可选）</Label>
            <Input
              id="note"
              placeholder="例如：突破前高，准备加仓"
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
