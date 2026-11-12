import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';

const source = readFileSync(new URL('../entry.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const order = { coin: 'SOL', isBuy: true, size: 1.234567, leverage: 2 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const p = new EventEmitter(), calls = [], storage = new Map();
  const c = {
    now: 100000, accounts: [A], mids: async () => ({ SOL: '100' }),
    approve: async () => ({}), leverage: async () => ({}),
    order: async () => ({ response: { data: { statuses: [{ filled: { totalSz: '1.234', avgPx: '100' } }] } } }),
    account: async () => ({ marginSummary: { accountValue: '1000', totalMarginUsed: '0' }, withdrawable: '1000', assetPositions: [{ position: { coin: 'SOL', szi: '2' } }] }),
    symbols: async () => ({ getAssetId: coin => coin === 'SOL' ? 0 : undefined, getSzDecimals: coin => coin === 'SOL' ? 3 : undefined }),
  };
  p.request = async () => c.accounts;
  const window = new EventTarget(); window.ethereum = p;
  class InfoClient {
    allMids() { return c.mids(); }
    clearinghouseState(args) { calls.push(['account', args.user]); return c.account(); }
    maxBuilderFee() { return 30; }
  }
  class ExchangeClient {
    constructor({ wallet }) { this.wallet = wallet; }
    approveAgent(args) { calls.push(['approve', this.wallet.account]); return c.approve(args); }
    approveBuilderFee() { return c.approve(); }
    updateLeverage(args) { calls.push(['leverage', args]); return c.leverage(args); }
    order(args) { calls.push(['order', args]); return c.order(args); }
  }
  vm.runInNewContext(source, {
    window, CustomEvent, Date: class extends Date { static now() { return c.now; } }, HttpTransport: class {}, InfoClient, ExchangeClient,
    formatSize, formatPrice, SymbolConverter: { create: () => c.symbols() },
    createWalletClient: x => x, custom: x => x, arbitrum: {},
    generatePrivateKey: () => 'test-key', privateKeyToAccount: key => ({ address: B, key }),
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  });
  const api = window.PPPHL;
  return { api, c, p, window, storage, calls, ready: async () => { await api.connect(); await api.enableTrading(); } };
}

test('valid IOC uses lot precision, a 1% price buffer and the approved session', async () => {
  const h = setup(); await h.ready();
  assert.equal((await h.api.marketOrder(order)).filled, true);
  const req = h.calls.find(x => x[0] === 'order')[1];
  assert.equal(req.orders[0].s, '1.234'); assert.equal(req.orders[0].p, '101');
  assert.equal(req.orders[0].r, false); assert.equal(req.orders[0].t.limit.tif, 'Ioc');
});
for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
  test(`${event} invalidates the old trading key`, async () => {
    const h = setup(); await h.ready(); h.p.emit(event, [B]);
    assert.equal(h.api.user(), null); assert.equal(h.api.hasAgent(), false);
    await assert.rejects(h.api.marketOrder(order), /Connect/);
  });
}
test('an unchanged accounts event preserves the session', async () => {
  const h = setup(); await h.ready(); const s = h.api.session(); h.p.emit('accountsChanged', [A]);
  assert.equal(h.api.session(), s); assert.equal(h.api.hasAgent(), true);
});
test('approval completed after switching accounts cannot save a key under either account', async () => {
  const h = setup(); await h.api.connect(); const d = deferred(), entered = deferred();
  h.c.approve = () => { entered.resolve(); return d.promise; };
  const pending = h.api.enableTrading(); await entered.promise;
  h.c.accounts = [B]; h.p.emit('accountsChanged', [B]); d.resolve({});
  await assert.rejects(pending, /session changed/); assert.equal(h.storage.size, 0); assert.equal(h.api.hasAgent(), false);
});
test('disable while approval is pending cannot re-enable trading', async () => {
  const h = setup(); await h.api.connect(); const d = deferred(), entered = deferred();
  h.c.approve = () => { entered.resolve(); return d.promise; };
  const pending = h.api.enableTrading(); await entered.promise; h.api.disableTrading(); d.resolve({});
  await assert.rejects(pending, /session changed/); assert.equal(h.api.hasAgent(), false);
});
for (const phase of ['mids', 'leverage']) {
  test(`wallet change while awaiting ${phase} prevents order dispatch`, async () => {
    const h = setup(); await h.ready(); const d = deferred(), entered = deferred();
    h.c[phase] = () => { entered.resolve(); return d.promise; };
    const pending = h.api.marketOrder(order); await entered.promise;
    h.c.accounts = [B]; h.p.emit('accountsChanged', [B]); d.resolve({ SOL: '100' });
    await assert.rejects(pending, /session changed/); assert.equal(h.calls.filter(x => x[0] === 'order').length, 0);
  });
}
test('a missed provider event is caught by eth_accounts before signing', async () => {
  const h = setup(); await h.ready(); h.c.accounts = [B];
  await assert.rejects(h.api.marketOrder(order), /account changed/);
  assert.equal(h.calls.filter(x => x[0] === 'order').length, 0);
});
test('concurrent open and close requests are rejected until the first completes', async () => {
  const h = setup(); await h.ready(); const d = deferred(), entered = deferred();
  h.c.order = () => { entered.resolve(); return d.promise; };
  const pending = h.api.marketOrder(order); await entered.promise;
  await assert.rejects(h.api.marketOrder(order), /already in progress/);
  await assert.rejects(h.api.closePosition('SOL'), /already in progress/);
  d.resolve({ response: { data: { statuses: [{ filled: { totalSz: '1', avgPx: '100' } }] } } }); await pending;
  assert.equal(h.calls.filter(x => x[0] === 'order').length, 1);
});
for (const patch of [{ size: -1 }, { size: NaN }, { size: Infinity }, { size: 0.00001 }, { leverage: 1.5 }, { leverage: 0 }, { isBuy: 'false' }, { slippage: Infinity }, { slippage: -0.1 }]) {
  test(`invalid order ${JSON.stringify(patch)} cannot change leverage or dispatch`, async () => {
    const h = setup(); await h.ready(); await assert.rejects(h.api.marketOrder({ ...order, ...patch }));
    assert.equal(h.calls.filter(x => x[0] === 'order' || x[0] === 'leverage').length, 0);
  });
}
for (const price of ['Infinity', '100junk', '0', '-1']) {
  test(`invalid execution price ${price} fails before leverage changes`, async () => {
    const h = setup(); await h.ready(); h.c.mids = async () => ({ SOL: price });
    await assert.rejects(h.api.marketOrder(order), /valid price/);
    assert.equal(h.calls.filter(x => x[0] === 'leverage').length, 0);
  });
}
for (const response of [undefined, {}, { response: { data: { statuses: ['waitingForFill'] } } }]) {
  test(`an unrecognized response is unknown, not proof of no trade: ${JSON.stringify(response)}`, async () => {
    const h = setup(); await h.ready(); h.c.order = async () => response;
    await assert.rejects(h.api.marketOrder(order), /could not be confirmed/);
  });
}
test('a lost response is reported as unknown and is never retried automatically', async () => {
  const h = setup(); await h.ready(); h.c.order = async () => { throw new Error('timeout'); };
  await assert.rejects(h.api.marketOrder(order), /Check your Hyperliquid/);
  assert.equal(h.calls.filter(x => x[0] === 'order').length, 1);
});
test('an explicit exchange rejection is preserved', async () => {
  const h = setup(); await h.ready(); h.c.order = async () => ({ response: { data: { statuses: [{ error: 'Insufficient margin' }] } } });
  await assert.rejects(h.api.marketOrder(order), /Insufficient margin/);
});
test('a close refreshes position size and submits reduce-only without changing leverage', async () => {
  const h = setup(); await h.ready(); await h.api.closePosition('SOL');
  const req = h.calls.find(x => x[0] === 'order')[1];
  assert.equal(req.orders[0].s, '2'); assert.equal(req.orders[0].b, false); assert.equal(req.orders[0].r, true);
  assert.equal(h.calls.filter(x => x[0] === 'leverage').length, 0);
});
test('an account read started before a switch cannot return the previous account', async () => {
  const h = setup(); await h.ready(); const d = deferred(); h.c.account = () => d.promise;
  const pending = h.api.account(); h.c.accounts = [B]; h.p.emit('accountsChanged', [B]);
  d.resolve({}); await assert.rejects(pending, /session changed/);
});
test('cross-tab key removal cancels the active session', async () => {
  const h = setup(); await h.ready(); const e = new Event('storage'); e.key = 'ppp.hl.agent.' + A;
  h.window.dispatchEvent(e); assert.equal(h.api.hasAgent(), false);
});
test('switching accounts during symbol loading leaves no connected session', async () => {
  const h = setup(); const d = deferred(), entered = deferred(); h.c.symbols = () => { entered.resolve(); return d.promise; };
  const pending = h.api.connect(); await entered.promise; h.c.accounts = [B]; d.resolve({});
  await assert.rejects(pending, /changed while connecting/); assert.equal(h.api.user(), null);
});
test('a quote expiring during leverage update cannot dispatch an order', async () => {
  const h = setup(); await h.ready(); const d = deferred(), entered = deferred();
  h.c.leverage = () => { entered.resolve(); return d.promise; };
  const pending = h.api.marketOrder({ ...order, validUntil: h.c.now + 30 }); await entered.promise;
  h.c.now += 31; d.resolve({});
  await assert.rejects(pending, /quote expired/); assert.equal(h.calls.filter(x => x[0] === 'order').length, 0);
});
