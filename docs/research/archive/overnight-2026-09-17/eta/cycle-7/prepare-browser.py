from pathlib import Path
O=Path(__file__).resolve().parent
s=(O/'browser_ordered_transitions.mjs').read_text().replace('ordered-browser-transitions','deadline-browser')
needle='      const clean=structuredClone(active);'
extra='''      await page.getByRole('button',{name:/Arrive by/}).click();
      const section=page.getByRole('region',{name:'Arrive by class'});
      await section.getByLabel('Time to get inside').selectOption('5');
      const classInput=section.getByLabel('Class starts · local time');
      const restored=want.options.find(o=>o.mode==='shuttle').journeyArrival;
      assert.ok(restored && !restored.catchRisk && !restored.estimated);
      const deadlineStates=[];
      for(const [delta,status] of [[360000,'Window fits buffer'],[60000,'May use your buffer'],[-60000,'Window extends past class']]){
        const value=await page.evaluate(at=>{const d=new Date(at),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},restored.highMs+delta);
        await classInput.fill(value);await section.getByRole('button',{name:/Red · #309/}).getByText(new RegExp(status)).waitFor();
        const text=await section.innerText();assert.ok(text.includes('Red · #309'));deadlineStates.push({value,status,text});
      }
      session.deadlines=deadlineStates;
'''
assert s.count(needle)==1;s=s.replace(needle,extra+needle)
needle="active={...clean,server_eta:null};"
s=s.replace(needle,"await section.getByText('No live window',{exact:true}).waitFor();\n      "+needle)
needle="await page.getByText('39 min',{exact:true}).waitFor();"
s=s.replace(needle,needle+"await section.getByText(/Window extends past class/).waitFor();")
(O/'browser_deadline.mjs').write_text(s)
