import test from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../src/components/alignment-explorer/conservation.js')

test('identity is a ratio of sums, never a mean of per-bin fractions',async()=>{
  const {conservationScore}=await load()
  // Bin A: 8 agreeing of 8 over 4 columns. Bin B: 2 of 4 over 2 comparable columns.
  const merged=conservationScore(8+2,8+4,4+2,12,8,2)
  assert.equal(merged.identity,10/12)
  assert.notEqual(merged.identity,(8/8+2/4)/2,'the unweighted average would have been .75')
})

test('a column with one canonical base agrees with nothing and is not counted',async()=>{
  const {conservationScore,conservationIndex,NOT_COMPARABLE}=await load()
  assert.equal(conservationScore(0,0,0,5,5,2),null)
  const bins={majority:[0],canonical:[0],comparable:[0],occupied:[5],columns:[5]}
  assert.equal(conservationIndex(bins,0,2),NOT_COMPARABLE)
})

test('the cohort is the denominator, so a thin block cannot read as well supported',async()=>{
  const {conservationScore}=await load()
  // The same three sequences agreeing perfectly, asked about as three and as ten.
  const narrow=conservationScore(30,30,10,30,10,3)
  const wide=conservationScore(30,30,10,30,10,10)
  assert.equal(narrow.conserved,wide.conserved,'agreement is untouched by who else was asked about')
  assert.equal(narrow.representation,1)
  assert.equal(wide.representation,0.3,'three of ten is three of ten however well they agree')
  assert.ok(wide.representation<narrow.representation)
})

test('the ramp is fitted to the identity actually loaded, not to a range nothing reaches',async()=>{
  const {conservationScale,conservationScore,DEFAULT_SCALE}=await load()
  // Measured on a 44-mammal EPO block, per-bin identity runs .86 to 1.00. On a
  // fixed 0..1 ramp the whole alignment is one colour; this is the regression.
  const bins={majority:[],canonical:[],comparable:[],occupied:[],columns:[]}
  for(let i=0;i<400;i++){
    const identity=0.86+(i/399)*0.14
    bins.majority.push(Math.round(identity*1000));bins.canonical.push(1000)
    bins.comparable.push(50);bins.occupied.push(1000);bins.columns.push(50)
  }
  const scale=conservationScale([{bins}])
  assert.equal(scale.fitted,true)
  assert.ok(scale.lo>0.85&&scale.lo<0.88,`fitted low ${scale.lo} should sit at the bottom of the data`)
  assert.ok(scale.hi>0.99,`fitted high ${scale.hi} should reach the top of the data`)
  const spread=v=>conservationScore(Math.round(v*1000),1000,50,1000,50,20,scale).conserved
  assert.ok(spread(0.87)<0.15,'the least conserved bins reach the blue end')
  assert.ok(spread(0.99)>0.85,'the most conserved bins reach the red end')
  // The same data on the unfitted ramp is the bug the user reported.
  const flat=v=>conservationScore(Math.round(v*1000),1000,50,1000,50,20,DEFAULT_SCALE).conserved
  assert.ok(flat(0.99)-flat(0.87)<0.3,'unfitted, that whole range is nearly one colour')
  assert.ok(spread(0.99)-spread(0.87)>0.7,'fitted, it spans most of the ramp')
})

test('a scale is not fitted to too little data, and never magnifies noise',async()=>{
  const {conservationScale,DEFAULT_SCALE}=await load()
  assert.equal(conservationScale([]),DEFAULT_SCALE)
  assert.equal(conservationScale([{bins:{majority:[2],canonical:[2],comparable:[1],occupied:[2],columns:[1]}}]),DEFAULT_SCALE)
  // Every bin identical: a zero-width range would turn rounding into a rainbow.
  const bins={majority:[],canonical:[],comparable:[],occupied:[],columns:[]}
  for(let i=0;i<200;i++){bins.majority.push(950);bins.canonical.push(1000);bins.comparable.push(50);bins.occupied.push(1000);bins.columns.push(50)}
  const scale=conservationScale([{bins}])
  assert.ok(scale.hi-scale.lo>=0.039,`range ${scale.hi-scale.lo} must not collapse`)
})

test('the ramp carries its order without hue, and never leans on green',async()=>{
  const {buildRamp,RAMP_SIZE}=await load()
  const rgb=c=>c.match(/\d+/g).map(Number)
  const luminance=c=>{const[r,g,b]=rgb(c);return .2126*r+.7152*g+.0722*b}
  for(const light of [true,false]){
    const ramp=buildRamp(light)
    // Red-green colour blindness is common enough that a blue-green-yellow-red
    // sweep is the wrong route. Going through purple instead, green never wins
    // a channel and luminance climbs steadily, so the ramp still reads in
    // greyscale and to a reader who cannot separate its hues.
    for(const colour of ramp){
      const [r,g,b]=rgb(colour)
      assert.ok(g<=Math.max(r,b),`${colour} is carried by green`)
    }
    for(let i=1;i<RAMP_SIZE;i++){
      const step=luminance(ramp[i])-luminance(ramp[i-1])
      // More agreement means more contrast against the page either way: darker
      // toward red on a light ground, brighter toward red on a dark one.
      assert.ok(light?step<0:step>0,`step ${i} breaks the luminance order on the ${light?'light':'dark'} theme`)
    }
  }
})

