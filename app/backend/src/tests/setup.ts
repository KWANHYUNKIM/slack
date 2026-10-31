import dotenv from 'dotenv';
dotenv.config();

import prisma from '../db.js';
import { clearTokenCache } from '../middleware/auth.js';
import { settleBackgroundWork } from '../services/mentionService.js';

beforeEach(() => {
  clearTokenCache();
});

// 응답 뒤에 도는 활동 작업이 다음 테스트의 DB 정리·요청과 풀(connection_limit)을 두고 다투지 않게
// 테스트마다 끝까지 기다린다. 부하가 높을 때 다음 테스트가 느려지거나 시간 단언이 깨지는 원인이었다.
afterEach(async () => {
  await settleBackgroundWork();
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
  await prisma.user.deleteMany();
});

afterAll(async () => {
  // 응답 뒤에 도는 활동 작업이 다음 테스트 파일의 DB 정리(beforeAll)와 겹치지 않게 끝까지 기다린다.
  await settleBackgroundWork();
  await prisma.$disconnect();
});
