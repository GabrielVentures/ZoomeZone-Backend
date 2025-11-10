/**
 * Type definitions for ShelfTagSnap Cloud Functions
 */

import { Timestamp } from "firebase-admin/firestore";

// ==================== User Quota Types ====================

export interface UserQuota {
  daily_cost_limit_usd: number;
  daily_request_limit: number;
  enabled: boolean;
  today_usage: TodayUsage;
  rate_limit: RateLimit;
}

export interface TodayUsage {
  request_count: number;
  total_tokens: number;
  cost_usd: number;
  last_request_at?: Timestamp;
  last_reset_at?: Timestamp;
}

export interface RateLimit {
  per_minute: number;
  per_hour: number;
  recent_requests: Timestamp[];
}

// ==================== Global Config Types ====================

export interface GlobalAIConfig {
  global_limits: GlobalLimits;
  today_stats: TodayStats;
  cost_alerts: CostAlert[];
  default_user_quota: DefaultUserQuota;
}

export interface GlobalLimits {
  daily_cost_limit_usd: number;
  daily_request_limit: number;
  circuit_breaker_enabled: boolean;
  circuit_breaker_reason: string | null;
}

export interface TodayStats {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  failed_requests: number;
  quota_exceeded_count: number;
  last_reset_at?: Timestamp;
}

export interface CostAlert {
  threshold_usd: number;
  email: string;
  triggered: boolean;
  triggered_at?: Timestamp;
}

export interface DefaultUserQuota {
  daily_cost_limit_usd: number;
  daily_request_limit: number;
  enabled: boolean;
}

// ==================== Scan Record Types ====================

export interface ScanRecord {
  User_ID: string;
  Username: string;
  Timestamp: Timestamp;
  Merchant: string;
  Barcode_Info: BarcodeInfo;
  Store_Info: StoreInfo;
  Photo_Info: PhotoInfo;
  AI_Result?: AIResult;
  ai_processed: boolean;
  ai_processing_error?: string;
  ai_processing_error_message?: string;
  ai_processing_error_timestamp?: Timestamp;
  ai_tokens?: AITokens;
  ai_cost?: AICost;
  ai_metrics?: AIMetrics;
}

export interface BarcodeInfo {
  code: string;
  type: string;
  is_valid: boolean;
}

export interface StoreInfo {
  merchant_name: string;
  store_name?: string;
  latitude?: number;
  longitude?: number;
  location_accuracy?: number;
}

export interface PhotoInfo {
  filename: string;
  file_size?: number;
  width?: number;
  height?: number;
  compression_quality?: number;
  image_format: string;
}

export interface AIResult {
  product_name: string | null;
  price: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  confidence: number;
  processed_at?: Timestamp;
  raw_response?: string;
}

export interface AITokens {
  input: number;
  output: number;
  total: number;
}

export interface AICost {
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  currency: string;
  pricing_model: string;
}

export interface AIMetrics {
  model_used: string;
  processing_timestamp?: Timestamp;
}

// ==================== Quota Log Types ====================

export interface QuotaLog {
  timestamp: Timestamp;
  event_type: "quota_exceeded" | "circuit_breaker" | "rate_limit";
  user_id: string;
  scan_id?: string;
  details: Record<string, any>;
}

// ==================== Admin Log Types ====================

export interface AdminLog {
  action: string;
  admin_id: string;
  target_user_id?: string;
  changes: Record<string, any>;
  timestamp: Timestamp;
}

// ==================== API Request/Response Types ====================

export interface GetAIQuotaStatusRequest {
  userId?: string;
}

export interface GetAIQuotaStatusResponse {
  success: boolean;
  data: {
    user_quota: {
      daily_cost_limit_usd: number;
      daily_request_limit: number;
      enabled: boolean;
      today_usage: {
        request_count: number;
        cost_usd: number;
        remaining_requests: number;
        remaining_cost_usd: number;
        usage_percentage: string;
      };
    };
    global_status: {
      circuit_breaker_enabled: boolean;
      circuit_breaker_reason: string | null;
      today_cost_usd: number;
      today_limit_usd: number;
    };
  };
}

export interface UpdateUserAIQuotaRequest {
  userId: string;
  quota: {
    daily_cost_limit_usd?: number;
    daily_request_limit?: number;
    enabled?: boolean;
  };
}

export interface UpdateUserAIQuotaResponse {
  success: boolean;
  message: string;
}

