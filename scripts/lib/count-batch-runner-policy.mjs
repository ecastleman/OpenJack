export const DEFAULT_BASE_FEE_LAMPORTS = 10_000;
export const DEFAULT_EXPECTED_RETRIES = 1;
export const DEFAULT_FEE_MULTIPLIER_BPS = 13_000;
export const DEFAULT_MIN_NET_LAMPORTS = 0;
export const DEFAULT_FORCE_COMPLETE_REMAINING = 12;

const RETRYABLE_ERROR_CLASSES = new Set([
  "CountProgressGap",
  "CountReplayMismatch",
  "BlockhashNotFound",
  "NodeUnhealthy",
  "Timeout",
  "RateLimited",
  "ConfirmTimeout",
  "SendFailure",
  "PreflightFailure",
  "SimulationError",
  "SimulationInfraError",
  "TransactionExpiredBlockheightExceededError",
]);

const HARD_STOP_ERROR_CLASSES = new Set([
  "CountBatchTooLarge",
  "CountBatchMembershipInvalid",
  "CountBatchWorkMismatch",
  "CountBatchOutOfBounds",
  "ClientOffsetOutOfRange",
  "InstructionSerializationOutOfRange",
  "FreezeStateInvalid",
  "InvalidRoundState",
  "RoundSolvencyFloorViolated",
  "CountBatchBountyRentViolation",
  "CountBatchBountyRecipientInvalid",
  "TransactionTooLarge",
  "TxSizeGuardExceeded",
]);

export function estimateFeeLamports({
  baseFeeLamports = DEFAULT_BASE_FEE_LAMPORTS,
  expectedRetries = DEFAULT_EXPECTED_RETRIES,
  feeMultiplierBps = DEFAULT_FEE_MULTIPLIER_BPS,
}) {
  const retries = Math.max(1, Number(expectedRetries) || 1);
  const base = Math.max(0, Number(baseFeeLamports) || 0);
  const multiplier = Math.max(10_000, Number(feeMultiplierBps) || 10_000);
  return Math.ceil((base * retries * multiplier) / 10_000);
}

export function decideBatchSubmission({
  rewardEstimateLamports,
  feeEstimateLamports,
  remainingTickets,
  minNetLamports = DEFAULT_MIN_NET_LAMPORTS,
  forceCompleteRemaining = DEFAULT_FORCE_COMPLETE_REMAINING,
  forceCompleteEnabled = true,
}) {
  const reward = Math.max(0, Number(rewardEstimateLamports) || 0);
  const fee = Math.max(0, Number(feeEstimateLamports) || 0);
  const net = reward - fee;
  const remaining = Math.max(0, Number(remainingTickets) || 0);
  const minNet = Number(minNetLamports) || 0;
  const forceThreshold = Math.max(0, Number(forceCompleteRemaining) || 0);
  const force = Boolean(forceCompleteEnabled) && remaining > 0 && remaining <= forceThreshold;
  const submit = force || net >= minNet;
  const reason = force ? "force_complete" : submit ? "profitable" : "below_min_net";
  return { submit, reason, netEstimateLamports: net };
}

export function classifyRunnerError(errorClass) {
  const name = String(errorClass || "UnknownFailure");
  if (HARD_STOP_ERROR_CLASSES.has(name)) return "hard_stop";
  if (RETRYABLE_ERROR_CLASSES.has(name)) return "retryable";
  return "retryable";
}

export function extractErrorClass(error) {
  const text = String(error?.stack || error?.message || error || "");
  const lower = text.toLowerCase();
  const codeMatch = text.match(/Error Code:\s*([A-Za-z0-9_]+)/);
  if (codeMatch?.[1]) return codeMatch[1];
  const programMatch = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (programMatch?.[1]) return `Custom(0x${programMatch[1]})`;
  if (
    lower.includes("node is unhealthy") ||
    lower.includes("nodeunhealthy") ||
    lower.includes("upstream unhealthy")
  ) {
    return "NodeUnhealthy";
  }
  if (
    lower.includes("blockhash not found") ||
    lower.includes("blockhashnotfound") ||
    lower.includes("transactionexpiredblockheightexceedederror")
  ) {
    return "BlockhashNotFound";
  }
  if (lower.includes("transaction too large") || lower.includes("packet too large")) {
    return "TransactionTooLarge";
  }
  if (lower.includes("value of \"offset\" is out of range") || lower.includes("received 1000")) {
    return "ClientOffsetOutOfRange";
  }
  if (lower.includes("simulation failed")) return "SimulationError";
  if (text.includes("Timeout")) return "Timeout";
  if (text.includes("429") || text.includes("Too Many Requests") || text.includes("Rate limit")) return "RateLimited";
  if (text.includes("SendTransactionError")) return "SendFailure";
  if (text.includes("Simulation failed")) return "PreflightFailure";
  if (text.includes("Blockhash")) return "BlockhashNotFound";
  if (text.includes("TransactionExpired")) return "TransactionExpiredBlockheightExceededError";
  return "UnknownFailure";
}

function sanitize(raw) {
  return String(raw || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w:.,=+\-()[\]{}]/g, "")
    .slice(0, 220);
}

export function extractErrorSurface(error, stage = "unknown") {
  const text = String(error?.stack || error?.message || error || "");
  const lower = text.toLowerCase();
  let rpcCode = null;
  const errObjCode = Number(error?.code);
  if (Number.isFinite(errObjCode)) rpcCode = errObjCode;
  const rpcCodeMatch = text.match(/\b(code|status)\s*[:=]\s*(-?\d{1,6})/i);
  if (rpcCodeMatch?.[2]) rpcCode = Number(rpcCodeMatch[2]);
  if (rpcCode == null && (text.includes("429") || text.includes("Too Many Requests"))) rpcCode = 429;

  let className = extractErrorClass(error);
  if (rpcCode === 429) className = "RateLimited";
  if (
    lower.includes("node is unhealthy") ||
    lower.includes("nodeunhealthy") ||
    lower.includes("upstream unhealthy")
  ) {
    className = "NodeUnhealthy";
  }
  if (lower.includes("blockhash not found")) className = "BlockhashNotFound";
  if (lower.includes("transaction too large") || lower.includes("packet too large")) className = "TransactionTooLarge";
  if (lower.includes("value of \"offset\" is out of range") || lower.includes("received 1000")) {
    className = "ClientOffsetOutOfRange";
  }
  if (stage === "preflight" && lower.includes("invalid arguments")) className = "SimulationError";
  if (stage === "preflight" && className === "UnknownFailure") className = "SimulationInfraError";
  if (stage === "send" && className === "UnknownFailure") className = "SendFailure";
  if (stage === "confirm" && className === "Timeout") className = "ConfirmTimeout";

  const message = sanitize(error?.message || text.split("\n")[0] || "UnknownFailure");
  return {
    className,
    rpcCode,
    message,
    stage,
  };
}
