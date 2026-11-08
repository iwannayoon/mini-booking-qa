# 틈 · Mini Booking QA

자동화 학습과 테스트 설계 포트폴리오를 위한 로컬 예약 서비스입니다. Node.js 24 이상이 필요합니다.

## 시작하기

이 README가 있는 `mini-booking` 폴더를 터미널로 열고 실행합니다.

```sh
npm ci
npm run dev
```

브라우저에서 http://127.0.0.1:3000 을 엽니다. `alice`, `bob`, `admin` 계정 모두 비밀번호는 `demo1234`입니다. 로그인 → 내일 날짜 및 시간 선택 → 내 예약 확인 → 취소 순서로 사용합니다. admin은 각 시간을 잠그거나 해제할 수 있습니다.

- SQLite 파일은 첫 실행 시 `data/booking.sqlite`에 생성됩니다. 서버를 껐다 켜도 예약은 남습니다.
- 로그인 세션은 메모리에만 있어 서버를 다시 켜면 다시 로그인해야 합니다.
- DB 초기화: 서버를 중지하고 `data` 폴더를 삭제한 뒤 다시 실행합니다.
- 실행 중지: 터미널에서 Ctrl+C.
- `PORT=3001 npm run dev`로 포트를 바꿀 수 있습니다.

## 테스트

```sh
npx playwright install chromium
npm run test:api
npm run test:e2e
npm test
npm run report
npm run build
```

테스트는 전용 3100 포트에서 서버를 자동 실행합니다. 실행마다 임시 DB를 만들고 종료 시 제거하므로 개인 예약 데이터와 섞이지 않습니다. 다른 테스트 실행과 동시에 사용하지 마세요. 테스트 실패 시 HTML 보고서와 trace, 화면 캡처를 남깁니다. 임의 sleep과 자동 재시도는 사용하지 않습니다.

## 최소 범위

- 스터디룸 1개, 09~18시 운영, 예약 시작 시각 09~17시, 1시간 슬롯 복수 선택
- 한국 시간(KST), 현재 이후 30일 미만까지 예약 가능
- 예약 상태: confirmed → cancelled. 같은 예약 취소는 반복해도 성공
- 본인 예약만 조회·취소. 다른 사람의 예약 ID는 404
- 동시간 확정 예약은 DB의 부분 고유 인덱스로 한 건만 허용
- 관리자 잠금은 빈 시간에만 가능. 기존 예약을 취소하지 않음

## 구조

```text
src/                  React 화면
server/app.js         인증·예약·관리자 REST API
server/db.js          SQLite 스키마와 고유 제약
server/index.js       API + Vite 단일 로컬 서버
 tests/               Playwright API·DB·E2E 테스트
 docs/design.md       설계와 테스트 레이어 판단
.github/workflows/    GitHub Actions 테스트 및 보고서
```

UI와 API는 같은 주소를 쓰므로 CORS 설정이나 별도 프론트 서버 실행이 필요 없습니다. Node 내장 SQLite를 사용해 별도 DB 서버도 필요 없습니다. `npm run build`는 프론트 빌드 검증이며 현재 실행 서버는 개발용 Vite를 사용합니다.

## 포트폴리오로 발전시키기

이 폴더 자체를 Git 저장소 루트로 올리면 포함된 GitHub Actions가 빌드와 전체 테스트를 실행합니다. 아직 원격 저장소 생성이나 CI 실행은 하지 않았습니다. 실행 기록, 실패 trace 사례, 테스트 레이어 선택 이유를 README에 추가하세요.

현재 로그인은 고정 계정과 메모리 세션을 사용하는 학습용입니다. 알림 제공자 연동, 외부 알림 mocking, 장애 주입, 만료 세션, 실제 비밀번호 저장, 마이그레이션은 후속 범위입니다. 현재 mocking 예시는 브라우저에서 예약 API의 503 응답을 대체하는 테스트입니다.

참고: [Node SQLite](https://nodejs.org/api/sqlite.html), [Playwright API 테스트](https://playwright.dev/docs/api-testing), [Playwright 테스트 서버](https://playwright.dev/docs/test-webserver).

## 이번 환경의 검증 결과

- 의존성 설치 및 프론트 빌드 성공
- Playwright API·DB 테스트 7개 통과
- E2E 3개는 실행 시도했으나 이 Codex 환경의 macOS 프로세스 권한 제한으로 Chromium이 시작 전에 종료되어 미검증
- 일반 로컬 터미널에서 위 브라우저 설치 명령과 `npm run test:e2e`로 재검증 가능
- 이번 에이전트 실행에서는 브라우저를 `/tmp/mini-booking-browsers`에 설치했습니다. 재사용할 경우 `PLAYWRIGHT_BROWSERS_PATH=/tmp/mini-booking-browsers npm run test:e2e`를 실행합니다.

## 예약 화면 개선

복수 슬롯 선택 후 일시·총 시간·데모 금액을 확인하고 예약을 확정합니다. 시간당 10,000원은 표시용이며 실제 결제는 없습니다. 선택 중 날짜 변경 시 확인 모달을 거칩니다. 연속 시간은 하나의 내역으로 표시하며 확인 후 묶음 취소합니다. 취소된 일시·룸·총 시간은 회색 취소선으로 표시합니다.

복수 예약은 POST /api/bookings의 slots 배열, 묶음 취소는 POST /api/bookings/cancel의 ids 배열로 요청합니다. 모두 트랜잭션으로 처리해 오류 시 일부만 처리되는 것을 막습니다. 기존 단일 API도 유지합니다.

이번 수정 검증: 빌드와 API·DB 테스트 7개 통과. 인앱 브라우저에서 복수 선택·요약·예약 확정·연속 시간 묶음·날짜 변경 유지/초기화·취소 모달·취소선 표시를 직접 확인했습니다. Playwright E2E 시나리오 3개는 갱신했으며 독립 Chromium 실행은 이전 환경 제한으로 재검증하지 않았습니다.
