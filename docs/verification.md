# TypeScript LSP 검증 기록

검증일: 2026-11-24 (이 Mac, 로컬).

- 작업공간: `/Users/copyx/orca/workspaces/codex-plugins/typescript-lsp`
- 원본 클론: `/Users/copyx/projects/codex-plugins`
- 작업 브랜치: `copyx/typescript-lsp`
- 환경: Node 24.14.1, Codex CLI 0.169.1, typescript-language-server 6.0.3,
  MiddleSomewhere tools의 TypeScript 5.9.3을 읽기 전용으로 사용했습니다.
- 커밋·푸시·PR·공개 배포, 본계정 전역 설정·개인 마켓 활성화는 하지 않았습니다.

## 바뀐 파일과 검사 결과

| 파일 | 결과와 검증 |
| --- | --- |
| [.agents/plugins/marketplace.json](../.agents/plugins/marketplace.json) | copyx-codex-plugins 마켓에 typescript-lsp 연결; 실제 CLI available 목록 탐색과 설치 성공 |
| [매니페스트](../plugins/typescript-lsp/.codex-plugin/plugin.json), [MCP 설정](../plugins/typescript-lsp/.mcp.json), [훅 설정](../plugins/typescript-lsp/hooks/hooks.json) | 설치된 Codex app-server가 MCP 3개와 PostToolUse 훅을 발견함; 초기 훅 trustStatus=untrusted도 확인 |
| [server.mjs](../plugins/typescript-lsp/server.mjs) | stdio MCP 초기화·목록·호버 테스트 통과; 실제 Codex app-server에서 정의 위치 0행, 참조 2개 이상, string 매개변수 호버 검증 |
| [project.mjs](../plugins/typescript-lsp/lib/project.mjs) | 가장 가까운 tsconfig/jsconfig, hoisted 프로젝트 TypeScript, 경로 탈출·심볼릭 링크 차단, 전역 TypeScript 대체 금지 검증 |
| [lsp.mjs](../plugins/typescript-lsp/lib/lsp.mjs) | 실제 정의·참조·호버, didChange 후 TS2345, 진단 시간 초과, 응답 없는 프로세스 종료 검증 |
| [post-tool-use.mjs](../plugins/typescript-lsp/hooks/post-tool-use.mjs) | 실제 진단을 additionalContext로 출력; 두 프로젝트를 한 패치에서 검사해 a의 TS2345와 b의 정상 결과 분리; JS checkJs TS2345도 검증 |
| [테스트](../tests/bridge.test.mjs), [고장 픽스처](../tests/fixtures/silent-lsp.mjs) | 전체 13개 통과, 실패 0, 건너뜀 0 |
| [check.mjs](../scripts/check.mjs), [package.json](../package.json) | Node 구문, JSON 파싱, 카탈로그→매니페스트→MCP/훅 경로 연결 통과; 외부 Node 의존성 추가 없음 |
| [test-codex.mjs](../scripts/test-codex.mjs) | 임시 CODEX_HOME 설치→실제 app-server 탐색→실제 apply_patch→실제 훅 실행→다음 모델 요청에 TS2345 포함, 종료 코드 0 |
| [README](../README.md), [사용법](../plugins/typescript-lsp/README.md), [구현 계획](implementation-plan.md), 이 기록 | 전제 조건·격리 설치·도구 입력·시간 제한·호환성·미검증 범위 기록; git diff --check 통과 |

실행한 명령:

```sh
TEST_TYPESCRIPT_DIR=/Users/copyx/projects/middle-somewhere/tools/node_modules/typescript npm test
npm run check
git diff --check
TEST_TYPESCRIPT_DIR=/Users/copyx/projects/middle-somewhere/tools/node_modules/typescript \
TEST_MODEL_CATALOG=/Users/copyx/.codex/models_cache.json \
KEEP_CODEX_TEST=1 npm run test:codex
```

