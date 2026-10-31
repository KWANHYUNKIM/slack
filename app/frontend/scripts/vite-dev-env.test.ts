import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEV_API_TARGET,
  DEFAULT_DEV_PORT,
  devApiTargetPort,
  resolveDevApiTarget,
  resolveDevPort,
} from './vite-dev-env.ts';

describe('VITE_DEV_API_TARGET 해석', () => {
  test('없거나 비어 있으면 기본값 localhost:3000', () => {
    assert.equal(resolveDevApiTarget(undefined), 'http://localhost:3000');
    assert.equal(resolveDevApiTarget(''), DEFAULT_DEV_API_TARGET);
    assert.equal(resolveDevApiTarget('   '), DEFAULT_DEV_API_TARGET);
  });

  test('http와 https의 host:port를 그대로 받는다', () => {
    assert.equal(resolveDevApiTarget('http://localhost:3120'), 'http://localhost:3120');
    assert.equal(resolveDevApiTarget('https://127.0.0.1:8443'), 'https://127.0.0.1:8443');
    assert.equal(resolveDevApiTarget('http://[::1]:3120'), 'http://[::1]:3120');
  });

  test('앞뒤 공백과 끝 슬래시는 정리해서 받는다', () => {
    assert.equal(resolveDevApiTarget('  http://localhost:3120/ '), 'http://localhost:3120');
  });

  test('형식이 잘못되면 오류를 던진다', () => {
    const bad = [
      'localhost:3120', // 스킴 없음
      'ftp://localhost:3120', // 허용하지 않는 스킴
      'http://localhost', // 포트 없음
      'http://localhost:', // 포트가 빈 값
      'http://localhost:abc', // 숫자가 아닌 포트
      'http://localhost:3120/api', // 경로
      'http://localhost:3120?x=1', // 쿼리
      'http://localhost:3120#x', // 해시
      'http://user:pw@localhost:3120', // 계정 정보
      'http://local host:3120', // 공백이 든 호스트
      'http://localhost:3120 http://example.com:80', // 여러 값
    ];
    for (const value of bad) {
      assert.throws(() => resolveDevApiTarget(value), /VITE_DEV_API_TARGET/, value);
    }
  });

  test('이 컴퓨터 밖의 호스트는 거부한다', () => {
    for (const value of ['http://example.com:3000', 'https://10.0.0.5:3120', 'http://[2001:db8::1]:3000', 'http://api.local:3000']) {
      assert.throws(() => resolveDevApiTarget(value), /localhost, 127\.0\.0\.1/, value);
    }
    assert.equal(resolveDevApiTarget('http://LOCALHOST:3120'), 'http://LOCALHOST:3120');
  });

  test('포트 범위(1-65535)를 벗어나면 오류를 던진다', () => {
    assert.throws(() => resolveDevApiTarget('http://localhost:0'), /범위/);
    assert.throws(() => resolveDevApiTarget('http://localhost:65536'), /범위/);
    assert.equal(resolveDevApiTarget('http://localhost:65535'), 'http://localhost:65535');
    assert.equal(resolveDevApiTarget('http://localhost:1'), 'http://localhost:1');
  });

  test('프록시 포트는 마지막 콜론 뒤에서 읽는다', () => {
    assert.equal(devApiTargetPort('http://localhost:3120'), 3120);
    assert.equal(devApiTargetPort('http://[::1]:3121'), 3121);
    assert.equal(devApiTargetPort('http://localhost:80'), 80);
  });
});

describe('VITE_DEV_PORT 해석', () => {
  test('없거나 비어 있으면 기본값 5173', () => {
    assert.equal(resolveDevPort(undefined), DEFAULT_DEV_PORT);
    assert.equal(resolveDevPort(''), 5173);
    assert.equal(resolveDevPort(' '), 5173);
  });

  test('1-65535 정수는 그대로 받는다', () => {
    assert.equal(resolveDevPort('5190'), 5190);
    assert.equal(resolveDevPort(' 3120 '), 3120);
    assert.equal(resolveDevPort('1'), 1);
    assert.equal(resolveDevPort('65535'), 65535);
  });

  test('정수가 아니거나 범위를 벗어나면 오류를 던진다', () => {
    const bad = ['0', '65536', '-1', '5173.5', 'abc', '5190abc', '1e3', '0x1F90', '999999'];
    for (const value of bad) {
      assert.throws(() => resolveDevPort(value), /VITE_DEV_PORT/, value);
    }
  });
});

describe('설정 생성, 조회, 수정, 삭제 반복', () => {
  // 환경 변수를 객체로 흉내 낸다. 설정(Create), 조회(Read), 수정(Update), 삭제(Delete 후 기본값 복귀)를 번갈아 확인한다.
  test('대상과 포트를 설정하고 고치고 지우면 기본값으로 돌아온다', () => {
    const env: Record<string, string | undefined> = {};
    const read = () => ({
      target: resolveDevApiTarget(env.VITE_DEV_API_TARGET),
      port: resolveDevPort(env.VITE_DEV_PORT),
    });

    assert.deepEqual(read(), { target: 'http://localhost:3000', port: 5173 });

    env.VITE_DEV_API_TARGET = 'http://localhost:3120';
    env.VITE_DEV_PORT = '5190';
    assert.deepEqual(read(), { target: 'http://localhost:3120', port: 5190 });

    env.VITE_DEV_API_TARGET = 'https://localhost:3121';
    assert.deepEqual(read(), { target: 'https://localhost:3121', port: 5190 });

    env.VITE_DEV_API_TARGET = 'http://localhost';
    assert.throws(read, /VITE_DEV_API_TARGET/);

    env.VITE_DEV_API_TARGET = 'http://localhost:3121';
    assert.deepEqual(read(), { target: 'http://localhost:3121', port: 5190 });

    delete env.VITE_DEV_API_TARGET;
    delete env.VITE_DEV_PORT;
    assert.deepEqual(read(), { target: 'http://localhost:3000', port: 5173 });
  });
});
