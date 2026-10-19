import { useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
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
import type { Direction } from '@/types'

interface Props {
  prices: Record<string, number>
  onCreated: () => void
  onError: (msg: string) => void
}

export default function CreateMonitorDialog({ prices, onCreated, onError }: Props) {
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

  const currentPrice = prices[symbol.trim().toUpperCase()]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const target = Number(price)
    if (!symbol.trim() || !target || target <= 0) {
      onError('请填写正确的交易对和目标价')
      return
    }
    setSubmitting(true)
    try {
      await api.createMonitor({
        symbol: symbol.trim().toUpperCase(),
        direction,
        target_price: target,
        note: note.trim(),
      })
      setOpen(false)
      setSymbol('')
      setPrice('')
      setNote('')
      setDirection('above')
      onCreated()
    } catch (err) {
      onError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-emerald-600 text-white hover:bg-emerald-500">
          <Plus className="mr-1.5 h-4 w-4" />
          新建监控
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建价格监控</DialogTitle>
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
              {symbols.slice(0, 500).map((s) => (
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
              创建监控
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
