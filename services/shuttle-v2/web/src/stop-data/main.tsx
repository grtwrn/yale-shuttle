import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StopDataCatalog, StopDataDay, StopDataDetail, StopDataVisit } from "../../../src/schema/stop-data";
import { ROUTE_ID_LABEL, ROUTE_COLOR_BY_BUS_ID } from "../routes";
import { Chart, type Series } from "./Chart";
import { clock, preciseClock, minutes, percentile, observedStand, compareModels } from "./analysis";
import { loadStudy, type StudyView, type SavedForecast } from "./study";
import "./style.css";

const BASELINE = "#b15f26", CANDIDATE = "#2876bb", OBSERVED = "#14786d", RECORDED = "#99918a";
const minuteTick = (n: number) => (n / 60).toFixed(1);
class AuthRequired extends Error {}
async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if (response.status === 401) throw new AuthRequired("Sign in to inspect retained stop data.");
  if (!response.ok) throw new Error(response.status === 503 ? "Operator access is not configured on this server." : `Could not load stop data (${response.status}).`);
  return response.json();
}
function Kpi({label, value, note}: {label: string; value: string | number; note: string}) {
  return <div className="kpi"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}
function Notices({items}: {items: string[]}) {
  return items.length ? <div className="notices">{[...new Set(items)].map(x => <p key={x}>{x}</p>)}</div> : null;
}
function App() {
  const [catalog, setCatalog] = useState<StopDataCatalog | null>(null);
  const [study, setStudy] = useState<StudyView | null>(null);
  const [day, setDay] = useState(""); const [routeId, setRouteId] = useState(3);
  const [occurrence, setOccurrence] = useState(""); const [bus, setBus] = useState("all");
  const [data, setData] = useState<StopDataDay | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StopDataDetail | null>(null);
  const [error, setError] = useState(""); const [detailError, setDetailError] = useState("");
  const [auth, setAuth] = useState(false); const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const [fileBusy, setFileBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importGeneration = useRef(0);

  useEffect(() => {
    if (study) return;
    const abort = new AbortController(); setBusy(true); setError(""); setCatalog(null); setData(null); setDetail(null);
    api<StopDataCatalog>("/api/stats/stops/catalog", abort.signal).then(result => {
      setCatalog(result); setAuth(false);
      setDay(previous => result.days.some(d => d.day === previous) ? previous : result.days[0]?.day ?? "");
      setRouteId(previous => result.routes.some(r => r.routeId === previous) ? previous : result.routes[0]?.routeId ?? 3);
    }).catch(e => { if (e.name === "AbortError") return; if (e instanceof AuthRequired) setAuth(true); else setError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [refresh, study]);
  const activeCatalog = study?.catalog ?? catalog;
  const route = activeCatalog?.routes.find(r => r.routeId === routeId);
  useEffect(() => {
    const stops = route?.occurrences ?? [];
    setOccurrence(old => stops.some(s => `${s.stopId}:${s.stopIndex}` === old) ? old : (() => {
      const ranked = [...stops].sort((a,b) => b.visitCount-a.visitCount);
      const first = (routeId === 3 ? ranked.find(s => s.stopId === 11) : undefined) ?? ranked[0];
      return first ? `${first.stopId}:${first.stopIndex}` : "";
    })());
  }, [route]);

  useEffect(() => {
    if (!day || !route || !occurrence || !route.occurrences.some(s => `${s.stopId}:${s.stopIndex}` === occurrence)) {
      setData(null); setDetail(null); setSelectedId(null); return;
    }
    const abort = new AbortController(); setError(""); setData(null); setDetail(null); setSelectedId(null); setBus("all");
    const [stopId, stopIndex] = occurrence.split(":").map(Number);
    if (study) {
      setData(study.day({ day, routeId, stopId, stopIndex })); setBusy(false);
    } else {
      setBusy(true);
      api<StopDataDay>(`/api/stats/stops/visits?${new URLSearchParams({day,routeId:String(routeId),stopId:String(stopId),stopIndex:String(stopIndex)})}`, abort.signal)
        .then(setData).catch(e => { if (e.name === "AbortError") return; if (e instanceof AuthRequired) setAuth(true); else setError(e.message); })
        .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    }
    return () => abort.abort();
  }, [day, routeId, occurrence, route, study, refresh]);
  const buses = useMemo(() => [...new Set(data?.visits.map(v => v.busKey) ?? [])].sort(), [data]);
  const visits = useMemo(() => data?.visits.filter(v => bus === "all" || v.busKey === bus) ?? [], [data, bus]);
  useEffect(() => { setSelectedId(old => visits.some(v => v.id === old) ? old : visits.find(v => observedStand(v) !== null)?.id ?? visits[0]?.id ?? null); }, [visits]);
  const selected = visits.find(v => v.id === selectedId);
  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selectedId) return;
    if (study) { setDetail(study.detail(selectedId)); return; }
    const abort = new AbortController();
    api<StopDataDetail>(`/api/stats/stops/visits/${encodeURIComponent(selectedId)}`, abort.signal).then(setDetail)
      .catch(e => { if (e.name === "AbortError") return; if (e instanceof AuthRequired) setAuth(true); else setDetailError(e.message); });
    return () => abort.abort();
  }, [selectedId, study, refresh]);
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/stats/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({token}), credentials: "same-origin" });
      setToken("");
      if (!response.ok) throw new Error(response.status === 429 ? "Too many sign-in attempts. Try again shortly." : "Could not sign in. Check the operator token.");
      setAuth(false); setRefresh(r => r+1);
    } catch (e) { setError((e as Error).message); } finally { setToken(""); setBusy(false); }
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    const generation = ++importGeneration.current;
    setFileBusy(true); setError("");
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("Study exceeds 25 MB. Export a smaller date or route selection.");
      const loaded = loadStudy(JSON.parse(await file.text()));
      if (generation !== importGeneration.current) return;
      setStudy(loaded); setDay(loaded.catalog.days[0]?.day ?? "");
      setRouteId(loaded.catalog.routes.some(r => r.routeId === 3) ? 3 : loaded.catalog.routes[0]?.routeId ?? 3); setOccurrence("");
    } catch (e) { if (generation === importGeneration.current) setError(`Could not open study: ${(e as Error).message}`); }
    finally { if (generation === importGeneration.current) setFileBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  const observed = visits.map(observedStand).filter((n): n is number => n !== null);
  const loops = visits.map(v => v.loopSec).filter((n): n is number => n !== null);
  const visitIds = new Set(visits.map(v=>v.id));
  const forecasts = study?.forecasts.filter(f => visitIds.has(f.visitId)) ?? [];
  const arms = study?.arms ?? [];
  const comparisons = useMemo(() => compareModels(visits, forecasts, arms), [visits, study, bus, day, routeId, occurrence]);
  const stop = route?.occurrences.find(s => `${s.stopId}:${s.stopIndex}` === occurrence);
  const color = ROUTE_COLOR_BY_BUS_ID[routeId] ?? OBSERVED;
  const chartSeries: Series[] = [{name: "Observed total stand", color: OBSERVED, line: false, points: visits.flatMap(v => {
    const sec = observedStand(v); return sec === null ? [] : [{x:v.pinnedAt!,y:sec,id:v.id,label:`${v.busName} · ${clock(v.pinnedAt!)} · ${minutes(sec)}`}];
  })}];
  if (study) for (let i=0;i<arms.length;i++) chartSeries.push({ name:`${arms[i]} · first total`,color:i===0?BASELINE:CANDIDATE,line:false,
    points: forecasts.filter(f => f.model === arms[i] && f.first && f.totalSec !== null).map(f => ({x:visits.find(v => v.id===f.visitId)!.pinnedAt ?? f.issuedAt,y:f.totalSec!,id:f.visitId,label:`${f.model} · ${clock(f.issuedAt)} · ${minutes(f.totalSec)}`})) });

  return <main className="operator-shell">
    <header className="page-header"><div><a className="eyebrow" href="/stats">Shuttle Tracker / Operator</a><h1>Stop data</h1><p>See what the buses did. Inspect what the algorithms predicted.</p></div><div className="header-actions"><button onClick={() => { ++importGeneration.current; setFileBusy(false); setStudy(null); setRefresh(r => r+1); }} disabled={busy}>Retained data ↻</button><button onClick={() => fileRef.current?.click()} disabled={fileBusy}>{fileBusy ? "Opening…" : "Open saved study"}</button><input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={e => void importFile(e.target.files?.[0])}/></div></header>
    {error && <div role="alert" className="error">{error}</div>}
    {auth && !study && <form className="login panel" onSubmit={signIn}><h2>Operator sign in</h2><p>Use the same token as the usage dashboard. Access is read-only.</p><label>Operator token<input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required/></label><button className="primary" disabled={busy}>Sign in</button></form>}
    {!auth && !activeCatalog && !error && <p role="status">Loading retained data…</p>}
    {activeCatalog && <>
      <div className="source-bar"><span className={`source-dot ${study ? "archive" : ""}`} /><strong>{study ? "Saved study" : "Retained database"}</strong><span>{study ? study.title : "Recorded detector visits · current server retention"}</span><span className="timezone">All times Eastern</span></div>
      {study && <p className="source-note">Opened locally in this browser; the file is not uploaded. {study.summary}</p>}
      <section className="filters panel" aria-label="Data filters">
        <label>Date<select aria-label="Date" value={day} onChange={e => setDay(e.target.value)}>{activeCatalog.days.map(d => <option key={d.day} value={d.day}>{d.day} · {d.visitCount} visits</option>)}</select></label>
        <label>Route<select aria-label="Route" value={routeId} onChange={e => setRouteId(Number(e.target.value))}>{activeCatalog.routes.map(r => <option key={r.routeId} value={r.routeId}>{ROUTE_ID_LABEL[r.routeId] ?? r.name}</option>)}</select></label>
        <label className="stop-filter">Stop occurrence<select aria-label="Stop occurrence" value={occurrence} onChange={e => setOccurrence(e.target.value)}>{route?.occurrences.map(s => <option key={`${s.stopId}:${s.stopIndex}`} value={`${s.stopId}:${s.stopIndex}`}>{s.name} · position {s.stopIndex+1} (ID {s.stopId})</option>)}</select></label>
        <label>Bus<select aria-label="Bus" value={bus} onChange={e => setBus(e.target.value)}><option value="all">All buses</option>{buses.map(b => <option key={b} value={b}>{data?.visits.find(v => v.busKey === b)?.busName || b}</option>)}</select></label>
      </section>
      <details className="evidence-notes"><summary>Evidence notes and coverage</summary><Notices items={[...activeCatalog.warnings, ...(data?.warnings ?? [])]}/></details>
      {!activeCatalog.days.length && <div className="empty-chart">No retained visits yet. Open a saved study to inspect archived observations.</div>}
      {busy && <p role="status">Loading visits…</p>}
      {data && <>
        <div className="section-heading"><div><h2><i className="route-mark" style={{background:color}}/>{stop?.name ?? `Stop ${data.selection.stopId}`}</h2><p>{ROUTE_ID_LABEL[routeId] ?? route?.name} · {day} · position {data.selection.stopIndex+1} · {visits.length} visits{bus !== "all" ? " for this bus" : ""}</p></div><span className="chip">{study ? "Reconstructed stop clock" : "Recorded stop clock"}</span></div>
        <div className="kpis"><Kpi label="Median total stand" value={minutes(percentile(observed,.5))} note={`${observed.length} completed stops`}/><Kpi label="90th percentile stand" value={minutes(percentile(observed,.9))} note="Observed duration, not a forecast"/><Kpi label="Median bus return" value={minutes(percentile(loops,.5))} note={`${loops.length} same-bus departure intervals`}/><Kpi label="Other visits" value={visits.length-observed.length} note="Passes, incomplete or unscorable"/></div>
        <section className="panel"><div className="panel-heading"><div><h3>Standing time through the day</h3><p>Select a point or table row to inspect that visit.</p></div><span className="unit">Duration in min</span></div><Chart title="Standing time through the day" series={chartSeries} xLabel="Stop time · Eastern" yLabel="Total stand (min)" xFormat={clock} yFormat={minuteTick} selectedId={selectedId} onSelect={setSelectedId}/></section>
        {study && <section className="panel"><div className="panel-heading"><div><h3>Saved algorithm comparison</h3><p>Paired query times only. First total uses each arm’s original first associated display; remaining error gives each visit equal weight.</p></div></div><div className="table-scroll"><table><thead><tr><th>Model</th><th>First total MAE</th><th>Bias</th><th>Under by &gt;2 min</th><th>Over by &gt;2 min</th><th>Remaining MAE</th></tr></thead><tbody>{comparisons.map((c,i) => <tr key={c.model}><th><i className="route-mark" style={{background:i===0?BASELINE:CANDIDATE}}/>{c.model}</th><td>{minutes(c.firstMae)}<small>{c.firstCount} visits</small></td><td>{minutes(c.firstBias)}</td><td>{c.underTwoMin}/{c.firstCount}</td><td>{c.overTwoMin}/{c.firstCount}</td><td>{minutes(c.remainingMae)}<small>{c.remainingVisits} visits · {c.pairedQueries} query pairs</small></td></tr>)}</tbody></table></div><p className="footnote">MAE = mean absolute error. Positive bias means overprediction. These descriptive results are not an independent validation; the study’s sampling and cohort apply. {new Set(visits.map(v => `${v.busKey}/${v.day}`)).size} bus/day groups in this selection.</p></section>}
        <div className="analysis-grid"><section className="panel visits-panel"><div className="panel-heading"><div><h3>Visit ledger</h3><p>Completed stops and unresolved evidence stay visible.</p></div></div><div className="table-scroll ledger"><table><thead><tr><th>Visit / bus</th><th>Total stand</th><th>Return interval</th><th>Outcome</th></tr></thead><tbody>{visits.map(v => <tr key={v.id} className={v.id === selectedId ? "selected" : ""}><td><button className="visit-button" onClick={() => setSelectedId(v.id)} aria-pressed={v.id===selectedId}>{clock(v.pinnedAt ?? v.anchoredAt)}<small>{v.busName || v.busKey}</small></button></td><td>{minutes(observedStand(v))}</td><td>{minutes(v.loopSec)}</td><td><span className={`outcome ${v.outcome === "stopped" ? "stopped" : ""}`}>{v.outcome}</span>{v.qualityNotes.length > 0 && <small>{v.qualityNotes.length} evidence notes</small>}</td></tr>)}</tbody></table>{!visits.length && <p className="empty-chart">No visits for this date and stop occurrence.</p>}</div>{data.truncated && <p className="footnote">Showing a capped subset of {data.totalVisits} visits. Counts describe the loaded subset.</p>}</section>
          <section className="panel"><h3>Time away and the next stand</h3><p>Time from the same bus’s previous departure to this stop pin. Unlike departure-to-departure intervals, time away excludes the current stand and is available when a forecast begins.</p><Chart title="Time away before reaching the stop against total stand" series={[{name:"Completed visit",color:OBSERVED,line:false,points:visits.flatMap(v => {const stand=observedStand(v);const away=v.pinnedAt!==null&&v.previousDepartureAt!==null?(v.pinnedAt-v.previousDepartureAt)/1000:null;return away !== null && away >= 0 && stand !== null ? [{x:away,y:stand,id:v.id,label:`${v.busName} · time away ${minutes(away)} · stand ${minutes(stand)}`}] : [];})}]} xLabel="Time away before stop pin (min)" yLabel="Total stand (min)" xFormat={minuteTick} yFormat={minuteTick} selectedId={selectedId} onSelect={setSelectedId}/></section></div>
        {selected && <VisitDetail key={selected.id} visit={selected} detail={detail} error={detailError} forecasts={forecasts.filter(f => f.visitId === selected.id)} arms={arms} archive={!!study}/>}
      </>}
      <details className="panel provenance"><summary>Data coverage and provenance</summary><p>{study ? study.summary : `Visits retained from ${activeCatalog.availability.visitsFrom ? new Date(activeCatalog.availability.visitsFrom).toISOString() : "unknown"}. Raw positions have a shorter retention window than stop visits; missing positions do not prove a bus was stationary.`}</p>{study ? <pre>{JSON.stringify(study.provenance,null,2)}</pre> : <dl><dt>Position coverage begins</dt><dd>{activeCatalog.availability.positionsFrom ? new Date(activeCatalog.availability.positionsFrom).toISOString() : "Unavailable"}</dd><dt>Position coverage ends</dt><dd>{activeCatalog.availability.positionsTo ? new Date(activeCatalog.availability.positionsTo).toISOString() : "Unavailable"}</dd></dl>}<p className="footnote">A stop occurrence is its position in the route sequence; repeated stop IDs are kept separate. Historical route identity can be uncertain. All displayed metrics use only the current filters.</p></details>
    </>}
  </main>;
}

