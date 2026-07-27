/**
 * Offline unit test — no network calls, no real keys, no signing, no broadcast.
 * Proves: for a genuine ADA "transfer" intent, if EdDSA MPCv2's recipient
 * reconstruction (txParamsFromIntent) fails to find recipients, the coin-level
 * verifyTransaction silently returns true with zero destination/amount checking —
 * whereas the ECDSA-equivalent guard (resolveEffectiveTxParams) would refuse to
 * proceed at all for the identical input.
 *
 * Run inside the cloned BitGoJS repo:
 *   cp this file to modules/sdk-coin-ada/test/unit/eddsaMPCv2-recipient-gap.ts
 *   cd modules/sdk-coin-ada && yarn mocha test/unit/eddsaMPCv2-recipient-gap.ts
 */
import should = require('should');
import * as _ from 'lodash';
import { TestBitGo, TestBitGoAPI } from '@bitgo/sdk-test';
import { BitGoAPI } from '@bitgo/sdk-api';
import { rawTx } from '../resources'; // real fixture already used by ada.ts tests
import { Ada, Tada } from '../../src';
import {
  resolveEffectiveTxParams,
  BaseTssUtils,
  TxRequest,
} from '@bitgo/sdk-core';

describe('EdDSA MPCv2 recipient-verification gap (ADA)', function () {
  let bitgo: TestBitGoAPI;
  let basecoin;

  // Real prebuild fixture: an actual signable transfer transaction, decoding to
  // two concrete outputs/amounts (see ada.ts's own txParams for the true recipients).
  const txPrebuild = {
    txHex: rawTx.unsignedTx,
    txInfo: {},
  };

  before(function () {
    bitgo = TestBitGo.decorate(BitGoAPI, { env: 'mock' });
    bitgo.initializeTestVars();
    bitgo.safeRegister('ada', Ada.createInstance);
    bitgo.safeRegister('tada', Tada.createInstance);
    basecoin = bitgo.coin('tada');
  });

  // ── Part 1: reproduce the exact call shape eddsaMPCv2.ts's signRequestBase
  // produces when params.txParams is falsy: `{ recipients: [] }`.
  it('[VULNERABLE] silently verifies true with empty recipients on a real transfer tx', async function () {
    const isVerified = await basecoin.verifyTransaction({
      txParams: { recipients: [] }, // <-- exact fallback from eddsaMPCv2.ts
      txPrebuild: _.cloneDeep(txPrebuild),
    });
    // No error, no mismatch detected — even though this tx has real, decodable
    // outputs that were never compared against anything.
    isVerified.should.equal(true);
  });

  // ── Part 2: control. Prove the check DOES work when recipients are supplied,
  // confirming Part 1 isn't just "ADA never checks anything."
  it('[CONTROL] rejects the same tx when explicit (wrong) recipients are supplied', async function () {
    const wrongTxParams = {
      recipients: [
        { address: '9f7b0675db59d19b4bd9c8c72eaabba75a9863d02b30115b8b3c3ca5c20f0254', amount: '1' },
      ],
    };
    await basecoin
      .verifyTransaction({ txParams: wrongTxParams, txPrebuild: _.cloneDeep(txPrebuild) })
      .should.be.rejectedWith('cannot find recipient in expected output');
  });

  // ── Part 3: root cause, one layer up. txParamsFromIntent has no type-based
  // gate — it returns undefined for ANY intent missing recipients, transfer or not.
  it('[ROOT CAUSE] txParamsFromIntent returns undefined for a transfer intent with no recipients', function () {
    const transferIntentMissingRecipients = {
      intentType: 'payment', // a genuine transfer intent, NOT in NO_RECIPIENT_TX_TYPES
      // recipients deliberately absent — simulates WP persisting an intent
      // without them, or any other reconstruction failure
    };
    const result = BaseTssUtils.txParamsFromIntent(transferIntentMissingRecipients, 'tada');
    should(result).equal(undefined);
    // This is exactly what feeds `params.txParams || { recipients: [] }`
    // in eddsaMPCv2.ts signRequestBase, reproducing Part 1's input.
  });

  // ── Part 4: the asymmetry. Feed the IDENTICAL fabricated data into the
  // ECDSA-side helper and show it refuses to proceed instead of silently passing.
  it('[ASYMMETRY] resolveEffectiveTxParams throws on the identical input ECDSA would face', function () {
    const txRequestMissingRecipients = {
      intent: {
        intentType: 'payment',
        // no recipients on the intent, same as Part 3
      },
    } as unknown as TxRequest;

    // Deliberately avoid should()'s .throw() matcher and `instanceof`.
    // In this monorepo the test may resolve a different copy of @bitgo/sdk-core
    // than the one that constructs the error, so instanceof can fail even when
    // the error is correct. Compare on name + message instead.
    let caught: Error | undefined;
    try {
      resolveEffectiveTxParams(txRequestMissingRecipients, undefined);
    } catch (e) {
      caught = e as Error;
    }

    should.exist(caught, 'expected resolveEffectiveTxParams to throw, but it returned normally');
    should(caught!.name).equal('InvalidTransactionError');
    should(caught!.message).match(/Recipient details are required to verify this transaction before signing/);
    // ECDSA's call site would never even reach verifyTransaction with this input —
    // it fails closed here. EdDSA MPCv2 has no equivalent gate before its
    // `params.txParams || { recipients: [] }` fallback.
  });
});
