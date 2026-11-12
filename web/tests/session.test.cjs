const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness } = require('./helpers.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
for (const path of ['web/index.src.html', 'site/index.html']) {
  test(`${path}: wallet events clear balances, fee approval and pending confirmations`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.run('builderOk=true'); h.element('bGo').onclick();
    h.wallet.user = null; h.wallet.session++; h.window.dispatchEvent(new Event('ppp:wallet-change'));
    assert.equal(h.run('RA'), null); assert.equal(h.run('pending'), null); assert.equal(h.run('builderOk'), false);
    assert.equal(h.element('confirm').hidden, true); assert.equal(h.element('bConn').hidden, false);
  });
  test(`${path}: switching away and back cannot reuse an old order confirmation`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.element('bGo').onclick(); h.wallet.session += 2;
    await h.element('bSend').onclick(); assert.equal(h.orders.length, 0); assert.match(h.element('msg').textContent, /session changed/);
  });
  test(`${path}: a pending order prevents a second review and submit`, async () => {
    const h = harness(path); await h.run('pullPrices()'); const d = deferred(); let count = 0;
    h.api.marketOrder = () => { count++; return d.promise; };
    h.element('bGo').onclick(); const pending = h.element('bSend').onclick();
    assert.equal(h.element('bGo').disabled, true); h.element('bGo').onclick(); await h.element('bSend').onclick();
    assert.equal(count, 1); d.resolve({ filled: true, totalSz: '1', avgPx: '100' }); await pending;
    assert.equal(h.run('submitting'), false);
  });
  test(`${path}: a confirmation uses the fee shown at review, not a later fee state`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.run('builderOk=false;builderLive=false');
    h.element('bGo').onclick(); h.run('builderOk=true;builderLive=true'); await h.element('bSend').onclick();
    assert.equal(h.orders[0].builder, null);
  });
  test(`${path}: stale account data blocks opening but preserves closing`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.run('realAtMs=0'); h.element('bGo').onclick();
    assert.equal(h.run('pending'), null); h.run("review({close:true,coin:'SOL',size:1,isBuy:false})");
    await h.element('bSend').onclick(); assert.deepEqual(h.closes, ['SOL']);
  });
  test(`${path}: a late account response cannot repopulate a disconnected wallet`, async () => {
    const h = harness(path), d = deferred(); h.api.account = () => d.promise;
    const pending = h.run('refreshReal()'); h.wallet.user = null; h.wallet.session++;
    h.window.dispatchEvent(new Event('ppp:wallet-change')); d.resolve({ accountValue: '999' }); await pending;
    assert.equal(h.run('RA'), null);
  });
  test(`${path}: older account responses cannot overwrite newer data`, async () => {
    const h = harness(path), d = deferred(); h.api.account = () => d.promise;
    const old = h.run('refreshReal()'); h.api.account = async () => ({ accountValue: '200', withdrawable: '100', positions: [] });
    await h.run('refreshReal()'); d.resolve({ accountValue: '999' }); await old;
    assert.equal(h.run('RA.accountValue'), '200');
  });
  test(`${path}: failed account refresh blocks new risk`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.api.account = async () => { throw Error('offline'); };
    await h.run('refreshReal()'); h.element('bGo').onclick(); assert.equal(h.run('pending'), null);
  });
  test(`${path}: transport errors never claim the exchange rejected an order`, async () => {
    const h = harness(path); await h.run('pullPrices()'); h.api.marketOrder = async () => { throw Error('timeout'); };
    h.element('bGo').onclick(); await h.element('bSend').onclick();
    assert.match(h.element('msg').textContent, /not confirmed/); assert.doesNotMatch(h.element('msg').textContent, /rejected|Nothing was traded/);
  });
  for (const input of ['-100', '1e3', '1.2.3', 'Infinity']) {
    test(`${path}: ambiguous margin input ${input} cannot turn into a positive order`, () => {
      const h = harness(path); h.element('usd').value = input; assert.equal(h.run('amount()'), 0);
    });
  }
  test(`${path}: formatted positive margin remains supported`, () => {
    const h = harness(path); h.element('usd').value = '$1,234.50'; assert.equal(h.run('amount()'), 1234.5);
  });
}
