# TypeScript LSP 구현

유지보수용 구현 설명입니다. 사용자 설치·설정은
[플러그인 안내](../plugins/typescript-lsp/README.md), 설계 선택과 작업 순서는
[구현 계획](implementation-plan.md), 실행 검사는 [검증 자동화](verify-usage.md)에 있습니다.

## 프로젝트와 프로세스 경계

파일에서 지정한 워크스페이스 루트까지 올라가며 가장 가까운 `tsconfig.json`
또는 `jsconfig.json`을 선택합니다. 같은 디렉터리에서는 tsconfig가 우선입니다.
TypeScript의 실제 파일 포함, 프로젝트 참조, 모듈 해석은 언어 서버가 처리합니다.
설정이 없으면 지정한 워크스페이스의 inferred project를 사용합니다.
프로젝트에서 찾은 `tsserver.js` 경로를 초기화 옵션에 전달합니다.

탐색마다 새 LSP 프로세스를 사용합니다. 훅은 변경 파일을 프로젝트 루트와
TypeScript 경로별로 나눠 새 프로세스에서 검사합니다. 다른 루트의 파일을
한 세션에 열지 않습니다. 지속 데몬이나 진단 캐시를 남기지 않으므로 각 호출에는
언어 서버 시작 비용이 있습니다.

## 진단 동기화와 제한

- 초기화 시 `textDocument.publishDiagnostics` capability를 선언합니다.
  진단에 버전이 있으면 현재 문서 버전과 대조하며, 버전이 없는 서버도 받습니다.
  새 프로세스로 이전 패치의 진단을 격리합니다.
- 진단 알림을 최대 6초 기다리고 마지막 알림 뒤 400ms 안정화 시간을 둡니다.
  버전 없는 알림의 완전성을 증명하는 프로토콜 장벽은 없으므로 전체 `tsc` 검사를 대체하지 않습니다.
- 일반 요청은 최대 10초, 훅 초기화는 최대 8초, 훅 전체 작업은 약 20초로 제한합니다.
  종료 시 shutdown/exit를 시도하고 응답하지 않으면 자식 프로세스 그룹을 종료합니다.
- 패치의 Add/Update/Move 목적지를 검사하고 Delete는 제외합니다.
- 한 훅에서 소스 최대 20개, 파일당 진단 최대 30개, 출력 최대 10,000자를 전달합니다.
  생략·시간 초과·실행 실패·TypeScript 누락은 미완료로 표시하며 패치를 차단하지 않습니다.

관련 코드: [프로젝트 선택](../plugins/typescript-lsp/lib/project.mjs),
[LSP 세션](../plugins/typescript-lsp/lib/lsp.mjs),
[MCP 서버](../plugins/typescript-lsp/server.mjs),
[편집 후 훅](../plugins/typescript-lsp/hooks/post-tool-use.mjs).

## 패키징 호환성

