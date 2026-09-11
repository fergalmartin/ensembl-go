import test from 'node:test'
import assert from 'node:assert/strict'
import { rowCoverage,sampleBase } from '../src/components/alignment-explorer/tileCoverage.js'
import { layoutCoverage } from '../src/components/alignment-explorer/layoutCoverage.js'
import { planTiles,resolutionLevel } from '../src/components/alignment-explorer/tilePlan.js'
import { createFragment } from '../src/components/alignment-explorer/layers.js'
import { TileScheduler } from '../src/components/alignment-explorer/tileScheduler.js'
const flush=()=>new Promise(r=>setTimeout(r,0))
const detail=(start,end,rows)=>({start,end,detail:true,rows:rows.map(id=>({id,sequence:'A'.repeat(end-start)}))})
test('adjacent and partial-row tiles compose without discarding cached coverage',()=>{
  const a=detail(0,10,['a','b']),b=detail(10,20,['a']),c=detail(10,20,['b'])
  for(const sources of [[a,b,c],[c,a,b],[b,c,a]])for(const row of ['a','b']){
    const result=rowCoverage(sources,row,0,20,2)
    assert.deepEqual(result.holes,[]);assert.deepEqual(result.spans.map(s=>[s.start,s.end]),[[0,10],[10,20]])
  }
  assert.deepEqual(rowCoverage([a,b],'b',0,20,2).holes,[[10,20]])
})
test('detail refines only covered intervals; missing rows remain explicit',()=>{
  const coarse={start:0,end:100,detail:false,bin_size:50,rows:[{id:'a',bins:[{A:50},{A:50}]}]}
  const fine=detail(20,40,['a']);fine.rows[0]={id:'a',sequence:null,missing:true}
  const result=rowCoverage([coarse,fine],'a',0,100,2)
  assert.deepEqual(result.spans.map(s=>[s.start,s.end,s.data.detail]),[[0,20,false],[20,40,true],[40,100,false]])
  assert.equal(result.spans[1].row.missing,true)
  assert.equal(sampleBase({sources:[detail(0,10,['a']),detail(10,20,['a'])]},'a',15),'A')
})
test('compatible layout pages join and a coarse layout persists through partial replacement',()=>{
  const block=(id,x,end_x,aggregate=false)=>({block:id,x,end_x,aggregate})
  const coarse={mode:'coarse',start:0,end:100,blocks:[block(1,0,100,true)]}
  const left={mode:'fine',start:0,end:50,blocks:[block(1,0,50)]},right={mode:'fine',start:50,end:100,blocks:[block(2,50,100)]}
  assert.deepEqual(layoutCoverage([coarse,left],0,100,'fine'),coarse.blocks)
  assert.deepEqual(layoutCoverage([coarse,left,right],0,100,'fine'),[...left.blocks,...right.blocks])
})
test('fixed tile keys survive small pans and row reorder; cropped chunks stay in their source coordinates',()=>{
  const f=createFragment(2,12000,18000,['a','c','b'],{x:0})
  const camera={x:0,y:0,scale:1,plane:1},size={width:800,height:500}
  const keys=fragment=>planTiles(fragment,camera,size,2).map(t=>JSON.stringify(t.request))
  assert.deepEqual(keys(f),keys({...f,rowIds:['a','b','c']}))
  assert.deepEqual(planTiles(f,camera,size,2),planTiles(f,{...camera,x:10},size,2))
  assert.ok(planTiles(f,camera,size,2).every(t=>t.request.end>12000&&t.request.start<18000))
})
test('resolution hysteresis resists threshold oscillation',()=>{
  assert.equal(resolutionLevel(.49,3),3);assert.equal(resolutionLevel(.51,3),3)
  assert.ok(resolutionLevel(.1,3)>3)
})
test('LRU protects wanted tiles and reads refresh recency',async()=>{
  const cache=new TileScheduler({maxEntries:2})
  await Promise.all([1,2].map(async key=>{cache.setWanted([{key,run:async()=>key}]);await flush()}))
  cache.get(1);cache.setWanted([{key:1,run:async()=>1},{key:3,run:async()=>3}]);await flush()
  assert.equal(cache.get(1),1);assert.equal(cache.get(2),undefined);assert.equal(cache.get(3),3)
})
test('consumer leases deduplicate previews and retry preserves healthy data',async()=>{
  const cache=new TileScheduler(),task={key:'a',run:async()=>7};let reads=0
  cache.setWanted([task],'main');cache.setWanted([task,{key:'bad',run:async()=>{reads++;throw Error('bad')}}],'preview');await flush()
  cache.release('preview');assert.equal(cache.get('a'),7)
  cache.retryFailed();await flush();assert.equal(cache.get('a'),7);assert.equal(reads,1)
  assert.deepEqual([...cache.wanted],['a'])
})
