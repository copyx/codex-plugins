# copyx Codex Plugins

개인용 로컬 Codex 플러그인 마켓플레이스입니다. 첫 플러그인은
[typescript-lsp](plugins/typescript-lsp/README.md)입니다.

- 카탈로그: [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json)
- 기능: TypeScript/JavaScript 정의·참조·호버, `apply_patch` 후 LSP 진단 컨텍스트
- 검증 결과와 한계: [검증 기록](docs/verification.md)

설치나 빌드가 필요한 Node 의존성은 없습니다. Node.js 22 이상,
PATH의 `typescript-language-server`, 대상 프로젝트의 `node_modules/typescript`가 필요합니다.

```sh
npm run check
TEST_TYPESCRIPT_DIR=/absolute/path/to/node_modules/typescript npm test
```

`TEST_TYPESCRIPT_DIR`가 없으면 실제 TypeScript가 필요한 테스트는 건너뜁니다.
Codex 자체 통합 검사는 [플러그인 문서](plugins/typescript-lsp/README.md#검증)를 참고하세요.
