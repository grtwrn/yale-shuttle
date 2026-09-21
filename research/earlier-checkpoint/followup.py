"""User-requested anchor comparisons, preserving the initial evaluation cohort."""
import collections
import datetime as dt
import hashlib
import json
from evaluate import (
    HERE, OUT, TRAIN_END, TZ, Labels, Predictor, bootstrap, metrics,
    quantile, read, write,
)

NEW_ARMS = [
    'trailing_ten_mean', 'ten_before_pickup_mean',
    'wait_minus1_departure_mean', 'wait_minus2_departure_mean',
    'wait_minus1_arrival_mean', 'wait_minus2_arrival_mean',
]
TARGET_INDEX = {48:17, 4:20}


class FollowupLabels(Labels):
    def episode(self, source, target):
        episode, reason = super().episode(source, target)
        if episode is not None:
            episode = dict(episode, arrivalStart=source['arrived_at'])
        return episode, reason


class FollowupPredictor:
    def __init__(self, episodes, cutoff=TRAIN_END):
        # Reuse the exact initial mean implementation, including weights and
        # support gates. Only checkpoint identity and timing boundary differ.
        self.models = {}
        for index in range(14):
            paths = [e for e in episodes if e['sourceIndex']==index]
            for arrival in (False, True):
                converted = []
                for e in paths:
                    start = e['arrivalStart'] if arrival else e['start']
                    assert start <= e['start'] < e['end']
                    converted.append(dict(e, sourceIndex=9, start=start,
                                          duration=(e['end']-start)/1000))
                self.models[index, arrival] = Predictor(converted, cutoff=cutoff)

    @staticmethod
    def anchor(row, arm):
        if arm=='trailing_ten_mean':
            return row.get('nearestIndex', row['index'])-10, False
        if arm=='ten_before_pickup_mean':
            return TARGET_INDEX[row['target']]-10, False
        if arm.startswith('wait_minus'):
            k = int(arm[len('wait_minus'):].split('_')[0])
            assert k in (1,2,5,10)
            return 14-k, '_arrival_' in arm
        raise ValueError(arm)

    def predict(self, row, arm):
        index, arrival = self.anchor(row, arm)
        group = 'checkpointArrivals' if arrival else 'checkpointOrigins'
        origin = row.get(group, {}).get(str(index))
        if origin is None or (index, arrival) not in self.models:
            return Predictor.fallback(row, 'checkpoint not yet causally observed')
        translated = dict(row, origins={'9':origin})
        result = self.models[index, arrival].predict(translated, 'fixed_mean')
        return dict(result, originIndex=index, boundary='arrival' if arrival else 'departure')


def identity(row):
    return row['day'], row['bus'], row['target'], row['at']


def calibration_pad(rows, arm, probability, allow_contraction=False):
    selected = [r for r in rows if r['forecasts'][arm]['forecast'] and
                (arm=='logged_production' or r['forecasts'][arm]['supported'])]
    counts = collections.Counter((r['target'],r['episode']['targetId']) for r in selected)
    errors, weights = [], []
    for r in selected:
        f = r['forecasts'][arm]['forecast']
        signed = max(f['low']-r['truth'], r['truth']-f['high'])
        errors.append(signed if allow_contraction else max(0,signed))
        weights.append(1/counts[r['target'],r['episode']['targetId']])
    return {'seconds':quantile(errors,probability,weights) if errors else 0,
            'snapshots':len(selected),'journeys':len(counts)}


def adjusted(rows, pads, contract_production=False):
    output = []
    for r in rows:
        forecasts = {}
        for arm, p in r['forecasts'].items():
            f = p['forecast']
            eligible = p['supported'] or (contract_production and arm=='logged_production')
            if f and eligible and arm in pads:
                pad = pads[arm]
                f = dict(f, low=max(0,min(f['eta'],f['low']-pad)),
                         high=max(f['eta'],f['high']+pad))
                assert 0<=f['low']<=f['eta']<=f['high']
            forecasts[arm] = dict(p, forecast=f)
        output.append(dict(r, forecasts=forecasts))
    return output


def diagnostics(rows, arm):
    eligible = [r for r in rows if r['forecasts'][arm]['forecast']]
    supported = [r for r in eligible if r['forecasts'][arm]['supported']]
    flagged = [r for r in eligible if r['forecasts'][arm]['forecast']['eta']<=15 and r['truth']>120]
    groups = collections.defaultdict(list)
    for r in eligible:
        groups[r['bus'],r['target'],r['episode']['targetId']].append(r)
    jumps = []
    for group in groups.values():
        group.sort(key=lambda r:r['at'])
        for a,b in zip(group,group[1:]):
            elapsed = (b['at']-a['at'])/1000
            if 0<elapsed<=30:
                jumps.append(elapsed+b['forecasts'][arm]['forecast']['eta']-a['forecasts'][arm]['forecast']['eta'])
    return {'snapshots':len(eligible),'supportedSnapshots':len(supported),
            'supportedSnapshotFraction':len(supported)/len(eligible) if eligible else None,
            'supportedJourneys':len({r['episode']['targetId'] for r in supported}),
            'fallbackReasons':dict(collections.Counter(r['forecasts'][arm].get('reason') for r in eligible if not r['forecasts'][arm]['supported'])),
            'falseNowSnapshots':len(flagged),'falseNowJourneys':len({r['episode']['targetId'] for r in flagged}),
            'adjacentPairs':len(jumps),'upJumpsOver60':sum(x>60 for x in jumps),'downJumpsOver60':sum(x<-60 for x in jumps)}


