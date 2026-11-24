# Python LSP

Python 파일의 **정의·참조·호버**를 조회하고 Codex `apply_patch` 편집 뒤 변경 파일의
타입 진단을 전달합니다. 0.1.1은 읽기 전용 도구 3개를 제공하며 소스를 수정하지 않습니다.
TypeScript LSP와 함께 설치하면 혼합 패치에서 각 언어의 진단이 따로 전달됩니다.

## 필수 조건

- 로컬 stdio MCP와 PostToolUse 플러그인 훅을 지원하는 Codex. 검증 버전은 CLI 0.172.0입니다.
- Node.js 22 이상, 별도로 준비한 **Astral ty 0.0.109** 실행 파일.
- 분석 프로젝트의 Python venv. 루트의 `.venv` 또는 명시한 venv 경로를 사용합니다.
- UTF-8 `.py` / `.pyi` 파일. 입력 위치는 1부터 시작하는 UTF-16 줄·문자 좌표입니다.

ty 실행 환경과 분석 프로젝트의 환경은 별개입니다. 예를 들어 서버 전용 venv에
`ty==0.0.109`를 준비하고 그 실행 파일의 절대 경로를 지정하세요. GUI에서 사용할 때는
Node 사용자 홈의 `$HOME/.config/codex-python-lsp/config.json`에 다음 설정을 두면 됩니다.

```json
{ "ty_path": "/absolute/path/to/server-venv/bin/ty" }
```

이 파일과 전용 디렉터리는 현재 사용자 소유여야 하고 다른 사용자/그룹이 쓸 수 없어야 합니다.
symlink, 잘못된 JSON, 다른 키, 상대 경로와 16 KiB 초과 파일은 거부합니다.
이 설정은 MCP와 PostToolUse에 함께 적용됩니다. 런타임 설정을 바꾼 후 다음 도구 호출에서 다시 읽습니다.
`CODEX_HOME`, `XDG_CONFIG_HOME`, 작업 디렉터리에서는 이 파일을 찾지 않습니다.
Node 사용자 홈이 절대 경로로 확인되지 않으면 중단합니다. 플러그인은
패키지를 설치하거나 `uv`를 실행하지 않으며, 전역 Python으로 대체하지 않습니다.

```sh
export PYTHON_LSP_TY=/absolute/path/to/server-venv/bin/ty
# 프로젝트 루트에 .venv가 없을 때 지정합니다. 디렉터리 또는 그 안의 python 실행 파일입니다.
export PYTHON_LSP_PYTHON=/absolute/path/to/project-venv
```

`PYTHON_LSP_TY`가 있으면 사용자 JSON보다 우선합니다. 잘못된 명시 값은 다른 설정으로 대체하지 않습니다.
환경 변수 전달이 어려운 GUI에서는 사용자 JSON을 사용하세요. 둘 다 없으면 도구가 설정 안내를 반환합니다.
`PYTHON_LSP_PYTHON`은 해당 Codex 프로세스에서 여는 모든 Python 프로젝트에 적용되므로,
여러 프로젝트에는 각각의 프로젝트 설정을 사용하는 편이 좋습니다.

## 설치

저장소 루트에서 마켓을 등록한 뒤 Python 플러그인을 선택합니다.

```sh
codex plugin marketplace add "$PWD" --json
codex plugin list --available --marketplace copyx-codex-plugins --json
codex plugin add python-lsp@copyx-codex-plugins --json
```

새 세션을 열고 `/hooks` → `PostToolUse` → `Checking Python diagnostics`에서
명령과 출처를 검토한 뒤 해당 훅을 신뢰하세요. 설치·활성화·신뢰는 별도 상태이며,
TypeScript 훅을 신뢰했더라도 Python 훅을 따로 검토해야 합니다.

## 프로젝트 환경과 설정

