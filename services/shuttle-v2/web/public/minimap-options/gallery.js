// Standalone design review. Every time is illustrative; no API, analytics,
// live forecasting, external maps, or application state is used here.
const concepts = [
  {id:1,title:'Map for location',description:'<strong>All timing below.</strong> The map answers “where?” with a bus and two stops. The card answers “when?”'},
  {id:2,title:'Pickup first',description:'<strong>One useful number on the map.</strong> Keep the pickup window beside your stop. Destination timing stays in the card.'},
  {id:3,title:'Destination first',description:'<strong>Lead with getting to class.</strong> A clean map sits above a prominent destination arrival window.'},
  {id:4,title:'One route at a time',description:'<strong>Choose a route above the map.</strong> Compare Red and Blue without stacking buses and time labels. Try the tabs.'},
  {id:5,title:'Tap to reveal',description:'<strong>Start almost empty.</strong> Stop labels and bus waiting stats appear only when requested. Tap the bus or a stop.'},
  {id:6,title:'One status strip',description:'<strong>Keep facts in one fixed place.</strong> A short strip carries the pickup window and compact waiting time, leaving the map clear.'},
  {id:7,title:'Your next step',description:'<strong>Show what matters right now.</strong> Start with the walk to pickup. Switch to Wait or Ride as the trip progresses.'},
  {id:8,title:'A simple stop timeline',description:'<strong>Replace geography with sequence.</strong> Bus → pickup → destination. Waiting and arrival information has a stable place.'},
  {id:9,title:'Zoom into pickup',description:'<strong>Prioritize the place you board.</strong> A close pickup map fills the space; a tiny inset preserves the trip overview.'},
  {id:10,title:'Map when you need it',description:'<strong>Put the arrival card first.</strong> Keep a small route preview folded away until someone wants the geography.'},
];
const busIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 19v2m8-2v2M9 6h6"/><circle cx="8.5" cy="15.5" r=".8" fill="currentColor"/><circle cx="15.5" cy="15.5" r=".8" fill="currentColor"/></svg>';
const busShape = `<span class="bus-shape">${busIcon}</span>`;
const routeBadge = '<span class="route-badge">Red</span>';
function map({pickup=false,labels=false,quiet=false,walk=false,inset=false,blue=false,bus=true}={}) {
  const color=blue?'#3466ae':'#c83443';
  return `<div class="map ${walk?'walk-map':''} ${inset?'pickup-local':''}" style="--red:${color}">
    <svg viewBox="0 0 360 250" aria-hidden="true">
      <rect width="360" height="250" fill="#edf0ea"/>
      <g fill="#e2e8dd"><rect x="17" y="147" width="61" height="74" rx="12"/><rect x="261" y="18" width="70" height="58" rx="9"/></g>
      <g fill="none" stroke="#dce2dc" stroke-width="12"><path d="M0 94H360M0 182H360M62 0V250M169 0V250M299 0V250"/></g>
      <g fill="none" stroke="#fff" stroke-width="9"><path d="M0 94H360M0 182H360M62 0V250M169 0V250M299 0V250"/><path d="M100 0V126H230L207 250M0 40H360M0 223H360" stroke-width="15"/></g>
      <g fill="#dfe4de"><rect x="184" y="145" width="17" height="20" rx="2"/><rect x="245" y="138" width="22" height="29" rx="3"/><rect x="112" y="50" width="29" height="28" rx="3"/><rect x="81" y="193" width="44" height="15" rx="2"/></g>
      ${quiet?'':'<g fill="#69766b" font-size="10"><text x="241" y="209" transform="rotate(-79 241 209)">Prospect St</text><text x="16" y="87">Division St</text></g>'}
      <path d="M100 72V126H230" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="5 7" opacity="${walk?'.2':'.6'}"/>
      <path d="M230 126Q227 152 221 180L214 225" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity="${walk?'.14':'1'}"/>
      <path d="M286 108V126H230" fill="none" stroke="${walk?'#337251':'#66917d'}" stroke-width="${walk?'4':'2.5'}" stroke-dasharray="3 5" stroke-linecap="round"/>
      <circle cx="286" cy="108" r="11" fill="#377eca" fill-opacity=".13"/><circle cx="286" cy="108" r="5" fill="#377eca" stroke="white" stroke-width="2"/>
      <circle cx="230" cy="126" r="8" fill="white" stroke="#233d34" stroke-width="3"/>
      <circle cx="214" cy="225" r="7" fill="${color}" stroke="white" stroke-width="3" opacity="${walk?'.3':'1'}"/>
      ${labels?'<text x="224" y="247" font-size="11" font-weight="650" fill="#233d34">Rosenkranz</text>':''}
      <path d="M10 23V12m-3 4 3-4 3 4" stroke="#697b6f" stroke-width="1.5" fill="none"/><text x="7" y="34" font-size="8" fill="#697b6f">N</text>
    </svg>
    ${bus?`<button class="map-bus" data-detail="${blue?'blue':'bus'}" aria-label="${blue?'Blue':'Red'} shuttle: show waiting details">${busShape}${blue?'':'<span class="pause" aria-hidden="true">Ⅱ</span>'}</button>`:''}
    ${pickup?'<button class="map-chip pickup-chip" data-detail="pickup" aria-label="Pickup estimate 5 to 9 minutes, show details">Pickup 5–9 min</button>':''}
    ${labels&&!pickup?'<button class="map-chip" style="left:47%;top:34%;font-size:11px;padding:7px 9px" data-detail="pickup">Board here</button>':''}
    ${quiet?'<button class="stop-target" style="left:63.9%;top:50.4%" data-detail="pickup" aria-label="Division / Prospect pickup details"></button><button class="stop-target" style="left:59.4%;top:90%" data-detail="destination" aria-label="Rosenkranz arrival details"></button>':''}
    ${inset?'<div class="inset"><span>Whole trip</span><svg viewBox="0 0 60 75" aria-hidden="true"><path d="M15 10V31H43L34 65" stroke="#c83443" stroke-width="3" fill="none"/><circle cx="15" cy="10" r="4" fill="#c83443"/><circle cx="43" cy="31" r="4" fill="white" stroke="#233d34" stroke-width="2"/><circle cx="34" cy="65" r="4" fill="#c83443"/></svg></div>':quiet?'':`<span class="map-key">${walk?'Walk to stop':blue?'Blue':'Red'}</span><span class="map-caption">Simplified</span>`}
  </div>`;
}
function summary({hero=false,pickup=true,blue=false}={}) {
  return `<div class="summary ${hero?'wide':''}"><div class="summary-head"><span class="summary-title">At Rosenkranz <small>(est.)</small></span><strong>${blue?'3:28–3:34':'3:24–3:30'}<small> pm</small></strong></div><div class="summary-meta"><span>${pickup?`Pickup ${blue?'8–12':'5–9'} min`:'2 min walk to pickup'}</span><span>${pickup?'2 min walk to stop':'Red shuttle'}</span></div></div>`;
}
function statusStrip(){return '<div class="status-strip"><span>Pickup <strong>5–9 min</strong></span><button data-detail="bus" aria-label="Red shuttle waited 4 minutes, usually 7 minutes total"><span class="pause-dot" aria-hidden="true">Ⅱ</span> Red <strong>4/~7m</strong></button></div>';}
function rail(){return `<div class="rail">
  <div class="rail-stop bus-stop"><button class="rail-bus" data-detail="bus" aria-label="Red shuttle waiting details">${busShape}</button><span class="eyeline">Red shuttle · waiting</span><strong>344 Winchester</strong><small>4 min so far · usually ~7 total</small></div>
  <div class="rail-stop"><span class="eyeline">Your pickup</span><strong>Division / Prospect</strong><span class="rail-time">5–9 min</span><small>2 min walk from you</small></div>
  <div class="rail-stop"><span class="eyeline">Your destination</span><strong>Rosenkranz</strong><span class="rail-time">3:24–3:30 pm <small style="display:inline">est.</small></span></div>
  </div><div class="rail-note">Stop order · spacing does not represent time</div>`;}
