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

export default function DivCharts({
  overview,
  interval,
}: {
  overview: DivOverviewInterval
  interval: DivInterval
}) {
  const rows = overview.candles.map((c, i) => ({
    ...c,
    rsi: overview.indicators.rsi[i],
    obv: overview.indicators.obv[i],
    dif: overview.indicators.dif[i],
    dea: overview.indicators.dea[i],
    hist: overview.indicators.hist[i],
  }))

  // 当前检出的背离在价格图上画摆动点连线（顶=红，底=绿）
  const divLines: { key: string; x1: number; y1: number; x2: number; y2: number; color: string; dash: string }[] = []
  for (const direction of ['top', 'bottom'] as DivDirection[]) {
    const color = direction === 'top' ? DOWN : UP
    for (const [kind, det] of Object.entries(overview.divergences[direction])) {
      if (!det) continue
      const dash = kind === 'macd_area' ? '2 3' : '6 3'
      if (kind === 'macd_area') {
        divLines.push({
          key: `${direction}-${kind}`,
          x1: det.a1_start,
          y1: det.p1,
          x2: det.a2_end,
          y2: det.p2,
          color,
          dash,
        })
      } else {
        divLines.push({
          key: `${direction}-${kind}`,
          x1: det.p1_time,
          y1: det.p1_price,
          x2: det.p2_time,
          y2: det.p2_price,
          color,
          dash,
        })
      }
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
    <div className="space-y-1">
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
              width={64}
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
                strokeWidth={1.6}
                strokeDasharray={l.dash}
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
                width={64}
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
                width={64}
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
                width={64}
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
