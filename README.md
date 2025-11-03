# ShelfTagSnap Cloud Functions

Firebase Cloud Functions for ShelfTagSnap - AI-powered shelf tag recognition with comprehensive cost control.

## 🚀 Features

### **OpenAI Cost Control System (5-Layer Security)**
1. **Global Circuit Breaker** - Emergency shutdown capability
2. **Global Quota Check** - System-wide daily limits ($100/day)
3. **User Quota Enabled Check** - Per-user AI processing toggle
4. **User Quota Limit Check** - Per-user daily limits ($10/day, 2000 requests/day)
5. **Rate Limiting** - Prevents abuse (10 requests/minute)

### **HTTP Callable Functions**
- `getAIQuotaStatus` - Get user quota status
- `updateUserAIQuota` - Admin: Update user quotas
- `updateGlobalAIConfig` - Admin: Control global settings and circuit breaker

### **Storage-Triggered Functions**
- `processImageUpload` - AI image processing with GPT-4o Vision

### **Scheduled Functions**
- `resetDailyQuotas` - Daily quota reset at 00:00 UTC+8
- `sendDailyCostReport` - Daily cost report at 23:50 UTC+8
- `checkCostAlerts` - Hourly cost alert checking

## 📦 Prerequisites

- Node.js 18+
- Firebase CLI: `npm install -g firebase-tools`
- OpenAI API Key
- Firebase project with:
  - Firestore Database
  - Cloud Storage
  - Cloud Functions
  - Authentication

## 🛠️ Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Firebase Configuration

```bash
# Login to Firebase
firebase login

# Set Firebase project
firebase use <your-project-id>
```

### 3. OpenAI API Key Configuration

```bash
# Set OpenAI API key as environment variable
firebase functions:config:set openai.key="sk-your-openai-api-key"

# Verify configuration
firebase functions:config:get
```

### 4. Initialize Firestore Data Structure

Run the initialization script to create required collections and documents:

```bash
# Run initialization script (create this separately)
node scripts/init-firestore.js
```

Or manually create in Firebase Console:
- Collection: `settings`, Document: `ai_global_config`
- Add `ai_quota` field to all `users` documents

See `docs/FIRESTORE_STRUCTURE.md` for detailed schema.

## 🏗️ Development

### Build

```bash
npm run build
```

### Local Testing

```bash
# Start Firebase emulators
npm run serve

# Test functions locally
firebase functions:shell
```

### Linting

```bash
# Check linting
npm run lint

# Fix linting issues
npm run lint:fix
```

## 🚢 Deployment

### Deploy All Functions

```bash
npm run deploy
```

### Deploy Specific Function

```bash
firebase deploy --only functions:processImageUpload
firebase deploy --only functions:getAIQuotaStatus
firebase deploy --only functions:resetDailyQuotas
```

### View Logs

```bash
# Real-time logs
firebase functions:log

# Specific function logs
firebase functions:log --only processImageUpload
```

## 📊 Firestore Data Structure

### users/{userId}

```typescript
{
  uid: string,
  email: string,
  role: "user" | "admin",

  ai_quota: {
    daily_cost_limit_usd: 10.0,
    daily_request_limit: 2000,
    enabled: true,

    today_usage: {
      request_count: 0,
      total_tokens: 0,
      cost_usd: 0.0,
      last_request_at: Timestamp,
      last_reset_at: Timestamp
    },

    rate_limit: {
      per_minute: 10,
      per_hour: 100,
      recent_requests: [Timestamp...]
    }
  }
}
```

### settings/ai_global_config

```typescript
{
  global_limits: {
    daily_cost_limit_usd: 100.0,
    daily_request_limit: 20000,
    circuit_breaker_enabled: false,
    circuit_breaker_reason: null
  },

  today_stats: {
    total_requests: 0,
    total_tokens: 0,
    total_cost_usd: 0.0,
    failed_requests: 0,
    quota_exceeded_count: 0,
    last_reset_at: Timestamp
  },

  cost_alerts: [
    { threshold_usd: 50, email: "admin@example.com", triggered: false },
    { threshold_usd: 80, email: "admin@example.com", triggered: false },
    { threshold_usd: 95, email: "admin@example.com", triggered: false }
  ],

  default_user_quota: {
    daily_cost_limit_usd: 10.0,
    daily_request_limit: 2000,
    enabled: true
  }
}
```

### scan_records/{scanId}

```typescript
{
  User_ID: string,
  Username: string,
  Timestamp: Timestamp,
  Merchant: string,

  ai_processed: boolean,
  ai_processing_error?: "QUOTA_EXCEEDED_COST_LIMIT" | "RATE_LIMIT_EXCEEDED" | ...,
  ai_processing_error_message?: string,

  ai_tokens?: {
    input: number,
    output: number,
    total: number
  },

  ai_cost?: {
    input_cost_usd: number,
    output_cost_usd: number,
    total_cost_usd: number,
    currency: "USD",
    pricing_model: "gpt-4-vision-preview"
  },

  AI_Result?: {
    product_name: string | null,
    price: string | null,
    brand: string | null,
    category: string | null,
    description: string | null,
    confidence: number
  }
}
```

## 🔒 Security

### Error Codes

- `QUOTA_EXCEEDED_COST_LIMIT` - User exceeded daily cost limit
- `QUOTA_EXCEEDED_DAILY_LIMIT` - User exceeded daily request limit
- `GLOBAL_CIRCUIT_BREAKER` - Global circuit breaker enabled
- `GLOBAL_QUOTA_EXCEEDED` - Global quota exceeded
- `QUOTA_DISABLED` - AI processing disabled for user
- `RATE_LIMIT_EXCEEDED` - Too many requests in short time
- `USER_NOT_FOUND` - User document not found

### Admin Functions

Only users with `role: "admin"` can call:
- `updateUserAIQuota`
- `updateGlobalAIConfig`

### Rate Limiting

- Default: 10 requests/minute per user
- Configurable per user via `ai_quota.rate_limit`

## 💰 Cost Estimation

### GPT-4o Vision Pricing
- Input: $5.00 / 1M tokens
- Output: $20.00 / 1M tokens

### Typical Usage
- Single image analysis: ~2000 tokens (~$0.005)
- 100 scans/day: ~$0.50/day
- 1000 scans/day: ~$5.00/day

### Default Limits
- User: $10/day (≈2000 scans)
- Global: $100/day (≈20000 scans)

## 📝 Development Workflow

1. **Make Changes** - Edit source files in `src/`
2. **Build** - `npm run build`
3. **Test Locally** - `npm run serve`
4. **Lint** - `npm run lint:fix`
5. **Deploy** - `npm run deploy`
6. **Monitor** - `npm run logs`

## 🐛 Troubleshooting

### Function Not Triggering

```bash
# Check function deployment status
firebase functions:list

# Check logs for errors
firebase functions:log --limit 50
```

### OpenAI API Errors

```bash
# Verify API key configuration
firebase functions:config:get

# Check OpenAI API usage at https://platform.openai.com/usage
```

### Quota Issues

```bash
# Check Firestore data
# Verify settings/ai_global_config exists
# Verify users have ai_quota field
```

## 📚 Resources

- [Firebase Functions Documentation](https://firebase.google.com/docs/functions)
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## 📄 License

UNLICENSED - Private project for ShelfTagSnap

## 👥 Authors

ShelfTagSnap Development Team

---

**Version**: 1.0.0
**Last Updated**: 2025-11-03
**Node Version**: 18
