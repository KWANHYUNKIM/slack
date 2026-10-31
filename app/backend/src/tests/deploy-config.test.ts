// 배포 설정 순수 함수: DATABASE_URL 조합, migrate 오류 판정, TRUST_PROXY, PUBLIC_URL.
import { buildDatabaseUrl } from '../ops/databaseUrl.js';
import { classifyMigrateOutput } from '../ops/migrateErrors.js';
import { parseTrustProxy, isHttpPublicUrl, useSecureTransport } from '../runtimeConfig.js';

describe('buildDatabaseUrl', () => {
  it('DATABASE_URL이 있으면 그대로 쓴다', () => {
    expect(buildDatabaseUrl({ DATABASE_URL: 'postgresql://a:b@h:1/d' })).toBe('postgresql://a:b@h:1/d');
  });

  it('특수문자가 든 비밀번호를 인코딩하고 URL로 다시 읽으면 원본과 같다', () => {
    const password = 'p@ss:w/rd?#%&=+ 한글$!';
    const url = buildDatabaseUrl({ PGHOST: 'db', PGUSER: 'pg user', PGPASSWORD: password, PGDATABASE: 'slackclone' });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('db');
    expect(parsed.port).toBe('5432');
    expect(decodeURIComponent(parsed.username)).toBe('pg user');
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(parsed.pathname).toBe('/slackclone');
  });

  it('PGPORT 기본값은 5432이고 잘못된 값은 거부한다', () => {
    const base = { PGHOST: 'db', PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd' };
    expect(buildDatabaseUrl(base)).toContain('@db:5432/d');
    expect(buildDatabaseUrl({ ...base, PGPORT: '5434' })).toContain('@db:5434/d');
    expect(() => buildDatabaseUrl({ ...base, PGPORT: '54/34' })).toThrow('PGPORT');
  });

  it('IPv6 호스트를 대괄호로 감싼다', () => {
    const url = buildDatabaseUrl({ PGHOST: '::1', PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd' });
    expect(new URL(url).hostname).toBe('[::1]');
  });

  it('필수 변수가 빠지면 어떤 것이 빠졌는지 알려 준다', () => {
    expect(() => buildDatabaseUrl({ PGHOST: 'db' })).toThrow(/PGUSER, PGPASSWORD, PGDATABASE/);
  });
});

describe('classifyMigrateOutput', () => {
  it('연결 실패는 재시도한다', () => {
    expect(classifyMigrateOutput("Error: P1001: Can't reach database server at `db:5432`")).toBe('retry');
    expect(classifyMigrateOutput('Error: P1002 timed out')).toBe('retry');
    expect(classifyMigrateOutput("Can't reach database server")).toBe('retry');
  });

  it('마이그레이션 오류는 바로 실패시킨다', () => {
    expect(classifyMigrateOutput('Error: P3009 migrate found failed migrations')).toBe('fatal');
    expect(classifyMigrateOutput('Error: P3018 A migration failed to apply')).toBe('fatal');
    expect(classifyMigrateOutput('Error: P3005 The database schema is not empty')).toBe('fatal');
  });

  it('마이그레이션 코드가 연결 코드와 함께 있으면 마이그레이션 오류가 우선한다', () => {
    expect(classifyMigrateOutput('P1001 earlier\nP3018 migration failed')).toBe('fatal');
  });

  it('인증 실패, 알 수 없는 출력, 빈 출력은 재시도하지 않는다', () => {
    expect(classifyMigrateOutput('Error: P1000 Authentication failed')).toBe('fatal');
    expect(classifyMigrateOutput('something unexpected')).toBe('fatal');
    expect(classifyMigrateOutput('')).toBe('fatal');
  });
});

describe('parseTrustProxy', () => {
  it('기본값은 0(신뢰 안 함)', () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('')).toBe(0);
    expect(parseTrustProxy('0')).toBe(0);
  });

  it('숫자, 불리언, 문자열을 해석한다', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});

describe('PUBLIC_URL', () => {
  it('기본은 https 전제', () => {
    expect(isHttpPublicUrl({})).toBe(false);
    expect(useSecureTransport({})).toBe(true);
    expect(useSecureTransport({ PUBLIC_URL: 'https://chat.example.com' })).toBe(true);
  });

  it('http scheme이면 보안 전송 강제를 끈다', () => {
    expect(useSecureTransport({ PUBLIC_URL: 'http://192.168.0.5:8080' })).toBe(false);
    expect(useSecureTransport({ PUBLIC_URL: 'HTTP://lan.local' })).toBe(false);
  });
});
