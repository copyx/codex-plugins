# TypeScript LSP

버전 0.2.0 · 조회·미리보기 9개, 실제 적용 2개 도구

로컬 TypeScript/JavaScript 프로젝트에서 문서 심볼과 정의·타입 정의·구현·참조·호버를 조회하고,
Codex가 `apply_patch`로 편집한 파일의 진단을 대화로 전달합니다.
조회·미리보기 도구는 소스를 수정하지 않습니다. 별도의 적용 도구는 선택한 편집을
재검증한 뒤 실제 파일을 변경합니다. 별도 원격 API는 호출하지 않습니다.
조회 결과와 진단은 Codex의 도구·훅 컨텍스트에 포함됩니다.
프로젝트 심볼 검색과 빠른 수정·이름 변경의 미리보기도 제공합니다.

## 이 플러그인의 LSP 제공 범위

아래는 이 플러그인이 Codex에 제공하는 도구와 자동 진단의 범위입니다.

| LSP 기능 | 제공 여부 | 사용자에게 제공되는 범위 |
| --- | --- | --- |
| 정의 탐색 (Definition) | 제공 | `definition`으로 지정한 심볼의 정의 위치 조회 |
| 문서 심볼 (Document Symbol) | 제공 | `document_symbols`로 지정한 파일의 심볼 이름·종류·위치 조회 |
| 타입 정의 탐색 (Type Definition) | 제공 | `type_definition`으로 변수 등이 사용하는 타입 선언 위치 조회 |
| 구현 탐색 (Implementation) | 제공 | `implementation`으로 인터페이스·멤버의 구현 위치 조회; 여러 결과 가능 |
| 참조 탐색 (References) | 제공 | `references`로 선언을 포함한 참조 위치 조회 |
| 호버 (Hover) | 제공 | `hover`로 지정한 위치의 타입·설명 조회 |
| 편집 후 자동 진단 (Diagnostics) | 조건부 제공 | 훅을 신뢰한 상태에서 Codex의 `apply_patch` 후 변경 파일의 저장된 내용에 대한 진단을 대화에 전달 |
| 프로젝트 전체 진단 | 미제공 | 변경 파일 밖의 전체 오류 목록이나 프로젝트 빌드 성공 여부를 확인하는 기능은 없음 |
| 실시간 편집기 진단 | 미제공 | 입력 중인 에디터 버퍼를 계속 감시하거나 실시간으로 진단을 표시하는 기능은 없음 |
| 자동완성·시그니처 도움말 (Completion / Signature Help) | 미제공 | 입력 후보나 함수 인자 도움말을 요청하는 도구 없음 |
| 이름 바꾸기 (Rename) | 미리보기·적용 제공 | `rename_preview`로 변경 목록 확인 후 `rename_apply`로 선택한 기존 파일 텍스트 편집 적용 |
| 코드 액션·빠른 수정 (Code Action) | 미리보기·제한적 적용 제공 | `code_actions_preview` 후 `code_action_apply`로 검증한 즉시 편집 적용; 임의 서버 명령은 실행하지 않음 |
| 문서 서식 (Formatting) | 미제공 | 코드 서식을 변경하는 도구 없음 |
| 프로젝트 심볼 검색 (Workspace Symbol) | 제공 | `project_symbols`로 기준 파일이 선택한 프로젝트 세션 검색; 모노레포 전체 검색은 보장하지 않음 |
| 시맨틱 토큰 (Semantic Tokens) | 미제공 | 의미 기반 구문 강조용 토큰을 제공하는 기능 없음 |

## 필수 조건

- 로컬 stdio MCP 및 플러그인 훅을 지원하는 Codex CLI
- Node.js 22 이상
- PATH에서 실행 가능한 `typescript-language-server`
- 대상 워크스페이스 내부에서 찾을 수 있는 프로젝트 TypeScript

language server가 없다면 Node.js 환경에 설치하세요.

```sh
npm install --global typescript-language-server
```