def generate(features, models):
    return [dict(r, forecasts={
        **{a:(models[r['day']] if isinstance(models,dict) else models).predict(r,a) for a in NEW_ARMS},
        'logged_production':Predictor.fallback(r,'actual logged production'),
    }) for r in features]


def attach_labels(generated, existing):
    matched = {identity(r):r for r in existing}
    output = []
    for r in generated:
        old = matched.get(identity(r))
        if old:
            output.append(dict(r, episode=old['episode'], truth=old['truth']))
    assert len(output)==len(existing)
    return output


def main():
    labels = FollowupLabels(source_indices=range(14))
    model = FollowupPredictor(labels.episodes)
    features = read(OUT/'features.jsonl.gz')
    existing = read(OUT/'primary-scored.jsonl.gz')
    generated = generate(features, model)
    write('followup-predictions',generated)  # Freeze forecasts before attaching outcomes.
    scored = attach_labels(generated, existing)
    write('followup-scored',scored)
    calibration = [r for r in scored if r['day']=='2026-09-16' and r['dense']]
    pads, calibration_audit = {}, {}
    for probability in (.8,.9):
        key = str(int(probability*100))
        calibration_audit[key] = {a:calibration_pad(calibration,a,probability) for a in NEW_ARMS}
        calibration_audit[key]['production_control'] = calibration_pad(
            calibration,'logged_production',probability,allow_contraction=True)
        pads[key] = {a:r['seconds'] for a,r in calibration_audit[key].items() if a in NEW_ARMS}
    (OUT/'followup-calibration.json').write_text(json.dumps(calibration_audit,indent=2))
    test = [r for r in scored if r['day']>'2026-09-16' and r['forecasts']['logged_production']['forecast']]
    adjusted80 = adjusted(test,pads['80'])
    adjusted90 = adjusted(test,pads['90'])
    result = {'plan':'FOLLOWUP-PLAN.md','calibration':calibration_audit,
              'features':len(generated),'scored':len(scored),'subgroups':{},
              'division':{},'productionControls':{},'rollingDivision':{},'delay15Division':{},
              'training':{},'tests':{},'worst':{},'cases':{}}

    original_by_key = {identity(r):r for r in existing}
    for r in scored:
        old = original_by_key[identity(r)]['forecasts']['five_before_mean']
        new = r['forecasts']['wait_minus2_departure_mean']
        for key in ('forecast','supported','n','effective','days'):
            assert old.get(key)==new.get(key),(identity(r),key,old,new)
    result['tests']['K2ExactlyReproducesOriginalFiveBefore'] = True
    prefix = FollowupPredictor([e for e in labels.episodes if e['end']<TRAIN_END])
    for r in features[::71]:
        for arm in NEW_ARMS:
            assert prefix.predict(r,arm)==model.predict(r,arm)
    result['tests']['futureTrainingDeletionInvariant'] = True
    result['tests']['originalOutcomeCohortPreserved'] = True

    predicates = {
        'all':lambda r:True,
        'before_canal':lambda r:r['index']<13,
        'canal_hold':lambda r:r['index']==13 and r['phase']=='hold',
        'winchester_hold':lambda r:r['index']==14 and r['phase']=='hold',
        'after_winchester':lambda r:r['index']>14,
        'stopped_pickup':lambda r:r['episode']['outcome']=='stopped',
        'strict_labels':lambda r:r['episode']['method']=='strict',
        **{day:lambda r,day=day:r['day']==day for day in sorted({r['day'] for r in test})},
    }
    for label,predicate in predicates.items():
        rs = [r for r in adjusted80 if r['target']==48 and predicate(r)]
        result['subgroups'][label] = {a:metrics(rs,a) for a in ['logged_production']+NEW_ARMS}
    for arm in ['logged_production']+NEW_ARMS:
        rs = [r for r in adjusted80 if r['target']==48]
        support = [r for r in rs if r['forecasts'][arm]['supported']]
        result['division'][arm] = {
            'calibrated80':metrics(rs,arm),
            'calibrated90':metrics([r for r in adjusted90 if r['target']==48],arm),
            'raw':metrics([r for r in test if r['target']==48],arm),
            'diagnostics':diagnostics(rs,arm),
            'supported':metrics(support,arm),
            'productionOnSupported':metrics(support,'logged_production'),
        }
        if arm in NEW_ARMS:
            result['division'][arm]['deltaBootstrap80'] = bootstrap(rs,arm,{},calibrated=False)
    for key in ['80','90']:
        control = adjusted(test,{'logged_production':calibration_audit[key]['production_control']['seconds']},True)
        result['productionControls'][key] = metrics([r for r in control if r['target']==48],'logged_production')

    rolling_models = {}
    for day in sorted({r['day'] for r in test}):
        cutoff = int(dt.datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp()*1000)
        rolling_models[day] = FollowupPredictor(labels.episodes,cutoff=cutoff)
        prefix = FollowupPredictor([e for e in labels.episodes if e['end']<cutoff],cutoff=cutoff)
        for r in [r for r in features if r['day']==day][::137]:
            for arm in NEW_ARMS:
                assert rolling_models[day].predict(r,arm)==prefix.predict(r,arm)
    result['tests']['rollingFutureDeletionInvariant'] = True
    rolling_generated = generate([r for r in features if r['day']>'2026-09-16'],rolling_models)
    rolling = attach_labels(rolling_generated,[r for r in existing if r['day']>'2026-09-16'])
    write('followup-rolling-scored',rolling)
    rolling = [r for r in adjusted(rolling,pads['80']) if r['target']==48 and r['forecasts']['logged_production']['forecast']]
    for arm in NEW_ARMS:
        result['rollingDivision'][arm] = {label:{'candidate':metrics([r for r in rolling if predicate(r)],arm),'production':metrics([r for r in rolling if predicate(r)],'logged_production')} for label,predicate in predicates.items()}
    delay_features = read(OUT/'features-delay15.jsonl.gz')
    delay_existing = read(OUT/'delay15-scored.jsonl.gz')
    delayed = attach_labels(generate(delay_features,model),delay_existing)
    write('followup-delay15-scored',delayed)
    delayed = [r for r in adjusted(delayed,pads['80']) if r['target']==48 and r['day']>'2026-09-16' and r['forecasts']['logged_production']['forecast']]
    result['delay15Division'] = {a:metrics(delayed,a) for a in ['logged_production']+NEW_ARMS}

    for index in range(14):
        paths = [e for e in labels.episodes if e['sourceIndex']==index and e['target']==48 and e['end']<TRAIN_END]
        result['training'][str(index)] = {'paths':len(paths),'days':len({e['day'] for e in paths}),
            'longCanal':sum('13' in e['stages'] and e['stages']['13']['depart']-e['stages']['13']['arrive']>=300000 for e in paths)}
    for arm in NEW_ARMS:
        cases = []
        for r in adjusted80:
            if r['target']!=48 or not r['forecasts'][arm]['supported']:continue
            f,b = r['forecasts'][arm]['forecast'],r['forecasts']['logged_production']['forecast']
            index,arrival = model.anchor(r,arm)
            origin = r['checkpointArrivals' if arrival else 'checkpointOrigins'][str(index)]
            cases.append({'day':r['day'],'bus':r['bus'],'at':r['at'],'targetId':r['episode']['targetId'],
                'truth':r['truth'],'candidate':f,'production':b,'index':r['index'],'phase':r['phase'],
                'originIndex':index,'boundary':'arrival' if arrival else 'departure',
                'originClock':origin['departed'],'originKnownAt':origin['knownAt'],'actualArrival':r['episode']['end'],
                'maeRegression':abs(f['eta']-r['truth'])-abs(b['eta']-r['truth']),
                'earlyMiss':max(0,f['low']-r['truth']),'lateMiss':max(0,r['truth']-f['high'])})
        result['worst'][arm] = {}
        for metric in ('maeRegression','earlyMiss','lateMiss'):
            selected = sorted(cases,key=lambda r:r[metric],reverse=True)[:8]
            for r in selected:
                r['rawQuality'] = labels.raw_quality(r['day'],r['bus'],r['originClock'],r['actualArrival'])
            result['worst'][arm][metric] = selected
    for target_id in [68528,74774,81098,83605]:
        result['cases'][str(target_id)] = [
            {k:r[k] for k in ('at','index','phase','truth','forecasts')}
            for r in adjusted80 if r['episode']['targetId']==target_id and r['at']%60000==0]

    (OUT/'followup-summary.json').write_text(json.dumps(result,indent=2))
    manifest = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir()
                if p.is_file() and p.name!='result-manifest.json' and p.suffix!='.log'}
    (OUT/'result-manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({'division':result['division'],'productionControls':result['productionControls'],'tests':result['tests']},indent=2))


if __name__=='__main__':
    main()
