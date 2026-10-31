import { z } from 'zod';

// MCP 도구 입력과 리소스 URI가 공용으로 쓰는 id 규칙. DB의 id 열은 Int(32비트)라, 넘는 값은 조회 전에 막는다.
export const MCP_MAX_ID = 2147483647;

export const idSchema = () => z.number().int().positive().max(MCP_MAX_ID);