TypeScript는 작업할 프로젝트의 의존성으로 준비합니다.
아래 npm 명령은 예시이며, 프로젝트가 사용하는 패키지 관리자를 따르세요.

```sh
# 작업할 프로젝트에서
npm install --save-dev typescript
```

플러그인은 `node_modules/typescript/lib/tsserver.js`를 찾으며 전역 TypeScript로
대체하지 않습니다. 모노레포에서 상위에 설치된 TypeScript를 사용한다면
해당 `node_modules`를 포함하는 워크스페이스 루트를 지정하세요.
플러그인 자체의 의존성 설치나 빌드는 필요하지 않습니다.

## 설치와 자동 진단 설정

이 저장소의 로컬 체크아웃을 등록하는 방법은 [설치 안내](../../README.md#설치)를 참고하세요.
설치 후 작업할 프로젝트에서 새 Codex 세션을 엽니다.

자동 진단은 훅 신뢰 검토가 필요합니다.

1. Codex에서 `/hooks`를 실행합니다.
2. `PostToolUse` → `Checking TypeScript diagnostics`를 선택합니다.
3. `typescript-lsp@copyx-codex-plugins`의 명령과 동작을 검토하고 해당 훅을 신뢰합니다.

데스크톱 클라이언트에 Review hooks가 표시되는 경우 그 화면에서도 검토할 수 있습니다.
신뢰하지 않은 훅은 실행되지 않습니다. 탐색 도구 사용과 자동 진단의 활성 여부는 별개입니다.

## 사용법

예를 들어 다음과 같이 요청할 수 있습니다.

> typescript-lsp로 src/main.ts 12행 7열의 정의를 찾아줘.
>
> 같은 위치의 참조와 타입 설명도 보여줘.
>
> service 변수가 사용하는 타입 선언과 Greeter 인터페이스의 구현을 찾아줘.

위치 기반 도구 `definition`, `references`, `hover`, `type_definition`, `implementation`은
같은 인자를 받습니다.

```json
{
  "workspace_root": "/absolute/path/to/your-project",
  "file": "src/main.ts",
  "line": 12,
  "character": 7
}
```

- `workspace_root`: 작업할 프로젝트의 절대 경로. 모노레포라면 프로젝트 TypeScript가 있는 상위 루트까지 포함하세요.
- `file`: 루트 상대 경로나 절대 경로. 루트 밖 파일과 밖으로 연결되는 심볼릭 링크는 허용하지 않습니다.
- `line`, `character`: 1부터 시작하는 줄과 UTF-16 문자 위치.

결과에는 선택한 `project_root`와 `config`가 포함됩니다.
반환 위치의 `range`는 LSP 형식에 따라 0부터 시작하며, 참조에는 선언도 포함됩니다.
파일에 가장 가까운 `tsconfig.json` 또는 `jsconfig.json`을 사용하고,
설정이 없으면 지정한 워크스페이스를 기준으로 해석합니다.

`definition`은 지정한 심볼의 선언을, `type_definition`은 사용하는 타입의 선언을 조회합니다.
`implementation`은 인터페이스나 멤버의 구현 위치를 조회하며 결과가 여러 개일 수 있습니다.
타입 정의·구현이 없는 위치는 `result: []`로 반환합니다.

### 파일의 심볼 목록

> typescript-lsp로 src/main.ts의 클래스·함수·인터페이스·메서드 목록을 보여줘.

`document_symbols`는 줄·문자 위치 없이 파일만 지정합니다.

```json
{
  "workspace_root": "/absolute/path/to/your-project",
  "file": "src/main.ts"
}
```

`project_root`, `config`와 함께 `result`에 평면 LSP 심볼 목록을 반환합니다.
각 항목의 `name`은 이름, `kind`는 숫자 종류, `location.uri`와 `location.range`는
파일과 0부터 시작하는 위치입니다. 대표 종류는 클래스 `5`, 메서드 `6`,
인터페이스 `11`, 함수 `12`입니다. 심볼이 없으면 `result: []`입니다.
문서 심볼은 지정한 파일만 조회하며 워크스페이스 전체 검색 도구는 아닙니다.

### 프로젝트의 심볼 검색

> src/main.ts를 기준으로 이 프로젝트의 square 심볼을 찾아줘.

`project_symbols`는 기준 파일과 비어 있지 않은 이름 query를 받습니다.

```json
{
  "workspace_root": "/absolute/path/to/your-project",
  "file": "src/main.ts",
  "query": "square"
}
```

아직 열지 않은 파일의 심볼도 프로젝트에 포함돼 있으면 찾을 수 있습니다.
결과의 `search_scope`에는 실제 기준 파일(`anchor_file`), 워크스페이스·프로젝트 루트,
선택한 config가 표시됩니다. 별도 config의 형제 패키지가 자동으로 포함되는 것은 아닙니다.
그 패키지를 검색하려면 그 안의 파일을 기준으로 요청하세요. 결과가 없으면 `result: []`입니다.

### 빠른 수정 후보 미리보기

> square의 누락된 import를 고칠 후보와 변경 내용만 보여줘.

`code_actions_preview`는 파일 범위와 실제 언어 서버 진단을 사용합니다.
예를 들어 `export const answer = square(2);`가 있는 1행의 square 범위는 다음과 같습니다.

```json
{
  "workspace_root": "/absolute/path/to/your-project",
  "file": "src/main.ts",
  "range": {
    "start": { "line": 1, "character": 23 },
    "end": { "line": 1, "character": 29 }
  }
}
```

입력 범위는 1부터 시작하는 UTF-16 위치이고 끝은 포함하지 않습니다.
응답의 `diagnostics`는 해당 범위의 실제 진단이며, `result`는 빠른 수정 후보 목록입니다.
후보가 없으면 빈 배열을 반환합니다. 진단을 임의로 입력해 수정을 요청하는 도구는 아닙니다.

| 후보 status | 의미 |
| --- | --- |
| `edit_available` | 편집 내용이 반환됨. 실제 적용 가능성이나 실행 허가를 뜻하지 않음 |
| `requires_command` | 후속 서버 명령이 수반됨. 편집이 보여도 명령 없이 완결된 수정이라고 볼 수 없음 |
| `requires_resolve` | 지연 계산 정보가 있어 완결된 편집으로 취급하지 않음. 이 도구는 resolve를 실행하지 않음 |
| `unavailable` | 즉시 보여줄 편집이나 실행 정보가 없음 |
| `disabled` | 서버가 사용할 수 없는 후보로 표시함. `disabled_reason` 확인 |

### 이름 변경 미리보기

> Greeter를 NamedGreeter로 바꾸면 어떤 파일이 바뀌는지 미리 보여줘.

`rename_preview`는 위치와 새 이름을 받습니다.

```json
{
  "workspace_root": "/absolute/path/to/your-project",
  "file": "src/model.ts",
  "line": 1,
  "character": 18,
  "new_name": "NamedGreeter"
}
```

선언·참조·import에 대한 예정된 편집을 파일별로 반환합니다.
심볼이 없거나 서버가 이름 변경을 제공하지 않는 위치는 `status: "not_renamable"`,
`result: null`로 반환합니다. 조회 실패는 다른 도구처럼 오류로 표시합니다.

### 미리보기 결과 읽기

두 미리보기 도구는 **파일을 쓰거나 반환된 명령을 실행하지 않습니다**.
각 후보의 `preview_only: true`는 그 범위를 나타냅니다.

- `edit.files`: URI·파일 경로와 파일별 편집. `old_text`/`new_text`로 교체 내용을,
  0부터 시작하는 `range`로 위치를 확인합니다.
- `workspace_boundary`, `project_boundary`: 각 대상이 워크스페이스·선택 프로젝트 안인지 표시합니다.
  워크스페이스 밖 파일은 내용을 읽지 않으므로 원문·해시가 제공되지 않습니다.
- `edit.resource_operations`: 파일 생성·이동·삭제 등 별도 편집 종류와 대상 경계.
  이 단계에서도 실제 작업은 수행하지 않습니다.
- `issues`: 경계 밖 대상, 해석할 수 없는 URI, 별도 정책이 필요한 편집 등의 주의 사항입니다.
- `selection_id`, `basis`: 해당 요청·프로젝트 설정·파일 내용에 묶인 선택 식별과 기준입니다.
  파일이나 문맥이 바뀐 뒤의 미리보기와 섞어 사용할 수 없습니다. 저장된 실행 예약이나 적용 허가가 아닙니다.

미리보기는 선택 자료만 제공합니다. 실제 변경은 다음의 별도 적용 도구로 요청해야 합니다.

### 선택한 편집 적용

> 방금 보여준 import 추가 후보 하나만 code_action_apply로 적용해줘.
>
> Greeter를 NamedGreeter로 바꾸는 미리보기를 선택해서 rename_apply로 적용해줘.

`code_action_apply`에는 원래 `code_actions_preview` 요청의 파일·range와 선택한 후보의
`selection_id`를 전달합니다. `rename_apply`에는 원래 `rename_preview` 요청의
파일·위치·`new_name`과 `selection_id`를 전달합니다. `workspace_root`도 원래 요청과 같아야 합니다.
편집 내용·basis·서버 명령을 직접 제출하는 입력은 받지 않습니다.

적용 도구는 서버를 다시 조회해 같은 후보인지 확인합니다. 파일·설정·새 이름 등 기준이
달라졌거나 이미 적용한 선택이면 오류로 거부하므로, 최신 미리보기를 다시 확인하세요.
`rename_apply`의 새 이름은 키워드를 제외한 TypeScript 식별자만 지원합니다.
미리보기·적용은 저장된 디스크 내용을 기준으로 하며, 에디터의 미저장 버퍼를 읽거나 병합하지 않습니다.

지원 범위는 선택한 프로젝트와 워크스페이스 안에서 현재 사용자가 소유한
**유효한 UTF-8 기존 일반 파일의 텍스트 편집**입니다.
심볼릭 링크 경로, 하드 링크, 읽기 전용 파일, 파일 생성·이동·삭제,
확인용 annotation이나 지연 resolve가 필요한 편집은 적용하지 않습니다.
심볼릭 링크를 따르지 않는 파일 열기를 지원하지 않는 환경에서는 적용을 거부합니다.

빠른 수정의 후속 명령은 기본적으로 거부합니다. 예외는 감사한
`typescript-language-server 6.0.3` CLI 아티팩트에서 `_typescript.applyCodeActionCommand`가
추가 작업을 하지 않는 경우뿐입니다. 실제 응답의 `action.commands`가 비어 있고
즉시 편집과 명령의 편집 정보가 같을 때 명령 실행을 생략하고 그 편집만 적용합니다.
같은 버전이라도 다른 아티팩트이거나 추가 실행이 필요하면 거부하며,
결과의 `command_effect`에 확인한 버전·아티팩트 해시와 효과를 표시합니다.

| 적용 결과 status | 의미 |
| --- | --- |
| `applied` | 편집 완료. `files`에서 변경 파일, `diagnostics`에서 명시적으로 조회한 후속 진단 확인 |
| `rejected` | 사전 검증이나 임계 시점 확인에서 거부. 이 호출의 소스 편집은 시작하지 않음 |
| `rolled_back` | 중간 실패 후 이 호출이 적용한 파일을 원본으로 복구함 |
| `recovery_incomplete` | 별도 변경 등으로 일부 복구를 중단함. 현재 내용과 `recovery`의 원본 `backup_path`를 직접 비교해야 함 |

지원하지 않는 선택·오래된 ID 등은 도구 오류로도 반환합니다.
복구 중 감지한 별도 변경은 덮지 않으며, 필요한 원본 백업과 정리하지 못한 파일은
`retained_artifacts`로 보고합니다. 복구 자료를 확인하기 전에 삭제하거나 같은 선택을 재실행하지 마세요.
`backup_verified: false`이면 표시된 경로를 원본 백업이라고 가정하지 말고,
함께 보고된 실패 이유와 원본 해시를 확인해야 합니다.

파일별 교체는 원자적으로 수행하고 도구끼리는 잠금과 내용·해시 재확인을 사용하지만,
여러 파일을 하나의 OS 트랜잭션으로 처리하지는 않습니다. 외부 프로그램이 최종 확인과
교체 사이에 변경하는 경합, 프로세스 강제 종료·전원 장애까지 완전히 격리·복구하지는 않습니다.
파일 모드·소유 정보를 보존하지만 교체로 inode·시간 정보가 바뀌며 특수 ACL/xattr 보존은 지원 범위가 아닙니다.

**적용 도구는 이 플러그인의 `apply_patch` 진단 훅을 실행시키지 않습니다.**
대신 도구가 변경 파일의 진단을 새 세션에서 직접 조회해 반환합니다.
편집이 완료됐더라도 조회가 실패하면 `diagnostics_status: "incomplete"`로 표시되므로
이를 적용 실패나 프로젝트 전체 검사 성공과 혼동하지 마세요.

연결된 도구가 지연 로딩되는 클라이언트에서는 먼저 플러그인을 선택하거나 도구 검색을 사용하세요.

## 자동 진단 범위

훅을 신뢰한 상태에서 Codex가 `apply_patch`로 소스를 추가·수정·이동하면
변경된 파일의 진단이 대화에 전달됩니다.

- 지원 확장자: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`
- JavaScript의 타입 오류를 확인하려면 프로젝트의 `checkJs` 설정 또는 `// @ts-check`를 사용하세요.
- 삭제한 파일, 다른 편집기·쉘로 바꾼 파일, 저장하지 않은 에디터 버퍼는 검사하지 않습니다.
- 변경하지 않은 다른 파일과 설정 파일만 바꾼 경우의 영향은 전체 프로젝트 검사를 통해 확인하세요.
- 파일 수·진단 수·실행 시간에 제한이 있습니다. 결과가 잘리거나 시간 초과·의존성 누락이 발생하면 미완료로 표시합니다.

`no diagnostics`는 해당 변경 파일에서 받은 결과이며, 프로젝트 전체의 빌드 성공을
뜻하지 않습니다. 프로젝트에서 사용하는 타입 검사·빌드 명령도 함께 실행하세요.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| 플러그인이 보이지 않음 | `codex plugin list --marketplace copyx-codex-plugins --json`으로 현재 프로필의 설치 상태를 확인하고 새 세션을 엽니다. |
| 탐색 도구가 연결되지 않음 | `codex mcp list --json`과 PATH의 Node.js·`typescript-language-server`를 확인합니다. |
| `Project TypeScript not found` | 프로젝트에 TypeScript를 설치했는지, 지정한 루트가 해당 `node_modules`를 포함하는지 확인합니다. |
| 탐색은 되지만 자동 진단이 없음 | `/hooks`에서 해당 훅의 활성·신뢰 상태를 확인하고, Codex의 `apply_patch`로 지원 소스 파일을 편집했는지 확인합니다. |
| 진단이 미완료로 표시됨 | 출력에 표시된 누락·시간 초과 원인을 확인하고 프로젝트 자체의 타입 검사 명령으로 확인합니다. |
| 업데이트 후 이전 내용이 보임 | 설치된 캐시 복사본을 사용하므로 아래와 같이 재설치한 뒤 새 세션을 열고 변경된 훅을 다시 검토합니다. |

로컬 체크아웃을 업데이트한 뒤 플러그인을 다시 설치하려면 다음을 실행합니다.

```sh
codex plugin remove typescript-lsp@copyx-codex-plugins --json
codex plugin add typescript-lsp@copyx-codex-plugins --json
```

제거만 하려면 첫 번째 명령만 실행하세요.

업데이트 후에는 새 Codex 세션을 열고 설치 목록의 버전이 `0.2.0`인지 확인하세요.
번들 내용이 바뀌면 자동 진단 훅도 다시 검토해야 할 수 있습니다.
