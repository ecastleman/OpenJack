import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

import { fetchActiveRound, fetchClaimEstimate, fetchRoundIngestionStatus, prepareBuyTx } from "./api";
import type { ClaimEstimate, Round, RoundIngestionStatus } from "./types";
import { UX_CLAIM_STATUS, assertReasonCoverage, deriveClaimSummaryUx, mapTicketClaimabilityToUx } from "./claimabilityMapper";
import { runPreparedTxFlow } from "./buyFlow.js";

type RouteTab = "home" | "buy" | "tickets";
type WalletTxState = "IDLE" | "SIGNING" | "PENDING" | "CONFIRMED" | "FAILED";
type WalletConnectivity = "DISCONNECTED" | "CONNECTED" | "WRONG_NETWORK";

const REQUIRED_CLUSTER = String(import.meta.env.VITE_REQUIRED_CLUSTER || "devnet").toLowerCase();
const API_BASE_RAW = String(import.meta.env.VITE_API_BASE || "http://localhost:8080");

const GENESIS_CLUSTER_MAP: Record<string, string> = {
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1: "devnet",
  "4uhcVJyU9pJKvQyS88uRDiswHXSCkY3z": "testnet",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "mainnet-beta",
};

function lamportsToSol(lamports: number): string {
  return (Number(lamports || 0) / 1_000_000_000).toFixed(4);
}

function shortPk(pk: string): string {
  if (!pk) return "";
  return `${pk.slice(0, 4)}...${pk.slice(-4)}`;
}

function clusterLabel(cluster: string | null): string {
  if (!cluster) return "unknown";
  return cluster;
}

function sanitizeApiBase(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return trimmed.split("?")[0];
  }
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    ROUND_NOT_FINALIZED: "Round not finalized",
    NOT_WINNER: "Not a winner",
    PENDING_PROOF: "Winner proof pending",
    PROOF_FAILED: "Winner proof failed",
    ALREADY_CLAIMED: "Already claimed",
    OWNER_MISMATCH: "Ticket owner mismatch",
    PAYOUT_NOT_READY_OR_ZERO: "Payout unavailable",
    INGESTION_NOT_READY: "Ingestion not ready",
  };
  return labels[reason] || `Unknown reason: ${reason}`;
}

function Badge({ text }: { text: string }) {
  return <span className="rounded-full border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] px-2 py-0.5 text-xs text-[var(--oj-text-muted)]">{text}</span>;
}

function statusToneClass(tone: "neutral" | "ok" | "warn" | "danger"): string {
  if (tone === "ok") return "border-[var(--oj-ok)]/40 bg-[var(--oj-ok)]/10 text-[var(--oj-ok)]";
  if (tone === "warn") return "border-[var(--oj-warn)]/40 bg-[var(--oj-warn)]/10 text-[var(--oj-warn)]";
  if (tone === "danger") return "border-[var(--oj-danger)]/40 bg-[var(--oj-danger)]/10 text-[var(--oj-danger)]";
  return "border-[var(--oj-border)] bg-[var(--oj-bg-elev)] text-[var(--oj-text-muted)]";
}

function walletConnectivityMeta(connectivity: WalletConnectivity): { label: string; detail: string; tone: "neutral" | "ok" | "warn" } {
  if (connectivity === "CONNECTED") {
    return { label: "Connected", detail: "Wallet connected and network accepted.", tone: "ok" };
  }
  if (connectivity === "WRONG_NETWORK") {
    return { label: "Wrong Network", detail: `Switch wallet/RPC to ${REQUIRED_CLUSTER}.`, tone: "warn" };
  }
  return { label: "Disconnected", detail: "Connect wallet to view ticket claimability.", tone: "neutral" };
}

