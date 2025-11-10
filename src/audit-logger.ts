/**
 * Audit Logging Utility
 * Centralized logging for all administrative and critical actions
 */

import * as admin from "firebase-admin";
import {
  ActivityLog,
  ActivityAction,
  ResourceType,
  ActivityLevel,
  ActivityLogChanges,
  LogActivityRequest,
} from "./types";

/**
 * Log an activity to the activity_logs collection
 *
 * @param userId - User ID performing the action
 * @param userEmail - User email
 * @param request - Activity log details
 * @param context - Optional additional context (IP, user agent)
 */
export const logActivity = async (
  userId: string,
  userEmail: string,
  request: LogActivityRequest,
  context?: {
    ip_address?: string;
    user_agent?: string;
  }
): Promise<void> => {
  try {
    const db = admin.firestore();

    // Get user role
    let userRole = "user";
    try {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) {
        userRole = userDoc.data()?.role || "user";
      }
    } catch (error) {
      console.warn(`Failed to fetch user role for ${userId}:`, error);
    }

    const logEntry: ActivityLog = {
      timestamp: admin.firestore.FieldValue.serverTimestamp() as any,
      action: request.action,
      resource_type: request.resource_type,
      resource_id: request.resource_id,
      user_id: userId,
      user_email: userEmail,
      user_role: userRole,
      level: request.level || ActivityLevel.INFO,
      description: request.description || generateDescription(request),
      changes: request.changes,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
      metadata: {
        success: true,
        ...request.metadata,
      },
    };

    // Write to Firestore asynchronously (non-blocking)
    await db.collection("activity_logs").add(logEntry);

    console.log(`✅ [AuditLog] ${request.action} by ${userEmail} (${userId})`);
  } catch (error) {
    // Audit logging should not break the main flow
    console.error("❌ [AuditLog] Failed to log activity:", error);
  }
};

/**
 * Generate human-readable description from action
 */
const generateDescription = (request: LogActivityRequest): string => {
  const actionDescriptions: Record<string, string> = {
    [ActivityAction.BUDGET_CONFIG_UPDATE]: "Updated budget configuration",
    [ActivityAction.BUDGET_CONFIG_RESET]: "Reset budget configuration to defaults",
    [ActivityAction.SCAN_RECORD_DELETE]: "Deleted scan record",
    [ActivityAction.SCAN_RECORD_BATCH_DELETE]: "Batch deleted scan records",
    [ActivityAction.SCAN_RECORD_EXPORT]: "Exported scan records to CSV",
    [ActivityAction.USER_QUOTA_UPDATE]: "Updated user AI quota",
    [ActivityAction.GLOBAL_AI_CONFIG_UPDATE]: "Updated global AI configuration",
    [ActivityAction.CIRCUIT_BREAKER_TOGGLE]: "Toggled circuit breaker",
  };

  return actionDescriptions[request.action] || `Performed ${request.action}`;
};

/**
 * Specialized function: Log budget configuration change
 */
export const logBudgetChange = async (
  userId: string,
  userEmail: string,
  before: any,
  after: any
): Promise<void> => {
  const changes = calculateChanges(before, after);

  await logActivity(userId, userEmail, {
    action: ActivityAction.BUDGET_CONFIG_UPDATE,
    resource_type: ResourceType.BUDGET_CONFIG,
    resource_id: "budget_config",
    level: ActivityLevel.INFO,
    description: `Updated budget configuration: ${changes.fields_changed.join(", ")}`,
    changes,
    metadata: {
      success: true,
    },
  });
};

/**
 * Specialized function: Log budget configuration reset
 */
export const logBudgetReset = async (
  userId: string,
  userEmail: string
): Promise<void> => {
  await logActivity(userId, userEmail, {
    action: ActivityAction.BUDGET_CONFIG_RESET,
    resource_type: ResourceType.BUDGET_CONFIG,
    resource_id: "budget_config",
    level: ActivityLevel.WARNING,
    description: "Reset budget configuration to default values",
    metadata: {
      success: true,
    },
  });
};

/**
 * Specialized function: Log scan record deletion
 */
export const logScanRecordDelete = async (
  userId: string,
  userEmail: string,
  recordId: string,
  recordData: any
): Promise<void> => {
  await logActivity(userId, userEmail, {
    action: ActivityAction.SCAN_RECORD_DELETE,
    resource_type: ResourceType.SCAN_RECORD,
    resource_id: recordId,
    level: ActivityLevel.WARNING,
    description: `Deleted scan record: ${recordData.Barcode || recordId}`,
    changes: {
      before: recordData,
      after: {},
      fields_changed: ["deleted"],
    },
    metadata: {
      success: true,
    },
  });
};

/**
 * Specialized function: Log batch scan record deletion
 */
