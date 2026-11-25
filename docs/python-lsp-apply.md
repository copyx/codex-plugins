# Python 텍스트 적용 계약 — Orca #75·#76·#77

`plugins/python-lsp/lib/apply.mjs`는 #73·#74 미리보기의 기존 파일 텍스트 편집을 적용하는 **내부 모듈**이다.
#75는 외부 쓰기 도구를 추가하지 않았다. #76·#77의 현재 MCP는 읽기 9개·선택 quickfix/rename 쓰기 2개다.
TS 적용의 검증·staging·파일별 교체·복구 패턴을 참고했지만 Python 번들 밖의 코드를 import하지 않는다.
추가 의존성·패키지 설치·서버 명령 실행·preview 저장은 없다.

## 소비 API와 선택 전제

```js
import { applyPreview } from './apply.mjs';
// 호출자는 canonical 원래 요청으로 새 서버 조회를 완료해야 한다.
// 표시했던 selection_id와 새 후보의 selection_id가 정확히 같은지 먼저 검사한다.
const result = await applyPreview(project, session, freshlyRegeneratedPreview);
```

project는 resolveProject로 선택한 실제 workspace/root/config/environment이고 session은 **재조회한 같은 세션**이다.
preview는 codeActionsPreview의 선택 후보 또는 renamePreview의 result이다.
이 함수는 새 서버 조회나 원래 선택 ID 비교를 대신하지 않는다. 내부 basis/selection 지문 일치만 추가로 확인한다.
MCP 클라이언트가 보낸 raw edit/basis/preview를 전달하는 용도로 사용하면 안 된다.
`{io}` 선택 인자는 실제 fs 작업 경계의 I/O 대체/실패 주입에 사용하며 MCP 입력으로 노출하지 않는다.

원래 [preview basis](python-lsp-previews.md)의 canonical 요청·target preimage·환경/서버 식별 계약은 바꾸지 않았다.
시작 시 assertBasisCurrent를 호출한다. 자체 교체 후에는 알려진 자기 소유 anchor/target 바이트·식별만 좁게 갱신한
검사용 basis와 anchor text overlay를 사용한다. 원래 config/환경/서버/operation 증거는 유지한다.
이 overlay는 실제 LSP document를 sync하거나 버전을 올린 것으로 취급하지 않는다.
#76은 아래 별도 helper로 성공 뒤 기존 세션을 닫고 새 진단을 받는다.

## 선택 빠른 수정 적용 — Orca #76

`code_action_apply(workspace_root,file,range,selection_id)`는 원래 1-based UTF-16 범위와
preview의 sha256 ID만 받는다. additionalProperties=false이며 raw edit/basis/command/복수 선택을 거부한다.
새 MCP 호출의 새 LSP 세션에서 새 진단·codeAction 후보를 얻고 ID가 일치하는 후보가 **정확히 하나**인지 확인한다.
canonical 요청·선택 context·target preimage는 기존 preview ID에 포함된다.
후보가 없거나 둘 이상 일치하면 거부한다. 첫 후보나 진단 억제 후보를 자동 선택하지 않는다.
command/deferred/disabled/unsupported 상태를 edit_available로 승격하거나 resolve/명령을 실행하지 않는다.

독립 `lib/operations.mjs`의 applyCodeAction(project,session,args,options={})가 이 흐름을 연결한다.
options는 내부 엔진 I/O 실패 주입용이며 MCP 입력이 아니다. 선택된 후보를 수정하지 않고 applyPreview에 전달한다.
반환은 workspace/project/config/environment/server와 result다. result에는 status/selection_id/files/recovery와 별도 진단 상태가 있다.
엔진 rejected/rolled_back/recovery_incomplete는 구조화한 결과를 보존하면서 MCP isError=true로 표시하고,
오래된 선택/잘못된 입력 등 사전 실패는 기존 오류 응답을 사용한다.

postApplyDiagnostics(project,session,result)는 #77에서도 같은 계약으로 재사용한다.
applied에만 원래 세션을 닫고 같은 선택 ty 절대 실행 경로로 별도 새 세션을 시작한다.
project/config/environment와 대상 경계를 다시 확인하고 새 publishDiagnostics를 기다린다.
결과를 applied_snapshot_in_new_session으로 표시하기 전 읽기 중 파일 identity/metadata가 안정적인지 확인하고,
실제 disk SHA-256과 열린 text가 적용 결과의 바이트에 일치하는지 확인한다.
이후 source가 달라지거나 서버/진단/cleanup이 실패하면 result.status=applied를 유지하고 diagnostics_status=incomplete와 이유를 반환한다.
기존 apply_patch 훅이 자동으로 실행되는 경로는 아니다.

