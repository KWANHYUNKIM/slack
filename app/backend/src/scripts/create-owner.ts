// 첫 OWNER 생성 CLI의 진입 파일. 실행 전용이라 "메인 모듈인가" 판정 없이 바로 돌린다(symlink 경로로 실행해도 같다).
// 로직은 createOwnerCli.ts에 있다. 사용법: node dist/scripts/create-owner.js --help
import dotenv from 'dotenv';

// db.js가 DATABASE_URL을 읽기 전에 .env를 불러와야 하므로 본체는 그 뒤에 동적으로 가져온다.
// quiet: dotenv 안내 문구가 CLI의 stdout에 섞이지 않게 한다.
dotenv.config({ quiet: true });

const { main } = await import('./createOwnerCli.js');
// stdin이 열려 있으면 이벤트 루프가 끝나지 않으므로 명시적으로 종료한다.
process.exit(await main());
