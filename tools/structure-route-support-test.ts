// bun tools/structure-route-support-test.ts — real WorldAgent bodies over transformed (translated, rotated, scaled)
// structures: the support mode, the band and the crossing height in world metres; no server or renderer, legs drive the
// real tick (tools/structure-oracle.ts). The planner's rows for the same rules are tools/structure-route-test.ts's.
import { noWorldUrl } from "./no-world.ts";
import { strict as assert } from "node:assert";
import { localizePoint } from "../shared/structure.js";
import { walk } from "./structure-oracle.ts";
import { WorldAgent } from "../mcpl/agent.ts";
let n=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);n++;console.log("✓ "+label);};
const upper={y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]};
const ground={y:0,tiles:[[0,0],[1,0],[2,0]],walls:[[1,1,0]],apertures:[[1,1,0,"door"]]};
const basement={y:-3,tiles:[[0,0]],walls:[],apertures:[]};
const wall={levels:[{y:0,tiles:[],walls:[[1,1,0]],apertures:[]}]};

const agents:WorldAgent[]=[];
function body(entity:any,height:(x:number,z:number)=>number,from:[number,number]) {
 const a=new WorldAgent({ url: noWorldUrl(), name:"walker",avatar:"",world:"support-test"});agents.push(a);a.joined=true;
 a.entities.set(entity.id,entity);(a as any).terrain={heightAt:height};
 a.pos={x:from[0],y:height(...from),z:from[1]};return a;
}
function transform(e:any,x:number,z:number):[number,number] {
 const c=Math.cos(e.yaw),s=Math.sin(e.yaw);
 return [e.pos[0]+(x*c+z*s)*e.scale,e.pos[2]+(-x*s+z*c)*e.scale];
}
try{
 for(const e of [
  {id:"world",pos:[0,0,0],yaw:0,scale:1,structure:{levels:[basement,ground]}},
  {id:"shift",pos:[10,2,-5],yaw:Math.PI/3,scale:2,structure:{levels:[ground,basement]}},
 ]) {
  const a=body(e,()=>e.pos[1],transform(e,.5,.5));
  const r=await walk(a,transform(e,3.5,.5));
  check(r.arrived&&r.points.every(p=>p.y===e.pos[1]),"real terrain-mode body exits ground above basement with translated/scaled frame");
 }
 const e={id:"overhead",pos:[10,1,-5],yaw:.6,scale:2,structure:{levels:[upper]}};
 const a=body(e,()=>1,transform(e,.5,.5));
 check((await walk(a,transform(e,2.5,.5))).arrived,"real ground body walks beneath translated/scaled overhead floor without confinement");

 // the obstruction band is 0.5 WORLD metres: at scale 2, y 0.4 the wall's base is 0.6 m up, above the band
 const raised={id:"band",pos:[0,.4,0],yaw:0,scale:2,structure:wall};
 const b=body(raised,()=>0,[0,1]);
 const r=await walk(b,[4,1]);
 check(r.arrived&&r.points.every(p=>Math.abs(p.z-1)<1e-10),"world-scaled step band leaves a 0.6m raised wall above a terrain walk");

 const sole={id:"sole",pos:[0,0,0],yaw:0,scale:1,structure:{levels:[upper]}};
 const soleBody=body(sole,()=>0,[.5,.5]);soleBody.pos.y=3.1;
 const soleWalk=await walk(soleBody,[2.5,.5]);
 check(!soleWalk.arrived && /no path across this floor connects the start to the destination/.test(String((soleBody as any).walkRefusal)) && soleBody.pos.y===3.1,"a body on a sole raised floor stands on it, and a walk across the floor's gap is refused rather than taken on the terrain, for its own reason: the hole divides the floor");
 const slope={id:"slope",pos:[10,2,-5],yaw:Math.PI/2,scale:2,structure:wall};
 const highAtCross=(wx:number,wz:number)=>{const [lx]=localizePoint(slope,wx,0,wz);return 2+8*lx;};
 const c=body(slope,highAtCross,transform(slope,0,.5));
 // walked, not run: shared/mover.js refuses a stride rising over a step (0.8 m); a run's stride here rises 1.6 m, a walk's 0.62 m
 const high=await walk(c,transform(slope,2,.5),{run:false});
 check(high.arrived&&high.points.every(p=>Math.abs(localizePoint(slope,p.x,p.y,p.z)[2]-.5)<1e-8),
   "transformed real body uses terrain at wall crossing rather than origin height");
 console.log("PASS "+n+" support-basis checks");
}finally{for(const a of agents)a.close();}
process.exit(0);
