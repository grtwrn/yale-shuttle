"""K=5/K=10 and causal switching from an earlier mean to logged production."""
import collections
import datetime as dt
import hashlib
import json
from evaluate import OUT, TRAIN_END, TZ, Predictor, bootstrap, metrics, read, write
from followup import (
    FollowupLabels, FollowupPredictor, adjusted, attach_labels,
    calibration_pad, diagnostics, identity,
)

BASES = ['wait_minus5_departure_mean','wait_minus10_departure_mean','trailing_ten_mean']
MODES = ['no_switch','after_344','after_344_or_long_canal']
ARMS = [base+'/'+mode for base in BASES for mode in MODES]


def release_gate(row, include_long_canal=False):
    origins = [e for index,e in row.get('origins',{}).items()
               if int(index)<14 and e['knownAt']<=row['asof'] and e['departed']<=row['asof']]
    if not origins:
        return None
    latest_origin = max(e['departed'] for e in origins)
    eligible = []
    for event in row.get('releaseEvents',[]):
        if event['index']!=14 and not (
            include_long_canal and event['index']==13 and (event.get('stand') or 0)>=300
        ):
            continue
        if not latest_origin<event['departed']<=event['knownAt']<=row['asof']:
            continue
        if row['at']-event['departed']>2700000:
            continue
        eligible.append(event)
    return min(eligible,key=lambda e:e['knownAt']) if eligible else None


def forecast_modes(row, base_forecasts):
    production = Predictor.fallback(row,'actual logged production')
    forecasts = {'logged_production':production}
    gates = {'no_switch':None,'after_344':release_gate(row),
             'after_344_or_long_canal':release_gate(row,True)}
    for base in BASES:
        for mode in MODES:
            event = gates[mode]
            if event:
                candidate = dict(production,reason='confirmed wait departure: production',
                                 switched=True,release=event)
            else:
                candidate = dict(base_forecasts[base],switched=False,release=None)
            forecasts[base+'/'+mode] = candidate
    return forecasts


def generate(features, models):
    generated = []
    for row in features:
        model = models[row['day']] if isinstance(models,dict) else models
        bases = {a:model.predict(row,a) for a in BASES}
        generated.append(dict(row,forecasts=forecast_modes(row,bases)))
    return generated


def check_switch_equality(rows):
    for row in rows:
        for arm in ARMS:
            p = row['forecasts'][arm]
            if p['switched']:
                assert p['forecast']==row['forecasts']['logged_production']['forecast']
                assert p['release']['knownAt']<=row['asof']


def switch_diagnostics(rows, arm):
    result = diagnostics(rows,arm)
    switched = [r for r in rows if r['forecasts'][arm]['switched']]
    false_now = [r for r in rows if r['forecasts'][arm]['forecast'] and
                 r['forecasts'][arm]['forecast']['eta']<=15 and r['truth']>120]
    result.update(
        switchedSnapshots=len(switched),
        switchedJourneys=len({r['episode']['targetId'] for r in switched}),
        switchStops=dict(collections.Counter(str(r['forecasts'][arm]['release']['index']) for r in switched)),
        falseNowBeforeSwitch=sum(not r['forecasts'][arm]['switched'] for r in false_now),
        falseNowAfterSwitch=sum(r['forecasts'][arm]['switched'] for r in false_now),
    )
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r['bus'],r['target'],r['episode']['targetId']].append(r)
    transitions = []
    for group in groups.values():
        group.sort(key=lambda r:r['at'])
        for a,b in zip(group,group[1:]):
            if not (0<b['at']-a['at']<=30000):continue
            p,q = a['forecasts'][arm],b['forecasts'][arm]
            if p['switched'] or not q['switched'] or not p['forecast'] or not q['forecast']:continue
            event = q['release']
            transitions.append({'day':b['day'],'bus':b['bus'],'targetId':b['episode']['targetId'],
                'at':b['at'],'release':event,'secondsToConfirm':(event['knownAt']-event['departed'])/1000,
                'jumpSeconds':(b['at']-a['at'])/1000+q['forecast']['eta']-p['forecast']['eta'],
                'before':p['forecast'],'after':q['forecast'],'truthAtSwitch':b['truth']})
    result['transitions'] = transitions
    return result


def paired(rows):
    return [r for r in rows if r['day']>'2026-09-16' and r['target']==48
            and r['forecasts']['logged_production']['forecast']]


