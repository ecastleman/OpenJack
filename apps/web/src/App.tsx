import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";

import {
  fetchActiveRound,
  fetchClaimEstimate,
  fetchRoots,
  fetchRound,
  fetchRoundIngestionStatus,
  fetchScannerStatus,
  prepareBuyTx,
  prepareClaimTx,
} from "./api";
import type { ClaimEstimate, ClaimTicket, RootRow, Round, RoundIngestionStatus, ScannerStatus } from "./types";

function decodeTx(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, "base64"));
}

function isClaimProofReady(ticket: ClaimTicket): boolean {
  return Boolean(
    ticket.winnerRootHash &&
      ticket.compressionRoot &&
      ticket.compressionLeaf &&
      Number.isInteger(Number(ticket.compressionIndex)) &&
      Array.isArray(ticket.ticketProof) &&
      ticket.ticketProof.length > 0,
  );
}

function shortPk(pk: string): string {
  if (!pk) return "";
  return `${pk.slice(0, 4)}...${pk.slice(-4)}`;
}

function txExplorerUrl(signature: string): string {
  const base = "https://explorer.solana.com/tx";
  const cluster = "devnet";
  return `${base}/${signature}?cluster=${cluster}`;
}

const DEVNET_DEFAULT_TICKET_LAMPORTS = 100_000_000; // $2 at 20 USD/SOL fallback used by prepare API.

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    const cause = (error as any).cause;
    if (cause) {
      return `${error.message} | cause: ${formatError(cause)}`;
    }
    return error.message;
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage =
      (error as any).message ||
      (error as any).error?.message ||
      (error as any).error ||
      (error as any).reason ||
      (error as any).toString?.();
    const logs = Array.isArray((error as any).logs) ? (error as any).logs.join(" | ") : "";
    const code = (error as any).code != null ? String((error as any).code) : "";
    const name = (error as any).name ? String((error as any).name) : "";
    const prefix = [name, code ? `code=${code}` : ""].filter(Boolean).join(" ");
    if (maybeMessage && maybeMessage !== "[object Object]") return String(maybeMessage);
    if (logs) return `${prefix ? `${prefix}: ` : ""}${logs}`;
    try {
      return JSON.stringify(error, Object.getOwnPropertyNames(error));
    } catch {
      return "Unexpected error";
    }
  }
  return "Unexpected error";
}

function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(4);
}