export interface UpdateGlobalAIConfigRequest {
  global_limits?: {
    daily_cost_limit_usd?: number;
    daily_request_limit?: number;
    circuit_breaker_enabled?: boolean;
    circuit_breaker_reason?: string;
  };
}

export interface UpdateGlobalAIConfigResponse {
  success: boolean;
  message: string;
}

// ==================== OpenAI API Types ====================

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TokenMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
}

// ==================== Error Code Types ====================

export type AIProcessingErrorCode =
  | "QUOTA_EXCEEDED_DAILY_LIMIT"
  | "QUOTA_EXCEEDED_COST_LIMIT"
  | "QUOTA_DISABLED"
  | "GLOBAL_CIRCUIT_BREAKER"
  | "GLOBAL_QUOTA_EXCEEDED"
  | "WEBADMIN_BUDGET_EXCEEDED"
  | "RATE_LIMIT_EXCEEDED"
  | "USER_NOT_FOUND"
  | "PROCESSING_ERROR"
  | "UNKNOWN_ERROR";

// ==================== Activity Log Types ====================

export enum ActivityAction {
  // Budget Management
  BUDGET_CONFIG_UPDATE = "BUDGET_CONFIG_UPDATE",
  BUDGET_CONFIG_RESET = "BUDGET_CONFIG_RESET",

  // Scan Records
  SCAN_RECORD_CREATE = "SCAN_RECORD_CREATE",
  SCAN_RECORD_DELETE = "SCAN_RECORD_DELETE",
  SCAN_RECORD_BATCH_DELETE = "SCAN_RECORD_BATCH_DELETE",
  SCAN_RECORD_RETRY = "SCAN_RECORD_RETRY",
  SCAN_RECORD_BATCH_RETRY = "SCAN_RECORD_BATCH_RETRY",
  SCAN_RECORD_EXPORT = "SCAN_RECORD_EXPORT",

  // User Management
  USER_QUOTA_UPDATE = "USER_QUOTA_UPDATE",
  USER_ROLE_CHANGE = "USER_ROLE_CHANGE",
  USER_CREATE = "USER_CREATE",
  USER_DELETE = "USER_DELETE",

  // Global AI Config
  GLOBAL_AI_CONFIG_UPDATE = "GLOBAL_AI_CONFIG_UPDATE",
  CIRCUIT_BREAKER_TOGGLE = "CIRCUIT_BREAKER_TOGGLE",

  // System Events
  DAILY_QUOTA_RESET = "DAILY_QUOTA_RESET",
  COST_ALERT_TRIGGERED = "COST_ALERT_TRIGGERED",
}

export enum ResourceType {
  BUDGET_CONFIG = "budget_config",
  SCAN_RECORD = "scan_record",
  USER = "user",
  USER_QUOTA = "user_quota",
  GLOBAL_AI_CONFIG = "global_ai_config",
  SYSTEM = "system",
}

export enum ActivityLevel {
  INFO = "INFO",
  WARNING = "WARNING",
  CRITICAL = "CRITICAL",
}

export interface ActivityLogChanges {
  before: Record<string, any>;
  after: Record<string, any>;
  fields_changed: string[];
}

export interface ActivityLogMetadata {
  success: boolean;
  error?: string;
  duration_ms?: number;
  affected_count?: number;
  [key: string]: any;
}

export interface ActivityLog {
  timestamp: Timestamp;
  action: ActivityAction | string;
  resource_type: ResourceType | string;
  resource_id: string;
  user_id: string;
  user_email: string;
  user_role: string;
  level: ActivityLevel;
  description: string;
  changes?: ActivityLogChanges;
  ip_address?: string;
  user_agent?: string;
  metadata: ActivityLogMetadata;
}

// API Request/Response Types
export interface LogActivityRequest {
  action: ActivityAction | string;
  resource_type: ResourceType | string;
  resource_id: string;
  level?: ActivityLevel;
  description?: string;
  changes?: ActivityLogChanges;
  metadata?: Partial<ActivityLogMetadata>;
}

export interface GetAuditLogsRequest {
  page?: number;
  pageSize?: number;
  filters?: {
    user_id?: string;
    resource_type?: string;
    action?: string;
    level?: string;
    start_date?: string;
    end_date?: string;
  };
  sort?: {
    field: string;
    order: "asc" | "desc";
  };
}

export interface GetAuditLogsResponse {
  success: boolean;
  data: {
    logs: ActivityLog[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
}
