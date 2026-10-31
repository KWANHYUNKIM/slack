# GCP 배포 (선택)

원작자(slawk)의 Cloud Run 배포용 파일이다. 이 프로젝트의 기본 배포(`app/Dockerfile`, `app/docker-compose.yml`)에는 필요 없다.

- `Dockerfile.base`, `build-base.sh`, `cloudbuild.base.yaml`: 사설 Artifact Registry base 이미지 빌드. 새 `app/Dockerfile`은 base 이미지를 쓰지 않으므로 더 이상 필요하지 않다.
- `cloudbuild.yaml`, `deploy.sh`: Cloud Build와 Cloud Run 배포. `app/Dockerfile`로 이미지를 빌드한다. 프로젝트 ID와 저장소 주소는 원작자 값이 기본값이므로 반드시 환경 변수로 덮어쓴다.
- 사용하지 않는다면 지워도 된다.
