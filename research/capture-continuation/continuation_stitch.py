"""Receipt-ordered provenance index over sealed prefixes. No model or state reset.

Current CI invokes this only on synthetic prefixes. A real-body invocation is
separately gated; this module does not authorize prospective outcome access.
"""
import collections
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from continuation_common import require,utc_us,validate_plan,part_map
sys.path.insert(0,str(Path(__file__).resolve().parent/'reference'))
import capture_decoder as decoder

def classify_record(part,record):
    if record['kind']=='schedule-gap':return 'gap_evidence'
    at=utc_us(record['requestedAt']);start,end=utc_us(part['primaryFrom']),utc_us(part['primaryUntil'])
    if start<=at<end:return 'primary'
    if at<start and not part['existing'] and record['kind'] in ('health','html','module'):return 'prelude_context'
    return 'overlap_audit'

def index_parts(plan,prefixes,destination):
    """Verify *all* bytes first; publish only a verification-complete index.

    prefixes maps fixed part IDs to (sealed prefix directory, external seal SHA).
    Missing parts are explicit. Full bodies remain in their original prefixes;
    only immutable references and decoder status are stored in this index.
    """
    validate_plan(plan);require(set(prefixes)<=set(part_map(plan)),'unknown/adaptive part')
    destination=Path(destination);require(not destination.exists(),'index output already exists')
    destination.mkdir(parents=True)
    audit=dict(parts={},roles=collections.Counter(),bodyReads='sealed decoder only; synthetic in CI',
               identityProof='none added; per-part release/decoder checks remain mandatory',scenarioResetEvents=0,
               decisionReady=False,missingParts=[],unsafeClockParts=[])
    try:
        with tempfile.TemporaryDirectory(dir=destination) as tmp:
            db=sqlite3.connect(Path(tmp)/'index.sqlite')
            db.execute('create table records(receipt integer, ordinal integer, sequence integer, payload text, primary key(ordinal,sequence))')
            for ordinal,part in enumerate(plan['parts']):
                pid=part['id']
                if pid not in prefixes:audit['missingParts'].append(pid);continue
                prefix,seal=prefixes[pid];anchor=part.get('preservedPrefix');anchor_seen=False;verification=None;last_wall=None;exact_unsafe=False
                for item in decoder.iter_verified(prefix,seal):
                    if item['event']=='verification-complete':verification=item;continue
                    r=item['record'];role=classify_record(part,r)
                    if anchor and r['sequence']==anchor['records']-1:
                        require(item['journalRecordSha256']==anchor['lastRecordSha256'],'original A prefix changed');anchor_seen=True
                    at=r['at'] if r['kind']=='schedule-gap' else r['receivedAt']
                    start=r['at'] if r['kind']=='schedule-gap' else r['requestedAt']
                    exact_unsafe=exact_unsafe or utc_us(at)<utc_us(start) or last_wall is not None and utc_us(start)<last_wall
                    last_wall=utc_us(at);unsafe=item['clockUnsafe'] or exact_unsafe
                    row=dict(capturePart=pid,captureScopedId=f'{pid}/{r["sequence"]}/{item["journalRecordSha256"]}',prefixSha256=seal,
                             sourceSequence=r['sequence'],journalRecordSha256=item['journalRecordSha256'],record=r,
                             role=role,receiptAt=at,receiptUs=utc_us(at),clockUnsafe=unsafe,
                             primaryFleetEvent=role=='primary' and r['kind']=='fleet',
                             updateFleet=role=='primary' and r['kind']=='fleet' and item.get('fleetUsable',False) and not unsafe,
                             fleetUsable=role=='primary' and r['kind']=='fleet' and item.get('fleetUsable',False) and not unsafe,
                             sourceUnusableReason='clock_unsafe' if unsafe else item.get('unusableReason'),
                             strictIdentityKnown=False,acceptedRelease=False,
                             gapOwnership='unknown span; no requestedAt' if role=='gap_evidence' else None,
                             releaseContextOnly=role=='prelude_context')
                    db.execute('insert into records values(?,?,?,?)',(row['receiptUs'],ordinal,r['sequence'],json.dumps(row,separators=(',',':'),allow_nan=False)))
                    audit['roles'][role]+=1
                require(verification is not None,'missing decoder verification-complete')
                if anchor:require(anchor_seen,'original A prefix missing/truncated')
                manifest=decoder.json_record((Path(prefix)/'manifest.json').read_bytes())
                require(manifest['maxStoredBytes']==plan['maximumPartBytes'] and manifest['minimumFreeBytes']==plan['minimumFreeBytes'],'part limits changed')
                require(manifest['until'].replace('+00:00','Z')==plan['deadline'],'part deadline changed')
                require(manifest['storedDataBytes']<=plan['maximumPartBytes'],'part byte cap exceeded')
                audit['parts'][pid]=dict(verification,exactClockUnsafe=exact_unsafe,storedDataBytes=manifest['storedDataBytes'],
                                         sourceStopReason=manifest.get('stopReason'),sourceErrorType=manifest.get('errorType'),
                                         collectionStatus='closed' if manifest.get('status') in ('stopped','failed') else 'partial',
                                         serviceCoverage='unknown; transport closure is not a complete service day')
                if verification['clockUnsafe'] or exact_unsafe:audit['unsafeClockParts'].append(pid)
            require(sum(p['storedDataBytes'] for p in audit['parts'].values())<=plan['maximumAggregateBytes'],'aggregate cap exceeded')
            db.commit()
            # Exact microsecond receipts, then fixed part ordinal and source
            # sequence; no rounding to JavaScript milliseconds before ordering.
            count=0
            with (destination/'records.jsonl').open('x') as f:
                for payload, in db.execute('select payload from records order by receipt,ordinal,sequence'):
                    f.write(payload+'\n');count+=1
            db.close()
            audit.update(records=count,verificationComplete=True,readyMeaning='Provenance only; not source identity, complete service coverage or app parity',
                         decisionReady=not audit['missingParts'] and not audit['unsafeClockParts'],
                         chronologyLimit='Unsafe-clock records are preserved and cannot be silently activated; existing permanent unsafe-frontier policy still required.')
        (destination/'verification.json').write_text(json.dumps(audit,indent=2)+'\n')
        return audit
    except BaseException:
        # No completion marker: a partial index cannot be used by a consumer.
        raise

def decision_events(index,asof_us):
    """Convenience fixture iterator; context/unknown records never become buses."""
    verification=json.loads((Path(index)/'verification.json').read_text())
    require(verification.get('verificationComplete') is True,'unverified partial index')
    for line in (Path(index)/'records.jsonl').open():
        row=json.loads(line)
        if row['receiptUs']>asof_us:break
        if row['role'] in ('primary','prelude_context','gap_evidence'):yield row
