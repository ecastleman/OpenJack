import test from "node:test";
import assert from "node:assert/strict";

import {
  CLAIMABILITY_CONTRACT_VERSION,
  CLAIMABILITY_REASON,
  assertClaimabilityResponse,
  buildClaimabilityResponse,
  UX_CLAIM_STATUS,
  assertReasonCoverage,
  deriveClaimSummaryUx,
  mapTicketClaimabilityToUx,
} from "../../packages/shared/src/index.js";

test("mapper enum coverage is complete", () => {
  const covered = assertReasonCoverage();
  console.log(`[mapper-coverage] reasons=${covered.join(",")}`);
  assert.equal(covered.length, Object.keys(CLAIMABILITY_REASON).length);
});

test("three-way distinction: no wins", () => {
  const payload = buildClaimabilityResponse({
    wallet: "walletA",
    roundId: 1,
    roundStatus: 4,
    tickets: [],
    estimatedLamports: 0,
    potentialLamports: 0,
    readinessReasons: [CLAIMABILITY_REASON.NOT_WINNER],
  });
  const summary = deriveClaimSummaryUx(payload);
  assert.equal(summary.state, UX_CLAIM_STATUS.NO_WINS);
  assert.equal(payload.winnerTickets, 0);
  assert.equal(payload.claimableTickets, 0);
});

test("three-way distinction: wins but not claimable", () => {
  const payload = buildClaimabilityResponse({
    wallet: "walletA",
    roundId: 2,
    roundStatus: 4,
    tickets: [
      {
        leafIndex: 5,
        tier: 2,
        amount: 10,
        readinessReasons: [CLAIMABILITY_REASON.PENDING_PROOF],
      },
    ],
    estimatedLamports: 0,
    potentialLamports: 10,
    readinessReasons: [],
  });
  const summary = deriveClaimSummaryUx(payload);
  assert.equal(payload.winnerTickets, 1);
  assert.equal(payload.claimableTickets, 0);
  assert.equal(summary.state, UX_CLAIM_STATUS.WINS_NOT_CLAIMABLE);
  const mapped = mapTicketClaimabilityToUx(payload.tickets[0]);
  assert.equal(mapped.status, "PENDING_PROOF");
});

test("three-way distinction: claimable now", () => {
  const payload = buildClaimabilityResponse({
    wallet: "walletA",
    roundId: 3,
    roundStatus: 4,
    tickets: [
      {
        leafIndex: 9,
        tier: 1,
        amount: 50,
        readinessReasons: [],
      },
    ],
    estimatedLamports: 50,
    potentialLamports: 50,
    readinessReasons: [],
  });
  const summary = deriveClaimSummaryUx(payload);
  assert.equal(payload.winnerTickets, 1);
  assert.equal(payload.claimableTickets, 1);
  assert.equal(summary.state, UX_CLAIM_STATUS.CLAIMABLE_NOW);
});

test("unknown readiness reason surfaces fallback state", () => {
  const payload = {
    contractVersion: CLAIMABILITY_CONTRACT_VERSION,
    wallet: "walletA",
    roundId: 4,
    roundStatus: 4,
    winnerTickets: 1,
    claimableTickets: 0,
    nonClaimableWinnerTickets: 1,
    estimatedLamports: 0,
    potentialLamports: 10,
    readinessReasons: ["SOME_NEW_REASON"],
    nonClaimableReasonCounts: {},
    tickets: [
      {
        leafIndex: 1,
        tier: 1,
        amount: 10,
        claimable: false,
        readinessReasons: ["SOME_NEW_REASON"],
      },
    ],
  };

  const summary = deriveClaimSummaryUx(payload);
  assert.equal(summary.state, UX_CLAIM_STATUS.UNKNOWN_REASON);

  const mapped = mapTicketClaimabilityToUx(payload.tickets[0]);
  assert.equal(mapped.status, "UNKNOWN_REASON");

  assert.throws(() => assertClaimabilityResponse(payload), /unknown_claimability_reason/);
});