성공한 새 수신은 received, 미수신/후속 오류는 incomplete, 미적용 엔진 결과는 not_run이다.
rejected/rollback에는 후속 진단 세션을 시작하지 않는다. 진단만 실패했다고 이미 완료한 적용을 rollback하지 않는다.
diagnostics_server에 실제 새 ty 버전/경로를 담는다. 이 메타데이터가 없으면 새 세션 준비가 실패했을 수 있다.
진단 원형은 파일당 30개·전체 진단 데이터 256 KiB 내에서 보존하고 omitted_diagnostics/diagnostics_truncated로 생략을 표시한다.
이 경우 빈 배열만으로 정상/무진단을 판정하지 않는다. 진단 출력 한도로 적용 성공 응답을 잃지 않도록 제한한다.
후속 오류/cleanup 오류 텍스트도 각각 4096 UTF-16 단위로 제한하고 생략을 표시해 큰 서버 오류가 applied 응답을 가리지 않게 한다.

실제 ty 0.0.109의 누락 import 후보는 서버 명령 없이 즉시 edit로 완결됐고,
정상 MCP 및 격리 Codex에서 import가 추가된 뒤 새 unresolved-reference가 해소됐다.
억제 후보와 utils/무관 파일은 자동으로 적용·변경하지 않았다. 중복 호출·변조/오래된 선택은 거부됐다.
명령/지연/비활성/리소스/annotation/외부·중복 후보, 진단 startup/timeout/출력 생략과 별도 source 변경은
통제 stdio fixture 증거다. 적용 롤백·진단 cleanup 오류는 내부 I/O/API 실패 주입 증거로 구분한다.

## 선택 이름 변경 적용 — Orca #77

`rename_apply(workspace_root,file,line,character,new_name,selection_id)`는 원래 1-based UTF-16 위치와 새 이름/선택만 받는다.
raw edit/basis/command·range/복수 선택을 거부하며 미리보기의 Python 이름 정책을 입력 단계부터 유지한다.
새 세션의 renamePreview가 확인한 capability/prepare 결과·canonical 요청·환경/서버·target preimage와
제안 편집에 묶인 ID가 같아야 한다. not_renamable/no_changes, 없는/오래된 ID와 unsupported_edit는 적용하지 않는다.

lib/operations.mjs의 applyRename(project,session,args,options={})가 새 미리보기를 재조회한다.
일치하는 edit_available 후보만 수정 없이 #75 applyPreview에 보내고 #76 postApplyDiagnostics로 결과를 분리한다.
applied/rolled_back/recovery_incomplete·selection_id·복구/백업 증거를 보존한다.
미적용 결과는 not_run이며 적용 후 서버 오류/별도 파일 변경은 applied+incomplete다.
후속 진단 출력 한도와 오류 메시지 생략 정책도 #76과 같다.

실제 ty 0.0.109의 두 파일에서 선언·import·참조가 바뀌고 CRLF/앞선 이모지 좌표와 무관한 동명 class/다른 파일이 유지됐다.
원래 대상 변경·변조 요청·중복 적용은 무쓰기 거부됐다. 실제 ty 편집 형식은 changes였다.
documentChanges 성공, capability/prepare 변경·오류/잘못된 응답·외부/리소스/annotation·hardlink 거부 및 post 오류는
통제 stdio fixture, 다중 파일 rollback/복구 충돌은 내부 I/O 실패 주입 증거다.
서버 workspace/applyEdit는 계속 거부하며 executeCommand/resolve·파일 생성/이동/삭제를 실행하지 않는다.
이름 변경 preview 자체의 null/빈/상태와 이름 검증 계약은 바꾸지 않았다.

## 쓰기 전 정책

- preview schema 1, rename_preview/code_actions_preview의 `edit_available`만 받는다.
  command/resolve/disabled/issues/resource operations와 annotations는 거부한다. 빈 annotations 객체도 현재는 거부한다.
- file URI만 허용한다. query/fragment·외부 위치·중복 canonical 대상/alias를 거부한다.
- 기존 `.py/.pyi` 일반 파일만 지원한다. lexical/canonical workspace 및 선택 project root 안이어야 하고
  실제 각 대상의 resolveProject 결과도 같은 root/config/configurationFile/environment여야 한다.
  하위 디렉터리에 별도 설정이 새로 생긴 경우도 임계 검사에서 다시 거부한다.
