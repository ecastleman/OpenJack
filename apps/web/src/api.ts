import type { ClaimEstimate, ClaimTicket, PreparedTx, RootRow, Round, ScannerStatus } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8080").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchActiveRound(): Promise<Round | null> {
  const data = await request<{ round: Round | null }>("/rounds/active");
  return data.round;
}

export async function fetchRoots(roundId: number): Promise<RootRow[]> {
  const data = await request<{ roots: RootRow[] }>(`/rounds/${roundId}/roots`);
  return data.roots;
}

export async function fetchClaimEstimate(roundId: number, wallet: string): Promise<ClaimEstimate> {
  return request<ClaimEstimate>(`/claims/estimate?roundId=${roundId}&wallet=${wallet}`);
}

export async function fetchScannerStatus(roundId: number): Promise<ScannerStatus> {
  return request<ScannerStatus>(`/scanner/status?roundId=${roundId}`);
}

export async function prepareBuyTx(wallet: string, roundId: number): Promise<PreparedTx> {
  return request<PreparedTx>("/tx/prepare/buy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      roundId,
      payload: { qty: 1, quickPick: true },
    }),
  });
}

export async function prepareClaimTx(wallet: string, roundId: number, ticket: ClaimTicket): Promise<PreparedTx> {
  return request<PreparedTx>("/tx/prepare/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      roundId,
      payload: ticket,
    }),
  });
}
