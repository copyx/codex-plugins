# Python LSP 0.1.0 설계와 검증

2026-11-24, Orca #61·#62·#63. 기준은 `main`의 `b8c7b4b`이며 Python 전용 worktree에서
0~1단계만 구현했다. 사용자 안내는 [Python README](../plugins/python-lsp/README.md)에 있다.
커밋·푸시·PR·병합이나 사용자 Codex 설치/설정/신뢰 변경은 이 작업에 포함하지 않는다.

## 후속 문서 심볼 — Orca #69

`document_symbols(workspace_root,file)`을 추가했다. 위치 입력이 없는 파일 단위 읽기 전용 도구이며
ty `textDocument/documentSymbol`을 호출한다. client는 hierarchicalDocumentSymbolSupport를 광고한다.
선택된 서버가 documentSymbolProvider를 제공하지 않으면 오류로 반환하고 LSP 요청 오류도 전파한다.
null/빈 정상은 `[]`로 통일하되, 원래 DocumentSymbol children/이름/kind/range/selectionRange 또는
flat SymbolInformation 형식을 변환하거나 flatten하지 않는다. 입력의 기존 프로젝트·파일 경계는 재사용한다.

실제 ty의 클래스/메서드/함수, .pyi, CRLF/비-BMP 식별자 범위, 빈 파일, traversal/symlink 거부를 검사하고
직접 LSP 응답과 MCP 결과 전체를 비교한다. flat/null/미지원/요청 오류는 stdio 서버 fixture로 계약을 검사한다.
정확한 Python MCP 목록은 4개로 갱신하며 격리 Codex에서 목록/호출과 기존 혼합 훅 회귀도 재검증한다.
릴리스 버전 정리는 후속 통합 항목에서 수행한다. 이 항목은 사용자 설치·신뢰·push를 변경하지 않는다.

2026-11-25 검증: `npm run verify:python` 33개와 `npm run verify`의 기존 TS 49개가
실패/건너뜀 없이 통과했다. 실제 격리 Codex에서 Python 4개·TS 11개 목록/호출,
혼합 패치 2회·모델 요청 3회와 언어별 오류 컨텍스트 1개→수정 후 새 컨텍스트 2개를 확인했다.
정적 검사 53파일과 `git diff --check`도 통과했다. 기본 격리 검증의 일회성 훅 신뢰 생략은
임시 프로필에만 적용했고 사용자 프로필의 설치·설정·신뢰는 변경하지 않았다.

## 후속 프로젝트 심볼 — Orca #70

`project_symbols(workspace_root,file,query)`는 기존 resolveProject로 세션을 선택하고 anchor 파일을 동기화한 뒤
`workspace/symbol`을 요청한다. query는 공백만이 아닌 문자열이고 위치 인자는 받지 않는다.
workspaceSymbolProvider 미지원·LSP 오류·잘못된 응답 형식은 오류이며 null/빈 정상은 `[]`이다.
`search_scope`의 kind=selected_project_session, workspace_root/project_root/config/anchor_file과
기존 environment 필드로 실제 세션 선택을 표시한다. 응답 kind/location/range 등은 보존하고
중첩 location.uri에도 workspace_boundary를 덧붙이며 외부 소스 내용을 별도로 읽지 않는다.

실제 ty 0.0.109 관찰은 다음과 같다.

- 프로젝트 a의 열지 않은 src/hidden.py 심볼 검색, 없는 이름의 `[]`.
- 별도 ty.toml을 가진 a 기준 검색에는 b 심볼이 없고, b 기준 파일을 쓰면 b 심볼을 찾는다.
- a의 environment.root에 ../b를 추가하고 import하면 definition은 b를 해석하지만 workspace/symbol에는 b 심볼이 없었다.
- a의 `[src].exclude`로 지정한 파일은 검색되지 않았고 다른 미개방 파일은 검색됐다.
- 부모 설정이 선택되는 기준 파일에서는 하위 b 심볼을 찾았다. 같은 workspace 경계여도 anchor의 선택이 다르다.

