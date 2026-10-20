import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bell, FileSearch, LineChart, Loader2, LogOut, Radio, TrendingUp } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { Monitor, MonitorStatus, PricesResponse, SecHit, SecStatus } from '@/types'
import CreateMonitorDialog from '@/components/CreateMonitorDialog'
import EmaMonitors from '@/components/EmaMonitors'
import MonitorGroup from '@/components/MonitorGroup'
import SecMonitor from '@/components/SecMonitor'
import TvForwards from '@/components/TvForwards'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'

const TABS: { value: MonitorStatus; label: string }[] = [
  { value: 'active', label: '活跃' },
  { value: 'triggered', label: '已触发' },
  { value: 'deleted', label: '已删除' },
]

type View = 'monitors' | 'ema' | 'tv' | 'sec'

export default function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [priceInfo, setPriceInfo] = useState<PricesResponse | null>(null)
  const [secHits, setSecHits] = useState<SecHit[]>([])
  const [secStatus, setSecStatus] = useState<SecStatus | null>(null)
  const [tab, setTab] = useState<MonitorStatus>('active')
  const [view, setView] = useState<View>('monitors')
  const [loading, setLoading] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSecHitId = useRef<number | null>(null)

  const refresh = useCallback(async (silent = false) => {
    try {
      const [m, p, s] = await Promise.all([api.monitors(), api.prices(), api.secHits()])
      setMonitors(m.items)
      setPriceInfo(p)
      setSecHits(s.items)
      setSecStatus(s.status)
      // 新捕获的财报（非存量）第一时间弹窗，任意页面都会提醒
      const fresh = s.items.filter((h) => !h.baseline)
      const maxId = fresh.length ? Math.max(...fresh.map((h) => h.id)) : 0
      if (lastSecHitId.current === null) {
        lastSecHitId.current = maxId
      } else if (maxId > lastSecHitId.current) {
        for (const h of fresh.filter((x) => x.id > lastSecHitId.current!).reverse()) {
          const isEarnings8k = h.form.startsWith('8-K')
          toast.success(
            isEarnings8k ? `${h.ticker} 发布业绩公告（8-K）` : `${h.ticker} 发布 ${h.form} 财报`,
            {
              description: `申报日期 ${h.filing_date}`,
              duration: 15000,
              action: h.url
                ? { label: '查看原文', onClick: () => window.open(h.url, '_blank') }
                : undefined,
            }
          )
        }
        lastSecHitId.current = maxId
      }
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    timer.current = setInterval(() => refresh(true), 3000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh])

  const priceMonitors = useMemo(() => monitors.filter((m) => m.type === 'price'), [monitors])
  const emaMonitors = useMemo(() => monitors.filter((m) => m.type === 'ema_cross'), [monitors])

  const counts = useMemo(() => {
    const c: Record<MonitorStatus, number> = { active: 0, triggered: 0, deleted: 0 }
    for (const m of priceMonitors) c[m.status] += 1
    return c
  }, [priceMonitors])

  const emaActiveCount = useMemo(
    () => emaMonitors.filter((m) => m.status === 'active').length,
    [emaMonitors]
  )

  const groups = useMemo(() => {
    const filtered = priceMonitors.filter((m) => m.status === tab)
    const map = new Map<string, Monitor[]>()
    for (const m of filtered) {
      const arr = map.get(m.symbol) || []
      arr.push(m)
      map.set(m.symbol, arr)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [priceMonitors, tab])

  async function handleDelete(id: number) {
    try {
      const r = await api.deleteMonitor(id)
      toast.success(r.result === 'purged' ? '已彻底删除' : '已移入「已删除」')
      await refresh(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleRestore(id: number) {
    try {
      await api.restoreMonitor(id)
      toast.success('已重新激活')
      await refresh(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function handleLogout() {
    try {
      await api.logout()
    } finally {
      onLogout()
    }
  }

  const pollerOk = priceInfo?.poller_ok

  const navItem = (v: View, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setView(v)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        view === v
          ? 'bg-emerald-50 text-emerald-700'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {icon}
      {label}
      {v === 'monitors' && counts.active > 0 && (
        <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700">
          {counts.active}
        </span>
      )}
      {v === 'ema' && emaActiveCount > 0 && (
        <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700">
          {emaActiveCount}
        </span>
      )}
      {v === 'sec' && secHits.some((h) => !h.baseline) && (
        <span className="ml-auto rounded-full bg-violet-100 px-2 py-0.5 text-xs tabular-nums text-violet-700">
          {secHits.filter((h) => !h.baseline).length}
        </span>
      )}
    </button>
  )

  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900">
      {/* 左侧导航栏 */}
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-zinc-100 px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100">
            <TrendingUp className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-bold">币安价格监控</p>
            <p className="text-xs text-zinc-500">告警助手</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {navItem('monitors', <Bell className="h-4 w-4" />, '价格监控')}
          {navItem('ema', <LineChart className="h-4 w-4" />, 'EMA 均线监控')}
          {navItem('sec', <FileSearch className="h-4 w-4" />, 'SEC 财报监听')}
          {navItem('tv', <Radio className="h-4 w-4" />, 'TradingView 转发')}
        </nav>

        <div className="space-y-3 border-t border-zinc-100 p-3">
          <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-500">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                pollerOk === true ? 'bg-emerald-500' : pollerOk === false ? 'bg-red-500' : 'bg-zinc-400'
              }`}
            />
            {pollerOk === false
              ? '行情连接异常'
              : priceInfo?.updated_at
                ? `行情更新于 ${fmtTime(priceInfo.updated_at)}`
                : '行情连接中…'}
          </p>
          <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
              {username.slice(0, 1).toUpperCase()}
            </div>
            <span className="truncate text-sm font-medium">{username}</span>
            <button
              onClick={handleLogout}
              title="退出登录"
              className="ml-auto rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* 右侧内容区 */}
      <main className="min-w-0 flex-1 px-6 py-6">
        {view === 'tv' ? (
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-4 text-lg font-bold">TradingView 转发</h2>
            <TvForwards />
          </div>
        ) : view === 'sec' ? (
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-4 text-lg font-bold">SEC 财报监听</h2>
            <SecMonitor hits={secHits} status={secStatus} onChanged={() => refresh(true)} />
          </div>
        ) : view === 'ema' ? (
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-4 text-lg font-bold">EMA 均线监控</h2>
            <EmaMonitors
              monitors={emaMonitors}
              prices={priceInfo?.prices || {}}
              onDelete={handleDelete}
              onRestore={handleRestore}
              onChanged={() => refresh(true)}
            />
          </div>
        ) : (
          <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">价格监控</h2>
              <CreateMonitorDialog
                prices={priceInfo?.prices || {}}
                onCreated={() => {
                  toast.success('监控已创建')
                  refresh(true)
                }}
                onError={(msg) => toast.error(msg)}
              />
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as MonitorStatus)}>
              <TabsList className="bg-white">
                {TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                    <span className="ml-1.5 rounded-full bg-zinc-100 px-1.5 text-xs tabular-nums text-zinc-600">
                      {counts[t.value]}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {pollerOk === false && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                行情连接异常：{priceInfo?.poller_error || '未知错误'}（监控判定会暂停，恢复后自动继续）
              </p>
            )}

            <div className="mt-5 space-y-4">
              {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-500">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  加载中…
                </div>
              ) : groups.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-20 text-zinc-500">
                  <Activity className="h-8 w-8 opacity-40" />
                  <p>
                    {tab === 'active'
                      ? '还没有活跃的监控，点击右上角「新建监控」开始'
                      : `暂无${TABS.find((t) => t.value === tab)?.label}的监控`}
                  </p>
                </div>
              ) : (
                groups.map(([symbol, items]) => (
                  <MonitorGroup
                    key={symbol}
                    symbol={symbol}
                    monitors={items}
                    price={priceInfo?.prices?.[symbol]}
                    onDelete={handleDelete}
                    onRestore={handleRestore}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
