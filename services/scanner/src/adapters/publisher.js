import { createWinnerRootPayload } from "../../../../packages/shared/src/index.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  deriveBondPda,
  deriveConfigPda,
  deriveRoundPda,
  getScannerProgram,
  hexToU8_32,
} from "../solana/openjack.js";
import { PublishLogRepo } from "../repo/publishLog.js";
import { TicketLedgerRepo } from "../repo/ticketLedger.js";

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
    this.autoSealSnapshots = process.env.SCANNER_AUTO_SEAL_SNAPSHOT !== "false";
    this.requireSealedSnapshots = process.env.SCANNER_REQUIRE_SEALED_SNAPSHOT !== "false";
    this.logRepo = new PublishLogRepo();
    this.ledgerRepo = new TicketLedgerRepo();
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
      const canPublish = await this.canPublishRoundNow({ program, roundId: Number(row.round_id), connection });
      if (!canPublish.ok) {
        this.logger.log(
          `[scanner] skip dead-letter replay round=${row.round_id} tier=${row.tier}: ${canPublish.reason}`,
        );
        continue;
      }
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
      await this.ensureScannerBondPosted({
        program,
        wallet,
        config,
        round,
        scannerBond,
        connection,
        roundId: payload.roundId,
      });
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

  async publishRoundRoots({ roundId, roots, observedTicketCount, commitmentHash, prechecked = null }) {
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
        metrics: {
          artifact_source: "sealed_snapshot",
          t_publish_roots_total_ms: 0,
          per_tier_publish_latency_ms: {},
        },
      };
    }

    const { program, programId, wallet, connection } = getScannerProgram();
    const config = deriveConfigPda(programId);
    const canPublish = prechecked || (await this.canPublishRoundNow({ program, roundId, connection }));
    if (!canPublish.ok) {
      throw new Error(`publish_precondition_failed round=${roundId} reason=${canPublish.reason}`);
    }
    this.logger.log(`[scanner] artifact_source=sealed_snapshot round=${roundId} phase=publish`);

    await this.replayDueDeadLetters({ program, wallet, config, connection, summary });

    const currentRound = deriveRoundPda(programId, roundId);
    const currentRoundBond = deriveBondPda(programId, roundId);
    await this.ensureScannerBondPosted({
      program,
      wallet,
      config,
      round: currentRound,
      scannerBond: currentRoundBond,
      connection,
      roundId,
    });

    const publishStart = Date.now();
    const perTierPublishLatencyMs = {};
    for (const payload of payloads) {
      const tierStart = Date.now();
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
        perTierPublishLatencyMs[String(payload.tier)] = Date.now() - tierStart;
        continue;
      }
      if (result.state === "skipped") {
        if (result.signature) txSignatures.push(result.signature);
        skipped += 1;
        perTierPublishLatencyMs[String(payload.tier)] = Date.now() - tierStart;
        continue;
      }
      if (result.state === "failed") {
        failed += 1;
        perTierPublishLatencyMs[String(payload.tier)] = Date.now() - tierStart;
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
    const metrics = {
      artifact_source: "sealed_snapshot",
      t_ingest_to_watermark_ms: Number(canPublish.metrics?.t_ingest_to_watermark_ms || 0),
      t_seal_snapshot_ms: Number(canPublish.metrics?.t_seal_snapshot_ms || 0),
      t_publish_roots_total_ms: Date.now() - publishStart,
      per_tier_publish_latency_ms: perTierPublishLatencyMs,
      close_slot: Number(canPublish.metrics?.close_slot || 0),
      finalized_watermark_slot: Number(canPublish.metrics?.finalized_watermark_slot || 0),
    };
    this.logger.log(`[scanner] publish summary ${JSON.stringify(summary)}`);
    this.logger.log(`[scanner] publish metrics ${JSON.stringify(metrics)}`);
    return { ok: failed === 0, mode: this.mode, txSignatures, summary, metrics };
  }

  async ensureScannerBondPosted({ program, wallet, config, round, scannerBond, connection, roundId }) {
    const configAccount = await program.account.lotteryConfig.fetch(config);
    const officialScanner = configAccount.officialScannerPubkey || configAccount.official_scanner_pubkey;
    if (officialScanner && !new PublicKey(officialScanner).equals(wallet.publicKey)) {
      throw new Error(
        `scanner wallet mismatch: wallet=${wallet.publicKey.toBase58()} official_scanner=${new PublicKey(officialScanner).toBase58()}. ` +
          "Update config via set_official_scanner or set SCANNER_KEYPAIR_PATH to the configured scanner keypair.",
      );
    }

    let bondAccount = null;
    try {
      bondAccount = await program.account.scannerBond.fetch(scannerBond);
    } catch {
      bondAccount = null;
    }
    if (bondAccount?.posted) {
      return;
    }
    const sig = await program.methods
      .postScannerBond()
      .accounts({
        scanner: wallet.publicKey,
        config,
        round,
        scannerBond,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await this.waitForConfirmation(connection, sig);
    this.logger.log(`[scanner] postScannerBond round=${roundId} sig=${sig}`);
  }

  async canPublishRoundNow({ program, roundId, connection }) {
    const t0 = Date.now();
    let tSealSnapshotMs = 0;
    const conn = connection || program.provider?.connection;
    if (!conn) {
      return { ok: false, reason: "missing_connection_for_readiness" };
    }
    const roundPda = deriveRoundPda(program.programId, roundId);
    let roundAccount;
    try {
      roundAccount = await program.account.round.fetch(roundPda);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `round_fetch_failed ${message}` };
    }
    const status = Number(roundAccount.status);
    if (status !== 3) {
      return { ok: false, reason: `round_status=${status} (requires SETTLING=3)` };
    }
    const now = Math.floor(Date.now() / 1000);
    const settleDeadline = Number(roundAccount.settleDeadlineTs || roundAccount.settle_deadline_ts || 0);
    if (settleDeadline > 0 && now > settleDeadline) {
      return { ok: false, reason: `settlement_window_closed now=${now} deadline=${settleDeadline}` };
    }
    const onchainTicketCount = Number(roundAccount.ticketCount || roundAccount.ticket_count || 0);
    const finalizedWatermarkSlot = Number(await conn.getSlot("finalized"));
    const closeSlot = status >= 1 ? finalizedWatermarkSlot : 0;

    await this.ledgerRepo.updateRoundWatermark({
      roundId,
      closeSlot,
      finalizedWatermarkSlot,
      onchainTicketCount,
    });
    await this.ledgerRepo.refreshRoundCounts(roundId);
    const tIngestToWatermarkMs = Date.now() - t0;

    let readiness = await this.ledgerRepo.getReadiness(roundId, { requireSealed: false });
    if (!readiness.ready) {
      return { ok: false, reason: `ledger_not_ready ${readiness.readinessReason}` };
    }

    if (this.autoSealSnapshots && !readiness.sealed) {
      const sealStart = Date.now();
      try {
        const snapshot = await this.ledgerRepo.sealRoundSnapshot(roundId, {
          schemaVersion: Number(process.env.SCANNER_SNAPSHOT_SCHEMA_VERSION || 1),
          createdBy: "scanner",
        });
        tSealSnapshotMs = Date.now() - sealStart;
        if (snapshot?.snapshotHashHex) {
          this.logger.log(
            `[scanner] sealed round=${roundId} snapshot_hash=${snapshot.snapshotHashHex} rows=${snapshot.rowCount}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `snapshot_seal_failed ${message}` };
      }
    }

    readiness = await this.ledgerRepo.getReadiness(roundId, { requireSealed: this.requireSealedSnapshots });
    if (!readiness.ready) {
      return { ok: false, reason: `ledger_not_publishable ${readiness.readinessReason}` };
    }

    if (this.requireSealedSnapshots) {
      const snapshot = await this.ledgerRepo.getSnapshot(roundId);
      if (!snapshot?.snapshot_hash_hex) {
        return { ok: false, reason: "missing_sealed_snapshot" };
      }
    }

    return {
      ok: true,
      reason: "ok",
      metrics: {
        t_ingest_to_watermark_ms: tIngestToWatermarkMs,
        t_seal_snapshot_ms: tSealSnapshotMs,
        close_slot: closeSlot,
        finalized_watermark_slot: finalizedWatermarkSlot,
      },
    };
  }
}
