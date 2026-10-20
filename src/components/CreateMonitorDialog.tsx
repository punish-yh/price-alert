import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
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
import { toast } from 'sonner'
import type { Direction, Monitor } from '@/types'

interface Props {
  prices: Record<string, number>
  initial?: Monitor
  onSaved: () => void
}

/** 价格监控新建 / 编辑对话框（initial 传入即为编辑） */
export default function MonitorDialog({ prices, initial, onSaved }: Props) {
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [direction, setDirection] = useState<Direction>('above')
  const [price, setPrice] = useState('')
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
    setDirection(initial?.direction || 'above')
    setPrice(initial ? String(initial.target_price) : '')
    setNote(initial?.note || '')
  }, [open, initial])

  const currentPrice = prices[symbol.trim().toUpperCase()]
  // 输入时按子串过滤（交易对数量已超 500，全量渲染 datalist 会截断 Z 开头等尾部标的）
  const symbolOptions = symbol.trim()
    ? symbols.filter((s) => s.includes(symbol.trim().toUpperCase())).slice(0, 100)
    : symbols.slice(0, 100)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const target = Number(price)
    if (!symbol.trim() || !target || target <= 0) {
      toast.error('请填写正确的交易对和目标价')
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        symbol: symbol.trim().toUpperCase(),
        direction,
        target_price: target,
        note: note.trim(),
      }
      if (initial) {
        await api.updateMonitor(initial.id, payload)
        toast.success('监控已更新')
      } else {
        await api.createMonitor(payload)
        toast.success('监控已创建')
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
          <DialogTitle>{initial ? '编辑价格监控' : '新建价格监控'}</DialogTitle>
          <DialogDescription>
            每 5 分钟检查一次 5 分钟 K 线。标准价为现货与 USDT 永续合约按成交额加权的综合价
            （一边不存在时自动忽略）。综合 K 线的 开 / 收 / 高 / 低
            任一价格触及目标价即触发一次饭碗告警通知。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
            {currentPrice !== undefined && (
              <button
                type="button"
                className="text-xs text-emerald-500 hover:underline"
                onClick={() => setPrice(String(currentPrice))}
              >
                当前价 {currentPrice}（点击填入）
              </button>
            )}
          </div>
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
