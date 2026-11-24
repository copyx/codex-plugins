# copyx Codex Plugins

개인용 로컬 Codex 플러그인 마켓플레이스입니다. 첫 플러그인은
[typescript-lsp](plugins/typescript-lsp/README.md)입니다.

- 카탈로그: [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
- 기능: TypeScript/JavaScript 정의·참조·호버, `apply_patch` 후 LSP 진단 컨텍스트
- 검증 결과와 한계: [검증 기록](docs/verification.md)

설치나 빌드가 필요한 Node 의존성은 없습니다. Node.js 22 이상,
PATH의 `typescript-language-server`, 대상 프로젝트의 `node_modules/typescript`가 필요합니다.

```sh
TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript \
TEST_MODEL_CATALOG=/absolute/path/to/models_cache.json npm run verify
```

`verify`는 정적 검사·전체 테스트·격리된 Codex 설치와 MCP·진단 통합 검사를 실행합니다.
현재 프로필의 설치·신뢰와 실제 오류/수정 진단은 같은 인자로 `npm run verify:installed`를 실행하세요.
필수 경로나 설치·신뢰가 빠지면 실패하며 사용자 프로필의 설치·신뢰를 자동 변경하지 않습니다.
경로 입력과 실행 전제는 [검증 자동화 사용법](docs/verify-usage.md)에 있습니다.
