import type {UpcomingArrival} from './arrivals';
import {predictionWindow} from './arrivalDetails';
import {fmtMin,fmtWalk} from './format';

export type EarlyPickupForecast=Pick<UpcomingArrival,'busName'|'eta'|'low'|'high'>;

/** Values are already aged to this render by the live arrival source. */
export function EarlyPickupNotice({arrival,walkSec}:{arrival:EarlyPickupForecast;walkSec:number}) {
  const band=predictionWindow(arrival.low,arrival.high);
  const range=band?.text.includes('–') ? band.text : null;
  return <span role="note" data-testid="approaching-pickup" style={{display:'block',fontSize:12,lineHeight:'17px',color:'#5f6368'}}>
    <strong>Approaching #{arrival.busName.replace(/^#/,'')}: {arrival.eta<60?'<1 min':`~${fmtMin(arrival.eta)}`}{range?` (${range})`:''}</strong>
    {' · '}estimated walk {fmtWalk(walkSec)}
  </span>;
}