[공식 패키징 문서](https://developers.openai.com/plugins/build/plugins)는 포터블
`plugin.json`과 호환 형식을 설명합니다. 이 패키지는
[.codex-plugin/plugin.json](../plugins/typescript-lsp/.codex-plugin/plugin.json)과
[.mcp.json](../plugins/typescript-lsp/.mcp.json)을 사용합니다.

초기 구현에서 사용한 Codex 0.169.1은 포터블 패키지의 훅 로딩을 명시적으로
건너뛰었습니다. [해당 버전 loader.rs](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/core-plugins/src/loader.rs#L929-L939)와
[검증 기록](verification.md)에 근거를 남겼습니다. 루트 포터블 매니페스트를 추가하면
우선 선택되어 이 버전에서 훅이 사라질 수 있으므로 패키징 변경 시 실제 클라이언트에서 재검증해야 합니다.
훅 입력·출력은 [PostToolUse 계약](https://learn.chatgpt.com/docs/hooks#posttooluse)을 따릅니다.

공개 디렉터리 제출·배포는 이 구현 기록의 검증 범위에 포함하지 않습니다.

## 0.2.0 도구와 선택 기준

공개 MCP 도구는 조회·미리보기 9개와 명시적 적용 2개입니다.

- 위치 조회: definition, references, hover, type_definition, implementation
- 파일/프로젝트 조회: document_symbols, project_symbols
- 읽기 전용 미리보기: code_actions_preview, rename_preview
- 쓰기: code_action_apply, rename_apply (readOnlyHint=false, destructiveHint=true)

프로젝트 심볼은 기준 파일이 선택한 config 세션에서 검색합니다.
workspace/symbol을 사용하지만 저장소나 모노레포 전체를 검색한다는 뜻은 아닙니다.
형제 config의 패키지는 그 안의 파일을 기준으로 별도 조회해야 할 수 있습니다.

미리보기 v1은 canonical 요청·root/config·TypeScript identity·anchor/대상 파일의
바이트 해시·편집·명령·resolve 데이터를 묶어 selection_id를 생성합니다.
파일별 URI/종류/경계와 old_text/new_text를 표시하며 영구 실행 예약을 저장하지 않습니다.
ID는 권한 토큰이 아닙니다. 적용 도구는 원래 요청을 새 LSP 세션에서 재조회해
동등한 현재 후보인지 비교하며, 클라이언트가 제출한 편집/basis/명령을 실행하지 않습니다.

## 즉시 빠른 수정과 후속 명령

확인한 서버는 typescript-language-server 6.0.3입니다.
[quickFix handler](https://github.com/typescript-language-server/typescript-language-server/blob/v6.0.3/src/features/codeActions/quickFix.ts#L34-L47)와
[command helper](https://github.com/typescript-language-server/typescript-language-server/blob/v6.0.3/src/features/util/codeAction.ts#L16-L48)를
설치된 번들과 대조했습니다. 알려진 _typescript.applyCodeActionCommand는
action.commands만 처리합니다. 실제 누락 import 후보의 이 배열은 비어 있었습니다.

서버 버전·아티팩트 해시·명령 인자 형식·빈 commands·즉시 edit와 action.changes의
일치를 확인한 경우에만 후속 명령이 no-op임을 증명해 생략합니다.
감사한 CLI SHA-256은 `9d9193d6b7d8d92b291d0f1cae8ca3588a5481d8dd6bdf18bd93a43bd49c2916`입니다.
다른 아티팩트/명령, 추가 실행, 지연 resolve는 사전 거부합니다.
명령이 동반된 미리보기를 일반적인 독립 편집으로 취급하지 않습니다.

## 파일 적용과 복구

[공통 적용](../plugins/typescript-lsp/lib/apply.mjs)은 선택 프로젝트/workspace 안의
기존·소유한·쓰기 가능한 UTF-8 일반 단일 링크 파일만 지원합니다.
URI/실제 경로·부모 inode·no-follow 열기·범위/겹침·원문/해시·검증 가능한 버전을
쓰기 전에 검사하고 임계 시점에 다시 확인합니다. 리소스 작업과 annotation은 지원하지 않습니다.

대상별 lock, 동일 디렉터리의 backup/next 파일, 파일별 원자 교체를 사용합니다.
중간 실패에서는 이번 after-image가 그대로인 파일만 역순 복구하며 별도 변경은 보존합니다.
복구 불가·불확실한 결과는 recovery_incomplete/write_outcome과 검증 가능한 백업 상태로 보고합니다.
실제 첫/두 번째 교체 후 실패와 복구 중 외부 변경을 주입해 검사했습니다.

여러 파일 전체의 OS 트랜잭션은 아니며 비협력 외부 쓰기의 최종 비교/교체 사이 경합,
강제 종료·전원 장애까지 완전 격리하지 않습니다. 모드·소유를 보존하지만 inode/시간이
바뀌고 특수 ACL/xattr 보존은 범위 밖입니다. 미저장 에디터 버퍼를 병합하지 않습니다.

적용 도구는 apply_patch 훅을 실행하지 않습니다. [적용 흐름](../plugins/typescript-lsp/lib/operations.mjs)이
새 세션에서 후속 진단을 직접 조회하고, 편집 성공과 진단 미완료를 분리해 반환합니다.

## 릴리스 버전과 설치 캐시

0.2.0은 기존 입력/응답을 보존하는 기능 추가 마이너 릴리스입니다.
매니페스트와 MCP serverInfo 버전을 맞추며 로컬 마켓은 매니페스트의 버전을 사용합니다.
설치 캐시는 `$CODEX_HOME/plugins/cache/copyx-codex-plugins/typescript-lsp/$VERSION`입니다.
업데이트 후 새 세션·실제 도구 목록과 번들 해시를 확인하며, 새 훅 내용은 별도 신뢰 검토가 필요할 수 있습니다.
