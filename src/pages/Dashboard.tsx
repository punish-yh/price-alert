import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bell, CandlestickChart, FileSearch, GitCompareArrows, LineChart, Loader2, LogOut, Percent, Radio, TrendingUp } from 'lucide-react'
import { api, fmtTime } from '@/lib/api'
import type { BiasAlert, CorrAlert, DivAlert, Monitor, MonitorStatus, PricesResponse, SecHit, SecStatus, TvComboAlert } from '@/types'
import BiasMonitor from '@/components/BiasMonitor'
import CreateMonitorDialog from '@/components/CreateMonitorDialog'
import CorrMonitor from '@/components/CorrMonitor'
import DivMonitor from '@/components/DivMonitor'
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

type View = 'monitors' | 'ema' | 'tv' | 'sec' | 'corr' | 'div' | 'bias'

export default function Dashboard({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [priceInfo, setPriceInfo] = useState<PricesResponse | null>(null)
  const [secHits, setSecHits] = useState<SecHit[]>([])
  const [secStatus, setSecStatus] = useState<SecStatus | null>(null)
  const [unreadSec, setUnreadSec] = useState(0)
  const [corrAlerts, setCorrAlerts] = useState<CorrAlert[]>([])
  const [unreadCorr, setUnreadCorr] = useState(0)
  const [divAlerts, setDivAlerts] = useState<DivAlert[]>([])
  const [unreadDiv, setUnreadDiv] = useState(0)
  const [biasAlerts, setBiasAlerts] = useState<BiasAlert[]>([])
  const [unreadBias, setUnreadBias] = useState(0)
  const [unreadTriggered, setUnreadTriggered] = useState(0)
  const [tab, setTab] = useState<MonitorStatus>('active')
  const [view, setView] = useState<View>('monitors')
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSecHitId = useRef<number | null>(null)
  const lastCorrAlertId = useRef<number | null>(null)
  const lastDivAlertId = useRef<number | null>(null)
  const lastBiasAlertId = useRef<number | null>(null)
  const lastTvAlertId = useRef<number | null>(null)

  /** SEC 新财报弹窗（SSE 与轮询共用，按命中 id 去重） */
  const notifySecHit = useCallback((h: SecHit) => {
    if (lastSecHitId.current !== null && h.id !== undefined && h.id <= lastSecHitId.current) return
    lastSecHitId.current = Math.max(lastSecHitId.current ?? 0, h.id ?? 0)
    const isEarnings8k = h.form.startsWith('8-K')
    toast.success(isEarnings8k ? `${h.ticker} 发布业绩公告（8-K）` : `${h.ticker} 发布 ${h.form} 财报`, {
      description: `申报日期 ${h.filing_date}`,
      duration: 15000,
      action: h.url
        ? { label: '查看原文', onClick: () => window.open(h.url, '_blank') }
        : undefined,
    })
  }, [])

  /** 相关度告警弹窗（SSE 与轮询共用，按告警 id 去重） */
  const notifyCorrAlert = useCallback((a: CorrAlert) => {
    if (lastCorrAlertId.current !== null && a.id <= lastCorrAlertId.current) return
    lastCorrAlertId.current = Math.max(lastCorrAlertId.current ?? 0, a.id)
    if (a.kind === 'decorr') {
      toast.warning(`${a.symbol} ${a.interval} 与 BTC 脱钩`, {
        description: `当前 r=${a.r.toFixed(4)}，|r| ≤ 阈值 ${a.threshold}`,
        duration: 15000,
      })
    } else {
      toast.warning(`${a.symbol} ${a.interval} 与 BTC 相关性突变`, {
        description: `r 由 ${a.prev_r?.toFixed(4) ?? '—'} 变为 ${a.r.toFixed(4)}，|Δr| ≥ 阈值 ${a.threshold}`,
        duration: 15000,
      })
    }
  }, [])

  /** 背离组合告警弹窗（SSE 与轮询共用，按告警 id 去重） */
  const notifyDivAlert = useCallback((a: DivAlert) => {
    if (lastDivAlertId.current !== null && a.id <= lastDivAlertId.current) return
    lastDivAlertId.current = Math.max(lastDivAlertId.current ?? 0, a.id)
    const kindCN: Record<string, string> = {
      volume: '量价',
      rsi: 'RSI',
      obv: 'OBV',
      macd: 'MACD(DIF)',
      macd_area: 'MACD面积',
    }
    const candidate = a.signal_stage === 'candidate'
    toast.warning(`${a.symbol} ${a.interval} ${candidate ? '候选' : '确认'}${a.direction === 'top' ? '顶背离' : '底背离'}组合`, {
      description: `${a.kinds.map((k) => kindCN[k] ?? k).join('、')}（${a.kinds.length} 种 ≥ 阈值 ${a.min_count}，${candidate ? '实时候选，可能消失' : '右侧 2 根已收盘'}）`,
      duration: 15000,
    })
  }, [])

  /** 乖离率价格告警弹窗（SSE 与轮询共用，按告警 id 去重） */
  const notifyBiasAlert = useCallback((a: BiasAlert) => {
    if (lastBiasAlertId.current !== null && a.id <= lastBiasAlertId.current) return
    lastBiasAlertId.current = Math.max(lastBiasAlertId.current ?? 0, a.id)
    const strength = a.strength === 'extreme' ? '强' : '放量'
    const direction = a.direction === 'negative' ? '负乖离' : '正乖离'
    toast.warning(`${a.symbol} ${a.interval} ${strength}${direction}触及触发价`, {
      description: `最低价 ${a.low} ≤ 触发价 ${a.trigger_price}，BIAS20 ${a.bias.toFixed(3)}%，量比 ${a.volume_ratio.toFixed(2)}×，RSI14 ${a.rsi.toFixed(1)}`,
      duration: 15000,
    })
  }, [])

  /** TV 周期组合告警弹窗（SSE 与轮询共用，按告警 id 去重） */
  const notifyTvAlert = useCallback((a: TvComboAlert) => {
    if (lastTvAlertId.current !== null && a.id <= lastTvAlertId.current) return
    lastTvAlertId.current = Math.max(lastTvAlertId.current ?? 0, a.id)
    toast.warning(`${a.symbol} TV 组合「${a.rule_name}」`, {
      description: a.conditions.map((c) => `${c.interval} ${c.direction === 'bullish' ? '看涨' : '看跌'}`).join(' + '),
      duration: 15000,
    })
  }, [])

  // 后端 SSE 实时推送：财报命中即刻弹窗（无轮询延迟）；断线时由下方轮询兜底
  const refresh = useCallback(async (silent = false) => {
    try {
      const [m, p, s, c, d, b, t] = await Promise.all([
        api.monitors(),
        api.prices(),
        api.secHits(),
        api.corrAlerts(),
        api.divAlerts(),
        api.biasAlerts(),
        api.tvComboAlerts(),
      ])
      setMonitors(m.items)
      setUnreadTriggered(m.unread_triggered)
      setPriceInfo(p)
      setSecHits(s.items)
      setSecStatus(s.status)
      setUnreadSec(s.unread)
      setCorrAlerts(c.items)
      setUnreadCorr(c.unread)
      setDivAlerts(d.items)
      setUnreadDiv(d.unread)
      setBiasAlerts(b.items)
      setUnreadBias(b.unread)
      // 轮询兜底：SSE 漏掉/断线期间的命中在这里补弹（notifySecHit 内部按 id 去重）
      const fresh = s.items.filter((h) => !h.baseline)
      const maxId = fresh.length ? Math.max(...fresh.map((h) => h.id)) : 0
      if (lastSecHitId.current === null) {
        lastSecHitId.current = maxId
      } else {
        for (const h of fresh.filter((x) => x.id > lastSecHitId.current!).reverse()) {
          notifySecHit(h)
        }
      }
      // 相关度告警轮询兜底（同样按 id 去重）
      const maxCorrId = c.items.length ? Math.max(...c.items.map((a) => a.id)) : 0
      if (lastCorrAlertId.current === null) {
        lastCorrAlertId.current = maxCorrId
      } else {
        for (const a of c.items.filter((x) => x.id > lastCorrAlertId.current!).reverse()) {
          notifyCorrAlert(a)
        }
      }
      // 背离告警轮询兜底
      const maxDivId = d.items.length ? Math.max(...d.items.map((a) => a.id)) : 0
      if (lastDivAlertId.current === null) {
        lastDivAlertId.current = maxDivId
      } else {
        for (const a of d.items.filter((x) => x.id > lastDivAlertId.current!).reverse()) {
          notifyDivAlert(a)
        }
      }
      // 乖离率价格告警轮询兜底
      const maxBiasId = b.items.length ? Math.max(...b.items.map((a) => a.id)) : 0
      if (lastBiasAlertId.current === null) {
        lastBiasAlertId.current = maxBiasId
      } else {
        for (const a of b.items.filter((x) => x.id > lastBiasAlertId.current!).reverse()) {
          notifyBiasAlert(a)
        }
      }
      // TV 组合告警轮询兜底
      const maxTvId = t.items.length ? Math.max(...t.items.map((a) => a.id)) : 0
      if (lastTvAlertId.current === null) {
        lastTvAlertId.current = maxTvId
      } else {
        for (const a of t.items.filter((x) => x.id > lastTvAlertId.current!).reverse()) {
          notifyTvAlert(a)
        }
      }
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [notifySecHit, notifyCorrAlert, notifyDivAlert, notifyBiasAlert, notifyTvAlert])

  // 后端 SSE 实时推送：财报命中即刻弹窗（无轮询延迟）；断线时由轮询兜底
  useEffect(() => {
    const es = new EventSource('/api/sec/events')
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data?.type === 'sec_hit' && data.hit) {
          notifySecHit(data.hit as SecHit)
          refresh(true)
        }
        if (data?.type === 'corr_alert' && data.alert) {
          notifyCorrAlert(data.alert as CorrAlert)
          refresh(true)
        }
        if (data?.type === 'div_alert' && data.alert) {
          notifyDivAlert(data.alert as DivAlert)
          refresh(true)
        }
        if (data?.type === 'bias_alert' && data.alert) {
          notifyBiasAlert(data.alert as BiasAlert)
          refresh(true)
        }
        if (data?.type === 'tv_combo_alert' && data.alert) {
          notifyTvAlert(data.alert as TvComboAlert)
          refresh(true)
        }
      } catch {
        /* 非 JSON 消息忽略 */
      }
    }
    return () => es.close()
  }, [notifySecHit, notifyCorrAlert, notifyDivAlert, notifyBiasAlert, notifyTvAlert, refresh])

  useEffect(() => {
    refresh()
    timer.current = setInterval(() => refresh(true), 3000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh])

  // 查看「已触发」页即视为已读：记录水位并清掉角标
  useEffect(() => {
    if (view !== 'monitors' || tab !== 'triggered' || unreadTriggered === 0) return
    setUnreadTriggered(0)
    api.markPriceTriggeredRead().catch(() => {})
  }, [view, tab, unreadTriggered])

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

  // 交易对导航：只在交易对集合变化时重建观察器（价格每 3 秒刷新不会重置）
  const groupKey = useMemo(() => groups.map(([symbol]) => symbol).join('|'), [groups])
  const currentSymbol = groups.some(([symbol]) => symbol === activeSymbol)
    ? activeSymbol
    : groups[0]?.[0] ?? null

  // 滚动联动：滚到哪一组，左侧导航就高亮哪一个
  useEffect(() => {
    if (view !== 'monitors' || !groupKey) return
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('[data-monitor-group]')
    )
    if (elements.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const top = visible[0]?.target.getAttribute('data-monitor-group')
        if (top) setActiveSymbol(top)
      },
      { rootMargin: '-12% 0px -68% 0px', threshold: 0 }
    )
    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [view, groupKey])

  function jumpToSymbol(symbol: string) {
    setActiveSymbol(symbol)
    document
      .getElementById(`monitor-group-${symbol}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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
      {v === 'monitors' && unreadTriggered > 0 && (
        <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs tabular-nums text-amber-700">
          {unreadTriggered}
        </span>
      )}
      {v === 'ema' && emaActiveCount > 0 && (
        <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700">
          {emaActiveCount}
        </span>
      )}
      {v === 'sec' && unreadSec > 0 && (
        <span className="ml-auto rounded-full bg-violet-100 px-2 py-0.5 text-xs tabular-nums text-violet-700">
          {unreadSec}
        </span>
      )}
      {v === 'corr' && unreadCorr > 0 && (
        <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs tabular-nums text-amber-700">
          {unreadCorr}
        </span>
      )}
      {v === 'div' && unreadDiv > 0 && (
        <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs tabular-nums text-amber-700">
          {unreadDiv}
        </span>
      )}
      {v === 'bias' && unreadBias > 0 && (
        <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs tabular-nums text-amber-700">
          {unreadBias}
        </span>
      )}
    </button>
  )

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 md:flex-row">
      {/* 电脑端左侧导航栏；手机端使用下方顶部横向导航 */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex">
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
          {navItem('corr', <GitCompareArrows className="h-4 w-4" />, '相关度计算')}
          {navItem('div', <CandlestickChart className="h-4 w-4" />, 'BTC 背离监控')}
          {navItem('bias', <Percent className="h-4 w-4" />, 'BTC 乖离率')}
          {navItem('sec', <FileSearch className="h-4 w-4" />, 'SEC 财报监听')}
          {navItem('tv', <Radio className="h-4 w-4" />, 'TV 告警转发')}
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

      {/* 手机端顶部导航：横向滚动，避免侧栏挤占内容宽度 */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white md:hidden">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-bold">币安价格监控</p>
            <p className="text-[11px] text-zinc-500">告警助手</p>
          </div>
          <button
            onClick={handleLogout}
            title="退出登录"
            className="ml-auto rounded-md p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
          {([
            ['monitors', '价格监控'],
            ['ema', 'EMA 均线'],
            ['corr', '相关度'],
            ['div', 'BTC 背离'],
            ['bias', 'BTC 乖离率'],
            ['sec', 'SEC 财报'],
            ['tv', 'TV 告警转发'],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                view === v ? 'bg-emerald-100 text-emerald-700' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
            >
              {label}
              {v === 'div' && unreadDiv > 0 && <span className="ml-1 text-amber-600">{unreadDiv}</span>}
              {v === 'bias' && unreadBias > 0 && <span className="ml-1 text-amber-600">{unreadBias}</span>}
              {v === 'corr' && unreadCorr > 0 && <span className="ml-1 text-amber-600">{unreadCorr}</span>}
              {v === 'sec' && unreadSec > 0 && <span className="ml-1 text-violet-600">{unreadSec}</span>}
            </button>
          ))}
        </nav>
      </header>

      {/* 右侧内容区 */}
      <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 md:px-6 md:py-6">
        {view === 'tv' ? (
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-4 text-lg font-bold">TV 告警转发</h2>
            <TvForwards />
          </div>
        ) : view === 'sec' ? (
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-4 text-lg font-bold">SEC 财报监听</h2>
            <SecMonitor hits={secHits} status={secStatus} onChanged={() => refresh(true)} />
          </div>
        ) : view === 'corr' ? (
          <div className="mx-auto max-w-5xl">
            <h2 className="mb-4 text-lg font-bold">相关度计算</h2>
            <CorrMonitor alerts={corrAlerts} unread={unreadCorr} onChanged={() => refresh(true)} />
          </div>
        ) : view === 'div' ? (
          <div className="mx-auto max-w-5xl">
            <h2 className="mb-4 text-lg font-bold">BTC 背离监控</h2>
            <DivMonitor alerts={divAlerts} unread={unreadDiv} onChanged={() => refresh(true)} />
          </div>
        ) : view === 'bias' ? (
          <div className="mx-auto max-w-7xl">
            <h2 className="mb-4 text-lg font-bold">BTC 乖离率</h2>
            <BiasMonitor alerts={biasAlerts} unread={unreadBias} onChanged={() => refresh(true)} />
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
          <div className="mx-auto flex max-w-6xl items-start gap-6">
            {/* 交易对快捷导航：列出当前页签下已设监控的交易对，点击定位到对应分组 */}
            {groups.length > 0 && (
              <aside className="sticky top-6 hidden w-44 shrink-0 lg:block">
                <div className="rounded-xl border border-zinc-200 bg-white p-2 shadow-sm">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <p className="text-xs font-semibold text-zinc-500">交易对导航</p>
                    <span className="rounded-full bg-zinc-100 px-1.5 text-[11px] tabular-nums text-zinc-500">
                      {groups.length}
                    </span>
                  </div>
                  <nav className="max-h-[calc(100vh-9rem)] space-y-0.5 overflow-y-auto pr-0.5">
                    {groups.map(([symbol, items]) => {
                      const active = symbol === currentSymbol
                      return (
                        <button
                          key={symbol}
                          type="button"
                          onClick={() => jumpToSymbol(symbol)}
                          title={`${symbol}（${items.length} 条监控）`}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                            active
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              priceInfo?.prices?.[symbol] !== undefined
                                ? 'bg-emerald-500'
                                : 'bg-zinc-300'
                            }`}
                          />
                          <span className="truncate font-mono font-semibold">{symbol}</span>
                          <span
                            className={`ml-auto shrink-0 rounded-full px-1.5 text-[11px] tabular-nums ${
                              active ? 'bg-white text-emerald-700' : 'bg-zinc-100 text-zinc-500'
                            }`}
                          >
                            {items.length}
                          </span>
                        </button>
                      )
                    })}
                  </nav>
                </div>
              </aside>
            )}

            <div className="min-w-0 flex-1">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold">价格监控</h2>
                <CreateMonitorDialog
                  prices={priceInfo?.prices || {}}
                  onSaved={() => refresh(true)}
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
                    <div
                      key={symbol}
                      id={`monitor-group-${symbol}`}
                      data-monitor-group={symbol}
                      className="scroll-mt-6"
                    >
                      <MonitorGroup
                        symbol={symbol}
                        monitors={items}
                        price={priceInfo?.prices?.[symbol]}
                        onChanged={() => refresh(true)}
                        onDelete={handleDelete}
                        onRestore={handleRestore}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
