# Python 사용자 런타임 설정 — 0.1.1 이상

0.2.0 후보도 아래 사용자 JSON/명시 환경 선택 계약을 유지한다.
새 후보의 실제 11개 도구·혼합 훅 검증은 [0.2.0 마감 기록](python-lsp-release-0.2.0.md)과 구분해 읽는다.
다음 설치·GUI 관찰은 0.1.1을 적용했을 당시 기록이다.

Orca #66 후속. 기존 0.1.0은 `PYTHON_LSP_TY`를 받은 별도 실행기에서만 동작했고,
실행기 없이 시작한 실제 사용자 app-server의 세 MCP 호출 모두 환경 누락으로 실패했다.
따라서 실행기 검증을 현재 Orca GUI 세션 해결로 간주하지 않고 작은 패치로 구분했다.

## 지원 설정 확인과 선택

[Codex 0.172.0 고정 스키마](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/config.schema.json)의
`PluginMcpServerConfig`는 transport 설정을 제외한 정책 overlay이며,
`shell_environment_policy`는 shell-like 도구의 프로세스 환경이다.
확인한 Orca `agent launch --help`와 설치 버전의 `agent-context`에도 MCP/훅 양쪽을 위한
플러그인별 환경 전달 설정을 찾지 못했다. 앱 전체 시작 환경을 바꾸는 방법을 사용하지 않았다.

0.1.1은 `lib/runtime.mjs`의 한 경로 선택 함수를 MCP와 PostToolUse가 공유한다.
선택 순서는 다음과 같다.

1. 명시한 `PYTHON_LSP_TY`. 비어 있거나 잘못된 값도 오류이며 fallback하지 않는다.
2. Node `os.homedir()`의 `.config/codex-python-lsp/config.json`에 명시한 `ty_path`.
3. 둘 다 없으면 두 설정 방법을 안내하고 중단한다.

```json
{ "ty_path": "/absolute/path/to/ty" }
```

파일/전용 디렉터리의 사용자 소유권·다른 사용자/그룹 쓰기 금지·symlink 거부를 확인한다.
파일은 UTF-8 JSON, 정확히 `ty_path` 한 키, 최대 16 KiB이다.
ty 경로는 절대 경로여야 하고 기존 ty 0.0.109 실행/버전 검증을 그대로 통과해야 한다.
사용자 홈이 비어 있거나 상대 경로면 workspace 설정을 읽는 대신 중단한다.
워크스페이스, PATH, `CODEX_HOME`, `XDG_CONFIG_HOME`은 이 설정의 탐색 후보가 아니다.
분석 대상 Python/venv의 선택·경계 정책과 읽기 전용 MCP 3개는 바꾸지 않았다.

각 도구 호출의 새 LSP 세션에서 설정을 읽으므로 0.1.1 MCP 프로세스는 JSON 변경을 다음 호출에 반영한다.
MCP 결과의 `server.executable`, `server.configuration_source`로 선택된 실행물과 출처를 확인할 수 있다.
이미 실행 중인 0.1.0 코드가 설정 파일을 이해한다고 약속하지 않는다.
GUI 앱/Orca 재시작, 기존 채팅 종료, 전역 셸·환경 변경을 설치 해결 조건으로 두지 않는다.

## 재현과 신뢰 경계

런타임 선택 계약과 실제 entry point는 다음으로 검사한다.

```sh
TEST_TY_BIN=/absolute/path/to/ty \
TEST_PYTHON_ENV=/absolute/path/to/test-venv \
TEST_TYPESCRIPT_DIR=/absolute/path/to/typescript \
node --test --test-reporter=tap tests/*.test.mjs
```

이는 정상 stdio MCP와 훅 코드를 임시 HOME/fixture에서 검사하며 사용자 프로필의 신뢰를 바꾸지 않는다.
전체 Codex 오류→수정 전달은 별도 임시 프로필을 정상 UI로 검토한 뒤
`TEST_PYTHON_RUNTIME_CONFIG=1 npm run verify:python:trusted`로 재현한다.
이 모드는 임시 Node HOME의 JSON을 만들고 `PYTHON_LSP_TY`를 전달하지 않는다.
신뢰 우회 옵션은 사용하지 않는다. 그 외 전제 변수는 [기존 검증 절차](python-lsp.md#재현-명령)와 같다.

실제 사용자 프로필에서는 Python 훅을 검토 전 신뢰하지 않는다.
당시 사용자 설치 버전은 0.1.1이며 검토 경로는 `/hooks` → `PostToolUse` →
`Checking Python diagnostics`, 출처 `python-lsp@copyx-python-preview`이다.
임시 프로필의 정상 신뢰 검사를 사용자 검토 완료로 보고하지 않는다.

macOS의 실제 Node 사용자 홈과 GUI에서 보고된 환경 누락 경로를 대상으로 한 수정이다.
다른 OS의 소유권/파일 시스템 정책이나 다른 Codex/Orca 버전까지 검증한 것은 아니다.

커밋 전 검증은 전체 80개(TS 49·Python 31), 실패/건너뜀 0이었다.
정상 검토를 마친 별도 임시 프로필의 JSON 모드 통합 검사도 Python 31개,
MCP 3+11개와 혼합 apply_patch 2회·모델 요청 3회·언어별 새 오류/정상 결과를 확인했다.
이때 Python 번들 10파일이 체크아웃과 같았고 원본 모델 요청과 외부 모델 호출은 없었다.
