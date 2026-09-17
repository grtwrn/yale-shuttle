import { useId } from 'react';

export interface PlotMarker { value: number; label: string; color: string; dashed?: boolean }
/** Stack equal-weight dots in time bins. All data and markers stay on scale. */
export function arrivalPlotLayout(values: readonly number[], markers: readonly PlotMarker[], clock: boolean) {
  const data = values.filter(Number.isFinite);
  const all = [...data, ...markers.map(m => m.value).filter(Number.isFinite)];
  const unit = clock ? 60_000 : 60;
  const min = clock ? Math.floor(Math.min(...all) / unit) * unit : 0;
  const max = Math.max(min + 2 * unit, Math.ceil(Math.max(...all) / unit) * unit);
  const bins = new Map<number, number>();
  const dots = data.map(value => {
    const bin = Math.min(24, Math.max(0, Math.round(24 * (value - min) / (max - min))));
    const stack = bins.get(bin) ?? 0;
    bins.set(bin, stack + 1);
    return { value, x: 26 + bin * 12, stack };
  });
  const baseline = Math.max(72, Math.max(0, ...bins.values()) * 7 + 12);
  return { dots, min, max, baseline, height: baseline + 37,
    x: (v: number) => 26 + 288 * (v - min) / (max - min) };
}

export function ArrivalPlot({ values, title, description, markers = [], clock = true, observed = false,
  labels }: { values: readonly number[]; title: string; description: string; markers?: PlotMarker[];
    clock?: boolean; observed?: boolean; labels?: string[] }) {
  const id = useId();
  if (!values.length || !values.every(Number.isFinite)) return null;
  const layout = arrivalPlotLayout(values, markers, clock);
  const format = (n: number) => clock
    ? new Date(n).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : `${Math.round(n / 60)} min`;
  const ticks = [layout.min, Math.round((layout.min + layout.max) / (clock ? 120_000 : 120)) * (clock ? 60_000 : 60), layout.max];
  return <figure style={{ margin: '16px 0' }}>
    <figcaption style={{ fontWeight: 600, fontSize: 14 }}>{title}</figcaption>
    <svg role="img" aria-labelledby={`${id}-title ${id}-description`} viewBox={`0 0 340 ${layout.height}`}
      style={{ width: '100%', display: 'block', marginTop: 8 }}>
      <title id={`${id}-title`}>{title}</title><desc id={`${id}-description`}>{description}</desc>
      {markers.map(m => <line key={m.label} x1={layout.x(m.value)} x2={layout.x(m.value)} y1={5} y2={layout.baseline + 4}
        stroke={m.color} strokeWidth={2} strokeDasharray={m.dashed ? '4 3' : undefined} />)}
      {layout.dots.map((d, i) => <circle key={i} cx={d.x} cy={layout.baseline - 5 - d.stack * 7} r={2.8}
        fill={observed ? '#fff' : '#3567a8'} stroke={observed ? '#6a4b86' : '#3567a8'} strokeWidth={observed ? 1.5 : 0.5}>
        <title>{labels?.[i] ?? format(d.value)}</title>
      </circle>)}
      <line x1={26} x2={314} y1={layout.baseline} y2={layout.baseline} stroke="#9aa5b1" />
      {ticks.map((t, i) => <text key={i} x={layout.x(t)} y={layout.baseline + 21} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
        fill="#4b5563" fontSize={16}>{format(t)}</text>)}
    </svg>
    {markers.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 12 }}>
      {markers.map(m => <span key={m.label} style={{ color: m.color }}><span aria-hidden="true">{m.dashed ? '┆' : '│'} </span>{m.label} {format(m.value)}</span>)}
    </div>}
    <p style={{ fontSize: 12, lineHeight: 1.5, color: '#5f6368', margin: '8px 0 0' }}>{description}</p>
  </figure>;
}
