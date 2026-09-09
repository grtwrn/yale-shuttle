import { useId } from "react";

export interface Point { x: number; y: number; label?: string; id?: string }
export interface Series { name: string; color: string; points: Point[]; dashed?: boolean; dots?: boolean; line?: boolean }

/** Deliberately small SVG plot: data stays inspectable without a remote chart service. */
export function Chart({ title, description, series, xLabel, yLabel, xFormat = String, yFormat = String,
  selectedId, onSelect, xDomain, yDomain, cursor, markers = [] }: {
  title: string; description?: string; series: Series[]; xLabel: string; yLabel: string;
  xFormat?: (n: number) => string; yFormat?: (n: number) => string;
  selectedId?: string | null; onSelect?: (id: string) => void;
  xDomain?: [number, number]; yDomain?: [number, number]; cursor?: number;
  markers?: {x:number;label:string}[];
}) {
  const id = useId();
  const points = series.flatMap(s => s.points).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return <div className="empty-chart">No observations available for this chart.</div>;
  const width = 860, height = 275, left = 65, right = 25, top = 18, bottom = 50;
  const minX = xDomain?.[0] ?? Math.min(...points.map(p => p.x));
  const maxX = Math.max(minX + 1, xDomain?.[1] ?? Math.max(...points.map(p => p.x)));
  const minY = yDomain?.[0] ?? Math.min(0, ...points.map(p => p.y));
  const maxY = Math.max(minY + 1, yDomain?.[1] ?? Math.max(...points.map(p => p.y)) * 1.08);
  const x = (v: number) => left + (v - minX) / (maxX - minX) * (width - left - right);
  const y = (v: number) => height - bottom - (v - minY) / (maxY - minY) * (height - top - bottom);
  return <div className="plot-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>{title}</title><desc id={`${id}-desc`}>{description ?? `${yLabel} against ${xLabel}. Exact values are available in the visit table.`}</desc>
      <defs><clipPath id={`${id}-clip`}><rect x={left} y={top} width={width-left-right} height={height-top-bottom}/></clipPath></defs>
      {Array.from({ length: 5 }, (_, i) => {
        const v = minY + (maxY - minY) * i / 4;
        return <g key={i}><line x1={left} x2={width-right} y1={y(v)} y2={y(v)} className="grid-line"/><text x={left-10} y={y(v)+4} textAnchor="end" className="tick">{yFormat(v)}</text></g>;
      })}
      {Array.from({ length: 5 }, (_, i) => {
        const v = minX + (maxX - minX) * i / 4;
        return <text key={i} x={x(v)} y={height-bottom+22} textAnchor="middle" className="tick">{xFormat(v)}</text>;
      })}
      <text x={left} y={12} className="axis-label">{yLabel}</text>
      <text x={(width+left-right)/2} y={height-5} textAnchor="middle" className="axis-label">{xLabel}</text>
      {series.map(s => <g key={s.name} clipPath={`url(#${id}-clip)`}>
        {s.line !== false && <path d={s.points.map((p,i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2.4} strokeDasharray={s.dashed ? "6 5" : undefined}/>}
        {(s.dots || s.line === false) && s.points.map((p,i) => <g key={`${p.id ?? i}-${i}`}>
          <circle cx={x(p.x)} cy={y(p.y)} r={p.id === selectedId ? 7 : 4.5} fill={s.color} stroke="var(--panel)" strokeWidth={p.id === selectedId ? 2.5 : 1}><title>{p.label ?? `${xFormat(p.x)} · ${yFormat(p.y)}`}</title></circle>
          {p.id && onSelect && <circle cx={x(p.x)} cy={y(p.y)} r={14} fill="transparent" className="point-target" onClick={() => onSelect(p.id!)}><title>{p.label ?? p.id}</title></circle>}
        </g>)}
      </g>)}
      {cursor !== undefined && cursor >= minX && cursor <= maxX && <line x1={x(cursor)} x2={x(cursor)} y1={top} y2={height-bottom} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="3 4"/>}
      {markers.filter(m=>m.x>=minX&&m.x<=maxX).map(m=><g key={m.label}><line x1={x(m.x)} x2={x(m.x)} y1={top} y2={height-bottom} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 4"/><text x={x(m.x)+5} y={top+12} className="tick">{m.label}</text></g>)}
    </svg>
    <div className="legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
  </div>;
}
