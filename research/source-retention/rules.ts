/** Only the age parameter varies; release is tied to the physical departure. */
export const capFor=(route:number,minutes:number)=>([9,10].includes(route)?minutes:45)*60000;
export function retain(e:any,route:number,asof:number,began:number,at:number,cap:number){
 return e.route===route&&e.knownAt<=asof&&e.departed<=began&&at-e.departed<=cap;
}
export function observeRelease(latches:Map<string,number>,key:string,origin:any,release:any,index:number,
 wait:number,k:number,n:number,phase:string,began:number,time:number,cap:number){
 if(!origin||origin.departed>began||time-origin.departed>cap)return false;
 const released=(release&&release.departed>origin.departed&&release.departed<=began&&release.knownAt<=time)
  ||(index-(wait-k+n)%n+n)%n>k||(index===wait&&phase==='drive');
 if(released)latches.set(key,origin.departed);
 return Boolean(released);
}
