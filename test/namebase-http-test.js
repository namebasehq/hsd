'use strict';

const { NodeClient, WalletClient } = require('namebase-hs-client');
const Network = require('../lib/protocol/network');
const FullNode = require('../lib/node/fullnode');

const NamebasePlugin = require('../lib/namebase');
const WalletPlugin = require('../lib/wallet/plugin');
const network = Network.get('regtest');
const assert = require('bsert');
const common = require('./util/common');

const node = new FullNode({
  network: 'regtest',
  apiKey: 'foo',
  walletAuth: true,
  memory: true,
  workers: true,
  plugins: [WalletPlugin, NamebasePlugin]
});

const nclient = new NodeClient({
  port: network.rpcPort,
  apiKey: 'foo'
});

const wclient = new WalletClient({
  port: network.walletPort,
  apiKey: 'foo'
});

const primaryWallet = wclient.wallet('primary');

let cbAddress;
let cb2Address;
const accountTwo = 'foobar';

const {
  treeInterval,
  biddingPeriod
} = network.names;

async function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

// take into account race conditions
async function mineBlocks(count, address) {
  for (let i = 0; i < count; i += 1) {
    const obj = { complete: false };
    node.once('block', () => {
      obj.complete = true;
    });
    await nclient.execute('generatetoaddress', [1, address]);
    await common.forValue(obj, 'complete', true);
  }
}

// create bid
function createBid(domainName, bid, idempotencyKey) {
  return {
    name: domainName,
    bid,
    lockup: bid + 1000000,
    idempotencyKey
  };
}

// create name with arbitrary number of bids
async function createNameWithBids(nclient, bidCount) {
  const domainName = await nclient.execute('grindname', [6]);
  const bids = [];
  const BaseBid = 10000000;

  for (let i = 0; i < bidCount; i += 1) {
    const idempotencyKey = domainName + i;
    bids.push(createBid(domainName, BaseBid + i, idempotencyKey));
  }

  return { domainName, bids };
}

// filter and return outputs of type
function getOutputsOfType(processedFinishes, type) {
  return processedFinishes
    .filter(element => element.output.covenant.action === type).map(element => element.output);
}