환경은 `PYTHON_LSP_PYTHON` → 프로젝트 설정의 `environment.python` → 프로젝트 `.venv`
순서로 선택합니다. 명시 환경과 프로젝트 설정이 서로 다르면 진행하지 않습니다.
환경에 `pyvenv.cfg`와 실행 가능한 Python이 있어야 하며, 환경 선택을 위해 Python을 실행하지 않습니다.
다른 `VIRTUAL_ENV`가 활성화되어 있으면 해제하거나 `PYTHON_LSP_PYTHON`을 명시하세요.

가까운 `ty.toml` 또는 `[tool.ty]`가 있는 `pyproject.toml`을 사용합니다. 같은 디렉터리에서는
`ty.toml`이 우선합니다. 상대 경로는 선택된 설정 디렉터리를 기준으로 합니다.
예를 들어 `pyproject.toml`에는 다음처럼 설정할 수 있습니다.

```toml
[tool.ty.environment]
python = ".venv"
root = ["src"]
```

`ty.toml`에서는 `[environment]`를 사용하세요. 환경 경로에는 단일 행 문자열과 명시적인
테이블을 사용해야 합니다. inline 환경 테이블·변수/틸드 확장은 안내와 함께 거부합니다.
일반 규칙 등 나머지 TOML 설정은 ty가 해석합니다. 사용자 홈의 ty 설정은 병합하지 않습니다.
ty 설정이 없는 프로젝트에서는 워크스페이스 밖 상위 설정을 자동으로 상속하지 않습니다.

## 사용법

> python-lsp로 src/main.py 12행 7열의 정의와 참조를 찾아줘. 호버 타입도 보여줘.

세 도구 모두 `workspace_root`, `file`, `line`, `character`를 받습니다.
`workspace_root`는 절대 경로이고 `file`은 그 안의 상대 경로나 절대 경로입니다.
반환되는 LSP 범위는 0부터 시작하며 외부 라이브러리 위치에는
`workspace_boundary: "outside"`가 붙습니다. 플러그인이 그 소스를 별도로 읽거나 쓰지 않습니다.
소스 입력의 워크스페이스 이탈과 외부를 가리키는 symlink는 거부합니다.

신뢰한 훅은 `apply_patch`로 추가·수정·이동된 Python 파일만 검사합니다. 삭제 파일과
다른 언어는 제외합니다. 새 정상 결과는 `no diagnostics published for this snapshot`,
진단 미수신·설정/서버 실패는 `incomplete` 또는 `not checked`로 구분합니다.
과거 오류가 대화에 남아 있어도 가장 최근 결과의 파일·상태를 확인하세요.
패치당 최대 20파일, 파일당 최대 30진단이며 생략 시 표시합니다.

## 문제 해결과 지원 범위

- 서버 경로/버전 오류: `PYTHON_LSP_TY` 또는 사용자 JSON의 `ty_path`가 ty 0.0.109 실행 파일을 가리키는지 확인하세요.
- GUI 환경 누락: 0.1.1 이상과 위 사용자 JSON을 사용하세요. 이미 연결된 0.1.0 MCP 프로세스는 새 설정을 읽지 못할 수 있으며, 앱 전체 재시작을 해결 조건으로 두지 않습니다.
- 환경 누락/충돌: 프로젝트 venv와 위 선택 순서를 확인하세요. Conda/Pixi나 여러 환경을 자동으로 고르지 않습니다.
- 자동 진단 없음: 설치·활성화와 Python 훅의 신뢰를 확인하세요. `apply_patch` 이외의 편집에는 훅이 실행되지 않습니다.
- timeout/incomplete: 정상 판정이 아닙니다. 설정·환경을 확인하고 작은 파일 범위로 다시 조회하세요.
- PEP 723 독립 스크립트 환경, 노트북, lint/format, 장기 서버, 미리보기와 실제 편집 도구는 이번 버전에 없습니다.

macOS의 작은 격리 fixture로 검증했습니다. ty는 Beta이며 다른 버전·운영체제·대규모 저장소·
실제 의존성별 타입 정확성을 보장하지 않습니다. 유지보수 검증은
[설계와 검증 기록](../../docs/python-lsp.md)에 있습니다.
