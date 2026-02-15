import type { ClaimEstimate, ClaimTicket, PreparedTx, RootRow, Round, RoundIngestionStatus, ScannerStatus } from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8080").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as any)?.error ? ` error=${(body as any).error}` : "";
    throw new Error(`${path} failed: ${res.status}${err}`);
  }
  return body as T;
}

export async function fetchActiveRound(): Promise<Round | null> {
  const data = await request<{ round: Round | null }>("/rounds/active");
  return data.round;
}

export async function fetchRound(roundId: number): Promise<Round> {
  const data = await request<{ round: Round }>(`/rounds/${roundId}`);
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

export async function fetchRoundIngestionStatus(roundId: number): Promise<RoundIngestionStatus> {
  return request<RoundIngestionStatus>(`/rounds/${roundId}/ingestion`);
}

export async function prepareBuyTx(
  wallet: string,
  roundId: number,
  ticket?: { main: number[]; bonus: number },
): Promise<PreparedTx> {
  const payload =
    ticket && Array.isArray(ticket.main) && Number.isInteger(ticket.bonus)
      ? { qty: 1, quickPick: false, tickets: [ticket] }
      : { qty: 1, quickPick: true };
  return request<PreparedTx>("/tx/prepare/buy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      roundId,
      payload,
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
