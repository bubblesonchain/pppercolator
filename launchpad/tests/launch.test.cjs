const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const html = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('  /* launch desk:'), html.indexOf('  /* guide:'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const els = new Map(), calls = [], messages = [], p = new EventEmitter();
  const $ = id => { if (!els.has(id)) els.set(id, { value: ({ coName:'Example',coSym:'EX',buy:'1' })[id]||'', addEventListener(type, fn) { this[type] = fn; } }); return els.get(id); };
  const key = value => ({ toString: () => value }); p.publicKey = key('walletA'); p.isPhantom = true;
  p.connect = async () => ({ publicKey: p.publicKey }); p.disconnect = async () => {};
  const c = { signers: ['walletA','mint1'], confirmBox: async () => true, prepare: async () => ({ tx: '' }), confirm: async () => ({}), send: async () => ({ signature:'signature1' }) };
  p.signAndSendTransaction = async () => { calls.push(['send']); return c.send(); };
  const ctx = vm.createContext({
    window:{ solana:p, solanaWeb3:{ Keypair:{generate:()=>({publicKey:{toBase58:()=> 'mint1'}})},VersionedTransaction:{deserialize:()=>({message:{staticAccountKeys:c.signers.map(key),header:{numRequiredSignatures:c.signers.length}},sign(){}})} } },
    $, atob:()=>'', say:t=>messages.push(t), confirmBox:t=>c.confirmBox(t), sel:{value:'SOL'}, MASCOTS:[['Bull']],m:0, COMPANIES:[],draw:()=>{},
    fetch: async (_url, options) => {
      if(!options.body)return {ok:true,json:async()=>[]};
      const body=JSON.parse(options.body);calls.push([body.action,body]);
      return {ok:true,json:()=>body.action==='prepare'?c.prepare(body):body.action==='confirm'?c.confirm(body):{}};
    },
  });
  vm.runInContext(source,ctx);vm.runInContext("logoData=()=> 'image'",ctx);
  return { $,c,p,calls,messages,ctx, key, submit:()=>$('launchForm').submit({preventDefault(){}}) };
}
test('a completed submission is recorded without claiming chain finality',async()=>{
  const h=setup();await h.submit();assert.equal(h.calls.filter(x=>x[0]==='send').length,1);
  assert.match(h.messages.at(-1),/submitted and recorded/);assert.doesNotMatch(h.messages.at(-1),/You are public/);
});
test('repeated submit during confirmation cannot launch twice',async()=>{
  const h=setup(),d=deferred(),entered=deferred();h.c.confirmBox=()=>{entered.resolve();return d.promise;};
  const pending=h.submit();await entered.promise;await h.submit();assert.equal(h.$('launchSubmit').disabled,true);
  d.resolve(true);await pending;assert.equal(h.calls.filter(x=>x[0]==='send').length,1);assert.equal(h.$('launchSubmit').disabled,false);
});
test('changing wallet while prepare is in flight prevents signing and cancels for original creator',async()=>{
  const h=setup(),d=deferred(),entered=deferred();h.c.prepare=()=>{entered.resolve();return d.promise;};
  const pending=h.submit();await entered.promise;h.p.publicKey=h.key('walletB');h.p.emit('accountChanged',h.p.publicKey);d.resolve({tx:''});await pending;
  assert.equal(h.calls.filter(x=>x[0]==='send').length,0);assert.equal(h.calls.find(x=>x[0]==='cancel')[1].creator,'walletA');
});
test('changing wallet during confirmation cancels before preparation',async()=>{
  const h=setup(),d=deferred(),entered=deferred();h.c.confirmBox=()=>{entered.resolve();return d.promise;};
  const pending=h.submit();await entered.promise;h.p.publicKey=h.key('walletB');h.p.emit('accountChanged',h.p.publicKey);d.resolve(true);await pending;
  assert.equal(h.calls.filter(x=>x[0]==='prepare').length,0);assert.equal(h.calls.filter(x=>x[0]==='send').length,0);
});
test('confirmation-server failure is not swallowed after a signature',async()=>{
  const h=setup();h.c.confirm=async()=>{throw Error('offline');};await h.submit();
  assert.match(h.messages.at(-1),/unconfirmed/);assert.match(h.messages.at(-1),/signature1/);assert.equal(h.calls.filter(x=>x[0]==='cancel').length,0);
});
test('an ambiguous wallet send error does not cancel a possibly submitted launch',async()=>{
  const h=setup();h.c.send=async()=>{throw Error('lost response');};await h.submit();
  assert.match(h.messages.at(-1),/wallet history before retrying/);assert.equal(h.calls.filter(x=>x[0]==='cancel').length,0);
});
test('post-submit recording always uses the original creator',async()=>{
  const h=setup();h.c.send=async()=>{h.p.publicKey=h.key('walletB');h.p.emit('accountChanged',h.p.publicKey);return {signature:'sig'};};await h.submit();
  assert.equal(h.calls.find(x=>x[0]==='confirm')[1].creator,'walletA');
});
for(const value of ['-1','6','NaN','1junk','1e2'])test(`invalid first buy ${value} never prepares a transaction`,async()=>{
  const h=setup();h.$('buy').value=value;await h.submit();assert.equal(h.calls.filter(x=>x[0]==='prepare').length,0);
});

for (const signers of [['walletB','mint1'],['walletA','mint1','unexpectedSigner']]) {
  test(`unexpected transaction signers ${signers} cannot reach the wallet`,async()=>{
    const h=setup();h.c.signers=signers;await h.submit();
    assert.equal(h.calls.filter(x=>x[0]==='send').length,0);assert.match(h.messages.at(-1),/Unexpected transaction signers/);
  });
}
