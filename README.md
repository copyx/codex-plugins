# Codex Plugins

Codex에서 사용할 수 있는 로컬 플러그인 모음입니다.

## 플러그인

| 플러그인 | 기능 | 사용자 안내 |
| --- | --- | --- |
| `typescript-lsp` | 문서·프로젝트 심볼과 코드 탐색, 빠른 수정·이름 변경 미리보기 및 선택 적용, 편집 후 진단 | [설치 조건과 사용법](plugins/typescript-lsp/README.md) |
| `python-lsp` | Python 코드 탐색·심볼, 빠른 수정 미리보기와 편집 후 타입 진단 | [설치·환경 설정과 지원 범위](plugins/python-lsp/README.md) |

TypeScript LSP 0.2.0은 조회·미리보기 도구 9개와 별도 적용 도구 2개를 제공합니다.
파일을 변경하려면 미리보기에서 후보를 고른 뒤 적용을 명시적으로 요청하세요.
Python LSP 작업 브랜치는 코드 탐색·심볼·빠른 수정 미리보기의 읽기 전용 도구 8개를 제공합니다.
기존 0.1.1 설치본의 3개 도구에 자동 반영된 것은 아닙니다. 별도로 준비한 ty 0.0.109의
절대 실행 경로를 환경 변수 또는 사용자 JSON에 지정하고 프로젝트 Python venv를 준비하세요.

## 필수 조건

TypeScript LSP 플러그인에는 다음이 필요합니다.

- 로컬 stdio MCP와 플러그인 훅을 지원하는 Codex CLI
- Node.js 22 이상
- PATH에서 실행 가능한 `typescript-language-server`
- 작업할 프로젝트 또는 모노레포 워크스페이스의 `node_modules/typescript`

전역 TypeScript 대신 대상 프로젝트의 TypeScript를 사용합니다.
의존성 준비 방법은 [플러그인 사용자 안내](plugins/typescript-lsp/README.md#필수-조건)에 있습니다.

## 설치

이 저장소의 로컬 체크아웃을 마켓플레이스 소스로 등록합니다.
저장소 루트에서 실행하세요.

```sh
codex plugin marketplace add "$PWD" --json
codex plugin list --available --marketplace copyx-codex-plugins --json
codex plugin add typescript-lsp@copyx-codex-plugins --json
# Python을 사용할 때 선택합니다. 실행 전 환경 설정은 Python 사용자 안내를 따르세요.
codex plugin add python-lsp@copyx-codex-plugins --json
```

마켓 이름은 `copyx-codex-plugins`이며 등록과 설치는 현재 Codex 프로필에 저장됩니다.
설치 후 새 Codex 세션을 여세요. 자동 진단을 사용하려면 `/hooks` → `PostToolUse` →
`Checking TypeScript diagnostics`에서 해당 훅을 검토하고 신뢰해야 합니다.
Python도 `/hooks` → `PostToolUse` → `Checking Python diagnostics`에서 별도로 검토합니다.
한 패치에 두 언어가 있으면 신뢰한 각 훅이 자기 언어의 변경 파일을 진단합니다.

## 사용

작업할 TypeScript/JavaScript 프로젝트에서 파일과 위치를 지정해 요청하세요.

> typescript-lsp로 이 저장소의 src/main.ts 12행 7열의 정의와 참조를 찾아줘.

호버로 타입 설명을 조회할 수도 있습니다. 자동 진단 훅을 신뢰한 상태에서 Codex가
`apply_patch`로 소스를 편집하면 변경 파일의 진단이 대화에 전달됩니다.
빠른 수정·이름 변경 적용 도구는 별도 호출이며, 파일 변경 후 진단을 도구 응답으로 반환합니다.
적용 범위와 실패 복구의 제한을 확인한 뒤 사용하세요.
도구 입력과 진단 범위는 [플러그인 사용자 안내](plugins/typescript-lsp/README.md#사용법)를 참고하세요.

## 문제가 생겼을 때

`codex plugin list --marketplace copyx-codex-plugins --json`으로 설치 상태를,
`codex mcp list --json`으로 MCP 연결 설정을 확인하세요.
TypeScript 누락, 자동 진단 미실행, 업데이트 후 재검토는
[플러그인 문제 해결](plugins/typescript-lsp/README.md#문제-해결)에 안내합니다.
