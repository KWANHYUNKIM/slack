export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        // 타입 검사는 npm run build(tsc)가 맡는다. 테스트에서는 변환만 해 메모리(8GB 머신의 스왑)와 시간을 줄인다.
        isolatedModules: true,
      },
    ],
  },
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
  // 8GB 개발 머신에서 다른 작업과 CPU를 나눌 때 10초는 느린 꼬리 테스트를 오탐으로 만들었다(DB는 연결 16개, 142/256MiB로 여유).
  testTimeout: 30000,
  maxWorkers: 1,
};