function content(id){
  switch(id){
    case 1:return map({labels:true})+'<div class="summary paired"><div><span class="summary-title">Pickup in</span><strong>5–9 <small>min</small></strong></div><div><span class="summary-title">At Rosenkranz (est.)</span><strong>3:24–3:30 <small>pm</small></strong></div></div><div class="small-foot"><span>2 min walk to pickup</span><span>Red shuttle</span></div>';
    case 2:return map({pickup:true})+summary({pickup:false});
    case 3:return '<div class="mini-title"><strong>Division / Prospect → Rosenkranz</strong></div>'+map()+summary({hero:true});
    case 4:return '<div class="route-tabs" role="group" aria-label="Example routes"><button class="route-tab" data-route="red" aria-pressed="true">Red <small>Pickup 5–9 min</small></button><button class="route-tab blue" data-route="blue" aria-pressed="false">Blue <small>Pickup 8–12 min</small></button></div><div class="route-content">'+map()+summary()+'</div>';
    case 5:return map({quiet:true})+'<div class="small-foot"><span>Tap a marker for details</span><span>Red</span></div>'+summary();
    case 6:return map()+statusStrip()+summary({pickup:false});
    case 7:return '<div class="action-banner"><strong>Walk to Division / Prospect</strong><span>2 min walk · bus expected in 5–9 min</span></div><div class="phase-tabs" role="group" aria-label="Trip stage"><button data-phase="walk" aria-pressed="true">1 Walk</button><button data-phase="wait" aria-pressed="false">2 Wait</button><button data-phase="ride" aria-pressed="false">3 Ride</button></div><div class="phase-content">'+map({walk:true})+'</div>'+summary({pickup:false});
    case 8:return rail()+'<div class="small-foot"><span>Red · to Rosenkranz</span><button class="expand-map" data-detail="map">Open map ↗</button></div>';
    case 9:return '<div class="local-header"><strong>Division / Prospect</strong><span>Pickup area</span></div>'+map({inset:true,pickup:true})+summary({pickup:false});
    case 10:return '<div class="action-banner"><span>At Rosenkranz · estimated</span><strong style="font-size:32px;margin-top:6px">3:24–3:30 <small style="font-size:17px;font-weight:500">pm</small></strong><span>Pickup in 5–9 min · 2 min walk to stop</span></div><details class="foldaway"><summary><svg viewBox="0 0 160 48" aria-hidden="true"><path d="M10 29H58Q68 29 75 20L85 11H150" stroke="#c83443" stroke-width="3" fill="none"/><circle cx="10" cy="29" r="6" fill="#c83443"/><circle cx="81" cy="15" r="5" stroke="#233d34" stroke-width="2" fill="white"/><circle cx="150" cy="11" r="5" fill="#c83443"/></svg><span>Show / hide map</span></summary>'+map({labels:true})+'</details><div class="quiet-details"><strong>Board</strong> Division / Prospect<br><strong>Get off</strong> Prospect / Sachem<br><strong>Then walk</strong> to Rosenkranz</div>';
  }
}
const storageKey='shuttle-minimap-design-favorites-v1';
let saved=new Set();try{const value=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(value))saved=new Set(value.filter(n=>Number.isInteger(n)&&n>=1&&n<=10));}catch{}
let favoritesOnly=false;
document.querySelector('#gallery').innerHTML=concepts.map(c=>`<article class="concept" id="option-${c.id}" data-id="${c.id}"><div class="concept-head"><span class="number">${String(c.id).padStart(2,'0')}</span><h2>${c.title}</h2><button class="save" aria-label="Save option ${c.id}: ${c.title}" aria-pressed="false" data-save="${c.id}">Save</button></div><div class="phone"><div class="phone-top"><span class="trip">${routeBadge} <small>to</small> Rosenkranz</span><span class="demo-clock">3:10 pm</span></div>${content(c.id)}</div><p class="explanation">${c.description}</p></article>`).join('');
function updateSaved(){
  document.querySelector('#saved-count').textContent=saved.size;
  document.querySelectorAll('[data-save]').forEach(b=>{const active=saved.has(Number(b.dataset.save));b.setAttribute('aria-pressed',String(active));b.textContent=active?'Saved ✓':'Save';});
  document.querySelectorAll('.concept').forEach(c=>c.hidden=favoritesOnly&&!saved.has(Number(c.dataset.id)));
  document.querySelector('#empty').hidden=!favoritesOnly||saved.size>0;
  document.querySelector('#all').setAttribute('aria-pressed',String(!favoritesOnly));document.querySelector('#all').classList.toggle('active',!favoritesOnly);
  document.querySelector('#favorites').setAttribute('aria-pressed',String(favoritesOnly));document.querySelector('#favorites').classList.toggle('active',favoritesOnly);
}
updateSaved();
const dialog=document.querySelector('#detail');
function showDetail(kind){
  const bodies={
    bus:`${routeBadge}<h2 id="detail-title">Waiting at 344 Winchester</h2><p>Red shuttle #309</p><div class="detail-stats"><div><strong>4 min</strong><span>Waited so far</span></div><div><strong>~7 min</strong><span>Typical total wait</span></div></div><p>The typical wait is historical context, not a countdown to departure.</p>`,
    blue:'<h2 id="detail-title">Blue shuttle</h2><p>Moving toward Division / Prospect.</p><p>Pickup estimate: 8–12 min. This alternative route is included only to demonstrate route switching.</p>',
    pickup:'<h2 id="detail-title">Division / Prospect</h2><p>Your pickup stop · 2 min walk away</p><div class="detail-stats"><div><strong>5–9 min</strong><span>Estimated bus arrival</span></div></div><p>This is an estimated window, not guaranteed earliest and latest arrival times.</p>',
    destination:'<h2 id="detail-title">Rosenkranz</h2><div class="detail-stats"><div><strong>3:24–3:30</strong><span>pm · estimated destination arrival</span></div></div><p>Includes the walk after getting off the shuttle.</p>',
    map:'<h2 id="detail-title">Your route</h2>'+map({labels:true,bus:false}),
  };
  document.querySelector('#detail-content').innerHTML=bodies[kind]+'<p class="sample-note">Illustrative example · not live data</p>';
  dialog.showModal();
}
document.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.save){const id=Number(button.dataset.save);saved.has(id)?saved.delete(id):saved.add(id);try{localStorage.setItem(storageKey,JSON.stringify([...saved]));}catch{}updateSaved();document.querySelector('#announcement').textContent=`Option ${id} ${saved.has(id)?'saved':'removed'}.`;}
  if(button.id==='all'||button.id==='favorites'){favoritesOnly=button.id==='favorites';updateSaved();}
  if(button.classList.contains('close'))dialog.close();
  if(button.dataset.detail)showDetail(button.dataset.detail);
  if(button.dataset.route){const phone=button.closest('.phone'),blue=button.dataset.route==='blue';phone.querySelectorAll('[data-route]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));phone.querySelector('.route-content').innerHTML=map({blue})+summary({blue});phone.querySelector('.phone-top .route-badge').textContent=blue?'Blue':'Red';phone.querySelector('.phone-top .route-badge').style.background=blue?'#3466ae':'#c83443';}
  if(button.dataset.phase){const phone=button.closest('.phone'),phase=button.dataset.phase;phone.querySelectorAll('[data-phase]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));phone.querySelector('.phase-content').innerHTML=map({walk:phase==='walk',pickup:phase==='wait',bus:phase!=='ride'});const title={walk:'Walk to Division / Prospect',wait:'Wait at Division / Prospect',ride:'Ride to Prospect / Sachem'}[phase];phone.querySelector('.action-banner strong').textContent=title;phone.querySelector('.action-banner span').textContent={walk:'2 min walk · bus expected in 5–9 min',wait:'Red shuttle expected in 5–9 min',ride:'Then walk to Rosenkranz'}[phase];}
});
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
document.querySelectorAll('.start-hint a').forEach(a=>a.addEventListener('click',()=>{favoritesOnly=false;updateSaved();}));
