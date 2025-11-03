# Quick Setup Guide

Follow these steps to get the backend up and running.

## 1. Install Dependencies

```bash
npm install
```

## 2. Configure Firebase Project

```bash
# Copy template and edit with your project ID
cp .firebaserc.template .firebaserc

# Edit .firebaserc and replace "your-firebase-project-id" with your actual Firebase project ID
# Example: "shelftagsnap-12345"
```

Or create `.firebaserc` manually:
```json
{
  "projects": {
    "default": "your-actual-project-id"
  }
}
```

## 3. Set OpenAI API Key

```bash
# Login to Firebase
firebase login

# Set OpenAI API key
firebase functions:config:set openai.key="sk-your-actual-openai-api-key"

# Verify
firebase functions:config:get
```

## 4. Initialize Firestore Data

**Option A: Via Firebase Console (Recommended for first-time setup)**

1. Go to Firebase Console → Firestore Database
2. Create collection: `settings`
3. Create document: `ai_global_config`
4. Copy-paste the structure from `DEPLOYMENT.md` Step 4.1

**Option B: Via Script (Coming Soon)**

```bash
# This will be implemented in the next phase
node scripts/init-firestore.js
```

## 5. Build and Deploy

```bash
# Build TypeScript
npm run build

# Deploy to Firebase
npm run deploy
```

## 6. Verify Deployment

```bash
# Check function status
firebase functions:list

# View logs
firebase functions:log
```

## Next Steps

See `DEPLOYMENT.md` for complete deployment guide including:
- Firestore security rules
- Testing checklist
- Monitoring setup

## Quick Commands

```bash
# Development
npm run serve          # Start local emulators
npm run build          # Build TypeScript
npm run lint           # Check linting
npm run lint:fix       # Fix linting issues

# Deployment
npm run deploy         # Deploy all functions
firebase functions:log # View logs

# Configuration
firebase functions:config:get                    # View config
firebase functions:config:set openai.key="..."   # Set API key
```

## Troubleshooting

### "Permission denied" errors
- Ensure you're logged in: `firebase login`
- Verify project ID in `.firebaserc`

### "OpenAI API key not found"
- Set the config: `firebase functions:config:set openai.key="sk-..."`
- Redeploy: `npm run deploy`

### Functions not triggering
- Check Cloud Scheduler is enabled
- View logs: `firebase functions:log`
- Verify Firestore data structure exists

For more help, see `README.md` and `DEPLOYMENT.md`.