function VisitDetail({visit:v, detail, error, forecasts, arms, archive}: {visit:StopDataVisit;detail:StopDataDetail|null;error:string;forecasts:SavedForecast[];arms:string[];archive:boolean}) {
  const [mode,setMode] = useState<"remaining"|"total"|"arrival">("remaining");
  const [targetId,setTargetId] = useState("");
  const [nearStop,setNearStop] = useState(true);
  const [cursor,setCursor] = useState(0);
  const pin = v.pinnedAt ?? v.anchoredAt;
  const duration = observedStand(v);
  const selectedTimes = [...new Set(forecasts.map(f => f.issuedAt))].sort((a,b)=>a-b);
  const at = selectedTimes[Math.min(cursor,selectedTimes.length-1)] ?? pin;
  const current = forecasts.filter(f => f.issuedAt === at);
  const targets = [...new Map(forecasts.flatMap(f => f.downstream ? [[f.downstream.arrivalId,f.downstream] as const] : [])).values()];
  const target = targets.find(t => t.arrivalId === targetId) ?? targets[0];
  const series: Series[] = [];
  if (duration !== null && mode !== "arrival") series.push({name:mode === "remaining" ? "Observed remaining" : "Observed total",color:OBSERVED,points: mode === "remaining" ? [{x:0,y:duration},{x:duration,y:0}] : [{x:0,y:duration},{x:Math.max(duration,1),y:duration}]});
  if (mode === "arrival") {
    const valid = forecasts.filter(f => f.downstream?.arrivalId === target?.arrivalId && f.downstream !== null);
    if (target) series.push({name:`Observed arrival · stop ${target.stopId}`,color:OBSERVED,points:valid.map(f => ({x:(f.issuedAt-pin)/1000,y:(f.downstream!.targetAt-f.issuedAt)/1000}))});
  }
  arms.forEach((arm,i) => {
    const relevant = forecasts.filter(f => f.model === arm).flatMap(f => {
      const value = mode === "total" ? f.totalSec : mode === "remaining" ? f.remainingSec : f.downstream?.arrivalId === target?.arrivalId ? f.downstream?.medianSec ?? null : null;
      return value === null ? [] : [{x:(f.issuedAt-pin)/1000,y:value,label:`${clock(f.issuedAt)} · ${minutes(value)}`}];
    });
    series.push({name:arm,color:i===0?BASELINE:CANDIDATE,points:relevant,dots:true});
    if (mode === "arrival") for (const bound of ["lowSec","highSec"] as const) {
      series.push({name:`${arm} · ${bound === "lowSec" ? "10th" : "90th"} percentile`,color:i===0?BASELINE:CANDIDATE,dashed:true,points:forecasts.filter(f=>f.model===arm && f.downstream?.arrivalId===target?.arrivalId).flatMap(f=>f.downstream?.[bound]===null || f.downstream?.[bound]===undefined?[]:[{x:(f.issuedAt-pin)/1000,y:f.downstream[bound]!}])});
    }
  });
  // A line across a missing GPS interval would invent movement. Split at every >30s gap.
  const positionSeries: Series[] = [];
  let previousBusId: number | null = null;
  for (const p of detail?.positions ?? []) {
    if (p.distanceM === null) continue;
    if (!positionSeries.length || previousBusId !== p.busId || (p.gapSec !== null && p.gapSec > 30)) positionSeries.push({name:`GPS segment ${positionSeries.length+1} · bus ID ${p.busId}`,color:OBSERVED,points:[],dots:true});
    positionSeries[positionSeries.length-1].points.push({x:(p.at-pin)/1000,y:p.distanceM,label:`${preciseClock(p.at)} · ${p.distanceM.toFixed(0)} metres${p.gapSec === null ? "" : ` · gap ${p.gapSec.toFixed(0)} sec`}`});
    previousBusId = p.busId;
  }
  return <section className="panel visit-detail" aria-label="Selected visit"><div className="panel-heading"><div><span className="eyebrow">Selected visit</span><h3>{v.busName || v.busKey} · {preciseClock(pin)}</h3><p>{v.day} · {v.outcome} · visit {v.id}</p></div><strong className="selected-duration">{minutes(duration)}<small>observed total stand</small></strong></div>
    <div className="clocks"><div><span>{archive ? "Reconstructed pin" : "Recorded pin"}</span><strong>{preciseClock(v.pinnedAt)}</strong></div><div><span>Stored pin</span><strong>{preciseClock(v.recordedPinnedAt)}</strong></div><div><span>Departure</span><strong>{preciseClock(v.departedAt)}</strong></div><div><span>Prior same-bus departure</span><strong>{preciseClock(v.previousDepartureAt)}</strong></div></div>
    {v.recordedPinnedAt !== null && v.pinnedAt !== null && Math.abs(v.recordedPinnedAt-v.pinnedAt) > 1000 && <p className="clock-warning">Stored pin differs from the reconstructed clock by {minutes((v.recordedPinnedAt-v.pinnedAt)/1000)}. A late pin can make a long stand appear short.</p>}
    <Notices items={v.qualityNotes}/>
    {forecasts.length ? <>
      <div className="panel-heading forecast-heading"><div><h3>What did the algorithms say?</h3><p>Saved outputs at the original query times. The time slider inspects predictions; it does not refit the model.</p></div><div className="segmented" aria-label="Prediction target">{([['remaining','Remaining wait'],['total','Total stand'],['arrival','Downstream ETA']] as const).map(([key,label]) => <button key={key} aria-pressed={mode===key} onClick={()=>setMode(key)}>{label}</button>)}</div></div>
      <Chart title={`${mode} forecasts for selected visit`} series={series} xLabel="Time since stop pin (min)" yLabel={mode === "total" ? "Total stand (min)" : "Time remaining (min)"} xFormat={minuteTick} yFormat={minuteTick} cursor={(at-pin)/1000}/>
      {mode === "arrival" && <label>Observed target arrival<select aria-label="Observed target arrival" value={target?.arrivalId ?? ""} onChange={e=>setTargetId(e.target.value)}>{targets.map(t=><option key={t.arrivalId} value={t.arrivalId}>Stop {t.stopId} · position {t.stopIndex+1} · {preciseClock(t.targetAt)}</option>)}</select></label>}
      <label className="scrubber">Inspect query · {preciseClock(at)}<input type="range" min={0} max={Math.max(0,selectedTimes.length-1)} value={Math.min(cursor,selectedTimes.length-1)} onChange={e=>setCursor(Number(e.target.value))}/></label>
      <div className="query-readings">{current.map((f,i)=><div key={f.model} style={{borderTopColor:i===0?BASELINE:CANDIDATE}}><strong>{f.model}</strong><span>{minutes(mode==="total"?f.totalSec:mode==="remaining"?f.remainingSec:f.downstream?.arrivalId===target?.arrivalId?f.downstream?.medianSec??null:null)}</span><small>{f.modelLabel}</small><small>Saved display: {minutes(f.displaySec)} · {f.displayKind}</small><small>Browser stand origin: {preciseClock(f.observedStartAt)}</small>{f.first && <small>Original first associated display</small>}{f.note && <small>{f.note}</small>}</div>)}</div>
    </> : <div className="empty-chart">No saved algorithm forecasts for this visit. Open an exported study to compare the recorded baseline and candidate outputs.</div>}
    <details open><summary>Position evidence</summary>{error && <p role="alert" className="error">{error}</p>}{!detail && !error ? <p>Loading position evidence…</p> : <><p>Distance from the stop’s available coordinate. Lines break at bus ID changes and gaps longer than 30 seconds. Pin and departure remain detector interpretations of these observations.</p><Notices items={detail?.warnings ?? []}/><div className="segmented" aria-label="GPS distance range"><button aria-pressed={nearStop} onClick={()=>setNearStop(true)}>Near stop · 0–200 metres</button><button aria-pressed={!nearStop} onClick={()=>setNearStop(false)}>Full distance range</button></div><Chart title="Raw GPS distance from selected stop" series={positionSeries} xLabel="Time since stop pin (min)" yLabel="Distance (metres)" xFormat={minuteTick} yFormat={n=>n.toFixed(0)} yDomain={nearStop?[0,200]:undefined} markers={[{x:0,label:"Pin"},...(duration===null?[]:[{x:duration,label:"Departure"}])]}/><p className="footnote">{detail?.positions.length ?? 0} positions · largest gap {detail?.coverage.maxGapSec === null ? "unavailable" : `${detail?.coverage.maxGapSec?.toFixed(0)} sec`} · stored detector stand {minutes(v.recordedStandSec)}{detail?.coverage.truncated ? " · position count capped" : ""}{detail?.coverage.windowCapped ? " · time window capped" : ""}.</p></>}</details>
  </section>;
}

class Boundary extends React.Component<{children:React.ReactNode},{error:string}> {
  state = {error:""};
  static getDerivedStateFromError(error:Error) { return {error:error.message}; }
  render() { return this.state.error ? <main className="operator-shell"><h1>Stop data could not be displayed</h1><p role="alert">{this.state.error}</p><button onClick={()=>location.reload()}>Reload</button></main> : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<Boundary><App/></Boundary>);
