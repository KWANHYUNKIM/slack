import { z } from 'zod';

// 가입(/auth/register)과 첫 OWNER 부트스트랩(scripts/create-owner)이 같은 정책을 쓰도록 한곳에 둔다.

// Strip HTML tags for defense-in-depth
export function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

export const emailSchema = z.string().email().max(255).transform(e => e.toLowerCase());

// bcrypt는 72바이트 뒤를 버리므로 상한을 둔다.
export const newPasswordSchema = z.string().min(6).max(72);

export const displayNameSchema = z.string().min(1).max(100)
  .refine(val => !val.includes('\u0000'), { message: 'Name cannot contain null bytes' })
  .transform(stripHtml);

export const BCRYPT_ROUNDS = 10;
