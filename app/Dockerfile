# 자체 완결 멀티스테이지 이미지. 공개 공식 이미지(node)만 사용한다.
# 빌드: docker build -t slackclone ./app   (컨텍스트는 app/)
ARG NODE_IMAGE=node:24-slim

# ── Stage 1: 프런트엔드 빌드 ────────────────────────────────────────
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build

# ── Stage 2: 백엔드 의존성 설치, prisma generate, tsc 빌드, 운영용 prune ──
# npm ci, apt, prisma generate는 이 단계에서 각각 한 번만 실행한다.
# bcrypt, sharp 같은 네이티브 모듈은 prebuilt가 없을 때를 대비해 빌드 도구를 둔다(이 단계에만 존재).
FROM ${NODE_IMAGE} AS backend-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate \
 && npx tsc --noEmitOnError \
 && test -f dist/index.js \
 && npm prune --omit=dev \
 && test -d node_modules/.prisma/client \
 && npm cache clean --force

# ── Stage 3: 런타임 ─────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS production
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package.json ./
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/prisma ./prisma
# 프런트 빌드 결과를 public/ 에 두면 백엔드가 정적 서빙한다.
COPY --from=frontend-build /app/frontend/dist ./public
COPY entrypoint.sh ./

# 업로드 저장소(로컬 저장 모드)는 볼륨으로 마운트한다.
RUN chmod +x entrypoint.sh \
 && mkdir -p /app/uploads/avatars /app/uploads/files \
 && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
EXPOSE 3478/udp
VOLUME ["/app/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
