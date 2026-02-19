import crypto from "node:crypto";

export const PROFILE_SPECS = {
  "dev-fast": {
    expectedProgramId: null,
    defaults: {
      OPENJACK_PROOF_MODE: "das",
      OPENJACK_GATE_SKIP_AUTO_CLAIM: "false",
    },
  },
  "qa-fast": {
    expectedProgramId: "Cnraeedx3R74G42eLHBz1rTbSwCQt62C2RC7iaejWSW3",
    defaults: {
      OPENJACK_PROOF_MODE: "off",
      OPENJACK_GATE_SKIP_AUTO_CLAIM: "true",
    },
  },
  "prod-like": {
    expectedProgramId: "2AWsuApMg1gr4e9Ybc5Uji5cJnjYDjYaqQzjn6s6draX",
    defaults: {
      OPENJACK_PROOF_MODE: "das",
      OPENJACK_GATE_SKIP_AUTO_CLAIM: "true",
    },
  },
};

export function getProfileSpec(profile) {
  const normalized = String(profile || "").toLowerCase();
  const spec = PROFILE_SPECS[normalized];
  if (!spec) {
    throw new Error(`unknown_profile ${profile}`);
  }
  return { profile: normalized, spec };
}

export function applyProfileDefaults(profile, env) {
  const { spec } = getProfileSpec(profile);
  const out = { ...env };
  for (const [key, value] of Object.entries(spec.defaults)) {
    if (out[key] === undefined || out[key] === null || String(out[key]).trim() === "") {
      out[key] = value;
    }
  }
  return out;
}

export function validateProfileEnv(profile, env, context = "runtime") {
  const { profile: normalized, spec } = getProfileSpec(profile);
  const programId = String(env.OPENJACK_PROGRAM_ID || "").trim();

  if (!programId || programId.startsWith("REPLACE_WITH_")) {
    throw new Error(`${context}: OPENJACK_PROGRAM_ID is required for profile=${normalized}`);
  }
  if (spec.expectedProgramId && programId !== spec.expectedProgramId) {
    throw new Error(
      `${context}: OPENJACK_PROGRAM_ID mismatch for profile=${normalized} expected=${spec.expectedProgramId} actual=${programId}`,
    );
  }

  const proofMode = String(env.OPENJACK_PROOF_MODE || "").toLowerCase();
  if (!["off", "das"].includes(proofMode)) {
    throw new Error(`${context}: OPENJACK_PROOF_MODE must be one of [off,das], got=${proofMode || "empty"}`);
  }

  return true;
}

export function buildProfileFingerprint(profile, env) {
  const toSafeEndpoint = (raw) => {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
      const u = new URL(value);
      // Intentionally drop username/password/query/fragment to avoid leaking credentials or API keys.
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      // If not URL-like, avoid echoing arbitrary secret-ish values.
      return "redacted";
    }
  };

  const payload = {
    profile: String(profile || "").toLowerCase(),
    programId: String(env.OPENJACK_PROGRAM_ID || ""),
    rpcEndpoint: toSafeEndpoint(env.RPC_URL || ""),
    proofMode: String(env.OPENJACK_PROOF_MODE || ""),
    gateSkipAutoClaim: String(env.OPENJACK_GATE_SKIP_AUTO_CLAIM || ""),
    scannerIntervalSecs: String(env.OPENJACK_SCAN_INTERVAL_SECS || ""),
    closeInSecs: String(env.OPENJACK_CLOSE_IN_SECS || env.OPENJACK_GATE_CLOSE_IN_SECS || ""),
  };
  const json = JSON.stringify(payload);
  const sha = crypto.createHash("sha256").update(json).digest("hex").slice(0, 12);
  return { id: sha, payload };
}
