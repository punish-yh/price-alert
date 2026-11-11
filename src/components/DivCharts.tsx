import { useEffect, useRef, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DivDirection, DivInterval, DivKind, DivOverviewInterval } from '@/types'

export const DIV_KIND_CN: Record<DivKind, string> = {
  volume: '量价',
  rsi: 'RSI',
  obv: 'OBV',
  macd: 'MACD(DIF)',
  macd_area: 'MACD面积',
}

const UP = '#10b981'
const DOWN = '#ef4444'

function fmtX(ms: number, interval: string) {
  const d = new Date(ms)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (interval === '1d') return md
  return `${md} ${String(d.getHours()).padStart(2, '0')}:00`
}

function fmtFull(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtNum(v: number) {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (Math.abs(v) >= 1) return v.toFixed(2)
  return v.toPrecision(3)
}

/** 自定义蜡烛：Bar 的 dataKey 返回 [low, high]，shape 内按 high-low 比例换算开收位置 */
function Candle(props: {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: { open: number; close: number; high: number; low: number }
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props
  if (!payload) return <g />
  const { open, close, high, low } = payload
  if (high === low || height <= 0) return <g />
  const yy = (v: number) => y + ((high - v) / (high - low)) * height
  const rising = close >= open
  const color = rising ? UP : DOWN
  const cx = x + width / 2
  const bw = Math.max(2, Math.min(width * 0.65, 10))
  const bodyTop = yy(Math.max(open, close))
  const bodyBottom = yy(Math.min(open, close))
  return (
    <g>
      <line x1={cx} x2={cx} y1={yy(high)} y2={yy(low)} stroke={color} strokeWidth={1} />
      <rect
        x={cx - bw / 2}
        y={bodyTop}
        width={bw}
        height={Math.max(1, bodyBottom - bodyTop)}
        fill={color}
      />
    </g>
  )
}

function PriceTooltip({ active, payload }: { active?: boolean; payload?: { payload: Record<string, number> }[] }) {
  if (!active || !payload?.length) return null
  const c = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{fmtFull(c.open_time)}</p>
      <p className="font-mono tabular-nums">
        开 {fmtNum(c.open)} / 高 {fmtNum(c.high)} / 低 {fmtNum(c.low)} / 收 {fmtNum(c.close)}
      </p>
      <p className="font-mono tabular-nums text-muted-foreground">量 {fmtNum(c.volume)}</p>
    </div>
  )
}

type DivStage = 'candidate' | 'confirmed' | 'history'

type DivLine = {
  key: string
  kind: DivKind
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  stage: DivStage
}

function signalLine(
  direction: DivDirection,
  kind: DivKind,
  det: DivOverviewInterval['history'][number],
  key: string,
  stage: DivStage
): DivLine {
  const common = {
    key,
    kind,
    color: direction === 'top' ? DOWN : UP,
    stage,
  }
  if (kind === 'macd_area' && stage === 'candidate') {
    return { ...common, x1: det.a1_start, y1: det.p1, x2: det.a2_end, y2: det.p2 }
  }
  if (kind === 'macd_area') {
    return { ...common, x1: det.p1_time, y1: det.p1, x2: det.p2_time, y2: det.p2 }
  }
  return { ...common, x1: det.p1_time, y1: det.p1_price, x2: det.p2_time, y2: det.p2_price }
}

export default function DivCharts({
  overview,
  interval,
  showHistory,
}: {
  overview: DivOverviewInterval
  interval: DivInterval
  showHistory: boolean
}) {
  const total = overview.candles.length
  const [visibleCount, setVisibleCount] = useState(total)
  const [isMobile, setIsMobile] = useState(false)
  const zoomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setVisibleCount(total)
  }, [interval, total])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const node = zoomRef.current
    if (!node) return
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      // 原生非 passive 监听，确保图表缩放时页面不会跟着滚动。
      event.preventDefault()
      const factor = event.deltaY < 0 ? 0.8 : 1.25
      setVisibleCount((current) => {
        const min = Math.min(20, total)
        const next = Math.round(current * factor)
        return Math.max(min, Math.min(total, next))
      })
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [total])

  const allRows = overview.candles.map((c, i) => ({
    ...c,
    rsi: overview.indicators.rsi[i],
    obv: overview.indicators.obv[i],
    dif: overview.indicators.dif[i],
    dea: overview.indicators.dea[i],
    hist: overview.indicators.hist[i],
  }))
  const rows = allRows.slice(-Math.min(visibleCount, total))

  // 候选、当前确认、历史确认分别绘制；是否触发过告警不影响任何信号的展示。
  const divLines: DivLine[] = []
  const visibleStart = rows[0]?.open_time ?? 0
  if (showHistory) {
    for (const [i, signal] of (overview.history ?? []).entries()) {
      const isCurrent = overview.divergences[signal.direction][signal.kind]?.confirmed_at === signal.confirmed_at
      if (isCurrent) continue
      const line = signalLine(signal.direction, signal.kind, signal, `history-${i}`, 'history')
      if (line.x1 >= visibleStart) divLines.push(line)
    }
  }
  for (const direction of ['top', 'bottom'] as DivDirection[]) {
    for (const [kind, det] of Object.entries(overview.candidates[direction])) {
      if (!det) continue
      divLines.push(signalLine(direction, kind as DivKind, det as DivOverviewInterval['history'][number], `candidate-${direction}-${kind}`, 'candidate'))
    }
    for (const [kind, det] of Object.entries(overview.divergences[direction])) {
      if (!det) continue
      divLines.push(signalLine(direction, kind as DivKind, det as DivOverviewInterval['history'][number], `confirmed-${direction}-${kind}`, 'confirmed'))
    }
  }

  const xAxis = (hide: boolean) => (
    <XAxis
      dataKey="open_time"
      type="number"
      domain={['dataMin', 'dataMax']}
      tickFormatter={(ms) => fmtX(ms, interval)}
      tick={hide ? false : { fontSize: 11, fill: '#71717a' }}
      minTickGap={48}
      axisLine={{ stroke: '#e4e4e7' }}
      tickLine={false}
      height={hide ? 0 : 22}
    />
  )

  return (
    <div ref={zoomRef} className="space-y-1" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
        <span>
          当前显示最近 {rows.length} / {total} 根
          <span className="hidden sm:inline"> · 滚轮向上放大，向下缩小</span>
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-sky-600 disabled:opacity-40 sm:hidden"
            disabled={rows.length <= 20}
            onClick={() => setVisibleCount((n) => Math.max(20, Math.round(n * 0.8)))}
          >
            放大
          </button>
          <button
            type="button"
            className="text-sky-600 disabled:opacity-40 sm:hidden"
            disabled={rows.length >= total}
            onClick={() => setVisibleCount((n) => Math.min(total, Math.round(n * 1.25)))}
          >
            缩小
          </button>
          {rows.length < total && (
            <button type="button" className="text-sky-600 hover:underline" onClick={() => setVisibleCount(total)}>
              重置为 {total} 根
            </button>
          )}
        </div>
      </div>
      {/* K 线主图 + 背离连线 */}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            {xAxis(false)}
            <YAxis
              domain={['auto', 'auto']}
              orientation="right"
              tick={{ fontSize: 11, fill: '#71717a' }}
              tickFormatter={(v) => fmtNum(v)}
              axisLine={false}
              tickLine={false}
              width={isMobile ? 48 : 64}
            />
            <Tooltip content={<PriceTooltip />} />
            <Bar dataKey={(r: { low: number; high: number }) => [r.low, r.high]} shape={<Candle />} isAnimationActive={false} />
            {divLines.map((l) => (
              <ReferenceLine
                key={l.key}
                segment={[
                  { x: l.x1, y: l.y1 },
                  { x: l.x2, y: l.y2 },
                ]}
                stroke={l.color}
                strokeOpacity={l.stage === 'history' ? 0.35 : l.stage === 'candidate' ? 0.8 : 0.95}
                strokeWidth={l.stage === 'history' ? 1 : l.stage === 'candidate' ? 1.4 : 2}
                strokeDasharray={l.stage === 'history' ? '3 3' : l.stage === 'candidate' ? '2 3' : l.kind === 'macd_area' ? '6 3' : undefined}
                label={isMobile && l.stage === 'history' && rows.length > 60 ? undefined : {
                  value: `${l.stage === 'candidate' ? '候选·' : l.stage === 'confirmed' ? '确认·' : ''}${DIV_KIND_CN[l.kind]}`,
                  position: 'middle',
                  fontSize: l.stage === 'history' ? 9 : 10,
                  fill: l.color,
                  fillOpacity: l.stage === 'history' ? 0.55 : 1,
                }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* 成交量 */}
      <div className="h-16">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
            {xAxis(true)}
            <YAxis hide domain={[0, 'auto']} />
            <Tooltip
              labelFormatter={(ms) => fmtFull(Number(ms))}
              formatter={(v) => [fmtNum(Number(v)), '成交量']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="volume" isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.open_time} fill={r.close >= r.open ? UP : DOWN} fillOpacity={0.55} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* RSI(14) */}
      <div>
        <p className="px-1 text-[11px] text-muted-foreground">RSI(14)（70 / 30 参考线）</p>
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
              {xAxis(true)}
              <YAxis
                domain={[0, 100]}
                orientation="right"
                tick={{ fontSize: 10, fill: '#a1a1aa' }}
                axisLine={false}
                tickLine={false}
                width={isMobile ? 48 : 64}
                tickCount={3}
              />
              <Tooltip
                labelFormatter={(ms) => fmtFull(Number(ms))}
                formatter={(v) => [Number(v).toFixed(2), 'RSI']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <ReferenceLine y={70} stroke="#fbbf24" strokeDasharray="4 4" />
              <ReferenceLine y={30} stroke="#fbbf24" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="rsi" stroke="#8b5cf6" strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* OBV */}
      <div>
        <p className="px-1 text-[11px] text-muted-foreground">OBV</p>
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
              {xAxis(true)}
              <YAxis
                domain={['auto', 'auto']}
                orientation="right"
                tick={{ fontSize: 10, fill: '#a1a1aa' }}
                tickFormatter={(v) => fmtNum(v)}
                axisLine={false}
                tickLine={false}
                width={isMobile ? 48 : 64}
              />
              <Tooltip
                labelFormatter={(ms) => fmtFull(Number(ms))}
                formatter={(v) => [fmtNum(Number(v)), 'OBV']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Line type="monotone" dataKey="obv" stroke="#0ea5e9" strokeWidth={1.4} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* MACD(12,26,9) */}
      <div>
        <p className="px-1 text-[11px] text-muted-foreground">MACD(12,26,9)：DIF 蓝 / DEA 橙 / 柱体</p>
        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 0, right: 4, bottom: 0, left: 4 }}>
              {xAxis(true)}
              <YAxis
                domain={['auto', 'auto']}
                orientation="right"
                tick={{ fontSize: 10, fill: '#a1a1aa' }}
                tickFormatter={(v) => fmtNum(v)}
                axisLine={false}
                tickLine={false}
                width={isMobile ? 48 : 64}
              />
              <Tooltip
                labelFormatter={(ms) => fmtFull(Number(ms))}
                formatter={(v, name) => [Number(v).toFixed(2), name === 'dif' ? 'DIF' : name === 'dea' ? 'DEA' : '柱']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <ReferenceLine y={0} stroke="#a1a1aa" />
              <Bar dataKey="hist" isAnimationActive={false}>
                {rows.map((r) => (
                  <Cell key={r.open_time} fill={(r.hist ?? 0) >= 0 ? UP : DOWN} fillOpacity={0.6} />
                ))}
              </Bar>
              <Line type="monotone" dataKey="dif" stroke="#0284c7" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
              <Line type="monotone" dataKey="dea" stroke="#f59e0b" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}
