import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {EarlyPickupNotice} from './EarlyPickupNotice';

it('shows the approaching bus time beside the estimated walk',()=>{
  const html=renderToStaticMarkup(<EarlyPickupNotice arrival={{busName:'#48',eta:14,low:7,high:25}} walkSec={115}/>);
  expect(html).toContain('Approaching #48: &lt;1 min');expect(html).toContain('estimated walk 2 min');
});
it('keeps a wide forecast range visible without asserting catchability',()=>{
  const html=renderToStaticMarkup(<EarlyPickupNotice arrival={{busName:'48',eta:180,low:65,high:541}} walkSec={600}/>);
  expect(html).toContain('~3 min (1–10 min)');expect(html).toContain('estimated walk 10 min');
  expect(html).not.toContain("can't catch");
});