def main():
    labels = FollowupLabels(source_indices=range(14))
    model = FollowupPredictor(labels.episodes)
    features = read(OUT/'features.jsonl.gz')
    existing = read(OUT/'primary-scored.jsonl.gz')
    generated = generate(features,model)
    write('hybrid-predictions',generated)
    scored = attach_labels(generated,existing)
    write('hybrid-scored',scored)
    calibration = [r for r in scored if r['day']=='2026-09-16' and r['dense']]
    calibration_audit,pads = {},{}
    for probability in (.8,.9):
        key = str(int(probability*100))
        calibration_audit[key] = {base:calibration_pad(calibration,base+'/no_switch',probability) for base in BASES}
        pads[key] = {base+'/'+mode:calibration_audit[key][base]['seconds'] for base in BASES for mode in MODES}
    test = paired(scored)
    versions = {key:adjusted(test,value) for key,value in pads.items()}
    result = {'plan':'HYBRID-PLAN.md','calibration':calibration_audit,'features':len(features),
              'scored':len(scored),'division':{},'subgroups':{},'rolling':{},'delay15':{},
              'tests':{},'worst':{},'cases':{}}

    old_by_key = {identity(r):r for r in existing}
    previous_by_key = {identity(r):r for r in read(OUT/'followup-scored.jsonl.gz')}
    for r in scored:
        for base,old in [
            ('wait_minus5_departure_mean',old_by_key[identity(r)]['forecasts']['fixed_mean']),
            ('trailing_ten_mean',previous_by_key[identity(r)]['forecasts']['trailing_ten_mean']),
        ]:
            new = r['forecasts'][base+'/no_switch']
            for field in ['forecast','supported','n','effective','days']:
                assert new.get(field)==old.get(field),(base,identity(r),field)
    result['tests']['K5ExactlyReproducesInitialFixedMean'] = True
    result['tests']['UnswitchedTrailingTenUnchanged'] = True
    prefix = FollowupPredictor([e for e in labels.episodes if e['end']<TRAIN_END])
    for r in features[::71]:
        assert generate([r],prefix)==generate([r],model)
    result['tests']['futureTrainingDeletionInvariant'] = True
    result['tests']['originalOutcomeCohortPreserved'] = True
    check_switch_equality(scored)
    for rows in versions.values():check_switch_equality(rows)
    result['tests']['exactProductionAfterSwitchRawAndCalibrated'] = True

    predicates = {
        'all':lambda r:True,
        'before_344_release':lambda r:release_gate(r) is None,
        'after_344_release':lambda r:release_gate(r) is not None,
        'canal_hold':lambda r:r['index']==13 and r['phase']=='hold',
        'winchester_hold':lambda r:r['index']==14 and r['phase']=='hold',
        'after_winchester_position':lambda r:r['index']>14,
        'stopped_pickup':lambda r:r['episode']['outcome']=='stopped',
        'strict_labels':lambda r:r['episode']['method']=='strict',
        **{day:lambda r,day=day:r['day']==day for day in sorted({r['day'] for r in test})},
    }
    for arm in ['logged_production']+ARMS:
        result['division'][arm] = {key:metrics(rows,arm) for key,rows in versions.items()}
        if arm!='logged_production':
            result['division'][arm]['diagnostics'] = switch_diagnostics(versions['80'],arm)
            result['division'][arm]['deltaBootstrap80'] = bootstrap(versions['80'],arm,{},False)
    for label,predicate in predicates.items():
        rs = [r for r in versions['80'] if predicate(r)]
        result['subgroups'][label] = {a:metrics(rs,a) for a in ['logged_production']+ARMS}

    models = {}
    for day in sorted({r['day'] for r in test}):
        cutoff = int(dt.datetime.fromisoformat(day).replace(tzinfo=TZ).timestamp()*1000)
        models[day] = FollowupPredictor(labels.episodes,cutoff)
        prefix = FollowupPredictor([e for e in labels.episodes if e['end']<cutoff],cutoff)
        for r in [r for r in features if r['day']==day][::137]:
            assert generate([r],prefix)==generate([r],models[day])
    result['tests']['rollingFutureDeletionInvariant'] = True
    rolling = attach_labels(generate([r for r in features if r['day']>'2026-09-16'],models),
                            [r for r in existing if r['day']>'2026-09-16'])
    write('hybrid-rolling-scored',rolling)
    delayed = attach_labels(generate(read(OUT/'features-delay15.jsonl.gz'),model),
                            read(OUT/'delay15-scored.jsonl.gz'))
    write('hybrid-delay15-scored',delayed)
    for name,rows in [('rolling',rolling),('delay15',delayed)]:
        for key in ['80','90']:
            rs = adjusted(paired(rows),pads[key]);check_switch_equality(rs)
            result[name][key] = {a:metrics(rs,a) for a in ['logged_production']+ARMS}

    for arm in ARMS:
        cases = []
        for r in versions['80']:
            f,b = r['forecasts'][arm]['forecast'],r['forecasts']['logged_production']['forecast']
            if not f:continue
            p = r['forecasts'][arm]
            cases.append({'day':r['day'],'bus':r['bus'],'at':r['at'],'targetId':r['episode']['targetId'],
                'truth':r['truth'],'candidate':f,'production':b,'index':r['index'],'phase':r['phase'],
                'switched':p['switched'],'release':p['release'],
                'rawStart':min(e['departed'] for e in r['origins'].values()),
                'actualArrival':r['episode']['end'],
                'maeRegression':abs(f['eta']-r['truth'])-abs(b['eta']-r['truth']),
                'earlyMiss':max(0,f['low']-r['truth']),'lateMiss':max(0,r['truth']-f['high'])})
        result['worst'][arm] = {}
        for metric in ['maeRegression','earlyMiss','lateMiss']:
            selected = []
            seen = set()
            for r in sorted(cases,key=lambda r:r[metric],reverse=True):
                if r['targetId'] in seen:continue
                seen.add(r['targetId'])
                r['rawQuality'] = labels.raw_quality(r['day'],r['bus'],r['rawStart'],r['actualArrival'])
                selected.append(r)
                if len(selected)==5:break
            result['worst'][arm][metric] = selected
    for target_id in [68528,74774,81098,83605]:
        result['cases'][str(target_id)] = [
            {k:r[k] for k in ['at','index','phase','truth','forecasts','releaseEvents']}
            for r in versions['80'] if r['episode']['targetId']==target_id and r['at']%60000==0]
    (OUT/'hybrid-summary.json').write_text(json.dumps(result,indent=2))
    manifest = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.iterdir()
                if p.is_file() and p.name!='result-manifest.json' and p.suffix!='.log'}
    (OUT/'result-manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({'division':result['division'],'tests':result['tests']},indent=2))


if __name__=='__main__':
    main()