// eslint-disable-next-line prefer-arrow-callback
describe('Namebase Wallet HTTP', function () {
  this.timeout(8000);
  before(async () => {
    await node.open();
    await nclient.open();
    await wclient.open();

    await wclient.createWallet('secondary');
    cbAddress = (await primaryWallet.createAddress('default')).address;
    cb2Address = (await wclient.createAddress('secondary', 'default')).address;
    // fund secondary address
    await mineBlocks(2, cb2Address);
    await primaryWallet.createAccount(accountTwo);
  });

  after(async () => {
    await nclient.close();
    await wclient.close();
    await node.close();
  });

  beforeEach(async () => {
  });

  afterEach(async () => {
    await node.mempool.reset();
  });

  it('should create a batch open transaction (multiple outputs) for valid names', async () => {
    const NAMES_LEN = 200;
    const grindNameTasks = [];
    for (let i = 0; i < NAMES_LEN; i += 1) {
      grindNameTasks.push(nclient.execute('grindname', [5]));
    }

    const validNames = await Promise.all(grindNameTasks);

    await mineBlocks(treeInterval, cbAddress);

    const json = await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: validNames,
      sign: true,
      broadcast: true
    });

    const transaction = json.tx;
    const { errors } = json;

    await sleep(100);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(transaction.hash));
    assert.ok(errors.length === 0);
    assert.ok(transaction.outputs
      && transaction.outputs.length === NAMES_LEN + 1); // NAMES_LEN OPEN + 1 NONE
  });

  it('should create a batch open transaction (multiple outputs) for partially valid names', async () => {
    const name = await nclient.execute('grindname', [5]);
    const name2 = await nclient.execute('grindname', [5]);

    const singleOpenJson = await primaryWallet.createOpen({
      name,
      broadcast: true,
      sign: true
    });
    const firstNameHash = singleOpenJson.hash;

    const batchOpenJson = await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: [name, name2],
      sign: true,
      broadcast: true
    });

    const batchOpenTransaction = batchOpenJson.tx;
    const batchOpenTransactionHash = batchOpenTransaction.hash;
    const { errors } = batchOpenJson;

    await sleep(100);
    // tx should be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(firstNameHash));
    assert.ok(mempool.includes(batchOpenTransactionHash));

    assert.ok(errors.length === 1);
    assert.ok(batchOpenTransaction.outputs
      && batchOpenTransaction.outputs.length === 2); // 1 OPEN, 1 NONE
  });

  it('should reject a batch open transaction (multiple outputs) for names already open', async () => {
    const name = await nclient.execute('grindname', [5]);
    const name2 = await nclient.execute('grindname', [5]);

    await wclient.createBatchOpen('primary', {
      passphrase: '',
      names: [name, name2],
      sign: true,
      broadcast: true
    });

    await sleep(100);

    try {
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: [name, name2],
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    // valid tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 1);
  });

  it('should reject a batch open transaction (multiple outputs) for more than 200 names', async () => {
    try {
      const tooManyNames = [...Array(201).keys()];
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: tooManyNames,
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    // valid tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should reject a batch open transaction (multiple outputs) for invalid names', async () => {
    const invalidNames = ['长城', '大鸟'];

    try {
      await wclient.createBatchOpen('primary', {
        passphrase: '',
        names: invalidNames,
        sign: true,
        broadcast: true
      });
    } catch (err) {
      assert.ok(err);
    }

    await sleep(500);
    // tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should create a batch reveal transaction (multiple outputs) for partial valid names', async () => {
    await mineBlocks(2, cbAddress);

    const VALID_NAMES_LEN = 2;
    const grindNameTasks = [];
    for (let i = 0; i < VALID_NAMES_LEN; i += 1) {
      grindNameTasks.push(nclient.execute('grindname', [5]));
    }
    const validNames = await Promise.all(grindNameTasks);

    const INVALID_NAMES_LEN = 10;
    const invalidNames = [...Array(INVALID_NAMES_LEN).keys()];

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // TODO Promise.All is failing ?
    const numberOfBids = VALID_NAMES_LEN * 2;
    for (const domainName of validNames) {
      await primaryWallet.createBid({
        name: domainName,
        bid: 1000,
        lockup: 2000
      });
      await primaryWallet.createBid({
        name: domainName,
        bid: 1500,
        lockup: 2000
      });
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: [...validNames, ...invalidNames]
    });

    const { processedReveals, errors } = json;
    assert.ok(errors.length === INVALID_NAMES_LEN);

    await sleep(100);

    const mempool = await nclient.getMempool();

    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }
    assert.ok(processedReveals.length === numberOfBids);
  });

  it('should create a batch reveal transaction with an output limit of 200 (+1 for NONE)', async () => {
    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 105;
    const OUTPUT_LIMIT_EXCEEDING_NAMES_LEN = 5;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i += 1) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // TODO Promise.All is failing ?
    for (let i = 0; i < BID_COUNT; i++) {
      for (const domainName of validNames) {
        await primaryWallet.createBid({
          name: domainName,
          bid: 1000 + i,
          lockup: 2000
        });
      }
      await mineBlocks(1, cbAddress);
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames,
      sign: true,
      broadcast: true
    });

    const { processedReveals, errors } = json;

    assert.ok(errors.length === OUTPUT_LIMIT_EXCEEDING_NAMES_LEN);
    assert.ok(errors[0].name != null);

    await sleep(100);

    const mempool = await nclient.getMempool();
    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }

    const numberOfBids = (VALID_NAMES_LEN - OUTPUT_LIMIT_EXCEEDING_NAMES_LEN) * BID_COUNT;
    assert.ok(
      processedReveals.length === numberOfBids
    ); // BIDS LEN + 1 NONE
  });

  it('should not permit partially revealed domains', async () => {
    const VALID_NAMES_LEN = 5;
    const validNames = [];
    const BID_COUNT = 50;
    const MAX_REVEAL_COUNT = 200;
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await mineBlocks(1, cbAddress);
    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // using batch bids to speed up the test
    let bids = [];
    for (const domainName of validNames) {
      for (let i = 1; i <= BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: `${domainName}_${i}`
        });

        if (i % 50 === 0) {
          await wclient.createBatchBid('primary', {
            passphrase: '',
            bids
          });
          await mineBlocks(1, cbAddress);
          bids = [];
        }
      }
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    const { processedReveals, errors } = json;

    assert.ok(errors.length === 1);
    assert.ok(processedReveals.length === MAX_REVEAL_COUNT);

    await sleep(100);

    const mempool = await nclient.getMempool();
    for (const processedReveal of processedReveals) {
      assert.ok(mempool.includes(processedReveal.tx_hash));
    }
  });

  it('should respond from cache to repeated identical requests', async () => {
    const VALID_NAMES_LEN = 2;
    const validNames = [];
    const BID_COUNT = 50;
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [5]));
    }

    await mineBlocks(1, cbAddress);
    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // using batch bids to speed up the test
    let bids = [];
    for (const domainName of validNames) {
      for (let i = 1; i <= BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: `${domainName}_${i}`
        });

        if (i % 50 === 0) {
          await wclient.createBatchBid('primary', {
            passphrase: '',
            bids
          });
          await mineBlocks(1, cbAddress);
          bids = [];
        }
      }
    }

    await mineBlocks(biddingPeriod + 1, cbAddress);

    await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    await mineBlocks(1, cbAddress);

    const json = await wclient.post('/wallet/primary/batch/revealwithcache', {
      passphrase: '',
      names: validNames
    });

    const { processedReveals, errors } = json;

    assert.ok(errors.length === 0);
    assert.ok(processedReveals.length === BID_COUNT * VALID_NAMES_LEN);

    for (const processedReveal of processedReveals) {
      assert.ok(processedReveal.from_cache);
    }
  });

  it('should reject a batch reveal transaction (multiple outputs) for invalid names', async () => {
    const invalidNames = ['长城', '大鸟'];
    try {
      await wclient.createBatchRevealWithCache('primary', {
        passphrase: '',
        names: invalidNames
      });
    } catch (err) {
      assert.ok(err);
    }
    await sleep(500);
    // tx should not be in mempool
    const mempool = await nclient.getMempool();
    assert.ok(mempool.length === 0);
  });

  it('should return from cache when same idempotency_key is used in a bid request', async () => {
    await mineBlocks(5, cbAddress);

    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i = 0; i < BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: String(counter++)
        });
      }
    }

    const UNIQUE_BID_COUNT = 2;
    const TOTAL_BID_COUNT = VALID_NAMES_LEN * BID_COUNT;

    const uniqueBids = bids.splice(TOTAL_BID_COUNT - UNIQUE_BID_COUNT, UNIQUE_BID_COUNT);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    for (let i = 0; i < UNIQUE_BID_COUNT; i++) {
      bids.push(uniqueBids[i]);
    }

    // Duplicate request with UNIQUE_BID_COUNT unique bids at the end
    const { processedBids, errorMessages } = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    assert.ok(processedBids);
    assert.equal(errorMessages.length, 0);
    assert.equal(bids.length, TOTAL_BID_COUNT);

    const allFromCache = processedBids.every(element => element.fromCache === true);
    assert.equal(allFromCache, false);

    await sleep(100);

    const mempool = await nclient.getMempool();
    //
    const uniqueTxs = new Set();
    processedBids.forEach(bid => uniqueTxs.add(bid.tx_hash));
    // should have 2 unique transactions within
    assert.equal(uniqueTxs.size, 2);
    assert.equal(mempool.length, uniqueTxs.size);
    for (const txHash of uniqueTxs.values()) {
      assert.ok(mempool.includes(txHash));
    }
  });

  it('should create a batch bid transaction (multiple outputs) for valid names', async () => {
    const BID_COUNT = 2;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i = 0; i < BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: `key_${counter++}`
        });
      }
    }

    const { processedBids, errorMessages } = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    assert.ok(processedBids);
    assert.equal(errorMessages.length, 0);
    const expectedOutputCount = BID_COUNT * VALID_NAMES_LEN;
    assert.equal(bids.length, expectedOutputCount);

    await sleep(100);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(processedBids[0].tx_hash));
  });

  it('should reject a batch bid transaction that exceeds the total number of bid limit of 200 or not permitted 0 bid', async () => {
    const BID_COUNT = 4;
    const VALID_NAMES_LEN = 100;
    const validNames = [];
    for (let i = 0; i < VALID_NAMES_LEN; i++) {
      validNames.push(await nclient.execute('grindname', [6]));
    }

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    let counter = 0;
    for (const domainName of validNames) {
      for (let i = 0; i < BID_COUNT; i++) {
        bids.push({
          name: domainName,
          bid: 999 + i,
          lockup: 2000,
          idempotencyKey: String(counter++)
        });
      }
    }

    assert.rejects(async () => {
      await wclient.createBatchBid('primary', {
        passphrase: '',
        bids
      });
    });

    assert.rejects(async () => {
      await wclient.createBatchBid('primary', {
        passphrase: '',
        bids: []
      });
    });
  });

  it('should reject malformed/invalid finish requests', async () => {
    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: ['invalid_finish_data']
    }), /map must be a object./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: 'domain_name' }]
    }), /name and data must be present in every element./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: 'domain_name', data: 'invalid data' }]
    }), /data must be a object./);

    await assert.rejects(wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: 'domain_name', data: {} }]
    }), /Invalid records/);
  });

  it('should redeem lost bid and register won bids', async () => {
    const name1 = await nclient.execute('grindname', [6]);
    const name2 = await nclient.execute('grindname', [6]);
    const data = { records: [] };

    await wclient.createBatchOpen('primary', {
      names: [name1, name2],
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // wallet1(primary) wins name1, wallet2(secondary) wins name2
    const wallet1Name1WinningBidValue = 1000001;
    const wallet1Name1WinningBid = createBid(name1, wallet1Name1WinningBidValue, 'wallet-1-bid-1');

    const wallet1Name2LosingBidValue = 1000000;
    const wallet1Name2LosingBid = createBid(name2, wallet1Name2LosingBidValue, 'wallet-1-bid-2');

    const wallet2Name1LosingBidValue = 1000000;
    const wallet2Name1LosingBid = createBid(name1, wallet2Name1LosingBidValue, 'wallet-2-bid-1');

    const wallet2Name2WinningBidValue = 1000001;
    const wallet2Name2WinningBid = createBid(name2, wallet2Name2WinningBidValue, 'wallet-2-bid-2');

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: [wallet1Name1WinningBid, wallet1Name2LosingBid]
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchBid('secondary', {
      passphrase: '',
      bids: [wallet2Name1LosingBid, wallet2Name2WinningBid]
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchReveal('secondary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2 * treeInterval + 1, cbAddress);

    const wallet2Finish = await wclient.createBatchFinish('secondary', {
      passphrase: '',
      finishRequests: [{ name: name1, data }, { name: name2, data }]
    });

    assert.deepStrictEqual(wallet2Finish.errorMessages, []);
    assert.equal(wallet2Finish.processedFinishes.length, 2); // one redeem one finish

    const wallet2RedeemOutput = getOutputsOfType(wallet2Finish.processedFinishes, 'REDEEM')[0];
    const wallet2RegisterOutput = getOutputsOfType(wallet2Finish.processedFinishes, 'REGISTER')[0];

    assert.equal(wallet2RedeemOutput.value, wallet2Name1LosingBidValue);
    assert.equal(wallet2RegisterOutput.value, wallet1Name2LosingBidValue); // wickrey auction

    const wallet1Finish = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: name1, data }, { name: name2, data }]
    });

    const wallet1RedeemOutput = getOutputsOfType(wallet1Finish.processedFinishes, 'REDEEM')[0];
    const wallet1RegisterOutput = getOutputsOfType(wallet1Finish.processedFinishes, 'REGISTER')[0];

    assert.equal(wallet1RedeemOutput.value, wallet1Name2LosingBidValue);
    assert.equal(wallet1RegisterOutput.value, wallet2Name1LosingBidValue); // wickrey auction

    assert.deepStrictEqual(wallet1Finish.errorMessages, []);
    assert.equal(wallet1Finish.processedFinishes.length, 2);

    await sleep(100);

    const mempool = await nclient.getMempool();
    assert.ok(mempool.includes(wallet2Finish.processedFinishes[0].tx_hash));
    assert.ok(mempool.includes(wallet1Finish.processedFinishes[0].tx_hash));
  });

  it('should partially process names when total finish count exceeds 200', async () => {
    const BATCH_FINISH_LIMIT = 200;
    const NAME_BID_COUNT = 100;
    const { domainName: name1, bids: name1Bids } = await createNameWithBids(nclient, NAME_BID_COUNT);
    const { domainName: name2, bids: name2Bids } = await createNameWithBids(nclient, NAME_BID_COUNT);
    const { domainName: name3, bids: name3Bids } = await createNameWithBids(nclient, NAME_BID_COUNT);
    const data = { records: [] };

    await wclient.createBatchOpen('primary', {
      names: [name1, name2, name3],
      passphrase: ''
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: [...name1Bids, ...name2Bids]
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids: name3Bids
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    // we need to reveal 2 time since total amount exceeds 200 limit
    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name1, name2],
      sign: true,
      broadcast: true
    });

    await mineBlocks(1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [name3],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2 * treeInterval + 1, cbAddress);

    let processedFinishes;
    let errorMessages;

    const batchFinishResponsePart1 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: name1, data }, { name: name2, data }, { name: name3, data }]
    });

    processedFinishes = batchFinishResponsePart1.processedFinishes;
    errorMessages = batchFinishResponsePart1.errorMessages;

    assert.equal(processedFinishes.length, BATCH_FINISH_LIMIT);
    // 1 name is expected to fail
    assert.equal(errorMessages.length, 1);

    await sleep(100);

    let mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    await mineBlocks(1, cbAddress);

    const batchFinishResponsePart2 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: name1, data }, { name: name2, data }, { name: name3, data }]
    });

    processedFinishes = batchFinishResponsePart2.processedFinishes;
    errorMessages = batchFinishResponsePart2.errorMessages;

    await sleep(100);

    mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    assert.equal(processedFinishes.length, 3 * NAME_BID_COUNT);
    assert.equal(errorMessages.length, 0);
  });

  it('should respond from cache when same names are used for batchFinish', async () => {
    const NAME_BID_COUNT = 100;
    const data = { records: [] };

    const { domainName, bids } = await createNameWithBids(nclient, NAME_BID_COUNT);

    await wclient.createBatchOpen('primary', {
      names: [domainName],
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchBid('primary', {
      passphrase: '',
      bids,
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    await wclient.createBatchReveal('primary', {
      passphrase: '',
      names: [domainName],
      sign: true,
      broadcast: true
    });

    await mineBlocks(2 * treeInterval + 1, cbAddress);

    const batchFinishResponse1 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: domainName, data }]
    });

    assert.equal(batchFinishResponse1.errorMessages.length, 0);
    assert.equal(batchFinishResponse1.processedFinishes.length, NAME_BID_COUNT);

    for (const processedFinish of batchFinishResponse1.processedFinishes) {
      assert.equal(processedFinish.from_cache, false);
    }

    await sleep(100);

    let mempool = await nclient.getMempool();
    assert(mempool.length, 1);

    await mineBlocks(1, cbAddress);

    const batchFinishResponse2 = await wclient.createBatchFinish('primary', {
      passphrase: '',
      finishRequests: [{ name: domainName, data }]
    });

    assert.equal(batchFinishResponse2.errorMessages.length, 0);
    assert.equal(batchFinishResponse2.processedFinishes.length, NAME_BID_COUNT);

    await sleep(100);

    mempool = await nclient.getMempool();
    assert.equal(mempool.length, 0);

    for (const processedFinish of batchFinishResponse2.processedFinishes) {
      assert.equal(processedFinish.from_cache, true);
    }
  });

  it('should clear key from cache when requested', async () => {
    const validNames = [];
    const domainName = await nclient.execute('grindname', [6]);

    const cacheName = 'bid';
    const bidIdempotencyKey = 'idempotency_key';

    validNames.push(domainName);

    await mineBlocks(1, cbAddress);

    await wclient.createBatchOpen('primary', {
      names: validNames,
      passphrase: '',
      broadcast: true,
      sign: true
    });

    await mineBlocks(treeInterval + 1, cbAddress);

    const bids = [];
    bids.push({
      name: domainName,
      bid: 1000,
      lockup: 2000,
      idempotencyKey: bidIdempotencyKey
    });

    const initialBidResponse = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    assert(initialBidResponse.errorMessages.length === 0);
    assert(initialBidResponse.processedBids.length === 1);

    // repeat same request ensure response is from cache
    const secondBidResponse = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    assert(secondBidResponse.errorMessages.length === 0);
    assert(secondBidResponse.processedBids.length === 1);
    assert(secondBidResponse.processedBids[0].fromCache);

    await wclient.del(`/cache/${cacheName}/${bidIdempotencyKey}`);

    const thirdBidResponse = await wclient.createBatchBid('primary', {
      passphrase: '',
      bids
    });

    assert(thirdBidResponse.errorMessages.length === 0);
    assert(thirdBidResponse.processedBids.length === 1);
    assert(initialBidResponse.processedBids[0].tx_hash !== thirdBidResponse.processedBids[0].tx_hash);
  });
});
