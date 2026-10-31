import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import prisma from '../../db.js';
import { JWT_SECRET } from '../../config.js';
import { DEFAULT_ORGANIZATION_ID, channelHostData, setUserRole } from '../../services/workspaceService.js';

// 교차 워크스페이스 테스트 공용 픽스처(E1b, 스펙 5.6). 워크스페이스 A·B와 사용자
//   a(A만), b(B만), ab(둘 다), orgAdmin(조직 관리자, A만 멤버), ga(A 게스트), aAdmin(A 관리자), bOwner(B 소유자)
// 와 A·B의 공개·비공개 채널을 만든다. 기본 워크스페이스(id=1)에는 아무도 넣지 않는다(행이 있는 사용자는 암묵 참여하지 않는다).
// 채널 이름 유일성은 워크스페이스 단위라(E1c) A와 B에 같은 이름 general을 하나씩 둔다(5.6-4).
// 토큰은 로그인 없이 서명한다(sid 없는 토큰은 tokenVersion 규칙만 따른다). 사용자는 prisma로 만들고 역할은 setUserRole로 쓴다.

export interface FixtureUser {
  id: number;
  token: string;
  email: string;
}

export interface WorkspaceFixture {
  prefix: string;
  workspaceA: number;
  workspaceB: number;
  users: Record<'a' | 'b' | 'ab' | 'orgAdmin' | 'ga' | 'aAdmin' | 'bOwner', FixtureUser>;
  channels: { aPublic: number; aPrivate: number; bPublic: number; bPrivate: number; aGeneral: number; bGeneral: number };
}

export function tokenFor(userId: number, tokenVersion = 0): string {
  return jwt.sign({ userId, tokenVersion }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

export async function createFixtureUser(email: string, name: string): Promise<FixtureUser> {
  const user = await prisma.user.create({
    data: { email, name, password: 'fixture-no-login', organizationId: DEFAULT_ORGANIZATION_ID },
    select: { id: true },
  });
  return { id: user.id, token: tokenFor(user.id), email };
}

export async function addFixtureMember(workspaceId: number, userId: number, role: Role = 'MEMBER'): Promise<void> {
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role },
    update: { role, leftAt: null },
  });
}

export async function createFixtureWorkspace(slug: string, name: string, opts: { discoverability?: 'OPEN' | 'INVITE_ONLY' | 'HIDDEN' } = {}) {
  return prisma.workspace.create({
    data: { organizationId: DEFAULT_ORGANIZATION_ID, slug, name, discoverability: opts.discoverability ?? 'INVITE_ONLY' },
  });
}

async function createChannel(name: string, workspaceId: number, isPrivate: boolean, memberIds: number[]): Promise<number> {
  const channel = await prisma.channel.create({
    data: { name, isPrivate, ...channelHostData(name, workspaceId) },
    select: { id: true },
  });
  if (memberIds.length > 0) {
    await prisma.channelMember.createMany({ data: memberIds.map((userId) => ({ userId, channelId: channel.id })) });
  }
  return channel.id;
}

/** prefix는 이메일·slug·채널 이름 충돌을 피하려고 테스트 파일마다 다르게 준다(소문자·숫자, 12자 이하) */
export async function createWorkspaceFixture(prefix = 'fx'): Promise<WorkspaceFixture> {
  const wsA = await createFixtureWorkspace(`${prefix}-a`, `${prefix} A`);
  const wsB = await createFixtureWorkspace(`${prefix}-b`, `${prefix} B`);
  const mk = (key: string) => createFixtureUser(`${prefix}-${key.toLowerCase()}@example.com`, `${prefix} ${key}`);

  const users = {
    a: await mk('a'),
    b: await mk('b'),
    ab: await mk('ab'),
    orgAdmin: await mk('orgAdmin'),
    ga: await mk('ga'),
    aAdmin: await mk('aAdmin'),
    bOwner: await mk('bOwner'),
  };
  // 조직 관리자: 기본 워크스페이스 멤버십은 만들지 않는다
  await setUserRole(prisma, users.orgAdmin.id, 'ADMIN', { joinDefaultWorkspace: false });

  await addFixtureMember(wsA.id, users.a.id);
  await addFixtureMember(wsA.id, users.ab.id);
  await addFixtureMember(wsA.id, users.orgAdmin.id);
  await addFixtureMember(wsA.id, users.ga.id, 'GUEST');
  await addFixtureMember(wsA.id, users.aAdmin.id, 'ADMIN');
  await addFixtureMember(wsB.id, users.b.id);
  await addFixtureMember(wsB.id, users.ab.id);
  await addFixtureMember(wsB.id, users.bOwner.id, 'OWNER');

  const channels = {
    aPublic: await createChannel(`${prefix}-a-public`, wsA.id, false, [users.a.id, users.ab.id]),
    aPrivate: await createChannel(`${prefix}-a-private`, wsA.id, true, [users.a.id]),
    bPublic: await createChannel(`${prefix}-b-public`, wsB.id, false, [users.b.id, users.ab.id]),
    bPrivate: await createChannel(`${prefix}-b-private`, wsB.id, true, [users.b.id]),
    aGeneral: await createChannel('general', wsA.id, false, [users.a.id, users.ab.id, users.aAdmin.id]),
    bGeneral: await createChannel('general', wsB.id, false, [users.b.id, users.ab.id, users.bOwner.id]),
  };

  return { prefix, workspaceA: wsA.id, workspaceB: wsB.id, users, channels };
}
