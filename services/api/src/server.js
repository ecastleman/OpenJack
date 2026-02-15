import http from "node:http";
import {
  getActiveRound,
  getClaimEstimate,
  getRound,
  getRoundRoots,
  getScannerStatus,
  setClaimEstimate,
  setRoundRoots,
  upsertRound,
} from "./data/store.js";
import { prepareBuyTx, prepareClaimTx } from "./tx/prepare.js";

const PORT = Number(process.env.PORT || 8080);
const INGEST_API_KEY = process.env.INGEST_API_KEY || "dev-ingest-key";

function send(res, statusCode, data) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function parsePath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function authorizeIngest(req) {
  return req.headers["x-api-key"] === INGEST_API_KEY;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const parts = parsePath(url.pathname);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "openjack-api" });
  }

  if (req.method === "GET" && url.pathname === "/rounds/active") {
    return send(res, 200, { round: await getActiveRound() });
  }

  if (req.method === "GET" && parts.length === 2 && parts[0] === "rounds") {
    const roundId = Number(parts[1]);
    const round = await getRound(roundId);
    if (!round) {
      return send(res, 404, { error: "round_not_found" });
    }
    return send(res, 200, { round });
  }

  if (req.method === "GET" && parts.length === 3 && parts[0] === "rounds" && parts[2] === "roots") {
    const roundId = Number(parts[1]);
    return send(res, 200, { roundId, roots: await getRoundRoots(roundId) });
  }

  if (req.method === "GET" && url.pathname === "/claims/estimate") {
    const roundId = Number(url.searchParams.get("roundId") || 0);
    const wallet = url.searchParams.get("wallet") || "";
    if (!roundId || !wallet) {
      return send(res, 400, { error: "roundId_and_wallet_required" });
    }
    return send(res, 200, await getClaimEstimate(roundId, wallet));
  }

  if (req.method === "GET" && url.pathname === "/scanner/status") {
    const roundId = Number(url.searchParams.get("roundId") || 0);
    if (!roundId) {
      return send(res, 400, { error: "roundId_required" });
    }
    return send(res, 200, await getScannerStatus(roundId));
  }

  if (req.method === "POST" && url.pathname === "/ingest/round") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, { round: await upsertRound(body) });
  }

  if (req.method === "POST" && url.pathname === "/ingest/roots") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, {
      roundId: body.roundId,
      roots: await setRoundRoots(body.roundId, body),
    });
  }

  if (req.method === "POST" && url.pathname === "/ingest/claim-estimate") {
    if (!authorizeIngest(req)) {
      return send(res, 401, { error: "unauthorized" });
    }
    const body = await parseBody(req);
    return send(res, 200, {
      claim: await setClaimEstimate(body.roundId, body.wallet, body),
    });
  }

  if (req.method === "POST" && url.pathname === "/tx/prepare/buy") {
    const body = await parseBody(req);
    return send(
      res,
      200,
      await prepareBuyTx({
        wallet: body.wallet,
        roundId: body.roundId,
        payload: body.payload,
      }),
    );
  }

  if (req.method === "POST" && url.pathname === "/tx/prepare/claim") {
    const body = await parseBody(req);
    return send(
      res,
      200,
      await prepareClaimTx({
        wallet: body.wallet,
        roundId: body.roundId,
        payload: body.payload,
      }),
    );
  }

  return send(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { error: err.message || "internal_error" });
  });
});

server.listen(PORT, () => {
  console.log(`openjack-api listening on :${PORT}`);
});