별도 lint/typecheck 패키지는 설치하지 않았습니다. JavaScript 실행 코드에 대해
Node 구문 검사와 동작 테스트를 수행했으며, TypeScript 정적 타입 검사를 실행했다는 의미는 아닙니다.
프로세스 목록의 테스트 fixture/설치 캐시 경로 검사에서 남은 LSP 프로세스는 없었습니다.
응답하지 않는 LSP 픽스처는 테스트에서 PID가 사라진 것도 확인했습니다.

## 실제 Codex 통합 증거

최종 임시 증거 디렉터리:

`/private/var/folders/8p/ncdyh9cj6zg04bkz3kqgz_f00000gn/T/typescript-lsp-codex-dmKpbx`

- `app-server-evidence.json`: hooks/list, mcpServerStatus/list와
  실제 mcpServer/tool/call definition/references/hover 응답.
- `model-requests.json`: 로컬 Responses 테스트 서버가 받은 실제 Codex 요청 2개.
  두 번째 요청의 developer 컨텍스트에 다음 문구가 포함됐습니다.
- `codex-output.jsonl`: 실제 apply_patch의 file_change completed 이벤트.
- `codex-stderr.txt`: 런타임 진단. 임시 호출에서만 hook trust 검토를 생략했다는 경고 포함.

```text
TypeScript LSP post-patch diagnostics (changed files only; disk snapshot):
main.ts:2:7: error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.
```

공개 모델 기능 메타데이터의 `models` 목록만 복사했습니다. 인증 파일과 계정 identity는
복사하지 않았고 API 키·토큰과 Orca 세션 환경을 테스트 자식 프로세스에서 제거했습니다.
위 임시 디렉터리의 원본 요청 파일은 로컬 세션 지침을 포함하므로 저장소에 넣지 않았습니다.
임시 파일은 OS 정리 이후 없어질 수 있으며 테스트 명령으로 재생성할 수 있습니다.

## 관찰한 제약과 남은 확인

1. 포터블 루트 `plugin.json`으로 설치하면 0.169.1에서 MCP는 로드되지만 훅은
   hooks/list에 나타나지 않았고 실제 패치 후 컨텍스트도 없었습니다.
   [동일 버전 loader.rs](https://github.com/openai/codex/blob/rust-v0.169.1/codex-rs/core-plugins/src/loader.rs#L929-L939)는
   AgentPlugin의 훅 소스를 빈 목록으로 만듭니다. 따라서 호환 매니페스트만 사용했습니다.
   최신 [패키징 문서](https://developers.openai.com/plugins/build/plugins)의 권장 형식과
   이 버전의 실제 동작 차이를 확인한 결과입니다.
2. loopback listen과 프로세스 목록 확인은 기본 sandbox에서 EPERM으로 막혀
   해당 로컬 통합 검사와 읽기 전용 프로세스 확인만 권한 확장으로 실행했습니다.
   전역 설정 변경이나 외부 서비스 연결은 필요하지 않았습니다.
3. 실제 모델 서비스, 본계정 데스크톱 UI에서의 설치·훅 신뢰 클릭·자연어 도구 선택은
   시험하지 않았습니다. 모델 응답은 결정적인 로컬 SSE 픽스처이며,
   실제 Codex의 도구 실행 및 다음 모델 요청으로 컨텍스트를 전달하는 구간을 검증했습니다.
   MCP 탐색은 별도의 실제 Codex app-server RPC로 검증했습니다.
4. 언어 서버의 버전 없는 publishDiagnostics에는 최종 완료 신호가 없습니다.
   짧은 안정화 시간과 새 프로세스로 이전 패치의 진단을 격리하지만, 전체 프로젝트
   빌드의 완전성을 보장하지 않습니다. 바뀐 파일만 검사하는 범위와 제한 시간은
   [사용법](../plugins/typescript-lsp/README.md)에 명시했습니다.
5. 본계정 활성화가 별도로 요청되면 실제 클라이언트에서 설치하고
   [공식 훅 신뢰 절차](https://learn.chatgpt.com/docs/hooks#posttooluse)에 따라 검토한 뒤
   자연어 탐색과 패치 오류 수정을 한 번 더 확인하면 됩니다.
