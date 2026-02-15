import { createWinnerRootPayload } from "../../../../packages/shared/src/index.js";
import {
  deriveBondPda,
  deriveConfigPda,
  deriveRoundPda,
  getScannerProgram,
  hexToU8_32,
} from "../solana/openjack.js";
import { PublishLogRepo } from "../repo/publishLog.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RootPublisher {
  constructor({ mode = "dry-run", logger = console } = {}) {
    this.mode = mode;
    this.logger = logger;
    this.maxAttempts = Number(process.env.SCANNER_PUBLISH_MAX_ATTEMPTS || 3);
    this.backoffMs = Number(process.env.SCANNER_PUBLISH_BACKOFF_MS || 1500);
    this.confirmationTimeoutMs = Number(process.env.SCANNER_CONFIRM_TIMEOUT_MS || 60_000);
    this.confirmationPollMs = Number(process.env.SCANNER_CONFIRM_POLL_MS || 2_000);
    this.deadLetterBaseDelayMs = Number(process.env.SCANNER_DEAD_LETTER_DELAY_MS || 15_000);
    this.deadLetterMaxAttempts = Number(process.env.SCANNER_DEAD_LETTER_MAX_ATTEMPTS || 10);
    this.logRepo = new PublishLogRepo();
  }

  async waitForConfirmation(connection, signature) {
    const start = Date.now();
    while (Date.now() - start < this.confirmationTimeoutMs) {
      const result = await connection.getSignatureStatuses([signature]);
      const status = result?.value?.[0];
      if (status?.err) {
        throw new Error(`tx failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return;
      }
      await sleep(this.confirmationPollMs);
    }
    throw new Error(`tx confirmation timeout: ${signature}`);
  }

  async publishOnePayload({ payload, program, wallet, config, round, scannerBond, connection }) {
    const existing = await this.logRepo.getPublished(payload.roundId, payload.tier, payload.rootHash);
    if (existing?.tx_signature) {
      this.logger.log(
        `[scanner] skip already published round=${payload.roundId} tier=${payload.tier} sig=${existing.tx_signature}`,
      );
      return { state: "skipped", signature: existing.tx_signature, attempts: 0 };
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.logRepo.markAttempt(payload);
        const sig = await program.methods
          .publishWinnerRoot({
            tier: payload.tier,
            rootHash: hexToU8_32(payload.rootHash),
            winnerCount: payload.winnerCount,
            observedTicketCount: payload.observedTicketCount,
            commitmentHash: hexToU8_32(payload.commitmentHash),
          })
          .accounts({
            scanner: wallet.publicKey,
            config,
            round,
            scannerBond,
          })
          .rpc();
        await this.waitForConfirmation(connection, sig);
        await this.logRepo.markPublished(payload, sig);
        this.logger.log(`[scanner] published round=${payload.roundId} tier=${payload.tier} sig=${sig}`);
        return { state: "published", signature: sig, attempts: attempt };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        await this.logRepo.markFailure(payload, message);
        this.logger.error(
          `[scanner] publish failed round=${payload.roundId} tier=${payload.tier} attempt=${attempt}/${this.maxAttempts}: ${message}`,
        );
        if (attempt < this.maxAttempts) {
          await sleep(this.backoffMs * attempt);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return { state: "failed", errorMessage: message, attempts: this.maxAttempts };
  }

  async replayDueDeadLetters({ program, wallet, config, connection, summary }) {
    const rows = await this.logRepo.getDueDeadLetters(50);
    if (rows.length === 0) return;
    this.logger.log(`[scanner] replay dead letters count=${rows.length}`);
    for (const row of rows) {
      const payload = createWinnerRootPayload({
        roundId: Number(row.round_id),
        tier: Number(row.tier),
        rootHash: row.root_hash,
        winnerCount: Number(row.winner_count),
        observedTicketCount: Number(row.observed_ticket_count),
        commitmentHash: row.commitment_hash,
      });
      const programId = program.programId;
      const round = deriveRoundPda(programId, payload.roundId);
      const scannerBond = deriveBondPda(programId, payload.roundId);
      const result = await this.publishOnePayload({
        payload,
        program,
        wallet,
        config,
        round,
        scannerBond,
        connection,
      });
      summary.deadLetterReplayed += 1;
      if (result.state === "published" || result.state === "skipped") {
        await this.logRepo.markDeadLetterResolved(row.id, result.signature || row.tx_signature || null);
        summary.deadLetterResolved += 1;
        continue;
      }
      const currentAttempts = Number(row.attempt_count || 0) + 1;
      if (currentAttempts >= this.deadLetterMaxAttempts) {
        await this.logRepo.markDeadLetterTerminal(row.id, result.errorMessage || "dead_letter_terminal");
        summary.deadLetterTerminal += 1;
      } else {
        const delayMs = this.deadLetterBaseDelayMs * currentAttempts;
        await this.logRepo.rescheduleDeadLetter(row.id, result.errorMessage || "dead_letter_retry", delayMs);
        summary.deadLetterRescheduled += 1;
      }
    }
  }

  async publishRoundRoots({ roundId, roots, observedTicketCount, commitmentHash }) {
    const payloads = roots.map((r) =>
      createWinnerRootPayload({
        roundId,
        tier: r.tier,
        rootHash: r.rootHash,
        winnerCount: r.winnerCount,
        observedTicketCount,
        commitmentHash,
      }),
    );
    const txSignatures = [];
    let attempted = 0;
    let published = 0;
    let skipped = 0;
    let failed = 0;
    let deadLetterQueued = 0;
    const summary = {
      total: payloads.length,
      attempted: 0,
      published: 0,
      skipped: 0,
      failed: 0,
      deadLetterQueued: 0,
      deadLetterReplayed: 0,
      deadLetterResolved: 0,
      deadLetterRescheduled: 0,
      deadLetterTerminal: 0,
    };

    if (this.mode === "dry-run") {
      this.logger.log("[scanner] dry-run publish", JSON.stringify(payloads, null, 2));
      summary.skipped = payloads.length;
      summary.total = payloads.length;
      return {
        ok: true,
        mode: this.mode,
        txSignatures: [],
        summary,
      };
    }

    const { program, programId, wallet, connection } = getScannerProgram();
    const config = deriveConfigPda(programId);
    await this.replayDueDeadLetters({ program, wallet, config, connection, summary });

    for (const payload of payloads) {
      const round = deriveRoundPda(programId, payload.roundId);
      const scannerBond = deriveBondPda(programId, payload.roundId);
      const result = await this.publishOnePayload({
        payload,
        program,
        wallet,
        config,
        round,
        scannerBond,
        connection,
      });
      attempted += result.attempts || 0;
      if (result.state === "published") {
        txSignatures.push(result.signature);
        published += 1;
        continue;
      }
      if (result.state === "skipped") {
        if (result.signature) txSignatures.push(result.signature);
        skipped += 1;
        continue;
      }
      if (result.state === "failed") {
        failed += 1;
        const delayMs = this.deadLetterBaseDelayMs;
        await this.logRepo.upsertDeadLetter(payload, result.errorMessage || "publish_failed", delayMs);
        deadLetterQueued += 1;
      }
    }

    summary.attempted += attempted;
    summary.published += published;
    summary.skipped += skipped;
    summary.failed += failed;
    summary.deadLetterQueued += deadLetterQueued;
    this.logger.log(`[scanner] publish summary ${JSON.stringify(summary)}`);
    return { ok: failed === 0, mode: this.mode, txSignatures, summary };
  }
}
