import {describe,expect,it} from 'vitest';
import {captureFeedbackScreen,feedbackScreenFromRows,feedbackScreenRow,FEEDBACK_SCREEN_MAX_ROWS} from './feedbackScreen';

const meta={capturedAt:1_700_000_000_000,build:'bundle-1234',view:'trip',tripDetail:false};
const row={mode:'shuttle',route:'Blue Day',boardStopId:100,alightStopId:117,busName:'44',countdownBusName:'48',stopsAhead:11,
  pickupChoice:'closest-stop',board:'~21 (17 – 28)',next:'~33 min',arrive:'10:20a – 10:35a',legs:'🚶 4 min › 🚌 13 min › 🚶 5 min',approaching:'Approaching #48: <1 min'};

describe('feedback screen evidence',()=>{
  it('keeps only public rendered trip facts, excluding planner and rider coordinates',()=>{
    const s=feedbackScreenFromRows([{...row,userLatLon:{lat:41.311234,lon:-72.912345},fromText:'Private home address',
      option:{fromLat:41.311234},pinnedBus:{lat:41.321,lon:-72.923},secret:'not part of evidence'}],meta);
    expect(s.rows).toEqual([row]);
    expect(JSON.stringify(s)).not.toMatch(/41\.311234|72\.912345|Private home|pinnedBus|secret|option/);
  });
  it('preserves different pickup choices on one route and their actual boarding buses',()=>{
    const s=feedbackScreenFromRows([row,{...row,boardStopId:129,busName:'41',pickupChoice:'arrive-sooner',board:'~16 min'}],meta);
    expect(s.rows.map(r=>[r.boardStopId,r.busName,r.pickupChoice])).toEqual([[100,'44','closest-stop'],[129,'41','arrive-sooner']]);
  });
  it('records unavailable evidence as displayed without inventing a bus or time',()=>{
    const s=feedbackScreenRow({mode:'shuttle',route:'Red',boardStopId:48,alightStopId:4,countdownBusName:'316',board:'Unavailable',next:'—',arrive:'—'});
    expect(s).toMatchObject({board:'Unavailable',next:'—',arrive:'—'});
    expect(s?.busName).toBeUndefined();expect(s?.stopsAhead).toBeUndefined();
    expect(s?.countdownBusName).toBe('316');
  });
  it('does not turn walk-only sentinel IDs into shuttle stops',()=>{
    const s=feedbackScreenRow({...row,mode:'walk',boardStopId:0,alightStopId:0});
    expect(s?.mode).toBe('walk');expect(s?.boardStopId).toBeUndefined();
    expect(s?.busName).toBeUndefined();expect(s?.stopsAhead).toBeUndefined();
  });
  it('rejects invalid stop/count values while keeping a legitimate zero-hop pickup',()=>{
    const s=feedbackScreenRow({...row,boardStopId:NaN,alightStopId:3.5,stopsAhead:0,pickupChoice:'invented'});
    expect(s?.boardStopId).toBeUndefined();expect(s?.alightStopId).toBeUndefined();expect(s?.stopsAhead).toBe(0);
    expect(s?.pickupChoice).toBeUndefined();expect(feedbackScreenRow({...row,mode:'other'})).toBeNull();
    expect(feedbackScreenRow({...row,route:''})).toBeNull();
  });
  it('bounds rows and text within the report context budget and declares omitted rows',()=>{
    const long='x'.repeat(10000),input={...row,route:long,board:long,next:long,arrive:long,legs:long,approaching:long};
    const s=feedbackScreenFromRows(Array.from({length:FEEDBACK_SCREEN_MAX_ROWS+10},()=>input),meta);
    expect(s.rows).toHaveLength(FEEDBACK_SCREEN_MAX_ROWS);expect(s.truncated).toBe(true);
    expect(s.rows[0]!.board.length).toBeLessThanOrEqual(160);expect(JSON.stringify(s).length).toBeLessThan(40*1024);
  });
  it('keeps opening-time evidence independent of later input changes',()=>{
    const mutable={...row},s=feedbackScreenFromRows([mutable],meta);
    mutable.board='~53 min';mutable.boardStopId=129;
    expect(s.capturedAt).toBe(meta.capturedAt);expect(s.rows[0]!.board).toBe(row.board);expect(s.rows[0]!.boardStopId).toBe(100);
  });
  it('does not interfere with rendering outside a browser',()=>{
    expect(captureFeedbackScreen('trip',undefined)).toBeUndefined();
  });
});
