const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness } = require('./helpers.cjs');
for (const path of ['web/index.src.html', 'site/index.html']) {
  const load = value => { const h = harness(path); h.run(`location={hash:${JSON.stringify('#r'+Buffer.from(JSON.stringify(value)).toString('hex'))}}`); return h.read('readHash()'); };
  test(`${path}: a generated replay with trades, closes and shocks remains valid`, () => {
    const acts = [[0,'L',0,100],[1,'S',2,1200],[1,'C',2,0],[2,'K',0,-4],[3,'K',1,-30],[4,'K',5,4]];
    assert.deepEqual(load({s:123,e:5,a:acts}),{seed:123,end:5,acts});
  });
  for (const change of [{s:-1},{s:1.2},{s:2**32},{e:-1},{e:'5'},{e:20001},{e:1.5},{a:{}},
    {a:[[0,'L',6,10]]},{a:[[0,'L',-1,10]]},{a:[[0,'L',0.5,10]]},{a:[[0,'L',0,-10]]},{a:[[0,'L',0,5e6+1]]},
    {a:[[6,'L',0,10]]},{a:[[2,'L',0,10],[1,'L',0,10]]},{a:[[0,'X',0,10]]},{a:[[0,'K',0,-100]]},{a:[[0,'C',0,5]]},{a:[null]}]) {
    test(`${path}: rejects malformed replay ${JSON.stringify(change)}`,()=>assert.equal(load({s:1,e:5,a:[],...change}),null));
  }
  test(`${path}: rejects excessive action counts`,()=>assert.equal(load({s:1,e:0,a:Array(10001).fill([0,'C',0,0])}),null));
}
