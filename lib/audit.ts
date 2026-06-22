import { getDatabase } from "./db.js";
import { createLogger } from "./logger.js";

export type AuditAction =
  | "approve"
  | "reject"
  | "publish"
  | "fulfill"
  | "reject_legal"
  | "design_generated"
  | "order_received"
  | "tracking_updated"
  | "budget_alert"
  | "provider_down"
  | "run_operation";

export type AuditActor = "human" | "feintsupply" | "system";
const logger = createLogger("audit");

/**
 * Appends one structured audit event to the local audit log table.
 */
export function auditLog(
  action: AuditAction,
  actor: AuditActor,
  details: object,
  listingId?: number,
  designId?: number,
): boolean {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO audit_log
        (action, actor, listing_id, design_id, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      action,
      actor,
      listingId ?? null,
      designId ?? null,
      JSON.stringify(details),
    );
    return true;
  } catch (error) {
    logger.error("Failed to record audit event", error, { action, actor, listingId, designId });
    return false;
  }
}
