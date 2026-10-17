/** Complete an already-observed arrival through the normal screen controls.
 * A restored page may reveal its prompt after the initial visibility check,
 * including while the screenshot or Done's actionability check is waiting.
 * Handle only that prompt, only during completion, without forcing the click.
 */
export async function completeArrival(page, captureDismissed) {
 const got=page.getByRole('alertdialog').getByRole('button',{name:'Got it',exact:true});
 if(await got.isVisible())await got.click();
 await page.addLocatorHandler(got,async()=>got.click());
 try{
  await captureDismissed();
  const done=page.getByRole('button',{name:'Done',exact:true});
  if(await done.isVisible())await done.click();
 }finally{
  await page.removeLocatorHandler(got);
 }
}
