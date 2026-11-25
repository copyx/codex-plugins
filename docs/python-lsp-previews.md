# Python 빠른 수정 미리보기 계약 — Orca #73

`code_actions_preview(workspace_root,file,range)`는 읽기 전용이다.
기존 입력 파일·project/venv/runtime 선택을 재사용하고 새 publishDiagnostics를 받은 뒤
범위에 해당하는 진단과 `only: [quickfix]`로 textDocument/codeAction을 요청한다.
진단 미수신·codeAction capability/quickfix 광고 부재·요청 오류·잘못된 후보 응답은 실패다.
새 진단 [] 또는 수정 후보 []는 이 실패 상태와 구분한다.

## 범위와 상태

입력은 start/end 각각 1-based UTF-16 line/character다. 추가 필드를 받지 않고 파일 좌표·순서와
surrogate 경계를 검사한다. 끝은 exclusive이며 cursor 범위도 허용한다.
진단은 half-open 겹침으로 선택한다. cursor는 진단의 시작을 포함하고 끝을 제외하며,
길이 0 진단은 같은 cursor 위치 또는 비어 있지 않은 요청 범위 안에 있을 때 포함한다.
텍스트 편집끼리 겹치거나 같은 위치의 복수 삽입은 이슈로 표시한다. 인접한 non-overlap 범위는 허용한다.

상태 우선순위는 disabled → requires_command → requires_resolve → unsupported_edit → edit_available → unavailable이다.
명령과 지연 data가 동시에 있을 수 있으므로 command/needs_resolve/issues도 함께 제공한다.
edit_available도 현재 도구에서는 미리보기 상태다. workspace/applyEdit는 기존 클라이언트가 거부한다.
workspace/executeCommand와 codeAction/resolve를 요청하거나 WorkspaceEdit를 파일에 적용하는 코드는 없다.
동적 capability나 resolveSupport를 광고하지 않는다. literal quickfix와 disabled 지원만 추가했다.

import와 suppression은 제목 번역에 의존하지 않고 제안 newText의 import 문/ty 또는 type ignore 지시문을 근거로
category와 category_evidence를 표시한다. 이는 편집 텍스트 분류이며 모든 Python 수정의 의미를 완전히 판별하는 AST 분석은 아니다.

## 선택과 snapshot (preview schema 1)

반환값은 공통 scope/server/environment와 diagnostics_status/version/diagnostics, basis, result 배열이다.
각 후보에는 preview_only, title/kind/category/status, selection_id/action_fingerprint, basis,
command fingerprint, needs_resolve/resolve_data_fingerprint/disabled_reason, edit.files/resource_operations와 issues가 있다.

- request는 canonical workspace/file과 원래 range를 보존한다. PID/시간은 ID에 넣지 않는다.
- scope는 workspace_root/project_root/config/anchor_file이다.
- anchor는 원본 바이트 SHA-256, 크기/모드/파일 식별과 BOM 정보를 포함하며 열린 LSP text와 일치해야 한다.
- project_metadata는 anchor의 디렉터리부터 workspace 경계까지 pyproject.toml/ty.toml 존재/바이트 식별을 담는다.
  별도 configurationFile도 식별한다. 경계 밖 project 설정은 읽지 않는다.
- environment는 선택 venv/path/source/version, pyvenv.cfg 및 interpreter의 canonical path/바이트 식별을 포함한다.
- server는 선택 ty 실행물 canonical path/SHA-256, 실제 --version 결과, server 인자, untrusted/uv 정책,
  실제 client settings, codeAction capability, runtime 설정 출처/파일 식별을 담는다.
- preview_bridge_sha256은 이 계약을 만드는 독립 Python 모듈을 식별한다.
- basis의 diagnostics는 선택된 원형을 canonical 순서로 보관한다.
- targets는 후보가 참조한 URI의 canonical 파일·경계·존재/읽기 상태와 허용된 원본 snapshot이다.
- action_fingerprint는 원래 서버 후보 JSON 전체다. ID는 fingerprint({basis,action_fingerprint})다.
  객체 키는 정렬하고 의미가 있는 배열 순서는 보존한다.

