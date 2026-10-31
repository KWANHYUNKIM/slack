import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../db.js';
import { BCRYPT_ROUNDS, displayNameSchema, emailSchema, newPasswordSchema } from '../utils/authSchemas.js';
import { joinDefaultChannels } from './defaultChannelService.js';
import { DEFAULT_WORKSPACE_ID, addWorkspaceMember, setUserRole } from './workspaceService.js';

// 빈 DB에 첫 OWNER를 만드는 경로. 가입은 초대 코드가 필요하고 초대는 기존 사용자가 만들어야 하므로,
// 운영 이미지에서는 이 서비스(scripts/create-owner.ts)로만 첫 계정을 만든다.

// CLI가 비밀번호를 묻기 전에 이메일과 이름을 먼저 검증할 수 있게 나눠 둔다.
export const bootstrapIdentitySchema = z.object({
  email: emailSchema,
  name: displayNameSchema,
});

export const bootstrapOwnerSchema = bootstrapIdentitySchema.extend({
  password: newPasswordSchema,
});

export type BootstrapOwnerInput = z.input<typeof bootstrapOwnerSchema>;

export class BootstrapRejectedError extends Error {
  constructor() {
    super('Workspace already has users');
    this.name = 'BootstrapRejectedError';
  }
}

export async function createInitialOwner(input: BootstrapOwnerInput) {
  const { email, password, name } = bootstrapOwnerSchema.parse(input);

  // 잠금을 잡기 전에 해시해 둔다. bcrypt 동안 User 테이블을 막지 않기 위해서다.
  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

  return prisma.$transaction(async (tx) => {
    // SHARE ROW EXCLUSIVE는 자기 자신과 INSERT(ROW EXCLUSIVE)를 모두 막는다.
    // 동시에 들어온 부트스트랩이나 가입은 커밋까지 기다리므로, 아래 count가 0인 상태로 유지된 채 OWNER가 하나만 생긴다.
    await tx.$executeRaw`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`;

    const userCount = await tx.user.count();
    if (userCount > 0) {
      throw new BootstrapRejectedError();
    }

    const created = await tx.user.create({
      data: { email, password: hashedPassword, name, defaultWorkspaceId: DEFAULT_WORKSPACE_ID },
      select: { id: true },
    });

    // 첫 OWNER는 기본 워크스페이스의 OWNER이고, setUserRole이 비어 있는 조직 주 소유자도 채운다(E1a).
    await addWorkspaceMember(tx, { workspaceId: DEFAULT_WORKSPACE_ID, userId: created.id, role: 'OWNER' });
    await setUserRole(tx, created.id, 'OWNER');
    const owner = await tx.user.findUniqueOrThrow({
      where: { id: created.id },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    // 가입과 같은 규칙으로 기본 채널에 넣는다. 첫 OWNER는 워크스페이스를 바로 쓸 수 있어야 한다.
    await joinDefaultChannels(tx, owner.id);

    // 감사 로그는 같은 트랜잭션에 넣는다. 기록 없이 OWNER만 생기는 일이 없게 한다(이메일·비밀번호는 남기지 않는다).
    await tx.auditLog.create({
      data: {
        action: 'owner.bootstrapped',
        actorId: owner.id,
        targetType: 'user',
        targetId: owner.id,
        details: 'cli',
      },
    });

    return owner;
  });
}
