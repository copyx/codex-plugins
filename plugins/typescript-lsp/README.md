# TypeScript LSP

로컬 TypeScript/JavaScript 파일을 `typescript-language-server --stdio`로 탐색합니다.
Codex `apply_patch` 이후 수정된 소스 파일의 진단을 동기 `PostToolUse` 훅의
`additionalContext`로 전달합니다. 서버와 훅은 파일을 읽고 언어 서버를 실행하며,
사용자 소스를 직접 수정하지 않으며 별도 원격 API를 호출하지 않습니다.
탐색 결과와 진단은 Codex의 도구·훅 컨텍스트에 전달됩니다.

## 전제 조건

- Node.js 22 이상과 PATH에서 실행 가능한 `typescript-language-server`.
- 대상 워크스페이스 내부의 `node_modules/typescript/lib/tsserver.js`.
  전역 TypeScript로 대체하지 않습니다. 모노레포에서는 상위 워크스페이스의
  hoisted `node_modules/typescript`를 찾을 수 있도록 충분히 넓은 루트를 지정하세요.
- 로컬 stdio MCP 및 플러그인 훅을 지원하는 Codex.
  이 Mac에서 Node 24.14.1, Codex CLI 0.169.1, language server 6.0.3,
  TypeScript 5.9.3으로 검증했습니다.
- 설치 후 `/hooks` 또는 데스크톱의 Review hooks에서 훅 내용을 검토하고 신뢰해야 합니다.
  신뢰하지 않은 훅은 실행되지 않습니다.

## 계정 설정을 건드리지 않는 설치 시험

저장소 루트에서 아래 명령을 실행하면 지정한 임시 홈만 변경합니다.

```sh
test_codex_home=$(mktemp -d)
CODEX_HOME="$test_codex_home" codex plugin marketplace add "$PWD" --json
CODEX_HOME="$test_codex_home" codex plugin list --available --marketplace copyx-codex-plugins --json
CODEX_HOME="$test_codex_home" codex plugin add typescript-lsp@copyx-codex-plugins --json
CODEX_HOME="$test_codex_home" codex plugin list --json
CODEX_HOME="$test_codex_home" codex mcp list --json
```

Codex는 설치된 캐시 복사본을 사용합니다. 소스를 수정했다면 해당 테스트 홈에서
플러그인을 제거하고 다시 설치한 뒤 새 세션을 여세요. 이 저장소는 본계정의
개인 마켓이나 전역 플러그인 설정을 자동 활성화하지 않습니다.

## 탐색 사용법

도구 `definition`, `references`, `hover`는 같은 인자를 받습니다.

```json
{
  "workspace_root": "/absolute/path/to/repo",
  "file": "src/main.ts",
  "line": 12,
  "character": 7
}
```

입력 위치는 **1부터 시작하는 줄과 UTF-16 문자 위치**입니다. 결과는 원래 LSP
형식으로 반환하므로 결과의 `range`는 0부터 시작합니다. 반환 JSON에 선택한
`project_root`와 `config`도 포함됩니다. references는 선언도 포함합니다.
파일 경로는 루트 상대 또는 절대 경로이며, 루트 밖의 파일과 심볼릭 링크 탈출을 거부합니다.

예: “typescript-lsp로 이 저장소 src/main.ts 12행 7열의 정의와 참조를 찾아줘.”
연결된 MCP 도구가 지연 로딩되는 클라이언트에서는 도구 검색/플러그인 선택을 먼저 할 수 있습니다.

## 프로젝트 선택과 진단 범위

파일에서 워크스페이스 루트까지 올라가며 가장 가까운 `tsconfig.json` 또는
`jsconfig.json`을 선택합니다. 같은 디렉터리에서는 tsconfig가 우선입니다.
TypeScript의 실제 파일 포함, 프로젝트 참조, 모듈 해석은 언어 서버가 처리합니다.
설정 파일이 없으면 지정한 워크스페이스의 inferred project를 사용합니다.

