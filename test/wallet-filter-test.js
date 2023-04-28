'use strict';

const assert = require('bsert');
const FullNode = require('../lib/node/fullnode');
const Network = require('../lib/protocol/network');

const network = Network.get('regtest');

const TEST_WALLET_ID = 'testwallet';
const TEST_RECOVER_ID = 'testrecover';

// TODO: Increase size of lookahead in the account record
// so we can store bigger numbers than 255.
// const TEST_LOOKAHEAD = 10;

describe('Wallet update and send filters/rescan', function() {
  // TODO: Temporary timeout for Patched LOOKAHEAD
  this.timeout(10000);

  let node, wdb, pwallet, waddr, twallet, taccount, xpub;

  const sendMine = async (txs) => {
    for (const txInfo of txs)
      await pwallet.send(txInfo);

    await node.rpc.generateToAddress([1, waddr]);
  };

  beforeEach(async () => {
    node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [require('../lib/wallet/plugin')]
    });

    await node.open();
    wdb = node.require('walletdb').wdb;

    pwallet = await wdb.get('primary');
    twallet = await wdb.create({ id: TEST_WALLET_ID });

    taccount = await twallet.getAccount(0);
    xpub = taccount.accountKey.toBase58(network);

    waddr = (await pwallet.createReceive(0)).getAddress().toString(network);
    await node.rpc.generateToAddress([10, waddr]);
  });

  afterEach(async () => {
    await node.close();
  });

  // simple case:
  //  2 TXs with gapped addresses in derivation order.
  it('should recover lookahead gapped block (deriv order)', async () => {
    // TODO: add lookahead configuration back.
    // assert.strictEqual(taccount.lookahead, TEST_LOOKAHEAD);

    // last address wallet is aware of.
    const lookaheadReceive = taccount.deriveReceive(
      taccount.receiveDepth + taccount.lookahead - 1
    );

    // next last address wallet will become aware of after receiving tx to
    // lookaheadReceive.
    const nextLookaheadReceive = taccount.deriveReceive(
      taccount.receiveDepth + (taccount.lookahead * 2) - 1
    );

    // in derivation order
    await sendMine([{
      outputs: [{
        value: 1e6,
        address: lookaheadReceive.getAddress().toString(network)
      }]
    }, {
      outputs: [{
        value: 1e6,
        address: nextLookaheadReceive.getAddress().toString(network)
      }]
    }]);

    const balance = await twallet.getBalance();

    // recover
    const rwallet = await wdb.create({
      id: TEST_RECOVER_ID,
      watchOnly: true,
      accountKey: xpub
    });

    await wdb.rescan(0);

    const recBalance = await rwallet.getBalance();
    assert.strictEqual(recBalance.tx, balance.tx);
    assert.strictEqual(recBalance.coin, balance.coin);
    assert.strictEqual(recBalance.unconfirmed, balance.unconfirmed);
    assert.strictEqual(recBalance.confirmed, balance.confirmed);
    assert.strictEqual(recBalance.ulocked, balance.ulocked);
    assert.strictEqual(recBalance.clocked, balance.clocked);
  });

  it('should recover lookahead gapped block (rev deriv order)', async () => {
    // TODO: add lookahead configuration back.
    // assert.strictEqual(taccount.lookahead, TEST_LOOKAHEAD);

    // last address wallet is aware of.
    const lookaheadReceive = taccount.deriveReceive(
      taccount.receiveDepth + taccount.lookahead - 1
    );

    // next last address wallet will become aware of after receiving tx to
    // lookaheadReceive.
    const nextLookaheadReceive = taccount.deriveReceive(
      taccount.receiveDepth + (taccount.lookahead * 2) - 1
    );

    // in derivation order
    await sendMine([{
      outputs: [{
        value: 1e6,
        address: nextLookaheadReceive.getAddress().toString(network)
      }]
    }, {
      outputs: [{
        value: 1e6,
        address: lookaheadReceive.getAddress().toString(network)
      }]
    }]);

    const balance = await twallet.getBalance();

    // recover
    const rwallet = await wdb.create({
      id: TEST_RECOVER_ID,
      watchOnly: true,
      accountKey: xpub
    });

    await wdb.rescan(0);

    const recBalance = await rwallet.getBalance();
    assert.strictEqual(recBalance.tx, balance.tx);
    assert.strictEqual(recBalance.coin, balance.coin);
    assert.strictEqual(recBalance.unconfirmed, balance.unconfirmed);
    assert.strictEqual(recBalance.confirmed, balance.confirmed);
    assert.strictEqual(recBalance.ulocked, balance.ulocked);
    assert.strictEqual(recBalance.clocked, balance.clocked);
  });
});
