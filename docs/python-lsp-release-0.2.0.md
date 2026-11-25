# Python LSP 0.2.0 로컬 릴리스 후보 — Orca #78

이 문서는 #78 당시의 후보 검증 기록이다. 이후 main 병합 전 #83의 안전성 보완은 [현재 검증 기록](python-lsp.md)에 분리했다.

0.1.1의 환경/기본 탐색/훅 계약을 유지하면서 #69~#77의 심볼·탐색·미리보기·선택 적용을 묶은 후보다.
이 기록은 임시 Codex 프로필의 0.2.0 검증이며 사용자 0.1.1 preview 설치의 갱신/신뢰 완료를 뜻하지 않는다.
원격 push·main 병합·태그·현재 사용자 설치/설정/신뢰 변경은 수행하지 않았다.

## 패키징과 공개 메타데이터

- plugin manifest, 실제 MCP serverInfo, 내부 LSP clientInfo를 0.2.0으로 맞췄다.
- manifest 설명/짧은 설명은 navigation·previews·selected edits를 표시하고 interface.capabilities는 Read/Write다.
  도구는 읽기 9개·쓰기 2개이며 쓰기 도구만 destructive/non-idempotent 힌트를 가진다.
- 기존 TypeScript 0.2.0과 같은 Codex manifest 형식을 유지한다. Agent Plugins 형식으로 이전하는 작업은 아니다.
- root marketplace의 ./plugins/python-lsp와 ./plugins/typescript-lsp 경로는 그대로다.
  Python 번들 안의 .mcp.json → server.mjs와 hooks/hooks.json → hooks/post-tool-use.mjs가 연결된다.
  runtime import는 Python 번들 내부와 Node 내장 모듈뿐이다. TS나 저장소 scripts의 runtime 코드가 필요하지 않다.

