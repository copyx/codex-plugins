# 유지보수 문서

설계·구현·검증 정보는 이 디렉터리에서 관리합니다.
플러그인을 사용하는 방법은 [루트 안내](../README.md)와
[TypeScript LSP 사용자 안내](../plugins/typescript-lsp/README.md)를 참고하세요.
Python 사용자는 [Python LSP 사용자 안내](../plugins/python-lsp/README.md)를 참고하세요.

| 문서 | 내용 |
| --- | --- |
| [구현 계획](implementation-plan.md) | 작업 범위, 설계 선택, 구현·검증 순서 |
| [TypeScript LSP 구현](typescript-lsp-implementation.md) | 프로세스 분리, 진단 대기, 실행 제한, 매니페스트 호환성 |
| [Python LSP 설계와 검증](python-lsp.md) | 독립 번들·ty/환경 계약, MCP 3개·타입 진단, TS 공존 검증과 한계 |
| [검증 자동화 사용법](verify-usage.md) | 유지보수용 검증 명령, 입력 경로, 격리·사용자 설치 검사의 경계 |
| [검증 기록](verification.md) | 실행 환경, 검사 결과, 당시 제약과 후속 확인 결과 |
