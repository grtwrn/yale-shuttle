"""Static research figures from saved, reproducible Red release experiments."""
import datetime,json,pathlib
from zoneinfo import ZoneInfo
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

D=pathlib.Path(__file__).resolve().parent;TZ=ZoneInfo('America/New_York')
rows=json.loads((D/'operating-pattern-screen.json').read_text())['featureRows']
rows=[r for r in rows if r['day']>='2026-09-14']
keys=sorted({(r['day'],r['bus'])for r in rows},reverse=True)
plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
fig,axes=plt.subplots(1,2,figsize=(12,7.8),sharey=True,layout='constrained')
colors={'2026-09-14':'#7f8c8d','2026-09-15':'#aa6f26','2026-09-16':'#3779ac','2026-09-17':'#663f9b'}
for ax,stop,title in zip(axes,[11,121],['344 Winchester','Union Station']):
 for i,(day,bus)in enumerate(keys):
  rs=[r for r in rows if(r['day'],r['bus'],r['stop'])==(day,bus,stop)]
  dt=[datetime.datetime.fromtimestamp(r['d']/1000,TZ)for r in rs]
  mins=[t.minute+t.second/60 for t in dt]
  ax.scatter(mins,[i]*len(mins),s=35,alpha=.65,color=colors[day],edgecolors='none')
 ax.set_title(title);ax.set_xlim(-1,61);ax.set_xticks([0,15,30,45,60]);ax.grid(axis='x',alpha=.2)
 ax.set_xlabel('Minute within the hour (Eastern)')
axes[0].set_yticks(range(len(keys)),[f'Sep {d[-2:]}   {b}'for d,b in keys])
fig.suptitle('Each bus’s departure minute often repeats within a day',fontsize=14)
fig.supxlabel('Each dot is an observed departure, Sep 14–17. This is descriptive evidence, not a published timetable.',fontsize=10)
fig.savefig(D/'release-hourly-pattern.png',dpi=170);fig.savefig(D/'release-hourly-pattern.svg');plt.close(fig)

series=json.loads((D/'release-wire-shadow-series.json').read_text())
s=next(s for s in series if s['id']==65347 and s['target']==48)
rs=s['rows'];t=np.array([(r['at']-s['pin'])/60000 for r in rs]);truth=np.array([(s['arrival']-r['at'])/60000 for r in rs])
fig,axes=plt.subplots(1,2,figsize=(12,4.8),sharex=True,sharey=True,layout='constrained')
for ax,arm,color,title in zip(axes,['production','shadow'],['#a35620','#176a8a'],['Current production model, replayed','Experimental wire switch']):
 lo=np.array([r[arm]['low']/60 for r in rs]);hi=np.array([r[arm]['high']/60 for r in rs]);point=np.array([r[arm]['eta']/60 for r in rs])
 ax.fill_between(t,lo,hi,color=color,alpha=.16,label='Forecast interval')
 ax.plot(t,point,color=color,lw=2,label='Point ETA')
 ax.plot(t,truth,color='#222',ls='--',lw=1.8,label='Actual time remaining')
 ax.axvline((s['departure']-s['pin'])/60000,color='#555',ls=':',lw=1.2,label='Actual departure')
 ax.set_title(title);ax.set_xlabel('Minutes since reaching the Winchester stop marker');ax.set_xlim(-2,9.3);ax.set_ylim(0,20);ax.grid(alpha=.15)
axes[0].set_ylabel('Minutes to Division / Prospect');axes[1].legend(fontsize=8,loc='upper right')
fig.suptitle('Report 115: the new wait model helps early, but the direct switch misses pull-away',fontsize=13)
fig.supxlabel('Red #309, Sep 17. Historical diagnostic only; the experimental model has not been deployed.',fontsize=10)
fig.savefig(D/'release-report115.png',dpi=170);fig.savefig(D/'release-report115.svg');plt.close(fig)
print('Saved release-hourly-pattern and release-report115 (PNG/SVG).')
