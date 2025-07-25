/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */
/* eslint no-return-assign: "off" */

'use strict';

const assert = require('bsert');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const Network = require('../lib/protocol/network');
const rules = require('../lib/covenants/rules');
const ownership = require('../lib/covenants/ownership');

const network = Network.get('regtest');
const {
  biddingPeriod,
  revealPeriod,
  transferLockup,
  treeInterval
} = network.names;
const NAME1 = rules.grindName(10, 20, network);
const NAME2 = rules.grindName(10, 20, network);

const workers = new WorkerPool({
  // Must be disabled for `ownership.ignore`.
  enabled: false
});

function createNode() {
  const chain = new Chain({
    memory: true,
    network,
    workers
  });

  const miner = new Miner({
    chain,
    workers
  });

  return {
    chain,
    miner,
    cpu: miner.cpu,
    wallet: () => {
      const wallet = new MemWallet({ network });

      chain.on('connect', (entry, block) => {
        wallet.addBlock(entry, block.txs);
      });

      chain.on('disconnect', (entry, block) => {
        wallet.removeBlock(entry, block.txs);
      });

      wallet.getNameStatus = async (nameHash) => {
        assert(Buffer.isBuffer(nameHash));
        const height = chain.height + 1;
        const state = await chain.getNextState();
        const hardened = state.hasHardening();
        return chain.db.getNameStatus(nameHash, height, hardened);
      };

      return wallet;
    }
  };
}

