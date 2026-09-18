"""Read-only descriptive join and prespecified small chronological screen.
No service/model changes. Paths are local captured artifacts and a readonly DB.
"""
import collections, datetime, json, math, pathlib, sqlite3, statistics, zoneinfo

ROOT = pathlib.Path('/home/gwarren/projects/yale-shuttle-watcher')
HERE = ROOT / 'red-window-data'
TZ = zoneinfo.ZoneInfo('America/New_York')
db = sqlite3.connect('file:' + str(ROOT / 'red-eta-data/replay-lap.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
trips = json.loads((HERE / 'trumbull-division-history.json').read_text())['journey']['trips']
table = json.loads((HERE / 'live-wide-report.json').read_text())['feed']['dwells']['3']['11']
rows = []
for t in trips:
    visits = list(db.execute("""SELECT * FROM stop_visits WHERE route_id=3 AND stop_id=11
      AND bus_name=? AND pinned_at>=? AND departed_at<=? AND outcome='stopped'""",
      (t['busName'], t['startedAt'], t['arrivedAt'])))
    if len(visits) != 1:
        raise ValueError('Ambiguous or missing Winchester visit')
    v = visits[0]
    prev = db.execute("""SELECT MAX(departed_at) FROM stop_visits WHERE route_id=3
      AND stop_id=11 AND bus_name=? AND departed_at<?""", (t['busName'], v['pinned_at'])).fetchone()[0]
    assert t['startedAt'] <= v['pinned_at'] <= v['departed_at'] <= t['arrivedAt']
    assert prev is None or prev <= t['startedAt']
    assert abs(t['actualSec'] - (t['arrivedAt']-t['startedAt'])/1000) < .002
    rows.append(dict(bus=t['busName'], date=datetime.datetime.fromtimestamp(t['startedAt']/1000, TZ).date().isoformat(),
      startedAt=t['startedAt'], arrivedAt=t['arrivedAt'], winchesterPinnedAt=v['pinned_at'], winchesterDepartedAt=v['departed_at'],
      approachSec=(v['pinned_at']-t['startedAt'])/1000, standSec=(v['departed_at']-v['pinned_at'])/1000,
      afterSec=(t['arrivedAt']-v['departed_at'])/1000, totalSec=t['actualSec'],
      lapSec=(v['pinned_at']-prev)/1000 if prev is not None else None,
      knownAgeAtOriginSec=(t['startedAt']-prev)/1000 if prev is not None else None))
db.close()

def q(values, p):
    a = sorted(values)
    return a[min(len(a)-1, max(0, math.ceil(p*len(a))-1))]

def cov(x, y):
    mx, my = statistics.mean(x), statistics.mean(y)
    return sum((a-mx)*(b-my) for a,b in zip(x,y))/(len(x)-1)

def corr(x, y):
    return cov(x,y)/statistics.stdev(x)/statistics.stdev(y)

def ols(rows, feature, target):
    x, y = [r[feature] for r in rows], [r[target] for r in rows]
    b = cov(x,y)/statistics.variance(x)
    a = statistics.mean(y)-b*statistics.mean(x)
    return dict(intercept=a, slope=b)

def predict(fit, row, feature):
    return fit['intercept'] + fit['slope']*row[feature]

def score(records):
    early = sum(r['truth']<r['low'] for r in records)
    late = sum(r['truth']>r['high'] for r in records)
    n = len(records)
    def wis(r):
        interval = r['high']-r['low']+10*max(0,r['low']-r['truth'])+10*max(0,r['truth']-r['high'])
        return (.5*abs(r['point']-r['truth'])+.1*interval)/1.5
    return dict(n=n, covered=n-early-late, early=early, late=late,
      meanWidthSec=statistics.mean(r['high']-r['low'] for r in records),
      maeSec=statistics.mean(abs(r['point']-r['truth']) for r in records),
      meanWIS=statistics.mean(wis(r) for r in records))

a, s = [r['approachSec'] for r in rows], [r['standSec'] for r in rows]
# This current published band is used only for the descriptive association,
# not to select observations in the chronological experiment below.
band = [.65*table['lapM'], 1.65*table['lapM']]
in_band = [r for r in rows if r['lapSec'] is not None and band[0]<=r['lapSec']<=band[1]]
fit = ols(in_band, 'lapSec', 'standSec')
descriptive = dict(n=len(rows), dates=len({r['date'] for r in rows}), corrApproachStand=corr(a,s),
  varianceApproachPlusStand=statistics.variance([x+y for x,y in zip(a,s)]),
  varianceIndependentMarginals=statistics.variance(a)+statistics.variance(s),
  lapBand=band, lapN=len(in_band), lapFit=fit,
  corrLapStand=corr([r['lapSec'] for r in in_band], [r['standSec'] for r in in_band]),
  rawStandSd=statistics.stdev(r['standSec'] for r in in_band),
  inSampleResidualSd=statistics.stdev(r['standSec']-predict(fit,r,'lapSec') for r in in_band))

# Fixed calendar split chosen before reading test scores: first three service
# dates fit, next two calibrate, last three test. No hyperparameter search.
dates=sorted({r['date'] for r in rows})
trainDates, calibrationDates, testDates=dates[:3], dates[3:5], dates[5:]
train = [r for r in rows if r['date'] in trainDates]
# Service-continuity band for the screen comes from TRAINING ONLY. A missing
# or out-of-band previous departure is not a valid same-service-block lap.
reference = statistics.median(r['lapSec'] for r in train if r['lapSec'] is not None)
eligible = [r for r in rows if r['lapSec'] is not None and .65*reference<=r['lapSec']<=1.65*reference]
train=[r for r in eligible if r['date'] in trainDates]
cal=[r for r in eligible if r['date'] in calibrationDates]
test=[r for r in eligible if r['date'] in testDates]
assert max(r['arrivedAt'] for r in train) < min(r['startedAt'] for r in cal)
assert max(r['arrivedAt'] for r in cal) < min(r['startedAt'] for r in test)
experiments={}
for label,feature,target in [
    ('hold_after_arrival_realized_lap','lapSec','standSec'),
    ('whole_journey_from_origin_known_age','knownAgeAtOriginSec','totalSec')]:
    conditional=ols(train,feature,target)
    arms={}
    for arm,f in [('pooled',dict(intercept=statistics.mean(r[target] for r in train),slope=0)),('conditional_residual',conditional)]:
        residuals=[r[target]-predict(f,r,feature) for r in cal]
        knots=[q(residuals,p) for p in [.1,.5,.9]]
        outcomes=[]
        for r in test:
            center=predict(f,r,feature)
            lo,point,hi=[max(0,center+k) for k in knots]
            outcomes.append(dict(date=r['date'],bus=r['bus'],truth=r[target],low=lo,point=point,high=hi))
        arms[arm]=dict(fit=f,calibrationResidualQuantiles=knots,summary=score(outcomes),
          byDate={d:score([r for r in outcomes if r['date']==d]) for d in testDates if any(r['date']==d for r in outcomes)},outcomes=outcomes)
    experiments[label]=arms

out=dict(method='Small exploratory linear location + separately calibrated empirical residual q10/q50/q90. No test tuning; not live-model evaluation.',
  limitations=['Trips share eight service dates and bus runs; no iid significance claim.',
    'Realized lap is available at the Winchester hold, NOT at Trumbull departure.',
    'Known age at Trumbull is a previous physical departure timestamp, assumed known; legacy exact ingestion availability is absent.',
    'Chronological screen uses only observed historical endpoint states; not current position, uncertain future lap, or live mixture replay.',
    'Completed/stopped-endpoint sample omits missing trips and pass-throughs; source clock is pinned time.',
    'The common cohort requires a subsequently realized lap within a training-derived band; this is outcome-dependent selection at the origin, although no nonmissing lap was excluded here.',
    'An unconstrained linear hold fit extrapolates below zero on one test trip; clipping collapses its interval to zero. This is an intentionally simple exploratory screen, not a deployable fit.',
    'All dates were inspected in the descriptive association before this screen; parameters and quantiles are chronological, but this is not a pristine confirmatory holdout.',
    'Only three final test dates; no production change is authorized by this screen.'],
  descriptive=descriptive, split=dict(trainDates=trainDates,calibrationDates=calibrationDates,testDates=testDates,
    trainN=len(train),calibrationN=len(cal),testN=len(test),trainingLapReference=reference,excludedN=len(rows)-len(eligible)),
  experiments=experiments,joinedTrips=rows)
(HERE/'statistician-followup.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'descriptive':descriptive,'split':out['split'],'experiments':{k:{a:v['summary'] for a,v in arms.items()} for k,arms in experiments.items()}},indent=2))
