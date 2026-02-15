import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";

import { fetchActiveRound, fetchClaimEstimate, fetchRoots, fetchScannerStatus, prepareBuyTx, prepareClaimTx } from "./api";
import type { ClaimEstimate, ClaimTicket, RootRow, Round, ScannerStatus } from "./types";

function decodeTx(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, "base64"));
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

export function App() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [round, setRound] = useState<Round | null>(null);
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [claim, setClaim] = useState<ClaimEstimate | null>(null);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  const [status, setStatus] = useState<string>("Loading...");

  const walletAddress = useMemo(() => wallet.publicKey?.toBase58() || "", [wallet.publicKey]);
  const settleCountdown = useMemo(() => {
    if (!round?.settleDeadlineTs) return "n/a";
    const secs = Math.max(0, round.settleDeadlineTs - Math.floor(Date.now() / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
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
        fetchRoots(r.roundId).then(setRoots).catch((e) => setStatus(String(e)));
        fetchScannerStatus(r.roundId).then(setScanner).catch(() => {});
      })
      .catch((e) => setStatus(String(e)));
  }, []);

  useEffect(() => {
    if (!round || !walletAddress) return;
    fetchClaimEstimate(round.roundId, walletAddress)
      .then(setClaim)
      .catch((e) => setStatus(String(e)));
  }, [round, walletAddress]);

  async function sendPrepared(base64: string) {
    if (!wallet.publicKey || !wallet.sendTransaction) {
      throw new Error("Wallet not connected");
    }

    const tx = decodeTx(base64);
    const signature = await wallet.sendTransaction(tx, connection);
    setStatus(`Transaction sent: ${signature}`);
  }

  async function onBuy() {
    if (!round || !walletAddress) {
      setStatus("Connect wallet first");
      return;
    }
    try {
      const prepared = await prepareBuyTx(walletAddress, round.roundId);
      await sendPrepared(prepared.unsignedTxBase64);
    } catch (e) {
      setStatus(String((e as Error).message || e));
    }
  }

  async function onClaim(ticket: ClaimTicket) {
    if (!round || !walletAddress) {
      setStatus("Connect wallet first");
      return;
    }
    try {
      const prepared = await prepareClaimTx(walletAddress, round.roundId, ticket);
      await sendPrepared(prepared.unsignedTxBase64);
    } catch (e) {
      setStatus(String((e as Error).message || e));
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
              <p className="text-2xl font-semibold text-cyan-300 sm:text-3xl">
                {round.jackpotPoolBalance.toLocaleString()}
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
              className="min-h-11 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
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
                  className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
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
            className="min-h-12 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
          >
            Claim First
          </button>
        </div>
      </div>
    </main>
  );
}
