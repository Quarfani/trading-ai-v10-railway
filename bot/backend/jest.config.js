/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        useUnknownInCatchVariables: false,
      },
      diagnostics: false,
    }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  testTimeout: 60000,
  verbose: true,
  // Handle better-sqlite3 native module
  transformIgnorePatterns: ['/node_modules/(?!(some-esm-pkg)/)'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
    '!src/index.ts',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  // Prevent open handles
  forceExit: true,
  detectOpenHandles: false,
};
