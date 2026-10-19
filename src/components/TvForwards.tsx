import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, Radio, Trash2 } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { TvForward } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'

function ForwardStatus({ r }: { r: TvForward }) {
  if (r.forward_ok === 1)
    return (
      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
        已送达
      </Badge>
    )
  if (r.forward_ok === 0)
    return (
      <Badge
        variant="outline"
        className="border-red-200 bg-red-50 text-red-600"
        title={r.forward_error || ''}
      >
        发送失败
      </Badge>
    )
  return (
    <Badge variant="outline" className="border-zinc-200 bg-zinc-100 text-zinc-500">
      发送中…
    </Badge>
  )
}

export default function TvForwards() {
  const [webhookUrl, setWebhookUrl] = useState('')
  const [items, setItems] = useState<TvForward[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (silent = false) => {
    try {
      const r = await api.tvForwards()
      setItems(r.items)
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    api
      .tvConfig()
      .then((c) => setWebhookUrl(`${window.location.origin}${c.webhook_path}`))
      .catch(() => setWebhookUrl(''))
    refresh()
    timer.current = setInterval(() => refresh(true), 10000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh])

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败，请手动选择复制')
    }
  }

  async function handleDelete(id: number) {
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

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="h-4 w-4 text-emerald-600" />
            TradingView Webhook 地址
          </CardTitle>
          <CardDescription>
            在 TradingView 告警的「Webhook
            URL」中填入下面的地址。告警消息支持纯文本或 JSON，收到后会立即转发到饭碗告警并在此留下记录。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
              {webhookUrl || '加载中…'}
            </code>
            <Button variant="outline" size="sm" onClick={copyUrl} disabled={!webhookUrl}>
              {copied ? (
                <Check className="mr-1.5 h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="mr-1.5 h-4 w-4" />
              )}
              复制
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            此地址即凭证，请勿泄露。部署到服务器后请使用你的域名访问本页面再复制（地址会带上域名）。
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
          <CardTitle className="text-base">转发记录</CardTitle>
          <Badge variant="outline" className="text-muted-foreground">
            {items.length} 条
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              加载中…
            </div>
          ) : items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              还没有转发记录，去 TradingView 建一个告警试试
            </p>
          ) : (
            items.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/50 px-3 py-2.5 text-sm"
              >
                <ForwardStatus r={r} />
                <span className="max-w-full truncate font-medium" title={r.raw_body}>
                  {r.summary || '(空消息)'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {fmtTime(r.received_at)}
                  {r.source_ip && `｜${r.source_ip}`}
                </span>
                <span className="ml-auto">
                  {busyId === r.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                      onClick={() => handleDelete(r.id)}
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
    </div>
  )
}
