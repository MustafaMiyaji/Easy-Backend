module.exports = {
  testEnvironment: "node",
  coverageDirectory: "coverage",
  testEnvironmentOptions: {
    NODE_ENV: "test",
  },
  collectCoverageFrom: [
    "controllers/**/*.js",
    "middleware/**/*.js",
    "services/**/*.js",
    "routes/**/*.js",
    "!**/node_modules/**",
    "!**/tests/**",
  ],
  testMatch: ["**/tests/**/*.test.js"],
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  coverageThreshold: {
    global: {
      branches: 10,
      functions: 10,
      lines: 15,
      statements: 15,
    },
  },
  testTimeout: 60000, // Increased to 60 seconds for MongoDB operations
  verbose: true,
  forceExit: true,
  detectOpenHandles: false, // Don't warn about async handles
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  maxWorkers: 1, // Run tests sequentially to prevent resource exhaustion
};