test('the ramp runs blue to red, is dense and deterministic, and avoids the gold reserved for picked',async()=>{
  const {buildRamp,RAMP_SIZE}=await load()
  const rgb=c=>c.match(/\d+/g).map(Number)
  for(const light of [true,false]){
    const ramp=buildRamp(light)
    assert.equal(ramp.length,RAMP_SIZE)
    assert.equal(new Set(ramp).size,RAMP_SIZE,'every step is its own colour')
    assert.deepEqual(ramp,buildRamp(light),'memoised, and the same every time')
    const [lr,,lb]=rgb(ramp[0]),[hr,,hb]=rgb(ramp[RAMP_SIZE-1])
    assert.ok(lb>lr,'little agreement reads blue')
    assert.ok(hr>hb,'a lot of agreement reads red')
    for(const colour of ramp){
      const [r,g,b]=rgb(colour)
      // Gold is high red, high green, low blue. The lit highlight owns that.
      assert.ok(!(r>195&&g>165&&g<215&&b<115),`${colour} is too close to the gold used for lit rows`)
    }
  }
  assert.notDeepEqual(buildRamp(true),buildRamp(false))
})

test('colour and bar height are separable, and a present column is never invisible',async()=>{
  const {conservationIndex,rampColour,rampHeight,IDENTITY_STEPS,REPRESENTATION_STEPS}=await load()
  const bins={majority:[900,900],canonical:[1000,1000],comparable:[50,50],occupied:[1000,200],columns:[50,50]}
  const full=conservationIndex(bins,0,20),thin=conservationIndex(bins,1,20)
  assert.equal(rampColour(full),rampColour(thin),'the same agreement is the same colour however thin the evidence')
  assert.ok(rampHeight(full)>rampHeight(thin),'and the thinner evidence draws a shorter bar')
  for(let r=0;r<REPRESENTATION_STEPS;r++){
    const h=rampHeight(r*IDENTITY_STEPS)
    assert.ok(h>0.2&&h<=1,`height ${h} must stay visible and fit the row`)
  }
})

test('runs merge equal buckets and break on this row’s own gaps',async()=>{
  const {conservationRuns,GAP_RUN}=await load()
  const data={start:0,bin_size:1,bins:{majority:[2,2,2,2],canonical:[2,2,2,2],comparable:[1,1,1,1],occupied:[2,2,2,2],columns:[1,1,1,1]}}
  assert.deepEqual(conservationRuns(data,0,4,2).map(r=>[r.start,r.end]),[[0,4]],'four identical columns cost one fill')
  const gapped=conservationRuns(data,0,4,2,c=>c===2)
  assert.deepEqual(gapped.map(r=>[r.start,r.end,r.index===GAP_RUN]),[[0,2,false],[2,3,true],[3,4,false]])
})

test('runs cover every column exactly once, whatever the bin size',async()=>{
  const {conservationRuns}=await load()
  const n=9,bins={majority:[],canonical:[],comparable:[],occupied:[],columns:[]}
  for(let i=0;i<n;i++){bins.majority.push(i%3?2:1);bins.canonical.push(2);bins.comparable.push(1);bins.occupied.push(2);bins.columns.push(1)}
  for(const bin_size of [1,2,4]){
    const runs=conservationRuns({start:0,bin_size,bins},1,8,2)
    assert.equal(runs[0].start,1);assert.equal(runs.at(-1).end,8)
    for(let i=1;i<runs.length;i++)assert.equal(runs[i].start,runs[i-1].end,`bin_size ${bin_size} left a seam`)
  }
})

test('presence colours the second axis alone and ignores agreement entirely',async()=>{
  const {representationIndex,rampColour,rampHeight,IDENTITY_STEPS}=await load()
  const full={majority:[2],canonical:[2],comparable:[1],occupied:[10],columns:[1]}
  const diverged={majority:[1],canonical:[10],comparable:[1],occupied:[10],columns:[1]}
  assert.equal(representationIndex(full,0,10),representationIndex(diverged,0,10),'agreement must not reach this scheme')
  assert.equal(rampColour(representationIndex(full,0,10)),IDENTITY_STEPS-1,'all present is the top of the ramp')
  assert.equal(rampColour(representationIndex({...full,occupied:[3]},0,10)),Math.floor(.3*IDENTITY_STEPS))
  assert.equal(rampHeight(representationIndex(full,0,10)),1,'presence fills the row; it is not also encoded as height')
})

test('a scheme without a ramp is the original path, and only cohort schemes ask for data',async()=>{
  const {COLOUR_SCHEMES,schemeById}=await import('../src/components/alignment-explorer/colourSchemes.js')
  assert.equal(schemeById('bases').ramp,null)
  assert.equal(schemeById('bases').cohort,false)
  assert.equal(schemeById('nonsense').id,'bases','an unknown scheme falls back rather than throwing')
  for(const scheme of COLOUR_SCHEMES)assert.equal(!!scheme.ramp,scheme.cohort,'a ramp and a cohort request go together')
})