function walletTxMeta(state: WalletTxState): { label: string; detail: string; tone: "neutral" | "ok" | "warn" | "danger" } {
  if (state === "SIGNING") {
    return { label: "Signing", detail: "Awaiting wallet signature.", tone: "warn" };
  }
  if (state === "PENDING") {
    return { label: "Pending", detail: "Transaction submitted, awaiting confirmation.", tone: "warn" };
  }
  if (state === "CONFIRMED") {
    return { label: "Confirmed", detail: "Last transaction confirmed.", tone: "ok" };
  }
  if (state === "FAILED") {
    return { label: "Failed", detail: "Last transaction failed. Retry when ready.", tone: "danger" };
  }
  return { label: "Idle", detail: "No transaction in progress.", tone: "neutral" };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodePreparedTransaction(base64: string): Transaction | VersionedTransaction {
  const raw = base64ToBytes(base64);
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function confirmSignatureByPolling(
  connection: ReturnType<typeof useConnection>["connection"],
  signature: string,
  { timeoutMs = 45_000, pollMs = 800 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = statuses?.value?.[0] ?? null;
    if (status?.err) {
      throw new Error(`confirm_err=${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("RPC confirmation timeout");
}

function parseManualTicket(mainInput: string, bonusInput: string): { main: number[]; bonus: number } {
  const main = String(mainInput || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  if (main.length !== 5) {
    throw new Error("Enter exactly 5 main numbers.");
  }
  const uniqueMain = Array.from(new Set(main));
  if (uniqueMain.length !== 5) {
    throw new Error("Main numbers must be unique.");
  }
  const mainInRange = uniqueMain.every((value) => value >= 1 && value <= 50);
  if (!mainInRange) {
    throw new Error("Main numbers must be between 1 and 50.");
  }
  const bonus = Number(String(bonusInput || "").trim());
  if (!Number.isInteger(bonus) || bonus < 1 || bonus > 10) {
    throw new Error("Bonus must be an integer between 1 and 10.");
  }
  return { main: uniqueMain.sort((a, b) => a - b), bonus };
}

function classifyBuyError(error: unknown): { userMessage: string; retryable: boolean } {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();
  if (
    message.includes("insufficient funds") ||
    message.includes("insufficient lamports") ||
    message.includes("custom program error: 0x1")
  ) {
    return { userMessage: "Insufficient funds to buy ticket(s).", retryable: false };
  }
  if (
    message.includes("user rejected") ||
    message.includes("rejected the request") ||
    message.includes("declined") ||
    message.includes("cancelled")
  ) {
    return { userMessage: "Signature request was rejected in wallet.", retryable: true };
  }
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("blockhash not found") ||
    message.includes("failed to fetch") ||
    message.includes("429") ||
    message.includes("node is behind")
  ) {
    return { userMessage: "RPC timeout or send failure. Retry the buy action.", retryable: true };
  }
  return { userMessage: raw || "Buy transaction failed.", retryable: true };
}

function explorerTxUrl(signature: string, cluster: string | null): string {
  const activeCluster = cluster && cluster !== "unknown" ? cluster : REQUIRED_CLUSTER;
  const suffix = activeCluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(activeCluster)}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

export function App() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [route, setRoute] = useState<RouteTab>("home");
  const [round, setRound] = useState<Round | null>(null);
  const [claim, setClaim] = useState<ClaimEstimate | null>(null);
  const [ingestion, setIngestion] = useState<RoundIngestionStatus | null>(null);
  const [ingestionError, setIngestionError] = useState<string>("");
  const [apiError, setApiError] = useState<string>("");
  const [homeError, setHomeError] = useState<string>("");
  const [ticketsError, setTicketsError] = useState<string>("");
  const [buyError, setBuyError] = useState<string>("");
  const [buySuccess, setBuySuccess] = useState<string>("");
  const [buySignature, setBuySignature] = useState<string>("");
  const [buyUseQuickPick, setBuyUseQuickPick] = useState<boolean>(true);
  const [buyMainInput, setBuyMainInput] = useState<string>("1,2,3,4,5");
  const [buyBonusInput, setBuyBonusInput] = useState<string>("1");
  const [loading, setLoading] = useState<boolean>(true);
  const [detectedCluster, setDetectedCluster] = useState<string | null>(null);
  const [walletTxState, setWalletTxState] = useState<WalletTxState>("IDLE");

  const walletAddress = useMemo(() => wallet.publicKey?.toBase58() || "", [wallet.publicKey]);
  const [walletConnectivity, setWalletConnectivity] = useState<WalletConnectivity>("DISCONNECTED");
  const apiBaseDisplay = useMemo(() => sanitizeApiBase(API_BASE_RAW), []);

  const claimUxSummary = useMemo(() => {
    if (!claim) return null;
    return deriveClaimSummaryUx(claim);
  }, [claim]);
  const connectivityMeta = useMemo(() => walletConnectivityMeta(walletConnectivity), [walletConnectivity]);
  const txMeta = useMemo(() => walletTxMeta(walletTxState), [walletTxState]);

  useEffect(() => {
    // CI/runtime guard for contract-drift risk in mapper coverage.
    assertReasonCoverage();
  }, []);

  useEffect(() => {
    let alive = true;
    connection
      .getGenesisHash()
      .then((hash) => {
        if (!alive) return;
        setDetectedCluster(GENESIS_CLUSTER_MAP[hash] || "unknown");
      })
      .catch(() => {
        if (!alive) return;
        setDetectedCluster("unknown");
      });
    return () => {
      alive = false;
    };
  }, [connection]);

  useEffect(() => {
    if (!wallet.connected || !walletAddress) {
      setWalletConnectivity("DISCONNECTED");
      return;
    }
    if (detectedCluster && detectedCluster !== "unknown" && detectedCluster !== REQUIRED_CLUSTER) {
      setWalletConnectivity("WRONG_NETWORK");
      return;
    }
    setWalletConnectivity("CONNECTED");
  }, [wallet.connected, walletAddress, detectedCluster]);

  async function refreshAll() {
    setLoading(true);
    setApiError("");
    setHomeError("");
    setTicketsError("");
    try {
      const active = await fetchActiveRound();
      setRound(active);
      if (active && walletAddress) {
        try {
          const [estimate] = await Promise.all([fetchClaimEstimate(active.roundId, walletAddress)]);
          setClaim(estimate);
          setTicketsError("");
        } catch (error) {
          setClaim(null);
          setTicketsError(error instanceof Error ? error.message : String(error));
        }
      } else {
        setClaim(null);
      }
      if (active) {
        try {
          const ingest = await fetchRoundIngestionStatus(active.roundId);
          setIngestion(ingest);
          setIngestionError("");
        } catch (error) {
          setIngestion(null);
          setIngestionError(error instanceof Error ? error.message : String(error));
        }
      } else {
        setIngestion(null);
        setIngestionError("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setApiError(message);
      setHomeError(message);
      if (walletAddress) setTicketsError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress]);

  const protectedRoute = route === "tickets" || route === "buy";
  const routeBlocked = protectedRoute && walletConnectivity !== "CONNECTED";

  async function runBuyFlow() {
    if (!walletAddress || !wallet.connected) {
      setBuyError("Connect wallet to buy tickets.");
      return;
    }
    if (!round?.roundId) {
      setBuyError("No active round available for buy.");
      return;
    }
    if (!wallet.signTransaction) {
      setBuyError("Connected wallet does not support signing transactions.");
      return;
    }

    setBuyError("");
    setBuySuccess("");
    setBuySignature("");
    setWalletTxState("IDLE");

    try {
      const result = await runPreparedTxFlow({
        prepare: async () => {
          const ticket = buyUseQuickPick ? undefined : parseManualTicket(buyMainInput, buyBonusInput);
          return prepareBuyTx(walletAddress, round.roundId, ticket);
        },
        sign: async (prepared) => {
          const decoded = decodePreparedTransaction(prepared.unsignedTxBase64);
          return wallet.signTransaction!(decoded as any);
        },
        send: async ({ signed }) => {
          return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 });
        },
        confirm: async ({ prepared, submission }) => {
          await withTimeout(
            confirmSignatureByPolling(connection, submission, { timeoutMs: 45_000 }),
            45_000,
            "RPC confirmation timeout",
          );
        },
        onState: (nextState) => setWalletTxState(nextState),
      });

      setBuySignature(result.submission);
      setBuySuccess("Ticket purchase confirmed.");
      await refreshAll();
    } catch (error) {
      const classified = classifyBuyError(error);
      setBuyError(classified.userMessage);
      setBuySuccess("");
    }
  }

  const unknownReasonDetected = useMemo(() => {
    if (!claim) return false;
    if (claimUxSummary?.state === UX_CLAIM_STATUS.UNKNOWN_REASON) return true;
    return claim.tickets.some((ticket) => {
      const mapped = mapTicketClaimabilityToUx(ticket);
      return mapped.status === "UNKNOWN_REASON";
    });
  }, [claim, claimUxSummary]);

  const unknownReasonDetails = useMemo(() => {
    if (!claim) {
      return { hasUnknown: false, unknownTopReasons: [] as string[], unknownTicketReasons: [] as string[] };
    }
    const unknownTopReasons = Array.isArray(claimUxSummary?.unknownReasons) ? claimUxSummary.unknownReasons : [];
    const unknownTicketReasons = Array.from(
      new Set(
        claim.tickets
          .flatMap((ticket) => {
            const mapped = mapTicketClaimabilityToUx(ticket);
            return Array.isArray(mapped.unknownReasons) ? mapped.unknownReasons : [];
          })
          .filter(Boolean),
      ),
    );
    return {
      hasUnknown: unknownTopReasons.length > 0 || unknownTicketReasons.length > 0,
      unknownTopReasons,
      unknownTicketReasons,
    };
  }, [claim, claimUxSummary]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!unknownReasonDetails.hasUnknown) return;
    console.warn("[claimability][unknown_reason]", {
      endpoint: "/claims/estimate",
      wallet: walletAddress || null,
      roundId: claim?.roundId ?? null,
      unknownTopReasons: unknownReasonDetails.unknownTopReasons,
      unknownTicketReasons: unknownReasonDetails.unknownTicketReasons,
    });
  }, [claim?.roundId, unknownReasonDetails, walletAddress]);

  return (
    <div className="min-h-screen bg-[var(--oj-bg)] text-[var(--oj-text)]">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-xl font-semibold">OpenJack</h1>
          <div className="text-xs text-[var(--oj-text-muted)]">Contract-driven claimability UI</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge text={`Required: ${REQUIRED_CLUSTER}`} />
          <Badge text={`RPC: ${clusterLabel(detectedCluster)}`} />
          {walletAddress ? <Badge text={shortPk(walletAddress)} /> : null}
          <WalletMultiButton />
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button
            className={`rounded-lg px-3 py-2 text-sm font-medium ${route === "home" ? "bg-[var(--oj-brand)] text-white" : "bg-[var(--oj-bg-elev)] text-[var(--oj-text)]"}`}
            onClick={() => setRoute("home")}
          >
            Home
          </button>
          <button
            className={`rounded-lg px-3 py-2 text-sm font-medium ${route === "buy" ? "bg-[var(--oj-brand)] text-white" : "bg-[var(--oj-bg-elev)] text-[var(--oj-text)]"}`}
            onClick={() => setRoute("buy")}
          >
            Buy Tickets
          </button>
          <button
            className={`rounded-lg px-3 py-2 text-sm font-medium ${route === "tickets" ? "bg-[var(--oj-brand)] text-white" : "bg-[var(--oj-bg-elev)] text-[var(--oj-text)]"}`}
            onClick={() => setRoute("tickets")}
          >
            My Tickets
          </button>
          <button className="ml-auto rounded-lg border border-[var(--oj-border)] px-3 py-2 text-sm" onClick={refreshAll}>
            Retry
          </button>
        </div>

        <section className="mb-4 rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className={`rounded-lg border px-3 py-2 text-sm ${statusToneClass(connectivityMeta.tone)}`}>
              <div className="font-semibold">Wallet: {connectivityMeta.label}</div>
              <div className="mt-0.5 text-xs">{connectivityMeta.detail}</div>
            </div>
            <div className={`rounded-lg border px-3 py-2 text-sm ${statusToneClass(txMeta.tone)}`}>
              <div className="font-semibold">Transaction: {txMeta.label}</div>
              <div className="mt-0.5 text-xs">{txMeta.detail}</div>
            </div>
          </div>
        </section>

        {routeBlocked ? (
          <section className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-6">
            <h2 className="text-lg font-semibold">Wallet Required</h2>
            {walletConnectivity === "WRONG_NETWORK" ? (
              <p className="mt-2 text-sm text-[var(--oj-warn)]">Connected wallet is on the wrong network. Switch to {REQUIRED_CLUSTER} to access {route === "buy" ? "Buy Tickets" : "My Tickets"}.</p>
            ) : (
              <p className="mt-2 text-sm text-[var(--oj-text-muted)]">Connect a wallet on {REQUIRED_CLUSTER} to access {route === "buy" ? "Buy Tickets" : "My Tickets"}.</p>
            )}
          </section>
        ) : null}

        {apiError ? (
          <section className="mb-4 rounded-xl border border-[var(--oj-danger)]/40 bg-[var(--oj-bg-card)] p-4 text-sm text-[var(--oj-danger)]">
            API error: {apiError}
          </section>
        ) : null}

        {unknownReasonDetected ? (
          <section className="mb-4 rounded-xl border border-[var(--oj-danger)]/40 bg-[var(--oj-bg-card)] p-4">
            <div className="text-sm font-semibold text-[var(--oj-danger)]">Unknown readiness reason detected</div>
            <div className="mt-1 text-sm text-[var(--oj-text-muted)]">
              Contract drift may have occurred. Retry, and inspect backend enum mapping.
            </div>
          </section>
        ) : null}

        {!routeBlocked && route === "home" ? (
          <HomePanel
            round={round}
            claim={claim}
            loading={loading}
            summary={claimUxSummary}
            error={homeError}
            onRetry={async () => {
              setHomeError("");
              setApiError("");
              setLoading(true);
              try {
                const active = await fetchActiveRound();
                setRound(active);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setHomeError(message);
                setApiError(message);
              } finally {
                setLoading(false);
              }
            }}
          />
        ) : null}

        {!routeBlocked && route === "buy" ? (
          <BuyTicketsPanel
            round={round}
            walletConnected={walletConnectivity === "CONNECTED"}
            useQuickPick={buyUseQuickPick}
            mainInput={buyMainInput}
            bonusInput={buyBonusInput}
            buyError={buyError}
            buySuccess={buySuccess}
            buySignature={buySignature}
            walletTxState={walletTxState}
            explorerUrl={buySignature ? explorerTxUrl(buySignature, detectedCluster) : ""}
            onToggleQuickPick={(next) => setBuyUseQuickPick(next)}
            onChangeMain={(next) => setBuyMainInput(next)}
            onChangeBonus={(next) => setBuyBonusInput(next)}
            onBuy={runBuyFlow}
          />
        ) : null}

        {!routeBlocked && route === "tickets" ? (
          <MyTicketsPanel
            claim={claim}
            loading={loading}
            error={ticketsError}
            ingestion={ingestion}
            ingestionError={ingestionError}
            onRetryTickets={async () => {
              setTicketsError("");
              setApiError("");
              if (!walletAddress) {
                setTicketsError("Connect wallet to load claimability.");
                return;
              }
              const roundId = Number(round?.roundId || 0);
              if (!roundId) {
                setTicketsError("No active round found.");
                return;
              }
              try {
                setLoading(true);
                const estimate = await fetchClaimEstimate(roundId, walletAddress);
                setClaim(estimate);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setTicketsError(message);
                setApiError(message);
              } finally {
                setLoading(false);
              }
            }}
            onRetryIngestion={async () => {
              if (!round) return;
              try {
                setIngestionError("");
                const ingest = await fetchRoundIngestionStatus(round.roundId);
                setIngestion(ingest);
              } catch (error) {
                setIngestionError(error instanceof Error ? error.message : String(error));
              }
            }}
          />
        ) : null}

        {import.meta.env.DEV ? (
          <section className="mt-4 rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-3 text-xs text-[var(--oj-text-muted)]">
            <div className="flex flex-wrap items-center gap-3">
              <span>contractVersion={claim?.contractVersion || "n/a"}</span>
              <span>apiBase={apiBaseDisplay || "n/a"}</span>
              <span>cluster={clusterLabel(detectedCluster)}</span>
              <span>profile={String(import.meta.env.VITE_PROFILE || "unset")}</span>
            </div>
            {unknownReasonDetails.hasUnknown ? (
              <div className="mt-1 text-[var(--oj-warn)]">
                unknownReasons={JSON.stringify([...unknownReasonDetails.unknownTopReasons, ...unknownReasonDetails.unknownTicketReasons])}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function HomePanel({
  round,
  claim,
  loading,
  summary,
  error,
  onRetry,
}: {
  round: Round | null;
  claim: ClaimEstimate | null;
  loading: boolean;
  summary: any;
  error: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <article className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4 lg:col-span-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Current Round</h2>
          <button className="rounded-md border border-[var(--oj-border)] px-2 py-1 text-xs" onClick={onRetry}>
            Retry
          </button>
        </div>
        {loading ? <p className="mt-2 text-sm text-[var(--oj-text-muted)]">Loading...</p> : null}
        {error ? <p className="mt-2 text-sm text-[var(--oj-danger)]">Home data unavailable: {error}</p> : null}
        {!loading && !round ? <p className="mt-2 text-sm text-[var(--oj-text-muted)]">No active round.</p> : null}
        {round ? (
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>Round ID: {round.roundId}</div>
            <div>Status: {String(round.status || "UNKNOWN")}</div>
            <div>Jackpot: {lamportsToSol(Number(round.jackpotPoolBalance || 0))} SOL</div>
            <div>Winners Pool: {lamportsToSol(Number(round.winnersPoolBalance || 0))} SOL</div>
          </div>
        ) : null}
      </article>

      <article className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4">
        <h2 className="text-lg font-semibold">Claim Snapshot</h2>
        {!claim ? (
          <p className="mt-2 text-sm text-[var(--oj-text-muted)]">Connect wallet to load claimability.</p>
        ) : (
          <div className="mt-3 space-y-2 text-sm">
            <div>State: <span className="font-semibold">{summary?.label || "Unknown"}</span></div>
            <div>Winner tickets: {claim.winnerTickets}</div>
            <div>Claimable tickets: {claim.claimableTickets}</div>
            <div>Non-claimable winners: {claim.nonClaimableWinnerTickets}</div>
            <div>Estimated claim: {lamportsToSol(claim.estimatedLamports)} SOL</div>
            <div>Potential claim: {lamportsToSol(claim.potentialLamports)} SOL</div>
          </div>
        )}
      </article>
    </section>
  );
}

function BuyTicketsPanel({
  round,
  walletConnected,
  useQuickPick,
  mainInput,
  bonusInput,
  buyError,
  buySuccess,
  buySignature,
  walletTxState,
  explorerUrl,
  onToggleQuickPick,
  onChangeMain,
  onChangeBonus,
  onBuy,
}: {
  round: Round | null;
  walletConnected: boolean;
  useQuickPick: boolean;
  mainInput: string;
  bonusInput: string;
  buyError: string;
  buySuccess: string;
  buySignature: string;
  walletTxState: WalletTxState;
  explorerUrl: string;
  onToggleQuickPick: (next: boolean) => void;
  onChangeMain: (next: string) => void;
  onChangeBonus: (next: string) => void;
  onBuy: () => Promise<void>;
}) {
  const txBusy = walletTxState === "SIGNING" || walletTxState === "PENDING";
  const canBuy = walletConnected && !!round?.roundId && !txBusy;

  return (
    <section className="space-y-4">
      <article className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4">
        <h2 className="text-lg font-semibold">Buy Tickets</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-[var(--oj-bg-elev)] p-3 text-sm">
            <div className="text-[var(--oj-text-muted)]">Round</div>
            <div className="mt-1 font-semibold">{round?.roundId ? `#${round.roundId}` : "No active round"}</div>
          </div>
          <div className="rounded-lg bg-[var(--oj-bg-elev)] p-3 text-sm">
            <div className="text-[var(--oj-text-muted)]">Round status</div>
            <div className="mt-1 font-semibold">{String(round?.status || "UNKNOWN")}</div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-sm">
          <button
            className={`rounded-md border px-3 py-1.5 ${useQuickPick ? "border-[var(--oj-brand)] bg-[var(--oj-brand)]/15 text-[var(--oj-text)]" : "border-[var(--oj-border)] text-[var(--oj-text-muted)]"}`}
            onClick={() => onToggleQuickPick(true)}
          >
            Quick Pick
          </button>
          <button
            className={`rounded-md border px-3 py-1.5 ${!useQuickPick ? "border-[var(--oj-brand)] bg-[var(--oj-brand)]/15 text-[var(--oj-text)]" : "border-[var(--oj-border)] text-[var(--oj-text-muted)]"}`}
            onClick={() => onToggleQuickPick(false)}
          >
            Manual
          </button>
        </div>

        {!useQuickPick ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <div className="mb-1 text-[var(--oj-text-muted)]">Main numbers (5 unique, comma-separated)</div>
              <input
                value={mainInput}
                onChange={(event) => onChangeMain(event.target.value)}
                className="w-full rounded-md border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] px-3 py-2 text-[var(--oj-text)]"
                placeholder="1,2,3,4,5"
              />
            </label>
            <label className="text-sm">
              <div className="mb-1 text-[var(--oj-text-muted)]">Bonus (1-10)</div>
              <input
                value={bonusInput}
                onChange={(event) => onChangeBonus(event.target.value)}
                className="w-full rounded-md border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] px-3 py-2 text-[var(--oj-text)]"
                placeholder="1"
              />
            </label>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] p-3 text-sm text-[var(--oj-text-muted)]">
            Quick pick uses protocol-generated random numbers.
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            className="rounded-lg bg-[var(--oj-brand)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canBuy}
            onClick={onBuy}
          >
            {walletTxState === "SIGNING" ? "Awaiting signature..." : walletTxState === "PENDING" ? "Submitting..." : "Buy Ticket"}
          </button>
          <span className="text-xs text-[var(--oj-text-muted)]">State: {walletTxState}</span>
        </div>

        {buyError ? (
          <div className="mt-3 rounded-md border border-[var(--oj-danger)]/40 bg-[var(--oj-danger)]/10 px-3 py-2 text-sm text-[var(--oj-danger)]">{buyError}</div>
        ) : null}

        {buySuccess ? (
          <div className="mt-3 rounded-md border border-[var(--oj-ok)]/40 bg-[var(--oj-ok)]/10 px-3 py-2 text-sm text-[var(--oj-ok)]">
            {buySuccess}
          </div>
        ) : null}

        {buySignature ? (
          <div className="mt-2 text-sm text-[var(--oj-text-muted)]">
            Signature: <span className="font-mono text-xs">{buySignature}</span>{" "}
            {explorerUrl ? (
              <a className="text-[var(--oj-brand)] underline" href={explorerUrl} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            ) : null}
          </div>
        ) : null}
      </article>
    </section>
  );
}

function MyTicketsPanel({
  claim,
  loading,
  error,
  ingestion,
  ingestionError,
  onRetryTickets,
  onRetryIngestion,
}: {
  claim: ClaimEstimate | null;
  loading: boolean;
  error: string;
  ingestion: RoundIngestionStatus | null;
  ingestionError: string;
  onRetryTickets: () => Promise<void>;
  onRetryIngestion: () => Promise<void>;
}) {
  const summary = useMemo(() => (claim ? deriveClaimSummaryUx(claim) : null), [claim]);

  return (
    <section className="space-y-4">
      <article className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">My Tickets</h2>
          <button className="rounded-md border border-[var(--oj-border)] px-2 py-1 text-xs" onClick={onRetryTickets}>
            Retry
          </button>
        </div>
        {loading ? <p className="mt-2 text-sm text-[var(--oj-text-muted)]">Loading...</p> : null}
        {error ? <p className="mt-2 text-sm text-[var(--oj-danger)]">Ticket data unavailable: {error}</p> : null}
        {!loading && !claim ? <p className="mt-2 text-sm text-[var(--oj-text-muted)]">No data yet.</p> : null}

        {claim ? (
          <>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-[var(--oj-bg-elev)] p-3">Winner tickets: <strong>{claim.winnerTickets}</strong></div>
              <div className="rounded-lg bg-[var(--oj-bg-elev)] p-3">Claimable: <strong>{claim.claimableTickets}</strong></div>
              <div className="rounded-lg bg-[var(--oj-bg-elev)] p-3">State: <strong>{summary?.label}</strong></div>
            </div>

            {summary?.state === UX_CLAIM_STATUS.NO_WINS ? (
              <p className="mt-3 text-sm text-[var(--oj-text-muted)]">No wins for this round.</p>
            ) : null}

            {summary?.state === UX_CLAIM_STATUS.WINS_NOT_CLAIMABLE ? (
              <div className="mt-3 rounded-lg border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] p-3 text-sm">
                Wins found, but none are currently claimable.
              </div>
            ) : null}

            {summary?.state === UX_CLAIM_STATUS.CLAIMABLE_NOW ? (
              <div className="mt-3 rounded-lg border border-[var(--oj-ok)]/40 bg-[var(--oj-bg-elev)] p-3 text-sm text-[var(--oj-ok)]">
                You have claimable tickets now.
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              {claim.tickets.map((ticket) => {
                const mapped = mapTicketClaimabilityToUx(ticket);
                return (
                  <div key={`${ticket.leafIndex}-${ticket.tier}`} className="rounded-lg border border-[var(--oj-border)] bg-[var(--oj-bg-elev)] p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        Ticket #{ticket.leafIndex} · Tier {ticket.tier}
                      </div>
                      <Badge text={mapped.label} />
                    </div>
                    <div className="mt-1 text-[var(--oj-text-muted)]">Amount: {lamportsToSol(ticket.amount)} SOL</div>
                    {mapped.reasons.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {mapped.reasons.map((reason: string) => (
                          <Badge key={reason} text={reasonLabel(reason)} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </article>

      <article className="rounded-xl border border-[var(--oj-border)] bg-[var(--oj-bg-card)] p-4 text-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Ingestion status</h3>
          <button className="rounded-md border border-[var(--oj-border)] px-2 py-1" onClick={onRetryIngestion}>
            Retry
          </button>
        </div>
        {ingestionError ? (
          <p className="mt-2 text-[var(--oj-warn)]">
            Ingestion endpoint unavailable. Claim reasons are still shown from `/claims/estimate`.
          </p>
        ) : null}
        {ingestion?.ingestionState ? (
          <div className="mt-2 text-[var(--oj-text-muted)]">
            Sealed: {String(Boolean(ingestion.ingestionState.sealed))} · Reason: {ingestion.ingestionState.readinessReason || "n/a"}
          </div>
        ) : null}
      </article>
    </section>
  );
}
