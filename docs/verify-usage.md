# 검증 자동화 사용법

플러그인 유지보수를 위한 검증 명령입니다. 사용자 설치·사용법은
[플러그인 안내](../plugins/typescript-lsp/README.md), 결과 기록은
[검증 기록](verification.md), 다른 기술 문서는 [문서 목록](README.md)에 있습니다.

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

- `verify`: 정적 검사 → TS 전체 테스트(건너뜀 0개 필수) → 새 임시 `CODEX_HOME`에서
  카탈로그 탐색·설치 → 실제 app-server 읽기/미리보기 9개·적용 2개 → 실제 오류/수정 패치와
  다음 모델 요청의 진단을 검증합니다. 전제 조건이나 검사 결과가 빠지면 종료 코드 1입니다.
- `verify:installed`: `CODEX_HOME` 또는 기본 사용자 Codex 홈의 **실제 설치본**을
  사용합니다. 설치 캐시가 없으면 생성하지 않고 실패하며, 비활성·미신뢰는 검토 안내와 함께 실패합니다.
  미신뢰 상태는 `/hooks` → `PostToolUse` → `Checking TypeScript diagnostics`에서 검토하세요.
  현재 프로필의 설치·설정·신뢰를 바꾸거나 우회하지 않습니다. 성공 시 실제 광고된 도구와
  별도 임시 프로젝트의 적용, 오류/수정 패치 2개, 모델 요청 3개, TS2345 전달과 새 정상 결과를 검증합니다.
  구 설치본은 원래 탐색 3개를 계속 허용하므로 이 명령 성공만으로 최신 설치를 뜻하지 않습니다.
  0.2.0 릴리스 확인에서는 버전·캐시 해시와 summary의 읽기 9개/쓰기 2개를 별도로 요구하세요.
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

Python 0.2.0 후보 검증은 `TEST_TY_BIN`, `TEST_PYTHON_ENV`를 추가하고 `npm run verify:python`을 실행합니다.
Python 정확히 11개(읽기 9·쓰기 2)와 실제 두 적용/후속 진단·독립 cache·TS 11개·혼합 패치를 확인합니다.
기존 `verify`는 Python 준비 없이 TS 회귀를 계속 검사합니다.
`TEST_PYTHON_RUNTIME_CONFIG=1`은 임시 Node HOME의 기존 형식 JSON을 사용하고 PYTHON_LSP_TY를 전달하지 않습니다.
`TEST_CODEX_PROFILE`로 정상 검토한 별도 임시 profile을 지정해 `npm run verify:python:trusted`를 실행하면
두 훅의 trusted 상태를 요구하고 우회 옵션 없이 동일 검사를 수행합니다. 현재 사용자 profile은 허용하지 않습니다.
재현 절차는 [Python 검증](python-lsp.md#재현-명령), 최신 결과와 한계는 [0.2.0 후보 기록](python-lsp-release-0.2.0.md)에 있습니다.

## 0.2.0 회귀 범위

프로젝트/config 경계와 빈/다중 탐색 결과, 실제 진단의 누락 import 미리보기,
다중 파일 rename 미리보기 및 원본 불변, 선택 ID 재생성과 stale 거부를 포함합니다.
적용 검사는 UTF-16/CRLF·버전·URI·겹침·해시·권한·symlink/하드 링크 및 실제 파일 교체 실패를
주입해 원본 복구와 별도 변경 보존을 확인합니다. 적용 도구의 후속 진단은 훅과 별도로 검사합니다.
일부 상태(지원 밖 명령·지연 데이터·리소스 작업)는 계약 테스트이며 모든 실제 서버 refactor를 실행한 것은 아닙니다.
TS의 감사된 빈 command wrapper 조건은 TS 전용입니다. Python 적용은 서버 명령을 모두 거부합니다.

## 수동으로 설치 경로를 분리해 확인하기

자동화 대신 카탈로그·설치 상태만 따로 재현할 때는 저장소 루트에서 임시 홈을 지정합니다.
아래 명령은 지정한 테스트 홈만 대상으로 합니다. 작업을 마치면 만든 임시 홈을 정리하세요.
전체 검사와 자동 정리는 위의 `verify` 명령을 사용합니다.

```sh
test_codex_home=$(mktemp -d)
CODEX_HOME="$test_codex_home" codex plugin marketplace add "$PWD" --json
CODEX_HOME="$test_codex_home" codex plugin list --available --marketplace copyx-codex-plugins --json
CODEX_HOME="$test_codex_home" codex plugin add typescript-lsp@copyx-codex-plugins --json
CODEX_HOME="$test_codex_home" codex plugin list --json
CODEX_HOME="$test_codex_home" codex mcp list --json
```
