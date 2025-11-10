/**
 * Test Setup - Initialize Firebase Functions Test SDK
 */

// Set environment variables for testing
process.env.GCLOUD_PROJECT = 'test-project';
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.OPENAI_API_KEY = 'test-api-key';

// Mock console methods to reduce test output noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
