import { getDatabase } from "./db.js";

/**
 * Records an operation failure for later retry or manual intervention.
 */
export function recordFailure(
  operationType: string,
  error: string,
  payload: object,
  listingId?: number,
  designId?: number,
): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO failed_operations
      (operation_type, listing_id, design_id, payload, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    operationType,
    listingId ?? null,
    designId ?? null,
    JSON.stringify(payload),
    error,
  );
}

/**
 * Marks a dead-letter row as resolved after a successful retry or manual fix.
 */
export function resolveFailure(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE failed_operations
    SET resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

/**
 * Increments the retry attempt counter and refreshes the attempted timestamp after another failure.
 */
export function incrementFailureAttempt(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE failed_operations
    SET attempts = attempts + 1,
        last_attempted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}
