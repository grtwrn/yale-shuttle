/** Internal model-distribution diagnostics. Existing operational WIS and
 * promotion decisions remain unchanged; these summaries cannot publish a model. */
export const DISTRIBUTION_PROBABILITIES = Object.freeze(Array.from({length:50},(_,i)=>(i+.5)/50));

export function distributionLoss(estimate, outcomeSec) {
 if(typeof outcomeSec!=='number'||!Number.isFinite(outcomeSec)||outcomeSec<0)return{scored:false,reason:'missing-outcome'};
 if(estimate?.missing)return{scored:false,reason:'missing-prediction'};
 const raw=estimate?.raw??estimate,quantiles=raw?.distribution,probabilities=raw?.distributionProbabilities;
 if(quantiles===undefined&&probabilities===undefined)return{scored:false,reason:'missing-distribution'};
 if(!Array.isArray(quantiles)||!Array.isArray(probabilities)||quantiles.length!==50||probabilities.length!==50)
  return{scored:false,reason:'invalid-distribution'};
 for(let i=0;i<50;i++)if(!Object.hasOwn(quantiles,i)||!Object.hasOwn(probabilities,i)
  ||probabilities[i]!==DISTRIBUTION_PROBABILITIES[i]||typeof quantiles[i]!=='number'
  ||!Number.isFinite(quantiles[i])||(i>0&&quantiles[i]<quantiles[i-1]))
  return{scored:false,reason:'invalid-distribution'};
 const age=estimate?.ageSec??0;
 if(typeof age!=='number'||!Number.isFinite(age)||age<0||age>=45)return{scored:false,reason:'invalid-age'};
 // These are the actual runtime quantiles. Neither conformal widening nor
 // model fitting is repeated here. Preserve the stored model-time values.
 const remaining=quantiles.map(q=>Math.max(0,q-age));
 const loss=remaining.reduce((sum,q,i)=>sum+(probabilities[i]-(outcomeSec<q?1:0))*(outcomeSec-q),0)/remaining.length;
 if(!Number.isFinite(loss))return{scored:false,reason:'invalid-distribution'};
 return{scored:true,loss,remaining};
}

/** Paired loss only when both distributions and the existing served control
 * are usable. Retain the whole cohort in counts, including unknown outcomes,
 * legacy records without distributions and malformed diagnostic evidence. */
export function distributionDiagnostics(rows, controlValid=()=>true) {
 const cells={};
 for(const row of rows){
  const keys=new Set(['0|all',`${row.r}|all`]);
  if(['0-2','2-5','5-10','10-30'].includes(row.h)){keys.add(`0|${row.h}`);keys.add(`${row.r}|${row.h}`);}
  const control=controlValid(row),a=distributionLoss(row.champion,row.det),b=distributionLoss(row.challenger,row.det);
  for(const key of keys){
   const c=cells[key]??={n:0,paired:0,invalidControl:0,missingOutcome:0,championUnavailable:0,challengerUnavailable:0,unavailableReasons:{},championLoss:0,challengerLoss:0};c.n++;
   if(!control){c.invalidControl++;continue;}
   if(a.reason==='missing-outcome'){c.missingOutcome++;continue;}
   if(!a.scored||!b.scored){
    for(const [name,result]of [['champion',a],['challenger',b]])if(!result.scored){c[name+'Unavailable']++;const reason=name+':'+result.reason;c.unavailableReasons[reason]=(c.unavailableReasons[reason]??0)+1;}
    continue;
   }
   c.paired++;c.championLoss+=a.loss;c.challengerLoss+=b.loss;
  }
 }
 for(const c of Object.values(cells)){
  c.championMeanLoss=c.paired?c.championLoss/c.paired:null;c.challengerMeanLoss=c.paired?c.challengerLoss/c.paired:null;
  c.meanLossDelta=c.paired?(c.challengerLoss-c.championLoss)/c.paired:null;
 }
 return{metric:'mean-pinball-loss',unit:'seconds',role:'secondary diagnostic; does not authorize promotion',probabilities:[...DISTRIBUTION_PROBABILITIES],cells};
}
