import test from 'node:test'
import assert from 'node:assert/strict'
import { TileScheduler } from '../src/components/alignment-explorer/tileScheduler.js'
const flush=()=>new Promise(resolve=>setTimeout(resolve,0))
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
test('a slow block does not block ready neighbours; panning deduplicates in-flight reads',async()=>{
  const slow=deferred();let calls=0,signal
  const cache=new TileScheduler({concurrency:2})
  const task={key:'slow',run:s=>{calls++;signal=s;return slow.promise}}
  cache.setWanted([task,{key:'fast',run:async()=>42}]);await flush()
  assert.equal(cache.get('fast'),42);assert.equal(cache.get('slow'),undefined)
  cache.setWanted([task,{key:'next',run:async()=>99}]);await flush()
  assert.equal(calls,1);assert.equal(signal.aborted,false);assert.equal(cache.get('next'),99)
  slow.resolve(5);await flush();assert.equal(cache.get('slow'),5)
})
test('a corrupt block does not starve later blocks or remain pending forever',async()=>{
  const errors=[],cache=new TileScheduler({concurrency:1,onError:e=>errors.push(e)})
  cache.setWanted([{key:'bad',run:async()=>{throw new Error('corrupt')}},{key:'good',run:async()=>7}]);await flush()
  assert.equal(cache.get('good'),7);assert.equal(cache.failed.has('bad'),true);assert.equal(cache.running.size,0);assert.deepEqual(errors,['corrupt'])
})
test('dataset changes discard late responses and bound cached entries',async()=>{
  const old=deferred(),cache=new TileScheduler({concurrency:2,maxEntries:2})
  cache.setWanted([{key:'old',run:()=>old.promise}]);await flush();cache.clear()
  cache.setWanted([1,2,3].map(key=>({key,run:async()=>key})));await flush()
  old.resolve(99);await flush();assert.equal(cache.get('old'),undefined);assert.equal(cache.cache.size,2)
})