describe('Auction', function() {
  this.timeout(15000);

  describe('Vickrey Auction', function() {
    const node = createNode();
    const orig = createNode();
    const comp = createNode();

    const {chain, miner, cpu} = node;

    const winner = node.wallet();
    const runnerup = node.wallet();

    let snapshot = null;

    let transferBlock, transferLockupEnd, blocksUntilValidFinalize;

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(winner.getReceive());
      miner.addAddress(runnerup.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open auction', async () => {
      const mtx = await winner.createOpen(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine blocks', async () => {
      for (let i = 0; i < network.names.treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a bid', async () => {
      const mtx1 = await winner.createBid(NAME1, 1000, 2000);
      const mtx2 = await runnerup.createBid(NAME1, 500, 2000);

      const job = await cpu.createJob();
      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it(`should mine ${biddingPeriod} blocks`, async () => {
      for (let i = 0; i < biddingPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reveal a bid', async () => {
      const mtx1 = await winner.createReveal(NAME1);
      const mtx2 = await runnerup.createReveal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx1.toTX(), mtx1.view);
      job.addTX(mtx2.toTX(), mtx2.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it(`should mine ${revealPeriod} blocks`, async () => {
      for (let i = 0; i < revealPeriod; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a name', async () => {
      const mtx = await winner.createRegister(NAME1, Buffer.from([1,2,3]));

      assert(mtx.outputs.length > 0);

      // Should pay the second highest bid.
      assert.strictEqual(mtx.outputs[0].value, 500);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it(`should mine ${treeInterval} blocks`, async () => {
      for (let i = 0; i < treeInterval; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register again and update tree', async () => {
      const mtx = await winner.createUpdate(NAME1, Buffer.from([1,2,4]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should redeem', async () => {
      const mtx = await runnerup.createRedeem(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should renew', async () => {
      const mtx = await winner.createRenewal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should fail renew', async () => {
      const mtx = await winner.createRenewal(NAME1);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'bad-renewal-premature');
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }

      snapshot = {
        treeRoot: chain.tip.treeRoot,
        ns: await chain.db.getNameStateByName(NAME1)
      };
    });

    it('should open other nodes', async () => {
      await orig.chain.open();
      await orig.miner.open();
      await comp.chain.open();
      await comp.miner.open();
    });

    it('should clone the chain', async () => {
      for (let i = 1; i <= chain.height; i++) {
        const block = await chain.getBlock(i);
        assert(block);
        assert(await orig.chain.add(block));
      }
    });

    it('should mine a competing chain', async () => {
      while (comp.chain.tip.chainwork.lte(chain.tip.chainwork)) {
        const block = await comp.cpu.mineBlock();
        assert(block);
        assert(await comp.chain.add(block));
      }
    });

    it('should reorg the auction', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

      // chain.on('disconnect', async () => {
      //   const ns = await chain.db.getNameStateByName(NAME1);
      //   if (ns)
      //     console.log(ns.format(chain.height, network));
      // });

      for (let i = 1; i <= comp.chain.height; i++) {
        assert(!reorgd);
        const block = await comp.chain.getBlock(i);
        assert(block);
        assert(await chain.add(block));
      }

      assert(reorgd);

      const ns = await chain.db.getNameStateByName(NAME1);
      assert(!ns);
    });

    it('should reorg back to the correct state', async () => {
      let reorgd = false;

      chain.once('reorganize', () => reorgd = true);

      // chain.on('connect', async () => {
      //   const ns = await chain.db.getNameStateByName(NAME1);
      //   if (ns)
      //     console.log(ns.format(chain.height, network));
      // });

      while (!reorgd) {
        const block = await orig.cpu.mineBlock();
        assert(block);
        assert(await orig.chain.add(block));
        assert(await chain.add(block));
      }
    });

    it('should close other nodes', async () => {
      await orig.miner.close();
      await orig.chain.close();
      await comp.miner.close();
      await comp.chain.close();
    });

    it('should mine 10 blocks', async () => {
      for (let i = 0; i < 10; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should have the same DB state', async () => {
      const ns = await chain.db.getNameStateByName(NAME1);
      assert(ns);

      assert.deepStrictEqual(ns, snapshot.ns);
      assert.bufferEqual(chain.tip.treeRoot, snapshot.treeRoot);
    });

    it('should mine 2 blocks', async () => {
      for (let i = 0; i < 2; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open auction', async () => {
      const mtx = await winner.createOpen(NAME2);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should have the same DB root', async () => {
      assert((chain.height % network.names.treeInterval) !== 0);
      const root = chain.db.txn.rootHash();
      await chain.close();
      await chain.open();
      assert.bufferEqual(root, chain.db.txn.rootHash());
    });

    it('should not have transfer stats in JSON yet', async () => {
      const ns = await chain.db.getNameStateByName(NAME1);
      const {stats} = ns.getJSON(chain.height, network);
      assert.ok(stats.renewalPeriodStart);
      assert.ok(stats.renewalPeriodEnd);
      assert.ok(stats.blocksUntilExpire);
      assert.ok(stats.daysUntilExpire);
      assert.ok(!stats.transferLockupStart);
      assert.ok(!stats.transferLockupEnd);
      assert.ok(!stats.blocksUntilValidFinalize);
      assert.ok(!stats.hoursUntilValidFinalize);
    });

    it('should transfer a name', async () => {
      const mtx = await winner.createTransfer(NAME1, runnerup.getReceive());

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();
      const block = await job.mineAsync();
      const entry = await chain.add(block);
      assert(entry);
      transferBlock = entry.height;
    });

    it('should be in a transfer state', async () => {
      const ns = await chain.db.getNameStateByName(NAME1);
      assert.strictEqual(ns.transfer, transferBlock);
      assert(ns.transfer !== 0);
    });

    it('should have transfer stats', async () => {
      const ns = await chain.db.getNameStateByName(NAME1);
      const {stats} = ns.getJSON(chain.height, network);
      assert.ok(stats.renewalPeriodStart);
      assert.ok(stats.renewalPeriodEnd);
      assert.ok(stats.blocksUntilExpire);
      assert.ok(stats.daysUntilExpire);
      assert.ok(stats.transferLockupStart);
      assert.ok(stats.transferLockupEnd);
      assert.ok(stats.blocksUntilValidFinalize);
      assert.ok(stats.hoursUntilValidFinalize);

      // The height of the first block that can contain a valid FINALIZE
      transferLockupEnd = stats.transferLockupEnd;
      // The number of blocks (inclusive) until that height will be reached
      blocksUntilValidFinalize = stats.blocksUntilValidFinalize;
    });

    it('should finalize at expected height', async () => {
      const mtx = await winner.createFinalize(NAME1);

      // Attempt to confirm the FINALIZE in a block.
      // If it fails, mine an empty block instead.
      // Repeat until the chain height completes the
      // transfer lockup period and the FINALIZE is valid.
      let count = 0;
      let entry;
      for (;;) {
        try {
          const job = await cpu.createJob();
          job.addTX(mtx.toTX(), mtx.view);
          job.refresh();
          const block = await job.mineAsync();
          entry = await chain.add(block);

          // exit loop when FINALIZE is finally confirmed without error
          assert.strictEqual(block.txs.length, 2);
          count++;
          break;
        } catch(e) {
          assert.strictEqual(e.reason, 'bad-finalize-maturity');

          // Ok, fine - mine a block without the FINALIZE
          const job = await cpu.createJob();
          job.refresh();
          const block = await job.mineAsync();
          entry = await chain.add(block);

          // just a coinbase
          assert.strictEqual(block.txs.length, 1);

          count++;
        }
      }

      assert.strictEqual(count, blocksUntilValidFinalize);
      assert.strictEqual(entry.height, transferLockupEnd);
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });

  describe('Claim', function() {
    const node = createNode();
    const {chain, miner, cpu} = node;

    const wallet = node.wallet();
    const recip = node.wallet();

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();
    });

    it('should add addrs to miner', async () => {
      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should reject a fraudulent claim', async () => {
      const claim = await wallet.fakeClaim('cloudflare');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'mandatory-script-verify-flag-failed');
    });

    it('should open a claim for cloudflare.com', async () => {
      const claim = await wallet.fakeClaim('cloudflare');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should open a TLD claim for .fr', async () => {
      const claim = await wallet.fakeClaim('fr');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should mine to deflation height', async () => {
      assert(chain.height < network.deflationHeight - 2);

      while (chain.height < network.deflationHeight - 2) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should open a TLD claim for .nl', async () => {
      const claim = await wallet.fakeClaim('nl');

      assert(chain.height === network.deflationHeight - 2);

      const job = await cpu.createJob();
      const last = job.attempt.fees;

      job.pushClaim(claim, network);

      assert(job.attempt.fees === last + job.attempt.claims[0].fee);

      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should fail to replace TLD claim for .nl', async () => {
      const claim = await wallet.fakeClaim('nl', {
        rate: 2000,
        commitHeight: 2
      });

      assert(chain.height === network.deflationHeight - 1);

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      ownership.ignore = true;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      ownership.ignore = false;

      assert(err);
      assert.strictEqual(err.reason, 'bad-claim-value');
    });

    it('should reject a fee-redeeming coinbase for .nl', async () => {
      const claim = await wallet.fakeClaim('nl', {
        commitHeight: 2
      });

      assert(chain.height === network.deflationHeight - 1);

      const job = await cpu.createJob();
      const last = job.attempt.fees;

      job.pushClaim(claim, network);

      assert(job.attempt.fees === last);

      job.attempt.fees += job.attempt.claims[0].fee;
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      ownership.ignore = true;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      ownership.ignore = false;

      assert(err);
      assert.strictEqual(err.reason, 'bad-cb-amount');
    });

    it('should replace TLD claim for .nl', async () => {
      const claim = await wallet.fakeClaim('nl', {
        commitHeight: 2
      });

      assert(chain.height === network.deflationHeight - 1);

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    it('should open a TLD claim for .af', async () => {
      const claim = await wallet.fakeClaim('af');

      assert(chain.height === network.deflationHeight);

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });

    /*
    it('should open an i18n-ized TLD claim', async () => {
      const claim = await wallet.fakeClaim('xn--ogbpf8fl');

      const job = await cpu.createJob();
      job.pushClaim(claim, network);
      job.refresh();

      const block = await job.mineAsync();

      assert(block.txs.length > 0);
      assert(block.txs[0].outputs.length === 2);
      assert(block.txs[0].outputs[1].value === 0);

      try {
        ownership.ignore = true;
        assert(await chain.add(block));
      } finally {
        ownership.ignore = false;
      }
    });
    */

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a claimed name', async () => {
      const mtx = await wallet.createRegister('cloudflare', Buffer.from([1,2]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should mine 140 blocks', async () => {
      for (let i = 0; i < 140; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should register a claimed name', async () => {
      const mtx = await wallet.createRegister('af', Buffer.from([1,2,3]));

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should transfer strong name', async () => {
      const addr = recip.createReceive().getAddress();
      const mtx = await wallet.createTransfer('af', addr);

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should not be able to finalize early', async () => {
      const mtx = await wallet.createFinalize('af');

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      let err = null;

      try {
        await chain.add(block);
      } catch (e) {
        err = e;
      }

      assert(err);
      assert.strictEqual(err.reason, 'bad-finalize-maturity');
    });

    it(`should mine ${transferLockup} blocks`, async () => {
      for (let i = 0; i < transferLockup; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should finalize name', async () => {
      const mtx = await wallet.createFinalize('af');

      const job = await cpu.createJob();
      job.addTX(mtx.toTX(), mtx.view);
      job.refresh();

      const block = await job.mineAsync();

      assert(await chain.add(block));
    });

    it('should cleanup', async () => {
      await miner.close();
      await chain.close();
    });
  });

  describe('ICANNLOCKUP', function() {
    const BAK_CLAIM_PERIOD = network.names.claimPeriod;
    const BAK_ALEXA_PERIOD = network.names.alexaLockupPeriod;
    const TMP_CLAIM = 10;
    const TMP_ALEXA = 20;

    const rootNames = ['com', 'org', 'net'];
    const alexaNames = ['6pm', 'gnu', 'tor'];

    const node = createNode();
    const {chain, miner, cpu} = node;

    const wallet = node.wallet();

    before(() => {
      network.names.noRollout = true;
    });

    afterEach(() => {
      network.names.claimPeriod = BAK_CLAIM_PERIOD;
      network.names.alexaLockupPeriod = BAK_ALEXA_PERIOD;
    });

    after(() => {
      network.names.noRollout = false;
      network.names.noReserved = false;
    });

    it('should open chain and miner', async () => {
      await chain.open();
      await miner.open();

      miner.addresses.length = 0;
      miner.addAddress(wallet.getReceive());
    });

    it('should mine 20 blocks', async () => {
      for (let i = 0; i < 20; i++) {
        const block = await cpu.mineBlock();
        assert(block);
        assert(await chain.add(block));
      }
    });

    it('should fail to mine OPEN before ICANNLOCKUP', async () => {
      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const name of badNames) {
        // Trick wallet into creating mtx.
        network.names.noReserved = true;
        const mtx = await wallet.createOpen(name);
        network.names.noReserved = false;

        const job = await cpu.createJob();
        job.addTX(mtx.toTX(), mtx.view);
        job.refresh();

        const block = await job.mineAsync();

        let err = null;

        try {
          await chain.add(block);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.reason, 'bad-open-reserved');
      }
    });

    it('should fail to OPEN auction during alexaLockupPeriod', async () => {
      network.names.claimPeriod = TMP_CLAIM;

      const badNames = [
        ...rootNames,
        ...alexaNames
      ];

      for (const name of badNames) {
        const mtx = await wallet.createOpen(name);

        const job = await cpu.createJob();
        job.addTX(mtx.toTX(), mtx.view);
        job.refresh();

        const block = await job.mineAsync();

        let err = null;

        try {
          await chain.add(block);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.reason, 'bad-open-lockedup');
      }
    });

    it('should fail to OPEN root even after alexaLockupPeriod', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const name of rootNames) {
        const mtx = await wallet.createOpen(name);

        const job = await cpu.createJob();
        job.addTX(mtx.toTX(), mtx.view);
        job.refresh();

        const block = await job.mineAsync();

        let err = null;

        try {
          await chain.add(block);
        } catch (e) {
          err = e;
        }

        assert(err);
        assert.strictEqual(err.reason, 'bad-open-lockedup');
      }
    });

    it('should open alexa names after alexaLockupPeriod', async () => {
      network.names.claimPeriod = TMP_CLAIM;
      network.names.alexaLockupPeriod = TMP_ALEXA;

      for (const name of alexaNames) {
        const mtx = await wallet.createOpen(name);

        const job = await cpu.createJob();
        job.addTX(mtx.toTX(), mtx.view);
        job.refresh();

        const block = await job.mineAsync();
        const entry = await chain.add(block);
        assert(entry);
      }
    });
  });
});