새 세션의 같은 후보는 같은 문맥에서 ID가 같았고, 요청·원문/대상·설정·환경 식별·서버 바이트·제안 편집·
command arguments/resolve data가 바뀌면 선택 근거가 달라진다. opaque data 자체가 새 세션마다 달라지는
다른 서버 후보까지 같은 의미 ID로 합치지는 않는다.
검증용 basis는 현재 문맥을 설명하는 데이터이며 클라이언트가 보내는 편집의 실행 경로가 아니다.
자체 preview 캐시나 자동 선택은 없다.

## 파일 미리보기 정책과 한계

허용된 원문은 lexical/realpath 모두 workspace 안인 .py/.pyi의 일반 파일이다.
같은 workspace의 다른 프로젝트 파일은 읽기 가능한 snapshot과 outside project 표시를 함께 제공한다.
workspace 밖/탈출 symlink, .git/.codex/.agents/.aws/.env 계열, 비 Python/누락/읽기 불가 파일과
선택 environment의 다른 파일은 원문/hash를 제공하지 않는다. 명시한 입력 anchor는 기존 입력 정책을 따른다.
resource create/rename/delete, changeAnnotations, mixed edit forms, 검증 불가 document version은 별도 정책 이슈다.
텍스트별 old/new/range, 원래 document version, 리소스 양 끝의 URI/경계와 옵션을 표시한다.
이슈가 있는 일반 편집은 unsupported_edit다.

최대 20후보·후보당 20 URI/200 편집·20 리소스, 소스 1 MiB, 선택 실행물/interpreter 식별 128 MiB,
runtime JSON 16 KiB, project metadata 디렉터리 64개 한도를 사용한다. 초과를 빈 정상으로 숨기지 않는다.
파생 old/new 텍스트도 후보당 1 MiB로 제한하며 전체 미리보기 출력 1 MiB 예산을 넘기기 전에 중단한다.
완료 전에 anchor/context와 모든 target snapshot을 다시 확인한다.

이 basis는 전체 site-packages·모든 import 의존성의 Merkle snapshot이나 OS sandbox가 아니다.
선택 환경의 식별 범위를 venv metadata/interpreter로 명시했고 외부 라이브러리 소스 전체를 hash하지 않는다.
경쟁적인 디렉터리 교체의 완전한 방어/다중 파일 원자 적용, ACL/xattr 보존은 이 읽기 전용 단계의 증거가 아니다.
후속 적용은 원래 요청의 새 서버 재조회와 대상·선택 재검증/쓰기 정책을 별도로 통과해야 한다.

## #74 재사용 표면

독립 `lib/preview.mjs`의 fingerprint, offsetAt/toLspRange, captureBasis, assertBasisCurrent,
buildPreview를 재사용할 수 있다. 코드 액션 경로는 codeActionsPreview가 새 진단과 실제 요청을 연결한다.
captureBasis의 request는 호출자가 canonical workspace/file과 정규화 좌표로 구성한다.
buildPreview는 basis.tool과 request를 ID에 묶고 서버 action/edit에서 snapshot과 상태를 만든다.
호출자는 build 후 basis와 후보의 targets를 assertBasisCurrent로 재검증해야 한다.
rename 자체의 prepare/이름 검증/요청·응답은 아직 구현하지 않았다.
적용 API·명령 정책·resolve 이후 새 편집 수용은 #75 이후의 별도 책임이다.

실제 ty의 import/억제·반복 ID와 통제된 command/deferred/disabled/resource/failure 증거는
[구현 검증 기록](python-lsp.md)에 구분한다. 사용자 설치/설정/신뢰와 제품 버전은 이번에 변경하지 않는다.