export function App() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [round, setRound] = useState<Round | null>(null);
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [claim, setClaim] = useState<ClaimEstimate | null>(null);
  const [claimRoundIdInput, setClaimRoundIdInput] = useState<string>("");
  const [claimRoundStatus, setClaimRoundStatus] = useState<string>("UNKNOWN");
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  const [ingestion, setIngestion] = useState<RoundIngestionStatus | null>(null);
  const [status, setStatus] = useState<string>("Loading...");
  const [buyMainInput, setBuyMainInput] = useState<string>("1,2,3,4,5");
  const [buyBonusInput, setBuyBonusInput] = useState<string>("1");

  const walletAddress = useMemo(() => {
    const adapterPk = (wallet as any)?.adapter?.publicKey;
    return wallet.publicKey?.toBase58() || adapterPk?.toBase58?.() || "";
  }, [wallet]);
  const settleCountdown = useMemo(() => {
    if (!round?.settleDeadlineTs) return "n/a";
    const secs = Math.max(0, round.settleDeadlineTs - Math.floor(Date.now() / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  }, [round]);
  const claimRoundId = useMemo(() => Number(claimRoundIdInput || 0), [claimRoundIdInput]);
  const claimRoundIsFinalized = String(claimRoundStatus || "").toUpperCase() === "FINALIZED";
  const claimRoundStatusNorm = useMemo(() => String(claimRoundStatus || "").toUpperCase(), [claimRoundStatus]);
  const activeJackpotLamports = useMemo(() => {
    if (!round) return 0;
    const status = String(round.status || "").toUpperCase();
    if (status === "SETTLING" || status === "FINALIZED") {
      return Number(round.winnersPoolBalance || round.jackpotPoolBalance || 0);
    }
    return Number(round.jackpotPoolBalance || 0);
  }, [round]);

  useEffect(() => {
    fetchActiveRound()
      .then((r) => {
        setRound(r);
        if (!r) {
          setStatus("No active round");
          return;
        }

        setStatus("");
        setClaimRoundIdInput(String(r.roundId));
        fetchRoots(r.roundId).then(setRoots).catch((e) => setStatus(String(e)));
        fetchScannerStatus(r.roundId).then(setScanner).catch(() => {});
        fetchRoundIngestionStatus(r.roundId).then(setIngestion).catch(() => {});
      })
      .catch((e) => setStatus(String(e)));
  }, []);

  useEffect(() => {
    if (!walletAddress || !Number.isInteger(claimRoundId) || claimRoundId <= 0) {
      setClaim(null);
      return;
    }
    fetchRound(claimRoundId)
      .then((r) => setClaimRoundStatus(String(r.status || "UNKNOWN")))
      .catch(() => setClaimRoundStatus("UNKNOWN"));
    fetchRoundIngestionStatus(claimRoundId).then(setIngestion).catch(() => {});
    fetchClaimEstimate(claimRoundId, walletAddress)
      .then(setClaim)
      .catch((e) => setStatus(String(e)));
  }, [claimRoundId, walletAddress]);

  async function refreshClaimRoundState(roundId: number, walletAddr: string) {
    const [roundResp, rootsResp, ingestionResp, claimResp] = await Promise.all([
      fetchRound(roundId),
      fetchRoots(roundId).catch(() => [] as RootRow[]),
      fetchRoundIngestionStatus(roundId).catch(() => null),
      fetchClaimEstimate(roundId, walletAddr),
    ]);
    setClaimRoundStatus(String(roundResp.status || "UNKNOWN"));
    setRoots(rootsResp);
    setIngestion(ingestionResp);
    setClaim(claimResp);
  }

  const ingestionBanner = useMemo(() => {
    if (!ingestion?.ingestionState) return null;
    if (claimRoundStatusNorm !== "SETTLING") return null;
    if (ingestion.ingestionState.sealed && ingestion.snapshot?.snapshotHashHex) {
      return {
        tone: "ok" as const,
        text: `Finalizing complete — snapshot sealed (${shortPk(ingestion.snapshot.snapshotHashHex)})`,
      };
    }
    return {
      tone: "pending" as const,
      text: "Finalizing — verifying tickets",
    };
  }, [ingestion, claimRoundStatusNorm]);

  async function resolveWalletAddress(): Promise<string> {
    if (!wallet.connected && wallet.connect) {
      await wallet.connect();
    }
    const adapterPk = (wallet as any)?.adapter?.publicKey;
    const pk = wallet.publicKey || adapterPk;
    if (!pk) {
      throw new Error("Wallet is connected but no public key was exposed");
    }
    return pk.toBase58();
  }

async function sendPrepared(base64: string) {
    const decoded = decodeTx(base64);
    const adapterPk = (wallet as any)?.adapter?.publicKey;
    const signerPk = wallet.publicKey || adapterPk;
    if (!signerPk) {
      throw new Error("Wallet has no signer public key");
    }
    if (!decoded.feePayer) {
      throw new Error("Prepared transaction missing fee payer");
    }
    if (!decoded.feePayer.equals(signerPk)) {
      throw new Error(
        `Prepared tx fee payer ${decoded.feePayer.toBase58()} does not match connected wallet ${signerPk.toBase58()}`,
      );
    }

    // Normalize tx object for wallet compatibility: rebuild with current blockhash and same instructions.
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: signerPk,
      blockhash: latest.blockhash,
    } as any);
    tx.recentBlockhash = latest.blockhash;
    for (const ix of decoded.instructions) {
      tx.add(ix);
    }

    const sim = await connection
      .simulateTransaction(tx, {
        sigVerify: false,
        commitment: "processed",
      } as any)
      .catch((error) => {
        const msg = formatError(error);
        if (msg.toLowerCase().includes("invalid arguments")) {
          // Some RPC providers reject simulation argument variants; continue to wallet signing path.
          return null;
        }
        throw new Error(`simulateTransaction failed: ${msg}`);
      });
    if (sim?.value?.err) {
      const logs = Array.isArray(sim.value.logs) ? sim.value.logs.join(" | ") : "";
      throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ` | logs: ${logs}` : ""}`);
    }
    let signature = "";
    if (wallet.signTransaction) {
      const signedTx = await wallet.signTransaction(tx).catch((error) => {
        throw new Error(`signTransaction failed: ${formatError(error)}`);
      });
      const raw = signedTx.serialize();
      signature = await connection
        .sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" })
        .catch((error) => {
          throw new Error(`sendRawTransaction failed: ${formatError(error)}`);
        });
      await connection
        .confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        )
        .catch((error) => {
          throw new Error(`confirmTransaction failed: ${formatError(error)}`);
        });
    } else {
      signature = await wallet.sendTransaction(tx, connection).catch((error) => {
        throw new Error(`sendTransaction failed: ${formatError(error)}`);
      });
    }
    setStatus(`Transaction sent: ${signature}`);
  }

  async function onBuy() {
    if (!round) {
      setStatus("No active round available");
      return;
    }
    try {
      const address = await resolveWalletAddress();
      if (String(round.status || "").toUpperCase() !== "OPEN") {
        setStatus(`Round is ${round.status}. Buying is only available while OPEN.`);
        return;
      }
      if (Number(round.closeTs || 0) > 0 && Math.floor(Date.now() / 1000) >= Number(round.closeTs)) {
        setStatus("Round already closed. Create/open a fresh round.");
        return;
      }
      const buyerBalance = await connection.getBalance(new PublicKey(address));
      if (buyerBalance < DEVNET_DEFAULT_TICKET_LAMPORTS) {
        setStatus(
          `Insufficient SOL for buy preflight. Need ~${lamportsToSol(DEVNET_DEFAULT_TICKET_LAMPORTS)} SOL, wallet has ${lamportsToSol(buyerBalance)} SOL.`,
        );
        return;
      }
      const parsedMain = buyMainInput
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v));
      if (parsedMain.length !== 5 || parsedMain.some((n) => !Number.isInteger(n) || n < 1 || n > 50)) {
        setStatus("Invalid main numbers. Enter exactly 5 integers in [1..50], comma-separated.");
        return;
      }
      const sortedMain = [...parsedMain].sort((a, b) => a - b);
      if (new Set(sortedMain).size !== 5) {
        setStatus("Invalid main numbers. Values must be unique.");
        return;
      }
      const parsedBonus = Number(buyBonusInput.trim());
      if (!Number.isInteger(parsedBonus) || parsedBonus < 1 || parsedBonus > 10) {
        setStatus("Invalid bonus number. Enter an integer in [1..10].");
        return;
      }
      setStatus("Preparing buy transaction...");
      const prepared = await prepareBuyTx(address, round.roundId, {
        main: sortedMain,
        bonus: parsedBonus,
      });
      setStatus("Simulating transaction...");
      setStatus("Awaiting wallet signature...");
      await sendPrepared(prepared.unsignedTxBase64);
    } catch (e) {
      const detail = formatError(e);
      const adapterName = (wallet as any)?.adapter?.name || "wallet";
      setStatus(`${adapterName} buy failed: ${detail}`);
    }
  }

  async function onClaim(ticket: ClaimTicket) {
    try {
      const address = await resolveWalletAddress();
      if (!Number.isInteger(claimRoundId) || claimRoundId <= 0) {
        setStatus("Set a valid claim round id first");
        return;
      }
      if (!claimRoundIsFinalized) {
        setStatus(`Round ${claimRoundId} is ${claimRoundStatus}. Claiming is only available while FINALIZED.`);
        return;
      }
      if (!isClaimProofReady(ticket)) {
        setStatus("Claim proof not ready yet for this ticket");
        return;
      }
      if ((ticket as any)?.ownershipProof?.owner !== address) {
        setStatus("Ticket ownership proof does not match connected wallet");
        return;
      }
      const prepared = await prepareClaimTx(address, claimRoundId, ticket);
      await sendPrepared(prepared.unsignedTxBase64);
      await refreshClaimRoundState(claimRoundId, address);
    } catch (e) {
      const detail = formatError(e);
      if (detail.toLowerCase().includes("already in use")) {
        setStatus("Ticket already claimed");
      } else {
        setStatus(detail);
      }
      const address = walletAddress;
      if (address && Number.isInteger(claimRoundId) && claimRoundId > 0) {
        refreshClaimRoundState(claimRoundId, address).catch(() => {});
      }
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-5 sm:px-6 md:px-8 md:pb-10">
      <header className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">OpenJack</h1>
          <p className="text-sm text-slate-400">Seeker-ready lottery dApp frontend</p>
          {walletAddress ? (
            <p className="inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
              Wallet {shortPk(walletAddress)}
            </p>
          ) : null}
        </div>
        <div className="w-full sm:w-auto">
          <WalletMultiButton className="!h-11 !w-full !rounded-xl !bg-cyan-500 !text-sm !font-semibold !text-slate-950 hover:!bg-cyan-400 sm:!w-auto sm:!px-5" />
        </div>
      </header>

      {ingestionBanner ? (
        <section
          className={`mb-3 rounded-xl border px-3 py-2 text-sm ${
            ingestionBanner.tone === "ok"
              ? "border-emerald-700/50 bg-emerald-950/20 text-emerald-300"
              : "border-amber-700/50 bg-amber-950/20 text-amber-300"
          }`}
        >
          {ingestionBanner.text}
        </section>
      ) : null}

      <section className="grid gap-3 sm:gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-slate-800/80 bg-slate-900 p-4 sm:p-5">
          <div className="flex items-start justify-between">
            <h2 className="text-base font-semibold sm:text-lg">Active Round</h2>
            <span className="rounded-full bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-300">
              {round?.status || "inactive"}
            </span>
          </div>
          {round ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-slate-300">Round #{round.roundId}</p>
              <p className="text-xs text-slate-500">Source: active round feed</p>
              <p className="text-2xl font-semibold text-cyan-300 sm:text-3xl">
                {activeJackpotLamports.toLocaleString()}
              </p>
              <p className="text-xs uppercase tracking-wide text-slate-400">Lamports jackpot</p>
              <p className="text-sm text-slate-300">Settling deadline in {settleCountdown}</p>
              {Array.isArray(round.winningMain) && round.winningMain.some((n) => Number(n) > 0) ? (
                <p className="text-sm text-slate-300">
                  Winning: {round.winningMain.join("-")} + {round.winningBonus ?? 0}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-400">No active round</p>
          )}
        </article>

        <article className="rounded-2xl border border-slate-800/80 bg-slate-900 p-4 sm:p-5">
          <h2 className="text-base font-semibold sm:text-lg">Claim Preview</h2>
          {claim ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-slate-300">Estimated claimable</p>
              <p className="text-2xl font-semibold text-emerald-300 sm:text-3xl">
                {claim.estimatedLamports.toLocaleString()}
              </p>
              <p className="text-xs uppercase tracking-wide text-slate-400">Lamports</p>
              <p className="text-sm text-slate-300">{claim.tickets.length} ticket(s) claimable</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-400">Connect wallet to see estimate</p>
          )}
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-slate-400">
              Claim Round ID
              <input
                value={claimRoundIdInput}
                onChange={(e) => setClaimRoundIdInput(e.target.value)}
                placeholder="e.g. 1771305343"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 focus:ring-2"
              />
            </label>
            <div className="text-xs text-slate-400">
              Claim Round Status
              <p className="mt-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100">
                {claimRoundStatus || "UNKNOWN"}
              </p>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-slate-400">
              Main (5 unique: 1..50)
              <input
                value={buyMainInput}
                onChange={(e) => setBuyMainInput(e.target.value)}
                placeholder="e.g. 1,2,3,4,5"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 focus:ring-2"
              />
            </label>
            <label className="text-xs text-slate-400">
              Bonus (1..10)
              <input
                value={buyBonusInput}
                onChange={(e) => setBuyBonusInput(e.target.value)}
                placeholder="e.g. 1"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 focus:ring-2"
              />
            </label>
          </div>
          <div className="mt-4 hidden gap-2 sm:flex">
            <button
              onClick={onBuy}
              className="min-h-11 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
            >
              Buy 1 Ticket
            </button>
            <button
              onClick={() => {
                const ticket = claim?.tickets?.[0];
                if (!ticket) {
                  setStatus("No claimable tickets found");
                  return;
                }
                void onClaim(ticket);
              }}
              disabled={!claimRoundIsFinalized}
              className="min-h-11 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
            >
              Claim First
            </button>
          </div>
        </article>
      </section>

      <section className="mt-3 rounded-2xl border border-slate-800/80 bg-slate-900 p-4 sm:mt-4 sm:p-5">
        <h2 className="text-base font-semibold sm:text-lg">Claim Tickets</h2>
        {claim?.tickets?.length ? (
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {claim.tickets.map((t) => (
              <li
                key={`${t.leafIndex}:${t.tier}`}
                className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-800/60 px-3 py-2.5 text-slate-300"
              >
                <span>
                  #{t.leafIndex} • Tier {t.tier} • {Number(t.amount || 0).toLocaleString()}
                </span>
                <button
                  onClick={() => {
                    void onClaim(t);
                  }}
                  disabled={!isClaimProofReady(t) || !claimRoundIsFinalized}
                  className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
                >
                  Claim
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-400">No claim tickets available yet.</p>
        )}
      </section>

      <section className="mt-3 rounded-2xl border border-slate-800/80 bg-slate-900 p-4 sm:mt-4 sm:p-5">
        <h2 className="text-base font-semibold sm:text-lg">Settlement Roots</h2>
        <ul className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
          {roots.map((r) => (
            <li
              key={r.tier}
              className="flex items-center justify-between rounded-xl border border-slate-700/60 bg-slate-800/60 px-3 py-2.5"
            >
              <span className="font-medium text-slate-200">{r.label}</span>
              <span className={r.published ? "text-emerald-300" : "text-amber-300"}>
                {r.published ? "published" : "pending"} • {r.winnerCount}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-3 rounded-2xl border border-slate-800/80 bg-slate-900 p-4 sm:mt-4 sm:p-5">
        <h2 className="text-base font-semibold sm:text-lg">Scanner Health</h2>
        {scanner ? (
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <p>
              publishes: {scanner.publishes.length} • dead-letter buckets: {scanner.deadLetters.length}
            </p>
            {scanner.deadLetters.length > 0 ? (
              <p>
                dead letters:{" "}
                {scanner.deadLetters.map((d) => `${d.status}:${d.count}`).join(", ")}
              </p>
            ) : (
              <p>dead letters: none</p>
            )}
            {scanner.warnings.length > 0 ? (
              <p className="text-amber-300">warnings: {scanner.warnings.join(" | ")}</p>
            ) : null}
            {scanner.publishes.length > 0 ? (
              <ul className="grid gap-1 pt-1">
                {scanner.publishes
                  .filter((p) => Boolean(p.txSignature))
                  .slice(0, 6)
                  .map((p) => (
                    <li key={`${p.tier}:${p.txSignature}`} className="text-xs text-slate-400">
                      tier {p.tier} {p.status}{" "}
                      <a
                        className="text-cyan-300 hover:text-cyan-200"
                        href={txExplorerUrl(String(p.txSignature))}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortPk(String(p.txSignature))}
                      </a>
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-400">Scanner status unavailable.</p>
        )}
      </section>

      <p className="mt-4 rounded-xl bg-slate-900/70 px-3 py-2 text-sm text-slate-400">{status}</p>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur sm:hidden">
        <div className="mx-auto mb-2 grid max-w-5xl grid-cols-1 gap-2">
          <input
            value={buyMainInput}
            onChange={(e) => setBuyMainInput(e.target.value)}
            placeholder="Main: 1,2,3,4,5"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 focus:ring-2"
          />
          <input
            value={buyBonusInput}
            onChange={(e) => setBuyBonusInput(e.target.value)}
            placeholder="Bonus: 1"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 focus:ring-2"
          />
        </div>
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-2">
          <button
            onClick={onBuy}
            className="min-h-12 rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
          >
            Buy 1 Ticket
          </button>
          <button
            onClick={() => {
              const ticket = claim?.tickets?.[0];
              if (!ticket) {
                setStatus("No claimable tickets found");
                return;
              }
              void onClaim(ticket);
            }}
            disabled={!claimRoundIsFinalized}
            className="min-h-12 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
          >
            Claim First
          </button>
        </div>
      </div>
    </main>
  );
}
