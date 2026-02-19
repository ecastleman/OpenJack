import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIMABILITY_CONTRACT_VERSION,
  CLAIMABILITY_REASON,
  assertClaimabilityResponse,
  buildClaimabilityResponse,
} from "../../packages/shared/src/index.js";

test("claimability contract builds deterministic counters and reasons", () => {
  const response = buildClaimabilityResponse({
    wallet: "Wallet111",
    roundId: 42,
    roundStatus: 4,
    readinessReasons: [],
    estimatedLamports: 100,
    potentialLamports: 200,
    tickets: [
      {
        leafIndex: 1,
        tier: 0,
        amount: 100,
        readinessReasons: [],
      },
      {
        leafIndex: 2,
        tier: 1,
        amount: 100,
        readinessReasons: [CLAIMABILITY_REASON.PENDING_PROOF, CLAIMABILITY_REASON.OWNER_MISMATCH],
      },
    ],
  });

  assert.equal(response.contractVersion, CLAIMABILITY_CONTRACT_VERSION);
  assert.equal(response.winnerTickets, 2);
  assert.equal(response.claimableTickets, 1);
  assert.equal(response.nonClaimableWinnerTickets, 1);
  assert.deepEqual(response.nonClaimableReasonCounts, {
    OWNER_MISMATCH: 1,
    PENDING_PROOF: 1,
  });
  assert.equal(response.tickets[0].claimable, true);
  assert.equal(response.tickets[1].claimable, false);
});

test("claimability contract supports no-winner state without ambiguity", () => {
  const response = buildClaimabilityResponse({
    wallet: "Wallet111",
    roundId: 43,
    roundStatus: 4,
    readinessReasons: [CLAIMABILITY_REASON.NOT_WINNER],
    estimatedLamports: 0,
    potentialLamports: 0,
    tickets: [],
  });

  assert.equal(response.winnerTickets, 0);
  assert.equal(response.claimableTickets, 0);
  assert.deepEqual(response.readinessReasons, [CLAIMABILITY_REASON.NOT_WINNER]);
});

test("claimability contract rejects unknown reason enums", () => {
  assert.throws(() => {
    buildClaimabilityResponse({
      wallet: "Wallet111",
      roundId: 44,
      roundStatus: 4,
      readinessReasons: ["BAD_REASON"],
      estimatedLamports: 0,
      potentialLamports: 0,
      tickets: [],
    });
  }, /unknown_claimability_reason/);
});

test("claimability invariant guard rejects mismatched counts", () => {
  assert.throws(() => {
    assertClaimabilityResponse({
      contractVersion: CLAIMABILITY_CONTRACT_VERSION,
      wallet: "Wallet111",
      roundId: 1,
      roundStatus: 4,
      winnerTickets: 2,
      claimableTickets: 0,
      nonClaimableWinnerTickets: 2,
      estimatedLamports: 0,
      potentialLamports: 0,
      readinessReasons: [],
      nonClaimableReasonCounts: {},
      tickets: [
        {
          leafIndex: 1,
          tier: 0,
          amount: 10,
          claimable: true,
          readinessReasons: [],
        },
      ],
    });
  }, /winner_ticket_count_mismatch/);
});
