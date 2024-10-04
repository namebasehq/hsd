'use strict';

const assert = require('bsert');
const {states} = require('../lib/covenants/namestate');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const WalletDB = require('../lib/wallet/walletdb');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const Address = require('../lib/primitives/address');
const Output = require('../lib/primitives/output');
const Coin = require('../lib/primitives/coin');
const MTX = require('../lib/primitives/mtx');
const {Resource} = require('../lib/dns/resource');
const {forEvent} = require('./util/common');

const network = Network.get('regtest');
const NAME1 = rules.grindName(10, 2, network);
const {
  treeInterval,
  biddingPeriod,
  revealPeriod,
  transferLockup
} = network.names;

const workers = new WorkerPool({
  enabled: false,
  size: 2
});

const chain = new Chain({
  memory: true,
  network,
  workers
});

const miner = new Miner({
  chain,
  workers
});

const cpu = miner.cpu;

const wdb = new WalletDB({
  network: network,
  workers: workers
});

describe('Wallet Auction', function() {
  let wallet, wallet2;

  before(async () => {
    // Open
    await chain.open();
    await miner.open();
    await wdb.open();

    // Set up wallet
    wallet = await wdb.create();
    wallet2 = await wdb.create();
    chain.on('connect', async (entry, block) => {
      await wdb.addBlock(entry, block.txs);
    });

    chain.on('disconnect', async (entry) => {
      await wdb.removeBlock(entry);
    });

    wdb.getNameStatus = async (nameHash) => {
      return chain.db.getNameStatus(nameHash, chain.height + 1);
    };

    // Generate blocks to roll out name and fund wallet
    let winnerAddr = await wallet.createReceive();
    winnerAddr = winnerAddr.getAddress().toString(network);
    for (let i = 0; i < 10; i++) {
      const block = await cpu.mineBlock(null, winnerAddr);
      await chain.add(block);
    }
  });

  after(async () => {
    await wdb.close();
    await miner.close();
    await chain.close();
  });

  describe('Duplicate OPENs', function() {
    // Prepare several OPEN txs to mine them on the network.
    // Because they don't have any height, we can reuse them whenever
    // we want.
    const OPENS1 = 4;
    const openTXs = [];

    // block/mempool/confirm indexes
    let openIndex = 0;
    const insertIndexes = [];

    it('should open auction', async () => {
      for (let i = 0; i < OPENS1; i++) {
        const open = await wallet.createOpen(NAME1, false);
        await wallet.sign(open);

        assert.strictEqual(open.inputs.length, 1);
        // make sure we don't double spend.
        wallet.lockCoin(open.inputs[0].prevout);
        openTXs.push(open);
      }

      // This one will not get confirmed, but will be forever erased.
      insertIndexes[0] = openIndex;
      const openMTX = openTXs[openIndex++];
      const tx = openMTX.toTX();
      const addResult = await wdb.addTX(tx);
      assert.strictEqual(addResult.size, 1);
      assert.ok(addResult.has(wallet.wid));

      const pending = await wallet.getPending();
      assert.strictEqual(pending.length, 1);
      assert.bufferEqual(pending[0].hash, tx.hash());
    });

    it('should fail to create duplicate open', async () => {
      let err;
      try {
        await wallet.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
    });

    it('should not accept own duplicate open', async () => {
      const pendingBefore = await wallet.getPending();
      assert.strictEqual(pendingBefore.length, 1);
      assert.bufferEqual(pendingBefore[0].hash, openTXs[insertIndexes[0]].hash());

      const openMTX = openTXs[openIndex];
      const result = await wdb.addTX(openMTX.toTX());
      assert.strictEqual(result, null);

      const pendingAfter = await wallet.getPending();
      assert.strictEqual(pendingAfter.length, 1);
      assert.bufferEqual(pendingAfter[0].hash, openTXs[insertIndexes[0]].hash());
    });

    it('should mine 1 block with different OPEN tx', async () => {
      const job = await cpu.createJob();

      const removeEvents = forEvent(wdb, 'remove tx');

      insertIndexes[1] = openIndex;
      const openMTX = openTXs[openIndex++];

      const [tx, view] = openMTX.commit();
      job.addTX(tx, view);
      job.refresh();

      const block = await job.mineAsync();
      assert(await chain.add(block));

      const removedTXs = await removeEvents;
      assert.strictEqual(removedTXs.length, 1);
      const removedTX = removedTXs[0].values[1];
      assert.bufferEqual(removedTX.hash(), openTXs[0].hash());

      const pending = await wallet.getPending();
      assert.strictEqual(pending.length, 0);
    });

    it('should fail to re-open auction during OPEN phase', async () => {
      let err;
      try {
        await wallet.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Name is already opening: "${NAME1}".`);
    });

    it('should mine enough blocks to enter BIDDING phase', async () => {
      for (let i = 0; i < treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should fail to send bid to null address', async () => {
      const mtx = await wallet.makeBid(NAME1, 1000, 2000, 0);
      mtx.outputs[0].address = new Address();
      await wallet.fill(mtx);
      await wallet.finalize(mtx);

      const fn = async () => await wallet.sendMTX(mtx);

      await assert.rejects(fn, {message: 'Cannot send to null address.'});
    });

    it('should fail to re-open auction during BIDDING phase', async () => {
      let err;
      try {
        await wallet.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Name is not available: "${NAME1}".`);
    });

    it('should mine enough blocks to expire auction', async () => {
      for (let i = 0; i < biddingPeriod + revealPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open auction (again)', async () => {
      // This one will be inserted and THEN confirmed.
      insertIndexes[2] = openIndex;
      const mtx = openTXs[openIndex++];
      await wdb.addTX(mtx.toTX());
    });

    it('should fail to create duplicate open (again)', async () => {
      let err;
      try {
        await wallet.createOpen(NAME1, false);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Already sent an open for: ${NAME1}.`);
    });

    it('should confirm OPEN transaction', async () => {
      const job = await cpu.createJob();
      const [tx, view] = openTXs[insertIndexes[2]].commit();
      job.addTX(tx, view);
      job.refresh();

      const block = await job.mineAsync();
      assert(await chain.add(block));

      let ns = await chain.db.getNameStateByName(NAME1);
      let state = ns.state(chain.height, network);
      assert.strictEqual(state, states.OPENING);

      for (let i = 0; i < treeInterval + 1; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      ns = await chain.db.getNameStateByName(NAME1);
      state = ns.state(chain.height, network);
      assert.strictEqual(state, states.BIDDING);
    });

    it('should create TX spending change of the OPEN', async () => {
      // Last OPEN and spending change will be used for the test in
      // the pending index test.
      const lastOpenMTX = openTXs[insertIndexes[2]];
      const change = lastOpenMTX.outputs[1];
      assert.notStrictEqual(change.value, 0);

      // does not matter where this goes.
      const spendMTX = new MTX();

      spendMTX.outputs.push(new Output({
        value: 1e5,
        address: change.address
      }));

      const coin = Coin.fromTX(lastOpenMTX.toTX(), 1, wdb.height);
      await spendMTX.fund([coin], {
        changeAddress: await wallet.changeAddress()
      });

      // We don't mine this transaction and reuse this to make sure
      // double opens are properly removed.
      await wallet.sign(spendMTX);
      const added = await wdb.addTX(spendMTX.toTX());
      assert.strictEqual(added.size, 1);
    });

    it('should mine enough blocks to expire auction (again)', async () => {
      for (let i = 0; i < biddingPeriod + revealPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should insert OPEN into the block', async () => {
      // This makes sure the confirmed/mined TX does not get removed
      const job = await cpu.createJob();

      insertIndexes[3] = openIndex;
      const openMTX = openTXs[openIndex++];
      let countRemoves = 0;

      wdb.on('remove tx', () => {
        countRemoves++;
      });

      const [tx, view] = openMTX.commit();
      job.addTX(tx, view);
      job.refresh();

      const block = await job.mineAsync();
      assert(await chain.add(block));

      assert.strictEqual(countRemoves, 0);
    });

    it('should revert the two auctions and only leave one open', async () => {
      const pendingBefore = await wallet.getPending();
      assert.strictEqual(pendingBefore.length, 1);

      await wdb.rollback(biddingPeriod + revealPeriod + 2);
      const pendingAfter = await wallet.getPending();

      // first OPEN and tx spending from first OPEN should get removed.
      // This mimics the behaviour of the mempool where OPENs from the block
      // will end up getting removed, if there's OPEN sitting there.
      assert.strictEqual(pendingAfter.length, 1);

      const secondTX = await wallet.getTX(openTXs[insertIndexes[2]].hash());
      assert.strictEqual(secondTX, null);
    });

    it('should resync and recover', async () => {
      for (let i = wdb.height; i <= chain.tip.height; i++) {
        const entry = await chain.getEntryByHeight(i);
        const block = await chain.getBlock(entry.hash);
        await wdb.addBlock(entry, block.txs);
      }

      const secondTX = await wallet.getTX(openTXs[insertIndexes[2]].hash());
      assert.notStrictEqual(secondTX, null);
    });
  });

  // This affects linked ones mostly as they are guaranteed
  // to reselect the same inputs: REVEAL, REDEEM, REGISTER, UPDATE,
  // RENEW, TRANSFER, FINALIZE and REVOKE,
  describe('Duplicate Pending Requests', function() {
    const name1 = rules.grindName(10, 2, network);
    const name2 = rules.grindName(10, 2, network);
    const expectedError = name => `Credit is already pending for: "${name}".`;

    const mineBlock = async (txs = []) => {
      const job = await cpu.createJob();

      for (const tx of txs)
        job.pushTX(tx);

      job.refresh();

      const block = await job.mineAsync();
      assert(await chain.add(block));
    };

    const mineBlocks = async (n) => {
      for (let i = 0; i < n; i++)
        await mineBlock();
    };

    it('should get to the reveal', async () => {
      const open1 = await wallet.sendOpen(name1);
      const open2 = await wallet.sendOpen(name2);

      await mineBlock([open1, open2]);
      await mineBlocks(treeInterval);

      const bid11 = await wallet.sendBid(name1, 1000, 2000);
      const bid12 = await wallet.sendBid(name1, 1500, 2000);
      const bid21 = await wallet.sendBid(name2, 1000, 2000);
      const bid22 = await wallet.sendBid(name2, 1500, 2000);

      await mineBlock([bid11, bid12, bid21, bid22]);
      await mineBlocks(biddingPeriod);
    });

    it('should REVEAL and fail duplicate reveal', async () => {
      const reveal1 = await wallet.sendReveal(name1);
      assert(reveal1);
      const reveal2 = await wallet.sendReveal(name2);
      assert(reveal2);

      let err;
      try {
        await wallet.sendReveal(name1);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `No bids to reveal: "${name1}".`);

      await mineBlock([reveal1, reveal2]);

      err = null;

      try {
        await wallet.sendReveal(name2);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `No bids to reveal: "${name2}".`);

      await mineBlocks(revealPeriod);
    });

    it('should REDEEM and fail duplicate redeem', async () => {
      const redeem1 = await wallet.sendRedeem(name1);
      assert(redeem1);
      const redeem2 = await wallet.sendRedeem(name2);
      assert(redeem2);

      let err;
      try {
        await wallet.sendRedeem(name1);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `No reveals to redeem: "${name1}".`);

      await mineBlock([redeem1, redeem2]);

      err = null;

      try {
        await wallet.sendRedeem(name2);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `No reveals to redeem: "${name2}".`);
    });

    it('should REGISTER and fail duplicate register', async () => {
      const register = await wallet.sendUpdate(name1, Resource.fromString('name1.1'));
      assert(register);

      let err;
      try {
        await wallet.sendUpdate(name1, Resource.fromString('name1.2'));
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([register]);
    });

    it('should RAWREGISTER and fail duplicate register', async () => {
      const resourceHex = 'deadbeef';
      const register = await wallet.sendRawUpdate(name2, resourceHex);
      assert(register);

      let err;
      try {
        await wallet.sendRawUpdate(name2, resourceHex);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name2));

      await mineBlock([register]);

      // This becomes update.
      const update = await wallet.sendRawUpdate(name2, resourceHex);
      assert(update);

      await mineBlock([update]);
    });

    it('should UPDATE and fail duplicate UPDATE', async () => {
      const update = await wallet.sendUpdate(name1, Resource.fromString('name1.2'));
      assert(update);

      let err = null;
      try {
        await wallet.sendUpdate(name1, Resource.fromString('name1.3'));
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([update]);
    });

    it('should RAWUPDATE and fail duplicate UPDATE', async () => {
      const resourceHex = 'deadbeef';
      const update = await wallet.sendRawUpdate(name1, resourceHex);
      assert(update);

      let err = null;
      try {
        await wallet.sendRawUpdate(name1, resourceHex);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([update]);
    });

    it('should RENEW and fail duplicate RENEW', async () => {
      await mineBlocks(treeInterval + 1);
      const renew = await wallet.sendRenewal(name1);
      assert(renew);
      const renew2 = await wallet.sendRenewal(name2);
      assert(renew2);

      let err = null;
      try {
        await wallet.sendRenewal(name1);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([renew, renew2]);

      err = null;
      try {
        await wallet.sendRenewal(name2);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, `Must wait to renew: "${name2}".`);

      await mineBlocks(treeInterval + 1);
    });

    it('should TRANSFER and fail duplicate TRANSFER', async () => {
      const recv = await wallet2.receiveAddress();
      const transfer = await wallet.sendTransfer(name1, recv);
      assert(transfer);

      let err = null;
      try {
        await wallet.sendTransfer(name1, recv);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([transfer]);

      let err2 = null;
      try {
        await wallet.sendTransfer(name1, recv);
      } catch (e) {
        err2 = e;
      }

      assert(err2);
      assert.strictEqual(err2.message, `Name is already being transferred: "${name1}".`);

      await mineBlocks(transferLockup);
    });

    it('should FINALIZE and fail duplicate FINALIZE', async () => {
      const finalize = await wallet.sendFinalize(name1);
      assert(finalize);

      let err = null;
      try {
        await wallet.sendFinalize(name1);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name1));

      await mineBlock([finalize]);
    });

    it('should REVOKE and fail duplicate REVOKE', async () => {
      const revoke = await wallet.sendRevoke(name2);
      assert(revoke);

      let err = null;
      try {
        await wallet.sendRevoke(name2);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.message, expectedError(name2));

      await mineBlock([revoke]);
      await mineBlocks(10);
    });
  });

  describe('Wallet ICANNLOCKUP', function() {
    const BAK_CLAIM_PERIOD = network.names.claimPeriod;
    const BAK_ALEXA_PERIOD = network.names.alexaLockupPeriod;
    const TMP_CLAIM = 10;
    const TMP_ALEXA = 20;

    const rootNames = ['com', 'org', 'net'];
    const alexaNames = ['6pm', 'gnu', 'tor'];

    before(async () => {
      network.names.noRollout = true;

      const receive = await wallet.createReceive();
      const addr = receive.getAddress().toString(network);
      for (let i = 0; i < 30; i++) {
        const block = await cpu.mineBlock(null, addr);
        await chain.add(block);
      }
    });

    afterEach(() => {
      network.names.claimPeriod = BAK_CLAIM_PERIOD;
      network.names.alexaLockupPeriod = BAK_ALEXA_PERIOD;
    });

    after(() => {
      network.names.noRollout = false;
    });

    it('should fail to OPEN before ICANNLOCKUP', async () => {
      network.names.claimPeriod = 1000;
      network.names.alexaLockupPeriod = 2000;

      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const badName of badNames) {
        let err;
        try {
          await wallet.createOpen(badName, false);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, 'Name is reserved');
      }
    });

    it('should fail to OPEN auction during alexaLockupPeriod', async () => {
      // Claim period has ended, now they are locked up.
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = 2000;
      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const badName of badNames) {
        let err;
        try {
          await wallet.createOpen(badName, false);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, 'Name is locked up');
      }
    });

    it('should fail to OPEN root auction even after alexaLockupPeriod', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const rootName of rootNames) {
        let err;
        try {
          await wallet.createOpen(rootName, false);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, 'Name is locked up');
      }
    });

    it('should OPEN alexa names after alexa lockup period', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const alexaName of alexaNames) {
        const open = await wallet.createOpen(alexaName, false);
        await wallet.sign(open);
      }
    });

    it('should fail to BID before ICANNLOCKUP', async () => {
      network.names.claimPeriod = 1000;
      network.names.alexaLockupPeriod = 2000;

      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const badName of badNames) {
        let err;
        try {
          await wallet.createBid(badName, 1e6, 1e6);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, `Name is reserved: "${badName}".`);
      }
    });

    it('should fail to BID auction during alexaLockupPeriod', async () => {
      // Claim period has ended, now they are locked up.
      network.names.claimPeriod = TMP_CLAIM;

      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const badName of badNames) {
        let err;
        try {
          await wallet.createBid(badName, 1e6, 1e6);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, `Name is locked up: "${badName}"`);
      }
    });

    it('should fail to open root auction even after alexaLockupPeriod', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const rootName of rootNames) {
        let err;
        try {
          await wallet.createBid(rootName, 1e6, 1e6);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message, `Name is locked up: "${rootName}"`);
      }
    });

    it('should allow BID on alexa names after alexa lockup period', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const alexaName of alexaNames) {
        let err;
        try {
          await wallet.createBid(alexaName, 1e6, 1e6);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.message,
          `Name has not reached the bidding phase yet: "${alexaName}".`);
      }
    });
  });
});