export const logBatchScanRecordDelete = async (
  userId: string,
  userEmail: string,
  recordIds: string[],
  successCount: number,
  failCount: number
): Promise<void> => {
  await logActivity(userId, userEmail, {
    action: ActivityAction.SCAN_RECORD_BATCH_DELETE,
    resource_type: ResourceType.SCAN_RECORD,
    resource_id: "batch",
    level: failCount > 0 ? ActivityLevel.WARNING : ActivityLevel.INFO,
    description: `Batch deleted ${successCount} scan records (${failCount} failed)`,
    metadata: {
      success: failCount === 0,
      affected_count: successCount,
      failed_count: failCount,
      record_ids: recordIds,
    },
  });
};

/**
 * Specialized function: Log scan record export
 */
export const logScanRecordExport = async (
  userId: string,
  userEmail: string,
  recordCount: number,
  filters: any
): Promise<void> => {
  await logActivity(userId, userEmail, {
    action: ActivityAction.SCAN_RECORD_EXPORT,
    resource_type: ResourceType.SCAN_RECORD,
    resource_id: "export",
    level: ActivityLevel.INFO,
    description: `Exported ${recordCount} scan records to CSV`,
    metadata: {
      success: true,
      affected_count: recordCount,
      filters,
    },
  });
};

/**
 * Specialized function: Log user quota change
 */
export const logUserQuotaChange = async (
  adminId: string,
  adminEmail: string,
  targetUserId: string,
  changes: any
): Promise<void> => {
  await logActivity(adminId, adminEmail, {
    action: ActivityAction.USER_QUOTA_UPDATE,
    resource_type: ResourceType.USER_QUOTA,
    resource_id: targetUserId,
    level: ActivityLevel.INFO,
    description: `Updated AI quota for user ${targetUserId}`,
    changes: {
      before: {},
      after: changes,
      fields_changed: Object.keys(changes),
    },
    metadata: {
      success: true,
      target_user_id: targetUserId,
    },
  });
};

/**
 * Specialized function: Log global AI config change
 */
export const logGlobalAIConfigChange = async (
  adminId: string,
  adminEmail: string,
  changes: any
): Promise<void> => {
  const level = changes.circuit_breaker_enabled !== undefined
    ? ActivityLevel.CRITICAL
    : ActivityLevel.INFO;

  await logActivity(adminId, adminEmail, {
    action: ActivityAction.GLOBAL_AI_CONFIG_UPDATE,
    resource_type: ResourceType.GLOBAL_AI_CONFIG,
    resource_id: "ai_global_config",
    level,
    description: "Updated global AI configuration",
    changes: {
      before: {},
      after: changes,
      fields_changed: Object.keys(changes),
    },
    metadata: {
      success: true,
    },
  });
};

/**
 * Specialized function: Log circuit breaker toggle
 */
export const logCircuitBreakerToggle = async (
  adminId: string,
  adminEmail: string,
  enabled: boolean,
  reason?: string
): Promise<void> => {
  await logActivity(adminId, adminEmail, {
    action: ActivityAction.CIRCUIT_BREAKER_TOGGLE,
    resource_type: ResourceType.GLOBAL_AI_CONFIG,
    resource_id: "ai_global_config",
    level: ActivityLevel.CRITICAL,
    description: `Circuit breaker ${enabled ? "enabled" : "disabled"}${reason ? `: ${reason}` : ""}`,
    changes: {
      before: { circuit_breaker_enabled: !enabled },
      after: { circuit_breaker_enabled: enabled, circuit_breaker_reason: reason },
      fields_changed: ["circuit_breaker_enabled", "circuit_breaker_reason"],
    },
    metadata: {
      success: true,
    },
  });
};

/**
 * Helper: Calculate changes between two objects
 */
const calculateChanges = (
  before: Record<string, any>,
  after: Record<string, any>
): ActivityLogChanges => {
  const fieldsChanged: string[] = [];

  // Check all keys in both objects
  const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  allKeys.forEach((key) => {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      fieldsChanged.push(key);
    }
  });

  return {
    before: before || {},
    after: after || {},
    fields_changed: fieldsChanged,
  };
};

/**
 * Batch log multiple activities (for bulk operations)
 */
export const logBatchActivities = async (
  logs: Array<{
    userId: string;
    userEmail: string;
    request: LogActivityRequest;
  }>
): Promise<void> => {
  const db = admin.firestore();
  const batch = db.batch();

  for (const log of logs) {
    const logRef = db.collection("activity_logs").doc();
    const logEntry: ActivityLog = {
      timestamp: admin.firestore.FieldValue.serverTimestamp() as any,
      action: log.request.action,
      resource_type: log.request.resource_type,
      resource_id: log.request.resource_id,
      user_id: log.userId,
      user_email: log.userEmail,
      user_role: "user", // Will be filled in actual implementation
      level: log.request.level || ActivityLevel.INFO,
      description: log.request.description || generateDescription(log.request),
      changes: log.request.changes,
      metadata: {
        success: true,
        ...log.request.metadata,
      },
    };

    batch.set(logRef, logEntry);
  }

  try {
    await batch.commit();
    console.log(`✅ [AuditLog] Batch logged ${logs.length} activities`);
  } catch (error) {
    console.error("❌ [AuditLog] Failed to batch log activities:", error);
  }
};