탐색마다 새 LSP 프로세스를 사용합니다. 훅은 변경 파일을 프로젝트 루트와
TypeScript 경로별로 나눠 새 프로세스에서 검사합니다. 다른 루트의 파일을
한 세션에 열지 않습니다. 지속 데몬이나 진단 캐시를 남기지 않습니다.
이 방식에는 각 호출에서 언어 서버를 시작하는 비용이 있습니다.

- `publishDiagnostics` capability를 선언합니다. 버전이 있으면 현재 문서 버전과
  대조하며, 버전이 없는 서버도 받습니다. 새 프로세스로 이전 패치의 진단을 격리합니다.
- 진단 알림을 최대 6초 기다리고 마지막 알림 뒤 400ms 동안 안정화 시간을 둡니다.
  버전 없는 알림의 완전성을 증명하는 프로토콜 장벽은 없으므로 전체 `tsc` 검사를 대체하지 않습니다.
- 일반 요청은 최대 10초, 훅 초기화는 최대 8초, 훅 전체 작업은 약 20초로 제한합니다.
  종료 시 shutdown/exit를 시도하고 응답하지 않으면 자식 프로세스 그룹을 종료합니다.
- 패치의 Add/Update/Move 목적지를 검사하고 Delete는 제외합니다. 소스 확장자는
  `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`입니다.
- 한 훅에서 변경된 소스 최대 20개, 파일당 진단 최대 30개, 출력 최대 10,000자를 전달합니다.
  생략, 제한 시간, 실행 실패, TypeScript 누락은 미완료로 표시하며 패치를 차단하지 않습니다.
- 바뀐 파일만 검사합니다. 삭제로 깨진 다른 파일, 설정 파일만 바뀐 경우,
  쉘·다른 편집기로 수정한 파일, 저장하지 않은 에디터 버퍼, 동시에 일어난 외부 편집은 범위 밖입니다.

## 매니페스트 호환성

[공식 패키징 문서](https://developers.openai.com/plugins/build/plugins)는 포터블
`plugin.json`과 호환 형식을 설명합니다. 이 패키지는
[.codex-plugin/plugin.json](.codex-plugin/plugin.json)과 [.mcp.json](.mcp.json)을 사용합니다.
검증한 Codex 0.169.1은 포터블 패키지의 훅 로딩을 명시적으로 건너뛰기 때문입니다.
[해당 버전 loader.rs](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/core-plugins/src/loader.rs#L929-L939)
및 [검증 기록](../../docs/verification.md)을 참고하세요.
루트에 포터블 매니페스트를 추가하면 우선 선택되어 이 버전에서 훅이 사라질 수 있습니다.

훅 입력·출력은 [공식 PostToolUse 계약](https://learn.chatgpt.com/docs/hooks#posttooluse)을
따릅니다. 공개 디렉터리 제출과 개인 계정 활성화는 이 구현의 검증 범위에 포함하지 않습니다.

## 검증

저장소 루트에서 실행합니다.

```sh
npm run check
TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript npm test
TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript \
TEST_MODEL_CATALOG=/absolute/path/to/models_cache.json \
npm run test:codex
```

마지막 검사는 Codex CLI가 필요하며 loopback 포트 바인딩이 허용되어야 합니다.
`TEST_MODEL_CATALOG`는 Codex의 공개 모델 기능 메타데이터 파일입니다. `models` 목록만
임시 파일에 복사하며 계정 identity, 인증 파일은 복사하지 않습니다.
실제 모델 호출은 없고 로컬 Responses SSE 픽스처가 도구 호출만 결정합니다.
새 임시 `CODEX_HOME`에서 카탈로그·설치, 실제 app-server MCP 호출 세 가지,
실제 `apply_patch`, 다음 모델 요청에 들어간 TS2345를 검증합니다.
훅 신뢰 검토 생략 옵션은 검증한 훅을 이 시험 호출에서 실행할 때만 사용하며 영구 신뢰를 저장하지 않습니다.

기본적으로 임시 홈과 결과를 정리합니다. `KEEP_CODEX_TEST=1`을 주면
`app-server-evidence.json`, `model-requests.json`, Codex stdout/stderr를 남기고 경로를 출력합니다.
이 파일에는 로컬 경로와 세션 지침이 포함될 수 있으므로 공개 저장소에 복사하지 마세요.
