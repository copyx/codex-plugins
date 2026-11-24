# 검증 자동화 사용법

아래는 저장소의 검증 스크립트 사용법입니다. 배포된 0.1.0 플러그인의 번들 문서는
변경하지 않았으므로, 검증 명령에 대해서는 이 문서를 우선 참고하세요.

저장소 루트에서 다음 경로를 지정합니다. `TEST_TYPESCRIPT_DIR`는 TypeScript 패키지
디렉터리이고 `lib/tsserver.js`와 `package.json`이 있어야 합니다.
`TEST_MODEL_CATALOG`는 Codex의 공개 모델 기능 메타데이터 파일(예: 현재 프로필의
`models_cache.json`)이며 freeform apply_patch를 지원하는 모델 항목이 필요합니다.
모델 이름을 하드코딩하지 않고 이 목록에서 선택합니다. 경로는 현재 디렉터리 기준으로
해석한 뒤 절대 경로로 바꿉니다. 공백이 있는 경로는 따옴표로 감싸세요.

```sh
TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript \
TEST_MODEL_CATALOG=/absolute/path/to/models_cache.json npm run verify

TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript \
TEST_MODEL_CATALOG=/absolute/path/to/models_cache.json npm run verify:installed
```

- `verify`: 정적 검사 → 전체 테스트(건너뜀 0개 필수) → 새 임시 `CODEX_HOME`에서
  카탈로그 탐색·설치 → 실제 app-server MCP 정의·참조·호버 → 실제 오류/수정 패치와
  다음 모델 요청의 진단을 검증합니다. 전제 조건이나 검사 결과가 빠지면 종료 코드 1입니다.
- `verify:installed`: `CODEX_HOME` 또는 기본 사용자 Codex 홈의 **실제 설치본**을
  사용합니다. 설치 캐시가 없으면 생성하지 않고 실패하며, 비활성·미신뢰는 검토 안내와 함께 실패합니다.
  미신뢰 상태는 `/hooks` → `PostToolUse` → `Checking TypeScript diagnostics`에서 검토하세요.
  현재 프로필의 설치·설정·신뢰를 바꾸거나 우회하지 않습니다. 성공 시 MCP 탐색과
  실제 오류/수정 패치 2개, 모델 요청 3개, TS2345 전달과 새 정상 결과를 검증합니다.
- 두 모드 모두 별도 임시 TypeScript 프로젝트를 만들며 사용자 저장소를 편집하지 않습니다.
  오류 수정 후 새 developer 훅 컨텍스트에 TS2345가 없고 `no diagnostics`가 있는지
  검사하므로, 이력에 남은 예전 오류와 현재 결과를 구분합니다. 제한 시간·출력 누락도 실패합니다.
- Node 22+, PATH의 `typescript-language-server`, `--ephemeral`을 지원하는 Codex와
  loopback 바인딩 권한이 필요합니다. `TEST_CODEX_BIN`으로 Codex 실행 파일 경로를
  지정할 수 있습니다. 이 Mac에서는 CLI 0.172.0으로 실행했습니다.
- API 키·토큰·Orca 세션 환경을 자식에게 넘기지 않고 원본 모델 요청을 저장하지 않습니다.
  계정 identity나 인증 파일도 복사하지 않습니다. 선택한 공개 모델 항목만 임시로 복사합니다.
  외부 모델은 호출하지 않으며 고유 이름의 로컬 Responses SSE 픽스처가 도구 호출을 결정합니다.
- ephemeral 세션과 임시 로그 경로를 사용합니다. 성공·실패 시 생성한 임시 디렉터리와
  자식 프로세스를 정리하고 현재 프로필 config.toml·설치 파일 해시가 동일한지 확인합니다.
  사용자 모드에서는 훅 활성·신뢰·정의 해시도 검증 전후 비교합니다.
  `KEEP_CODEX_TEST`로 원본 요청을 보관하던 옵션은 제거했습니다.
- 격리 모드에서만 검토된 테스트 패키지를 실행하기 위한 일회성 훅 신뢰 생략 옵션을
  사용합니다. 사용자 프로필 모드는 이 옵션을 사용하지 않으며 영구 신뢰를 저장하지 않습니다.

`npm run check`, `npm test`는 개별 검사로 남아 있습니다. 개별 `npm test`는
TypeScript 경로가 없으면 실제 LSP 테스트를 건너뛰므로 전체 검증에는 `verify`를 사용하세요.
`npm run test:codex`는 공통 검증기를 사용하는 격리 통합 검사만 실행합니다.