따라서 import 해석 root와 심볼 인덱싱 범위를 동일시하거나 모든 형제 프로젝트의 절대 격리를 약속하지 않는다.
결과를 bridge에서 project_root로 잘라 서버 동작을 숨기지도 않는다.
[고정 환경 설정 문서](https://github.com/astral-sh/ty/blob/0.0.109/docs/reference/configuration.md)와
[LSP 기능 문서](https://github.com/astral-sh/ty/blob/0.0.109/docs/features/language-server.md)를 확인했으며,
검색 범위 판단의 직접 근거는 위 실제 fixture 호출이다. 사용자 설치·버전 마감은 이 항목에서 변경하지 않는다.

2026-11-25 검증: Python 35개와 기존 TS 49개, 실패/건너뜀 0. 실제 격리 Codex에서
Python 5개·TS 11개 목록/호출과 혼합 패치 2회·모델 요청 3회·언어별 새 오류/정상 결과를 확인했다.
정적 검사 53파일과 `git diff --check`도 통과했다.

## 계약과 구현 선택

`plugins/python-lsp`는 매니페스트, MCP 서버, lib, 빈 기본 설정, 훅을 모두 포함한다.
TS 플러그인이나 저장소 scripts를 runtime import하지 않는다. Node 내장 모듈만 사용하며
서버 실행 파일은 `PYTHON_LSP_TY` 또는 0.1.1의 사용자 전용 JSON에 명시된 절대 경로를 요구하고
실행 전 정확한 버전을 확인한다. [GUI 런타임 설정](python-lsp-runtime-settings.md)에 후속 변경을 기록했다.
고정 서버 명령은 `ty server`이며 `--stdio` 같은 TS 전용 인자는 붙이지 않는다.

워크스페이스 경계·선택 프로젝트·ty 설정·분석 venv·서버 실행물은 별도로 관리한다.
소스는 lexical/realpath 경계를 검사하고 `.py/.pyi` UTF-8 파일만 연다.
프로젝트의 가까운 ty 설정을 찾고 같은 디렉터리의 `ty.toml`을 우선한다.
환경은 명시 설정이나 확인 가능한 `.venv`만 채택한다. 인터프리터의 파일/venv 메타데이터를
확인할 뿐 프로젝트 Python이나 import 코드를 실행하지 않는다.

환경 경로의 충돌을 무음으로 덮지 않기 위해 TOML의 환경 메타데이터를 보수적으로
사전 검사한다. ty가 전체 TOML을 검증한다. 명시 테이블·일반/인용/dotted key·단일 행
환경 문자열을 지원하고 환경 inline table·변수 확장·PEP 723 환경은 명확히 거부한다.
이 사전 검사는 범용 TOML 파서를 제공한다는 계약이 아니다.

선택된 `ty.toml`은 `configurationFile`로 전달하고, `[tool.ty]`는 프로젝트 탐색으로 읽는다.
ty 설정이 없을 때는 번들 안의 빈 `defaults.toml`을 지정해 경계 밖 상위 ty 설정 상속을
차단한다. 사용자 ty 설정을 암묵적으로 병합하지 않도록 자식의 XDG/APPDATA 설정 위치를
번들 내 미사용 경로로 고정한다. 명시 분석 환경은 inline `configuration.environment.python`에도
전달한다. 활성 환경/Conda/PYTHONPATH 등은 자식 환경에 무작정 전달하지 않는다.

초기화는 `untrustedWorkspace=true`, `experimental.useUv=off`, UTF-16을 명시한다.
`workspace/configuration` 요청에 실제 선택 설정을 응답하고 `workspace/applyEdit`는 거부한다.
정의는 Location과 LocationLink를 보존하고 외부 URI/실체 경계를 표시한다.
반환 위치에 대한 부가 소스 읽기는 없다. rootUri와 이 표시는 ty의 파일 접근을 막는 OS sandbox는 아니다.

도구/훅마다 새 프로세스를 열어 watcher 없는 장기 세션 문제를 피한다.
파일을 full-text didOpen/didChange로 동기화하고 단조 증가 버전을 사용한다.
현재 open 버전과 일치하는 새 push publication만 진단으로 인정한다.
과거·versionless 결과나 미수신을 새 정상 결과로 표시하지 않는다.
진단 완료를 탐색 도구의 불필요한 대기 조건으로 사용하지 않는다.

LSP 프레임 최대 8 MiB, 요청 기본 8초, 진단 기본 6초, 소스 1 MiB,
MCP 응답 1 MiB, 훅 입력 2 MiB/20파일/파일당30진단/총20초 제한을 둔다.
시간 초과는 불완전 상태이며 종료 때 자식 프로세스 그룹을 정리한다.
Windows에서는 직접 자식 종료만 구현되어 있으며 자식 트리 정리를 검증하지 않았다.

## 공식 고정 근거

- [ty 0.0.109 editor settings](https://github.com/astral-sh/ty/blob/0.0.109/docs/reference/editor-settings.md): configuration/configurationFile, untrustedWorkspace와 uv 차단.
- [ty 0.0.109 configuration](https://github.com/astral-sh/ty/blob/0.0.109/docs/configuration.md): ty.toml 우선순위, pyproject와 사용자 설정 병합 기본 동작.
- [ty 0.0.109 environment](https://github.com/astral-sh/ty/blob/0.0.109/docs/reference/configuration.md): Python 환경/상대 root/src 탐색.
- [Codex MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): stdio 환경 전달에는 `env_vars`가 필요하다. 실제 0.172.0 설치에서 확인했다.
- [Codex 플러그인 패키징](https://developers.openai.com/plugins/build/plugins): 플러그인 루트 내 manifest/MCP/hook 경로. 실제 캐시에서 Python 번들이 독립 실행됨을 별도로 확인했다.

## 재현 명령

테스트 도구는 제품 환경과 분리해 준비한다. 아래 준비는 사람이 명시적으로 실행하는
유지보수 절차이며 플러그인에서 자동 실행하지 않는다. 서버와 분석 venv를 별개로 지정할 수도 있다.

```sh
test_tools=$(mktemp -d)
python3 -m venv "$test_tools/tools"
"$test_tools/tools/bin/python" -m pip install --disable-pip-version-check --no-cache-dir ty==0.0.109
export TEST_TY_BIN="$test_tools/tools/bin/ty"
export TEST_PYTHON_ENV="$test_tools/tools"
export TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript
export TEST_MODEL_CATALOG=/absolute/path/to/models_cache.json
npm run verify
npm run verify:python
```

`verify`는 기존 TS 49개와 TS 격리 Codex 검증을 유지한다. `verify:python`은 Python 테스트의
건너뜀을 허용하지 않고 두 플러그인을 임시 CODEX_HOME에 설치해 공존까지 검사한다.
Python 경로/정확한 버전/분석 venv가 없으면 명확히 실패한다.
기본 격리 자동화에서만 일회성 hook trust bypass를 사용하고 summary에 이를 표시한다.
외부 모델을 호출하지 않고 공개 모델 기능 메타데이터만 로컬 Responses fixture에 사용한다.
loopback 바인딩과 Codex 자식 실행 권한이 필요하다.

정상 신뢰 경로는 별도 임시 프로필에 설치한 뒤 Codex TUI에서 두 훅을 검토하고 검사한다.
`TEST_CODEX_PROFILE`은 임시 디렉터리 안의 프로필만 허용하며 현재 사용자 프로필을 거부한다.
신뢰 상태 파일을 직접 생성하거나 복사하지 않는다.

```sh
test_profile=$(mktemp -d)
CODEX_HOME="$test_profile" codex plugin marketplace add "$PWD" --json
CODEX_HOME="$test_profile" codex plugin add typescript-lsp@copyx-codex-plugins --json
CODEX_HOME="$test_profile" codex plugin add python-lsp@copyx-codex-plugins --json
# 별도 임시 프로필의 Codex TUI를 열어 /hooks → PostToolUse의 두 훅을 검토하고 신뢰한 뒤 종료한다.
# 인증 정보나 사용자 프로필을 복사하지 않는다. 로컬 모델 provider를 사용하면 외부 모델 호출이 필요 없다.
TEST_CODEX_PROFILE="$test_profile" npm run verify:python:trusted
# 검사 종료 후 이 절차가 만든 test_profile과 test_tools만 정리한다.
```

`verify:python:trusted`는 두 훅의 실제 trusted 상태를 요구하고 bypass 옵션을 사용하지 않는다.
검사 전후 선택 프로필의 config.toml과 두 플러그인 캐시 해시를 비교한다.
기본 격리 모드도 현재 사용자 프로필의 설정/두 플러그인 파일 해시 무변경을 확인한다.
원본 모델 요청·인증 정보를 저장하지 않고 임시 fixture와 자식 프로세스를 정리한다.

## 검증 결과와 한계

실행 환경: macOS arm64, Node 24.14.1, Python 3.15.2, ty 0.0.109,
Codex CLI 0.172.0, typescript-language-server 6.0.3, TypeScript 6.0.2.
이전 Orca #49의 서버 후보 실험은 설계 입력이며 아래 구현 검증과 별개다.

| 항목 | 이번 구현의 직접 증거 |
| --- | --- |
| 환경/경계 | 명시 venv/프로젝트 .venv, 누락·충돌·다른 VIRTUAL_ENV, 상대 경로, ty.toml 우선, quoted/dotted 환경 키, sibling config, 소스/설정 symlink 이탈과 workspace alias 검사 |
| 실제 LSP | initialize/capabilities/configuration, src import, definition/reference/hover, .pyi 소스/대상, 무심볼 정상, UTF-16 이모지/CRLF, 새 오류 뒤 새 빈 진단 |
| 외부 환경 | 별도 실제 테스트 venv에 marker 패키지를 두고 외부 definition 위치/표시 확인; bridge 추가 소스 읽기 없음 |
| 오류/제한 | 무응답 요청·진단 timeout, 자식 종료, 큰 프레임, 과거/versionless publication, 서버 편집 요청 거부, malformed MCP와 입력 경계/좌표 오류 |
| 실제 진입점 | 복사한 독립 번들의 MCP list와 세 호출; PostToolUse의 오류→정상, 다중 프로젝트, 추가/이동/.pyi/삭제/다른 언어와 누락 환경 구분 |
| 기본 통합 | 임시 실제 Codex 설치와 app-server에서 Python 3개 + TS 11개 발견/호출; mixed apply_patch 2회·모델 요청 3회, 언어별 오류 컨텍스트 1개→수정 뒤 2개 |
| 신뢰 통합 | 별도 임시 Codex 정상 검토 화면에서 두 훅을 신뢰; trusted 상태 검사 후 우회 없는 동일 혼합 패치/새 결과 검증 |
| TS 회귀 | `npm run verify`: 기존 49개 통과, 실패/건너뜀 0; 기존 TS 실제 MCP 적용·훅 검증 유지 |
| Python 검증 | `npm run verify:python` 및 `npm run verify:python:trusted`: 각각 24개 통과, 실패/건너뜀 0; 최종 Python 캐시 9파일이 체크아웃과 바이트별 일치 |

이 수치는 이번 고정 환경의 관찰이며 다른 버전의 검사 결과로 일반화하지 않는다.
이 저장소는 별도 lint/typecheck 도구 체계가 없으므로 `npm run check`의 모든 MJS 구문,
JSON, 로컬 Markdown 링크와 manifest 연결 검사 및 테스트로 검증한다.

미확인: 실제 고객 의존성의 타입 정확성, 큰 저장소의 초기 분석/성능,
여러 환경·Conda/Pixi의 자동 선택, 다른 Python/ty/Codex 버전, Windows/Linux,
사용자 GUI 앱의 환경 전달과 신뢰 UX 전수, 설정 병합 전수, 경쟁적인 파일/디렉터리 교체.
입력 경계 검사는 OS sandbox나 디렉터리 교체 경쟁에 대한 완전한 방어를 뜻하지 않는다.
다음 단계는 승인 후 탐색 확장이며 preview·실제 적용은 별도의 검증/쓰기 계약이 필요하다.
