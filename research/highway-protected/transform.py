"""Outcome-independent protected-window transform."""
import copy
import math

FIELDS=('eta','low','high')
TARGETS=(9,10)


def valid(f):
    return all(isinstance(f[k],(int,float)) and not isinstance(f[k],bool) and math.isfinite(f[k]) for k in FIELDS) and 0<=f['low']<=f['eta']<=f['high']


def protect(deployed,candidate):
    assert valid(deployed) and valid(candidate)
    result=dict(eta=deployed['eta'],low=min(deployed['low'],candidate['low'],deployed['eta']),high=max(deployed['eta'],candidate['high']))
    assert valid(result) and result['eta']==deployed['eta'] and result['low']<=deployed['low']
    return result


def row(source):
    result=copy.deepcopy(source)
    for field in ('label','truth','originalCohort','outcomeReason'):result.pop(field,None)
    result['rawCandidates']=result['candidates']
    result['rawCandidateEvidence']=result['candidateEvidence']
    result['rawCandidateReasons']=result['candidateReasons']
    result['candidates']={};result['candidateEvidence']={};result['candidateReasons']={}
    for arm,candidate in source['candidates'].items():
        forecast=protect(source['deployed'],candidate) if source['route'] in TARGETS else dict(source['deployed'])
        changed=forecast!=source['deployed']
        evidence=dict(source['candidateEvidence'][arm],changed=changed)
        # An unused source is retained in raw evidence but must not count as an
        # actually used protected forecast source or trigger a source handoff.
        if not changed:evidence.pop('origin',None)
        evidence['reason']=source['candidateReasons'][arm] if changed else 'exact deployed protected fallback'
        result['candidates'][arm]=forecast;result['candidateEvidence'][arm]=evidence
        result['candidateReasons'][arm]=evidence['reason']
    return result


def raw_row(r):
    return dict(r,candidates=r['rawCandidates'],candidateEvidence=r['rawCandidateEvidence'],candidateReasons=r['rawCandidateReasons'])