- 대상/부모의 symlink, hardlink(nlink != 1), 보호 경로(.git/.codex/.agents/.aws/.env 계열),
  선택 venv 내부와 실행물/interpreter, 누락·특수 파일을 거부한다. 입력 anchor도 venv 안이면 쓸 수 없다.
  preview가 읽기 허용한 일부 symlink/다른 프로젝트 파일도 쓰기는 더 엄격하게 제한한다.
- 현재 사용자가 소유하고 쓰기 비트가 있는 파일만 받는다. setuid/setgid/sticky 등 특수 권한은 거부한다.
- SHA-256·원본 바이트 길이/일반 mode·device/inode·BOM과 현재 snapshot을 비교한다.
  preview target metadata와 edit.files도 같아야 한다. 현재 열린 버전이 필요한 편집은 session의 버전과 같아야 한다.
  buildPreview가 unverified로 표시하는 non-anchor document version은 적용 가능 후보가 아니다.
- 원본과 합성 결과 모두 UTF-8을 엄격히 decode하고 유효한 Python source coding cookie/BOM인지 검사한다.
  첫 줄 cookie가 우선이며 둘째 줄은 첫 줄이 공백/주석일 때만 유효하다. 비활성 이후 선언은 무시한다.
  ASCII/Latin-1/unknown 등 지원 밖 선언과 BOM 충돌은 본문이 ASCII여도 거부하고 자동 변환하지 않는다.
  LSP의 BOM 없는 UTF-16 좌표를 사용하며 BOM은 원래 바이트에 있을 때 보존한다.
  원문 old_text, 유효한 좌표·순서/surrogate 경계를 확인하고 중복·겹침·같은 시작의 모호한 편집을 거부한다.
  인접 범위는 허용한다. 적용 범위 밖의 CRLF는 보존하고 서버 new_text의 줄바꿈을 임의로 변환하지 않는다.
  잘못된 Unicode replacement를 자동 대체 문자로 바꾸지 않고 거부한다.
- 최대 20파일·200편집, 파일 읽기/결과 각각 1 MiB다. no-op만 있는 후보는 거부한다.

모든 대상의 사전 검증이 끝나기 전에는 transaction artifact도 만들지 않는다.
일반 실패는 rejected와 이유를 반환하며 source 쓰기를 시작하지 않는다.

## 파일별 교체와 복구

대상 디렉터리에 고정 이름 `.파일명.python-lsp.lock`을 O_EXCL로 만든다. 같은 엔진끼리의 협조적 충돌 방지이며
기존 lock을 자동 제거하지 않는다. UUID를 포함한 .backup/.next를 O_EXCL/O_NOFOLLOW로 만들고 파일 내용을 sync한다.
백업은 0600, next는 원래 mode/소유자·그룹을 사용한다.
source를 truncate해서 쓰지 않고 같은 디렉터리의 next를 rename으로 파일별 교체한다.
엔진 자체의 source/artifact snapshot은 O_NOFOLLOW/O_NONBLOCK으로 열어, 이 open 경계에서 FIFO로 바뀌어도
writer를 기다리지 않고 일반 파일 여부로 거부한다. 기존 project/preview 검사 전체를 OS sandbox로 바꾸는 것은 아니다.

staging 뒤·매 교체 전·전체 완료 전에 basis, 모든 대상 snapshot, 각 대상 project 선택과 문서 버전을 다시 확인한다.
artifact도 inode/hash/mode/소유자·시간·link 수와 부모 identity를 확인하고 source를 마지막으로 다시 읽는다.
교체 뒤 결과가 staged 바이트/파일 식별/권한과 같은지도 확인한다. rename 자체가 실패를 보고해도 실제 교체가
일어났을 수 있어 destination을 관찰한다. 검증 불가 결과는 무단 rollback 대신 불확실한 쓰기로 보고한다.

| status | 의미 |
| --- | --- |
| applied | 알려진 모든 파일 교체와 완료 검사가 통과함; files에 before/after SHA-256 |
| rejected | source 교체를 시작하지 않음; reason과 retained_artifacts 확인 |
| rolled_back | 교체한 파일의 원본 바이트를 복구하고 검증함; recovery에 restored |
| recovery_incomplete | 별도 편집/metadata 변경·artifact 교체·검증 불가로 일부 복구하지 않음 |

