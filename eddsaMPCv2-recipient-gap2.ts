/**
 * SOL counterpart to eddsaMPCv2-recipient-gap.ts (ADA).
 *
 * Offline unit test — no network calls, no real keys, no signing, no broadcast.
 *
 * PURPOSE: SOL is also an EdDSA MPCv2 coin, so it receives the same
 * `params.txParams || { recipients: [] }` fallback from
 * EddsaMPCv2Utils.signRequestBase. This test establishes whether SOL's
 * coin-level verifier fails OPEN (like ADA) or CLOSED on that input.
 *
 * EXPECTED RESULT (predicted from source): SOL fails CLOSED. Its verifier
 * compares recipient count against decoded output count, so 0 !== 1 throws.
 * If Part 1 instead returns true, SOL shares ADA's fail-open defect and the
 * finding is broader than currently scoped.
 *
 * Run inside the cloned BitGoJS repo:
 *   cp this file to modules/sdk-coin-sol/test/unit/solEddsaMPCv2-recipient-gap.ts
 *   cd modules/sdk-coin-sol && yarn mocha test/unit/solEddsaMPCv2-recipient-gap.ts
 */
import * as should from 'should';
import * as _ from 'lodash';
import { TestBitGo, TestBitGoAPI } from '@bitgo/sdk-test';
import { BitGoAPI } from '@bitgo/sdk-api';
import { Wallet } from '@bitgo/sdk-core';
import { KeyPair, Sol, Tsol } from '../../src';
import * as resources from '../resources/sol';

describe('EdDSA MPCv2 recipient-verification gap — SOL comparison', function () {
  let bitgo: TestBitGoAPI;
  let basecoin: Sol;
  let walletObj: Wallet;

  // Real fixture already used by sol.ts's own tests: a native transfer with
  // memo + durable nonce, decoding to exactly ONE output.
  const txPrebuild = {
    recipients: [{ address: 'lionteste212', amount: '1000' }],
    txBase64: resources.TRANSFER_UNSIGNED_TX_WITH_MEMO_AND_DURABLE_NONCE,
    txInfo: {
      feePayer: '5hr5fisPi6DXNuuRpm5XUbzpiEnmdyxXuBDTwzwZj5Pe',
      nonce: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
    },
    txid: '586c5b59b10b134d04c16ac1b273fe3c5529f34aef75db4456cd469c5cdac7e2',
    isVotingTransaction: false,
    coin: 'tsol',
  };

  // The fixture embeds a memo and durable nonce; SOL's verifier checks both,
  // so they must be supplied or tests fail for unrelated reasons.
  const memo = { value: 'test memo' };
  const durableNonce = {
    walletNonceAddress: '8Y7RM6JfcX4ASSNBkrkrmSbRu431YVi9Y3oLFnzC2dCh',
    authWalletAddress: '5hr5fisPi6DXNuuRpm5XUbzpiEnmdyxXuBDTwzwZj5Pe',
  };

  // The genuine recipient this transaction actually pays.
  const correctRecipients = [{ address: 'CP5Dpaa42RtJmMuKqCQsLwma5Yh3knuvKsYDFX85F41S', amount: '300000' }];

  before(function () {
    bitgo = TestBitGo.decorate(BitGoAPI, { env: 'mock' });
    bitgo.safeRegister('sol', Tsol.createInstance);
    bitgo.safeRegister('tsol', Tsol.createInstance);
    bitgo.initializeTestVars();
    basecoin = bitgo.coin('tsol') as Tsol;

    const wallet = new KeyPair(resources.authAccount).getKeys();
    walletObj = new Wallet(bitgo, basecoin, {
      id: '5b34252f1bf349930e34020a00000000',
      coin: 'tsol',
      keys: ['5b3424f91bf349930e34017500000000', '5b3424f91bf349930e34017600000000', '5b3424f91bf349930e34017700000000'],
      coinSpecific: { rootAddress: wallet.pub },
      multisigType: 'tss',
    });
  });

  // ── Part 1: the decisive comparison. Feed SOL the EXACT fallback value
  // that eddsaMPCv2.ts signRequestBase produces — the same input that makes
  // ADA silently return true.
  it('[FAIL-CLOSED?] rejects the empty-recipients fallback instead of silently passing', async function () {
    await basecoin
      .verifyTransaction({
        txParams: { recipients: [] }, // <-- identical to ADA Part 1
        txPrebuild: _.cloneDeep(txPrebuild),
        memo,
        durableNonce,
        wallet: walletObj,
      } as any)
      .should.be.rejectedWith('Number of tx outputs does not match with number of txParams recipients');
    // Mechanism: txParams.recipients !== undefined passes (an empty array is
    // not undefined), so SOL proceeds to the count comparison:
    // filteredRecipients.length (0) !== filteredOutputs.length (1) -> throws.
    // ADA has no count comparison; it loops over recipients, so an empty array
    // means zero iterations and an unconditional `return true`.
  });

  // ── Part 2: control. Prove the verifier accepts the transaction when the
  // real recipients ARE supplied, so Part 1 is a genuine rejection and not a
  // fixture/memo/nonce problem.
  it('[CONTROL] accepts the same tx when the correct recipients are supplied', async function () {
    const isVerified = await basecoin.verifyTransaction({
      txParams: { recipients: _.cloneDeep(correctRecipients) },
      txPrebuild: _.cloneDeep(txPrebuild),
      memo,
      durableNonce,
      wallet: walletObj,
    } as any);
    isVerified.should.equal(true);
  });

  // ── Part 3: control. Wrong recipients are rejected on the merits, not just
  // on count. Confirms verification is substantive, not arity-only.
  it('[CONTROL] rejects a recipient whose address does not match the tx output', async function () {
    await basecoin
      .verifyTransaction({
        txParams: {
          // Correct arity (1), wrong destination — bypasses the count check
          // and must be caught by the address comparison instead.
          recipients: [{ address: 'CP5Dpaa42mMuKqCQsLwma5Yh3knuvKsYDFX85F41S', amount: '300000' }],
        },
        txPrebuild: _.cloneDeep(txPrebuild),
        memo,
        durableNonce,
        wallet: walletObj,
      } as any)
      .should.be.rejected();
  });

  // ── Part 4: the OTHER fail-open shape, documented for completeness.
  // SOL gates its entire recipient block on `txParams.recipients !== undefined`.
  // An empty array clears that gate (hence Part 1 throwing), but a genuinely
  // ABSENT recipients field skips recipient verification altogether.
  // This is NOT the condition signRequestBase produces — it emits `[]`, not
  // undefined — so it is not the reported vulnerability. It is recorded here
  // because it means SOL's fail-closed behavior depends on the fallback
  // continuing to use `[]`; a future refactor emitting `undefined` instead
  // would silently convert SOL to fail-open.
  it('[LATENT] absent recipients field skips recipient verification entirely', async function () {
    const isVerified = await basecoin.verifyTransaction({
      txParams: {}, // recipients absent, not empty
      txPrebuild: _.cloneDeep(txPrebuild),
      memo,
      durableNonce,
      wallet: walletObj,
    } as any);
    // Documents current behavior: returns true without comparing recipients.
    // Consolidation flows rely on this (server generates recipients), which is
    // why the gate exists — but it is one refactor away from mattering.
    isVerified.should.equal(true);
  });
});