근거는 [공식 패키징 문서](https://developers.openai.com/plugins/build/plugins)의 Read/Write 예와 Codex 호환 형식,
[Codex 0.172.0 manifest parser](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core-plugins/src/manifest.rs)의
interface/상대 경로 처리다. interface 표시는 실행 권한을 대체하지 않으며 실제 쓰기 경계는 별도로 검사한다.
현재 설치 CLI가 이 형식을 읽고 독립 cache를 생성한 것도 통합 검사에서 확인한다.

| 읽기 9개 | 쓰기 2개 |
| --- | --- |
| definition, references, hover, document_symbols, project_symbols, type_definition, implementation, code_actions_preview, rename_preview | code_action_apply, rename_apply |

Python 사용자 표의 첫 열은 LSP 기능이며 [사용자 README](../plugins/python-lsp/README.md)는 설치/환경·사용 예·지원 범위만 다룬다.
설계/단계 기록은 [python-lsp.md](python-lsp.md), JSON 호환은 [runtime 설정](python-lsp-runtime-settings.md),
선택 ID는 [preview 계약](python-lsp-previews.md), 쓰기/복구/후속 진단은 [apply 계약](python-lsp-apply.md)에 분리했다.

## 설정 호환과 통합 검사

고정 ty 0.0.109 실행물과 분석 fixture의 Python .venv를 별도로 지정한다.
명시 PYTHON_LSP_TY가 최우선이며, 없으면 Node 사용자 홈의 전용 JSON ty_path를 사용한다.
0.1.1의 JSON 형식·소유권/경로 검사·per-session 읽기 동작은 바꾸지 않았다.
두 방식 모두 실제 MCP/훅 경로에서 검사하며 JSON 모드에는 PYTHON_LSP_TY를 전달하지 않는다.
임의 PATH/global Python fallback·자동 패키지 설치·uv 실행을 추가하지 않았다.

검증 진입점은 [자동화 사용법](verify-usage.md)과 같다.
아래 변수는 각각 ty 절대 실행물·분리한 도구 venv·TypeScript 패키지·공개 모델 카탈로그의 절대 경로다.

```sh
TEST_TY_BIN="$TY_BIN" TEST_PYTHON_ENV="$PYTHON_ENV" TEST_TYPESCRIPT_DIR="$TYPESCRIPT_DIR" TEST_MODEL_CATALOG="$MODEL_CATALOG" npm run verify:python
TEST_PYTHON_RUNTIME_CONFIG=1 TEST_CODEX_PROFILE="$REVIEWED_TEMP_PROFILE" TEST_TY_BIN="$TY_BIN" TEST_PYTHON_ENV="$PYTHON_ENV" TEST_TYPESCRIPT_DIR="$TYPESCRIPT_DIR" TEST_MODEL_CATALOG="$MODEL_CATALOG" npm run verify:python:trusted
TEST_TYPESCRIPT_DIR="$TYPESCRIPT_DIR" TEST_MODEL_CATALOG="$MODEL_CATALOG" npm run verify
TEST_TY_BIN="$TY_BIN" TEST_PYTHON_ENV="$PYTHON_ENV" TEST_TYPESCRIPT_DIR="$TYPESCRIPT_DIR" TEST_MODEL_CATALOG="$MODEL_CATALOG" npm test
npm run check
git diff --check
```

trusted 모드는 별도 임시 프로필에 두 패키지를 설치하고 정상 Codex TUI의 /hooks에서 각각 검토한 뒤 사용한다.
신뢰 파일을 복사/작성하거나 사용자 프로필의 검토로 대체하지 않는다. 외부 모델 대신 로컬 모델 fixture를 사용한다.
기본 격리 모드는 임시 프로필의 일회성 신뢰 생략을 명시하고, trusted 모드는 해당 옵션 없이 실행한다.
검증기는 선택 프로필 config와 cache 파일의 해시 무변경, 실제 hook 신뢰 hash/활성 상태를 전후 비교한다.

2026-11-25, Codex 0.172.0·ty 0.0.109·Node 24.14.1·테스트 Python 3.15.2·TypeScript 6.0.2·language-server 6.0.3에서 확인했다.

| 실행 | 결과 |
| --- | --- |
| npm test | 154개 통과, 실패/건너뜀 0 |
| npm run verify:python (명시 env) | Python 105개·정확한 11개 MCP·두 적용/후속 진단·혼합 훅 통과; 기본 격리 신뢰 생략 모드 |
| npm run verify:python:trusted (기존 JSON) | Python 105개·동일 MCP/적용/혼합 훅 통과; 별도 임시 정상 검토 프로필, 우회 없음 |
| npm run verify | 기존 TS 49개·11개 MCP·실제 적용/훅 통과, 실패/건너뜀 0 |
| npm run check / git diff --check | 70파일과 diff 검사 통과 |

두 Python 통합 모드 각각 혼합 apply_patch 2회·로컬 모델 요청 3회에서 TS/Python 오류 컨텍스트 1개씩,
수정 뒤 새 정상 컨텍스트 2개씩을 확인했다. 원본 모델 요청 저장과 외부 모델 호출은 없다.
최종 임시 cache의 Python 14파일·TS 11파일이 소스와 바이트별로 같았다.
파일별 SHA-256을 이름순 JSON으로 직렬화한 aggregate는 Python
`7439513bb65a9917634b9465bc9265084c6d0420f960c1c5d8997cbdd40f6966`, TS
`30f0ef71681eb02d26bf4c2a10634de436cb6a88528c99b6a3040265af918fdc`였다.
이는 해당 후보 내용의 검증 지문이며 다른 번들이 같은 버전명만 가진다고 동일하다고 보지 않는다.

release metadata 검사는 변경 전 0.1.1 실패를 먼저 확인한 뒤 0.2.0·실제 MCP inventory/힌트와의 일치로 통과했다.
통제 stdio fixture에서도 실제 initialize의 내부 clientInfo가 manifest와 같은지 확인한다.
재설치 후 변경된 훅을 다시 정상 검토한 임시 프로필에서 최종 JSON 검사를 수행했다.
검증 전후 현재 사용자 config/마켓·TS/Python 설치 cache·신뢰·runtime JSON은 동일했다.

## 관찰 범위와 적용 경계

실제 ty에서는 계층/프로젝트 심볼·타입/구현 탐색, 누락 import quickfix와 다중 파일 rename을 확인했다.
쓰기에는 원래 요청과 명시한 selection_id만 허용한다. 새 서버 재조회·후보/대상 일치 후에만 기존 파일을 적용한다.
미리보기는 항상 읽기 전용이고 raw edit/basis/명령·자동 첫 후보/억제 선택·리소스 작업은 실행하지 않는다.
단순 import 수정과 선언/import/참조 rename, 무관한 동명 심볼 유지와 후속 새 진단을 검사했다.

파일별 교체이며 여러 파일 전체가 하나의 OS 트랜잭션은 아니다. 별도 편집이 있으면 rollback으로 덮지 않고
recovery_incomplete와 원본 백업/검증 상태를 반환한다. 적용 뒤 진단만 실패하면 applied+incomplete로 남긴다.
원래 inode/mtime·ACL/xattr·crash recovery/directory fsync 내구성·완전한 동시 디렉터리 교체 방어를 보장하지 않는다.
전체 site-packages/import 의존성 snapshot, 모든 Unicode/Node/Python 버전·다른 OS·대규모 저장소는 미검증이다.
command/deferred/disabled/resource/annotation/오류와 일부 WorkspaceEdit 변형은 통제 fixture 증거이며
실제 ty가 모두 반환한 것으로 주장하지 않는다.

## 다음 배포의 경계

현재 후보를 실제 사용자 설치로 설명하지 않는다. 기존 main 추적 TS 마켓/0.2.0 설치와 Python 0.1.1 preview는 보존한다.
향후 배포에는 별도 승인된 push/소스 선택·설치 갱신과 정상 훅 검토가 필요하다.
당시 구현의 Git 경로·고정 preview 설치 관계는 [이전 설치 기록](python-lsp-installation.md)에 있다.