복구는 역순이며 현재 파일이 **엔진이 확인한 교체 결과와 바이트/identity/metadata까지 같을 때만** 수행한다.
검증된 백업과 source를 다시 확인한 뒤 복구하며 별도 사용자 편집은 덮지 않는다.
백업은 복구 준비 시 원래 소유자/권한으로 조정하므로 이 시점의 충돌로 남긴 백업은 생성 시의 0600과 다를 수 있다.
실패 항목은 backup_path/original_sha256/backup_verified/reason을 반환하고 해당 백업을 남긴다.
retained_artifacts는 자동 삭제하지 못했거나 보존한 경로다. 경로만 있다는 사실이 현재 유효성을 보장하지 않으므로
backup_verified=false 또는 부모 교체 사례에서는 별도 확인해야 한다. 삭제/수동 복구를 자동 실행하지 않는다.

## main 병합 전 안전성 보완 — Orca #83

lib/source.mjs의 readRegularBytes/protectedPath/pythonText를 project/preview/apply가 공유한다.
설정·preview 대상 읽기는 nonblocking/no-follow open 뒤 fd의 일반 파일 여부와 상한을 확인한다.
소스 인코딩은 원본 preview/프로젝트 선택과 엔진 원본/합성 결과에 같은 UTF-8 전용 정책을 적용한다.
미리보기는 합성 결과의 지원 밖 인코딩도 unsupported_result_encoding으로 표시한다.
보호 경로 요소는 모든 볼륨에서 보수적으로 소문자 비교해 혼합 대소문자 alias의 원문 노출과 쓰기를 막는다.
대소문자 구분 볼륨에서도 해당 예약 이름 변형을 거부하는 정책이다.

[PEP 263](https://peps.python.org/pep-0263/)의 유효 선언 위치와
[CPython 3.15.2 tokenize](https://github.com/python/cpython/blob/v3.15.2/Lib/tokenize.py)의 UTF-8 이름/BOM 규칙을 참고했다.
Python 3의 무선언 기본값은 UTF-8이며, BOM 없는 utf8과 utf-8/utf_8 계열을 지원한다.
제품에서 Python을 실행하거나 다른 코덱으로 변환하지 않는다. 테스트 도구의 바이트 compile은 소스를 실행하지 않는다.

수정 전 실제 ty rename이 ASCII/Latin-1 선언 소스를 손상시키던 사례와 writer 없는 config/target FIFO 대기,
case-insensitive fixture의 보호 경로 원문 노출을 재현했다. 수정 후 무쓰기·원문 비노출과 UTF-8/BOM 대조군,
첫째/둘째 줄 규칙·다중 파일 사전 거부를 확인한다. 최신 전체 수치는 [검증 기록](python-lsp.md)에 둔다.

## 기존 엔진 검증과 제한

실제 ty 0.0.109의 rename을 새 세션으로 재조회하여 ID 일치를 확인한 다음, 두 파일의 선언/import/참조를 적용했다.
무관한 동명 class는 그대로였고 중복 적용은 오래된 preimage로 거부됐다.
내부 실제 파일 I/O 검사에서는 .py/.pyi·UTF-16 이모지·BOM·CRLF·인접 편집·mode 보존,
사전 무쓰기 거부·staging/임계 시점 변경·중간 실패 전/후의 불확실 rename·완전 복구·복구 중 사용자 편집 보존과
검증된/교체된 백업·부모 symlink·FIFO 대체·협조적 동시 적용을 검사한다. 실패 주입은 실제 fs 함수를 감싼 테스트 증거다.
세부 수치와 명령은 [Python 검증 기록](python-lsp.md#후속-공통-텍스트-적용-기반--orca-75)에 있다.

여러 파일은 하나의 OS 트랜잭션이 아니다. 복구도 원본 inode/mtime 복원을 약속하지 않는다.
최종 검사와 rename 사이의 경쟁을 원자적으로 차단하지 못하며 악의적인 동일 사용자 프로세스에 대한 OS sandbox가 아니다.
프로세스 중단/전원 손실의 crash recovery·directory fsync 내구성·ACL/xattr 보존·완전한 의존성 closure snapshot은 제공하지 않는다.
macOS의 작은 격리 fixture에서 관찰한 범위이며 다른 OS/대규모 저장소는 미검증이다.
