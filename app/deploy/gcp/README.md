# GCP 배포 (선택)

Cloud Run 배포 예시다. 이 프로젝트의 기본 배포(`app/Dockerfile`, `app/docker-compose.yml`)에는 필요 없고, 쓰지 않는다면 지워도 된다.

- `deploy.sh`: 이 저장소(`https://github.com/KWANHYUNKIM/slack`)의 main을 clone해서 `app/`을 빌드 컨텍스트로 Cloud Build에 올리고(`app/deploy/gcp/cloudbuild.yaml`) Cloud Run에 배포한다. `.gcloudignore`는 gcloud 소스 루트인 `app/`에 있다.
- `cloudbuild.yaml`: `app/Dockerfile`로 이미지를 빌드하고 Cloud Run에 배포한다.
- `Dockerfile.base`, `build-base.sh`, `cloudbuild.base.yaml`: 사설 Artifact Registry base 이미지 빌드. `app/Dockerfile`은 base 이미지를 쓰지 않으므로 더 이상 필요하지 않다(남겨 둔 것).
- 프로젝트 ID(`your-gcp-project`), 서비스 이름, 버킷 이름은 placeholder다. 환경 변수(`GCP_PROJECT_ID`, `SERVICE_NAME`, `GCS_BUCKET_NAME` 등)로 반드시 덮어쓴다.

## 예전 배포와의 차이 (원작자 코드 기준)

- **trust proxy**: 예전 코드는 `app.set('trust proxy', 1)`을 하드코딩했다. 지금은 `TRUST_PROXY` 환경 변수이고 기본값이 0이다. Cloud Run은 프록시가 1홉이므로 `cloudbuild.yaml`이 `TRUST_PROXY=1`을 넣는다. 값을 빼면 rate limit이 모든 요청을 프록시 IP 하나로 센다.
- **STUN**: Cloud Run은 UDP를 받지 않으므로 `STUN_ENABLED=false`를 넣는다.
- **첫 사용자 / 시드**: `RUN_SEED` 옵션은 없앴다. 이미지에 시드가 없다. 첫 OWNER 생성은 `feat/bootstrap-owner`가 대체한다.
- **HTTPS**: Cloud Run은 TLS를 종단하므로 `PUBLIC_URL`을 따로 두지 않는다(기본이 https 전제).
