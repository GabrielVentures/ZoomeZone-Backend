/**
 * Audit Log Query Functions
 * Provides API endpoints for querying and creating activity logs
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { GetAuditLogsRequest, GetAuditLogsResponse } from "./types";

/**
 * Interface for Log Activity Request
 */
interface LogActivityRequest {
  action: string;
  resource_type: string;
  resource_id: string;
  user_id: string;
  user_email: string;
  level: "INFO" | "WARNING" | "CRITICAL";
  description: string;
  changes?: {
    fields_changed: string[];
    before: Record<string, any>;
    after: Record<string, any>;
  };
  metadata?: Record<string, any>;
}

/**
 * Helper function to check if user is admin
 */
const isAdmin = async (userId: string): Promise<boolean> => {
  try {
    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    if (!userDoc.exists) return false;
    return userDoc.data()?.role === "admin";
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
};

/**
 * Get audit logs with filtering and pagination
 * Callable by: Admins only
 */
export const getAuditLogs = functions.https.onCall(
  async (
    data: GetAuditLogsRequest,
    context: functions.https.CallableContext
  ): Promise<GetAuditLogsResponse> => {
    try {
      // 1. Check authentication
      if (!context.auth) {
        throw new functions.https.HttpsError(
          "unauthenticated",
          "User must be authenticated"
        );
      }

      // 2. Check admin permission
      const isAdminUser = await isAdmin(context.auth.uid);
      if (!isAdminUser) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Only admins can view audit logs"
        );
      }

      // 3. Parse request parameters
      const page = data.page || 1;
      const pageSize = Math.min(data.pageSize || 50, 100); // Max 100 items per page
      const filters = data.filters || {};
      const sort = data.sort || { field: "timestamp", order: "desc" };

      console.log(`📊 [AuditLogs] Fetching page ${page}, size ${pageSize}`);

      // 4. Build query with filters
      let query: admin.firestore.Query = admin.firestore().collection("activity_logs");

      // Apply filters
      if (filters.user_id) {
        query = query.where("user_id", "==", filters.user_id);
      }
      if (filters.resource_type) {
        query = query.where("resource_type", "==", filters.resource_type);
      }
      if (filters.action) {
        query = query.where("action", "==", filters.action);
      }
      if (filters.level) {
        query = query.where("level", "==", filters.level);
      }
      if (filters.start_date) {
        query = query.where("timestamp", ">=", new Date(filters.start_date));
      }
      if (filters.end_date) {
        query = query.where("timestamp", "<=", new Date(filters.end_date));
      }

      // 5. Apply sorting
      query = query.orderBy(
        sort.field as any,
        sort.order === "asc" ? "asc" : "desc"
      );

      // 6. Get total count (for pagination)
      const countQuery = query;
      const countSnapshot = await countQuery.count().get();
      const total = countSnapshot.data().count;

      // 7. Apply pagination
      const offset = (page - 1) * pageSize;
      query = query.limit(pageSize).offset(offset);

      // 8. Execute query
      const snapshot = await query.get();
      const logs = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      console.log(`✅ [AuditLogs] Returned ${logs.length} logs (total: ${total})`);

      return {
        success: true,
        data: {
          logs: logs as any[],
          total,
          page,
          pageSize,
          hasMore: offset + logs.length < total,
        },
      };
    } catch (error) {
      console.error("❌ [AuditLogs] Error fetching audit logs:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        "Failed to fetch audit logs"
      );
    }
  }
);

/**
 * Log Activity
 * Create a new audit log entry
 * Callable by: All authenticated users (role is fetched and stored)
 */
export const logActivity = functions.https.onCall(
  async (
    data: LogActivityRequest,
    context: functions.https.CallableContext
  ): Promise<{ success: boolean; logId?: string }> => {
    try {
      // 1. Check authentication
      if (!context.auth) {
        throw new functions.https.HttpsError(
          "unauthenticated",
          "User must be authenticated to log activities"
        );
      }

      // 2. Get user role from Firestore
      const userDoc = await admin
        .firestore()
        .collection("users")
        .doc(context.auth.uid)
        .get();

      if (!userDoc.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          "User profile not found"
        );
      }

      const userRole = userDoc.data()?.role || "user";

      // 3. Prepare log entry
      const logEntry = {
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        action: data.action,
        resource_type: data.resource_type,
        resource_id: data.resource_id,
        user_id: context.auth.uid,
        user_email: data.user_email || context.auth.token.email || "unknown",
        user_role: userRole,
        level: data.level || "INFO",
        description: data.description,
        changes: data.changes || null,
        metadata: data.metadata || {},
        // Optional: Add IP address and user agent if available
        // ip_address: context.rawRequest?.ip,
        // user_agent: context.rawRequest?.headers['user-agent'],
      };

      console.log(`📝 [LogActivity] Creating log: ${data.action} by ${data.user_email}`);

      // 4. Write to Firestore
      const docRef = await admin
        .firestore()
        .collection("activity_logs")
        .add(logEntry);

      console.log(`✅ [LogActivity] Log created with ID: ${docRef.id}`);

      return {
        success: true,
        logId: docRef.id,
      };
    } catch (error) {
      console.error("❌ [LogActivity] Error creating audit log:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        "Failed to create audit log"
      );
    }
  }
);