test('conservation tiles compose finest-first and never erase coarse coverage',async()=>{
  const {conservationSpans}=await import('../src/components/alignment-explorer/conservationCoverage.js')
  const coarse={start:0,end:100,bin_size:64,bins:{columns:[1]}}
  const fine={start:20,end:60,bin_size:4,bins:{columns:[1]}}
  const {spans,holes}=conservationSpans([coarse,fine],0,100)
  assert.deepEqual(spans.map(s=>[s.start,s.end,s.data.bin_size]),[[0,20,64],[20,60,4],[60,100,64]])
  assert.deepEqual(holes,[],'the coarse parent still covers what the finer tile does not reach')
  assert.deepEqual(conservationSpans([],0,100).holes,[[0,100]],'nothing loaded is a hole, not a colour')
})

test('cohort keys survive row order and pan, and narrow to what is picked',async()=>{
  const {cohortOf,planConservationTiles}=await import('../src/components/alignment-explorer/conservationPlan.js')
  const inventory=[{id:'c'},{id:'a'},{id:'b'}]
  const all=cohortOf({id:'original'},inventory,new Set())
  assert.deepEqual(all.ids,['a','b','c'])
  assert.equal(all.key,cohortOf({id:'original'},[...inventory].reverse(),new Set()).key,'reordering rows is not a new question')
  const picked=cohortOf({id:'original'},inventory,new Set(['b','missing']))
  assert.deepEqual(picked.ids,['b'])
  assert.equal(picked.picked,true)
  const fragment={id:'f',sourceBlock:1,start:0,end:100000,x:0,rowIds:['a','b'],aggregate:null}
  const size={width:900,height:500}
  const keys=camera=>planConservationTiles(fragment,camera,size,2,all).map(t=>`${t.request.start}:${t.request.end}:${t.request.bins}`)
  const a=keys({x:0,y:0,scale:1,plane:1}),b=keys({x:7,y:0,scale:1,plane:1})
  assert.ok(a.length&&b.length)
  for(const key of b.filter(k=>a.includes(k)))assert.ok(a.includes(key),'a nudge of the camera must reuse the tile, not re-cut it')
  assert.ok(a.every(k=>Number(k.split(':')[2])<=2048),'never finer than the endpoint allows')
})

test('a saved colour scheme round-trips, and an unknown one falls back rather than throwing',async()=>{
  const {emptyWorkspace,validateLayerWorkspace}=await import('../src/components/alignment-explorer/layers.js')
  assert.equal(emptyWorkspace().colourScheme,'bases')
  assert.equal(validateLayerWorkspace({...emptyWorkspace(),colourScheme:'conservation'},[]).colourScheme,'conservation')
  assert.equal(validateLayerWorkspace({...emptyWorkspace(),colourScheme:'from-a-later-build'},[]).colourScheme,'bases')
  assert.equal(validateLayerWorkspace(emptyWorkspace(),[]).colourScheme,'bases')
})

test('the cohort is what the blocks on the sheet hold, not every identity in the file',async()=>{
  const {cohortOf}=await import('../src/components/alignment-explorer/conservationPlan.js')
  // A 200-block MAF names a distinct identity per sequence per block. Measured
  // against all of them, a block holding 45 reads as holding a hundredth of the
  // cohort and the presence axis goes flat. This is that regression.
  const inventory=Array.from({length:3881},(_,i)=>({id:`seq${i}`}))
  const laid=[{id:'f1',sourceBlock:1,rowIds:['seq0','seq1','seq2'],availableRows:['seq0','seq1']},
              {id:'f2',sourceBlock:2,rowIds:['seq2','seq3'],availableRows:['seq2','seq3']}]
  const cohort=cohortOf({id:'original',fragments:laid},inventory,new Set())
  assert.deepEqual(cohort.ids,['seq0','seq1','seq2','seq3'])
  assert.equal(cohort.ids.length,4,'not 3881')
  // A merged overview carries no row lists, and then the inventory is all there is.
  const merged=cohortOf({id:'original',fragments:[{id:'a',aggregate:{count:20},rowIds:[]}]},inventory,new Set())
  assert.equal(merged.ids.length,3881)
})

test('conservation tiles share the sequence tiles order, pixel rule and all',async()=>{
  const {conservationSpans}=await import('../src/components/alignment-explorer/conservationCoverage.js')
  const tile=size=>({start:0,end:1000,bin_size:size,bins:{columns:[1]}})
  // No scale given: finest first, exactly as before.
  assert.equal(conservationSpans([tile(64),tile(4)],0,1000).spans[0].data.bin_size,4)
  // Zoomed out past what either resolves: the cheaper of the two, same wash.
  assert.equal(conservationSpans([tile(64),tile(4)],0,1000,1/1000).spans[0].data.bin_size,64)
  // Zoomed in: the finest still wins.
  assert.equal(conservationSpans([tile(64),tile(4)],0,1000,2).spans[0].data.bin_size,4)
})
