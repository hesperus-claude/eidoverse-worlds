// bun tools/route-preparation-test.ts: the authored-plan cache's boundaries, through real editor operations and the
// received-entry fold; unrelated geometry I/O is disabled so this suite cannot fetch assets from a running sequencer.
// The cap rows (16384 admitted, 16385 refused, the worst case's time) are tools/structure-route-test.ts's.
import { strict as assert } from "node:assert";
import { WorldAgent } from "../mcpl/agent.ts";
import { prepareRouteLocal } from "../shared/structure.js";
import { routeGeometryFor } from "../shared/structure-route.js";
import { addWall, removeWall, setAperture, setTile, removeTile, drawRoom, eraseRoom, labelCell } from "../shared/structure_edit.js";
import { agentOnDoor } from "./agent-scratch.ts";
import { qFromYaw } from "../shared/rot.js";
let count=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);count++;console.log("✓ "+label);};
const terrain=(height=0)=>({kind:"terrain",heightAt:()=>height,step:.5});
const base:any={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}],labels:{}};
const agent=new WorldAgent({name:"cache-test",avatar:"",world:"cache-test"});
(agent as any).syncSupport=async()=>{}; // the fold/cache, not remote asset support, is under test
// the agent folds the authority's log itself, so each old hand-written entry is the current write doing the same (spawn →
// create, comp → set/delete a component, place → set transform) through the real door (tools/agent-scratch.ts agentOnDoor)
const door=agentOnDoor(agent,"route-prep");
async function receive(verb:string,args:any) {
 const a=JSON.parse(JSON.stringify(args));
 const now=agent.entities.get(a.id) as any;
 const tf=(r:any)=>{const s=r.scale??now?.scale??1;return {pos:r.pos??now?.pos??[0,0,0],q:qFromYaw(r.yaw??now?.yaw??0),scale:[s,s,s]};};
 let r:any;
 if(verb==="spawn"){
  if(now){
   // the authority never reuses an id: the old thing is deleted and the door refuses the id's return ("reused"), structure or not
   const gone=await door.act("delete",{id:a.id});
   if(!gone.ok) throw new Error("delete refused: "+JSON.stringify(gone.refused));
   r=door.call("create",{id:a.id,model:a.lib,components:{transform:tf(a)}});
   if(r.ok||r.refused?.code!=="reused") throw new Error("the authority let an id be reused: "+JSON.stringify(r));
   return {verb,args:a};
  }
  r=await door.act("create",{id:a.id,model:a.lib,components:{transform:tf(a)}});
 } else if(verb==="comp") r=await door.act(a.data===null?"delete":"set",a.data===null?{id:a.id,component:a.type}:{id:a.id,component:a.type,value:a.data});
 else if(verb==="place") r=await door.act("set",{id:a.id,component:"transform",value:tf(a)});
 else throw new Error("no current write for old "+verb);
 if(!r.ok) throw new Error(verb+" refused: "+JSON.stringify(r.refused));
 return {verb,args:a};
}
/** The same value: the fold hands the agent a copy of what was written, never the writer's object. */
const same=(x:any,y:any)=>JSON.stringify(x)===JSON.stringify(y);
const data=()=>agent.entities.get("house")?.structure;
const cached=(d:any)=>(agent as any).planOf(d);
async function planned(target:[number,number]) {
 const promise=agent.walkTo(...target,true,1000,0);
 const result={refusal:agent.walkRefusal,legs:(agent as any).legs.length,target:(agent as any).target};
 agent.stop();await promise;return result;
}
/** An accepted straight walk: no refusal, no legs, and the destination as its target. */
const straight=(r:any,[x,z]:[number,number])=>r.refusal===null&&r.legs===0&&r.target?.x===x&&r.target?.z===z;
/** An accepted detour: no refusal, and waypoints before the destination. */
const detour=(r:any)=>r.refusal===null&&r.legs>0&&!!r.target;
try{
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0],yaw:0});
 await receive("comp",{id:"house",type:"structure",data:base});
 const original=data(), initial=cached(original), originalJSON=JSON.stringify(original);
 check(cached(original)===initial,"same received component identity reuses its pure local plan");
 const geometry=routeGeometryFor(initial);
 check(routeGeometryFor(initial)===geometry,"same immutable plan reuses wall spans and terrain topology");
 const low=prepareRouteLocal(initial,terrain(0)), high=prepareRouteLocal(initial,terrain(4));
 check(low!==high&&!low.clear(.5,.5,1.5,.5)&&high.clear(.5,.5,1.5,.5),"same cached geometry gets fresh terrain/support checkers");

 const edge={axis:1,x:1,z:0}, cell={x:0,z:0};
 const edits:[string,(d:any)=>any][]=[
  ["add wall",d=>addWall(d,{axis:0,x:0,z:0})],
  ["remove wall",d=>removeWall(d,edge)],
  ["door",d=>setAperture(d,edge,"door")],
  ["window",d=>setAperture(d,edge,"window")],
  ["clear aperture",d=>setAperture(setAperture(d,edge,"door"),edge,null)],
  ["tile/half",d=>setTile(d,cell,"floor","A")],
  ["remove tile",d=>removeTile(d,cell)],
  ["draw room",d=>drawRoom(d,cell,{x:1,z:1})],
  ["erase room",d=>eraseRoom(d,cell,cell)],
  ["label",d=>labelCell(d,cell,"kitchen")],
 ];
 for(const [name,edit] of edits){
  const next=edit(original);
  check(next!==original&&JSON.stringify(original)===originalJSON,name+": editor returns new identity and preserves the old value");
  const previous=data();
  const packet=await receive("comp",{id:"house",type:"structure",data:next});
  check(data()!==previous&&same(data(),packet.args.data),name+": received comp replaces data identity in the actual agent fold");
  check(cached(data())!==initial,name+": changed component gets a different plan");
 }
 const door=setAperture(base,edge,"door");
 await receive("comp",{id:"house",type:"structure",data:door});
 const doorPlan=cached(data());
 check(prepareRouteLocal(doorPlan,terrain()).clear(.5,.5,1.5,.5),"replacement opening invalidates old blocking geometry");
 // the editor clearing that door: the wall it leaves blocks again
 await receive("comp",{id:"house",type:"structure",data:setAperture(door,edge,null)});
 const clearedPlan=cached(data());
 check(clearedPlan!==doorPlan&&!prepareRouteLocal(clearedPlan,terrain()).clear(.5,.5,1.5,.5),"clearing an existing door through the editor closes the opening");
 await receive("comp",{id:"house",type:"structure",data:door});
 await receive("comp",{id:"house",type:"structure",data:base}); // UI undo: send the previous value through comp
 const undone=data(), undonePlan=cached(undone);
 check(undonePlan!==doorPlan&&!prepareRouteLocal(undonePlan,terrain()).clear(.5,.5,1.5,.5),"undo restores the prior wall without reusing the changed geometry");

 agent.pos={x:.5,y:0,z:.5};
 check(detour(await planned([1.5,.5])),"cached wall produces a real walk detour");
 await receive("place",{id:"house",pos:[10,0,0]});
 check(same(data(),undone)&&cached(data())===undonePlan,"entity translation preserves authored-cache identity");
 check(straight(await planned([1.5,.5]),[1.5,.5]),"new walk uses fresh translation rather than an old transformed checker");
 await receive("place",{id:"house",pos:[10,1,-5],yaw:Math.PI/2,scale:2});
 (agent as any).terrain={heightAt:()=>1};agent.pos={x:11,y:1,z:-6};
 check(cached(data())===undonePlan&&detour(await planned([11,-8])),"same geometry uses fresh rotation, scale and terrain origin");
 (agent as any).terrain={heightAt:()=>8};
 check(straight(await planned([11,-8]),[11,-8]),"later walk uses changed terrain height with the same authored plan");
 // walkTo plans each received revision once: a second walk over the same component reads none of its data again
 let reads=0;
 const counted={levels:[{y:0,tiles:[[0,0],[1,0]],walls:[[1,1,0]],apertures:[]}]};
 const watched={get levels(){reads++;return counted.levels;}};
 agent.entities.set("watched",{id:"watched",model:"",pos:[20,0,0],yaw:0,scale:1,structure:watched} as any);
 (agent as any).terrain={heightAt:()=>1};agent.pos={x:20.5,y:1,z:.5};
 check(detour(await planned([21.5,.5]))&&reads>0,"a walk past a new revision plans it");
 const readsAfterFirst=reads;
 check(detour(await planned([21.5,.5]))&&reads===readsAfterFirst,"a second walk over the same revision reads none of it again");
 agent.entities.delete("watched");
 await receive("comp",{id:"house",type:"structure",data:null});
 agent.pos={x:11,y:1,z:-6};
 check(data()===undefined&&straight(await planned([11,-8]),[11,-8]),"component removal drops the obstacle rather than reviving cached data");
 await receive("comp",{id:"house",type:"structure",data:base});
 check(data()!==undone&&cached(data())!==undonePlan,"re-attach creates its own received revision");
 for(const primitive of ["junk",true,7,null]){
  const first=cached(primitive);
  check(first.levels.length===0&&cached(primitive)!==first,"malformed primitive "+JSON.stringify(primitive)+" plans empty, afresh each time (uncached)");
 }
 await receive("spawn",{id:"house",lib:"fixture.glb",pos:[0,0,0]});
 check(data()===undefined,"same-id spawn replacement does not inherit cached structure data");
 console.log("PASS "+count+" route-preparation assertions");
}finally{agent.close();}
process.exit(0);
