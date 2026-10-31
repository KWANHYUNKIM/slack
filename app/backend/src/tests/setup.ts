import dotenv from 'dotenv';
dotenv.config();

import prisma from '../db.js';
import { bindEphemeralListenToLoopback } from './loopback.js';
import { clearTokenCache } from '../middleware/auth.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import {
  DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_NAME, DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_SLUG,
} from '../services/workspaceService.js';

bindEphemeralListenToLoopback();

// 끝나지 않는 작업 하나가 모든 테스트의 정리를 훅 시간 한도까지 막지 않게 상한을 둔다.
async function settleWithLimit(ms = 10000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    settleBackgroundWork().then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); }),
  ]);
  clearTimeout(timer);
  if (timedOut) console.warn(`[test setup] background work did not settle within ${ms}ms`);
}

beforeEach(() => {
  clearTokenCache();
});

// 응답 뒤에 도는 활동 작업이 다음 테스트의 DB 정리·요청과 풀(connection_limit)을 두고 다투지 않게
// 테스트마다 끝까지 기다린다. 부하가 높을 때 다음 테스트가 느려지거나 시간 단언이 깨지는 원인이었다.
afterEach(async () => {
  await settleWithLimit();
});

beforeAll(async () => {
  // Clean database before tests
  await prisma.auditLog.deleteMany();
  await prisma.inviteLink.deleteMany();
  await prisma.bookmark.deleteMany();
  await prisma.scheduledMessage.deleteMany();
  await prisma.reaction.deleteMany();
  await prisma.file.deleteMany();
  await prisma.message.deleteMany();
  await prisma.channelRead.deleteMany();
  await prisma.channelMember.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.directMessage.deleteMany();
  await prisma.dMGroup.deleteMany();
  await prisma.user.deleteMany();
  // 조직·워크스페이스(E1a). WorkspaceMember·ChannelWorkspace는 사용자·채널 삭제에 연쇄로 지워진다.
  // 기본 조직·워크스페이스(id=1)는 마이그레이션이 만든 행이라 지우지 않고, 테스트가 바꾼 값만 되돌린다.
  await prisma.workspace.deleteMany({ where: { id: { not: DEFAULT_WORKSPACE_ID } } });
  await prisma.organization.deleteMany({ where: { id: { not: DEFAULT_ORGANIZATION_ID } } });
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORGANIZATION_ID },
    create: { id: DEFAULT_ORGANIZATION_ID, name: DEFAULT_ORGANIZATION_NAME },
    update: { name: DEFAULT_ORGANIZATION_NAME, primaryOwnerId: null },
  });
  await prisma.workspace.upsert({
    where: { id: DEFAULT_WORKSPACE_ID },
    create: { id: DEFAULT_WORKSPACE_ID, organizationId: DEFAULT_ORGANIZATION_ID, slug: DEFAULT_WORKSPACE_SLUG, name: DEFAULT_WORKSPACE_NAME },
    update: {
      organizationId: DEFAULT_ORGANIZATION_ID, slug: DEFAULT_WORKSPACE_SLUG, name: DEFAULT_WORKSPACE_NAME,
      description: null, discoverability: 'INVITE_ONLY', icon: null, archivedAt: null,
    },
  });
});

afterAll(async () => {
  // 응답 뒤에 도는 활동 작업이 다음 테스트 파일의 DB 정리(beforeAll)와 겹치지 않게 끝까지 기다린다.
  await settleWithLimit();
  await prisma.$disconnect();
});
