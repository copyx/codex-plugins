# Python 0.1.0 브랜치 설치 기록

이 문서는 최초 0.1.0 설치의 당시 기록이다. GUI 환경 누락을 해결한 0.1.1의 현재 설정은
[런타임 설정 후속](python-lsp-runtime-settings.md)을 참고한다.

2026-11-24, Orca #65·#66. `copyx/python-lsp` 브랜치의
[`560f131d91f3dd039a0a14eb882d3f70f080e2da`](https://github.com/copyx/codex-plugins/commit/560f131d91f3dd039a0a14eb882d3f70f080e2da)에
구현·테스트·문서 22파일을 커밋하고 일반 push했다. 원격 branch SHA가 일치했고
main은 `b8c7b4b0a24e6f10999f4ed7bf69191419cdb8e4` 그대로였다. main 병합·PR·별도 릴리스 브랜치는 만들지 않았다.

커밋 직전 `npm run verify`는 기존 TS 49개, `npm run verify:python`은 Python 24개가
실패·건너뜀 없이 통과했다. 정적 검사 49파일과 `git diff --check`도 통과했다.
환경은 [구현 검증](python-lsp.md#검증-결과와-한계)과 같은 버전이다.

## 선택한 설치 경로

현재 사용자 `copyx-codex-plugins` Git 마켓은 계속 main을 추적한다.
임시 프로필에서 같은 이름에 다른 ref를 추가하면 CLI가 remove/add를 요구했다.
브랜치에서 Python 설치 후 main으로 복귀하고 `marketplace upgrade`한 뒤에도 새 app-server의
Python 3개 호출은 성공했지만, main의 `plugin list`에는 Python 설치 항목이 나타나지 않았다.
캐시만 남는 이 상태를 사용자 설치의 관리·갱신 경로로 사용하지 않았다.
이는 직접 수행한 강제 refresh 결과이며 모든 자동 refresh 타이밍을 검증했다는 뜻은 아니다.

대신 **로컬 Python 전용 카탈로그 + 원격 Git 고정 커밋 번들**을 사용했다.
사용자 마켓 ref를 전환하지 않으면서 설치 목록·출처·갱신 대상을 명확히 유지한다.

- 설치 ID: `python-lsp@copyx-python-preview`, 버전 `0.1.0`.
- 카탈로그: `$HOME/.local/share/codex-plugin-previews/python-lsp/.agents/plugins/marketplace.json`.
- 번들 원본: `https://github.com/copyx/codex-plugins.git`, `plugins/python-lsp`, 위 커밋 SHA.
- 카탈로그는 Python 한 개만 제공한다. 코드 복사본이나 이 worktree 경로를 runtime source로 사용하지 않는다.
- `git-subdir`를 통해 Codex가 원격 번들을 가져온다. 실제 설치 캐시 9파일이 커밋 바이트와 일치했다.

카탈로그의 핵심 항목은 다음과 같다.

```json
{
  "name": "copyx-python-preview",
  "plugins": [{
    "name": "python-lsp",
    "source": {
      "source": "git-subdir",
      "url": "https://github.com/copyx/codex-plugins.git",
      "path": "plugins/python-lsp",
      "ref": "copyx/python-lsp",
      "sha": "560f131d91f3dd039a0a14eb882d3f70f080e2da"
    },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" }
  }]
}
```

이 경로는 임시 프로필에서 main과 공존하고 main 강제 refresh 뒤에도 설치 목록과 실제 호출을
유지하는 것을 먼저 확인했다. 사용자 프로필에서는 기존 main을 전환하거나 refresh하지 않았다.
갱신은 새 커밋을 별도 검증한 뒤 이 카탈로그의 `sha`를 명시적으로 바꾸고 정상 CLI로 재설치한다.
고정 SHA는 브랜치의 새 커밋을 자동 채택하지 않는다. 재설치 후 훅은 다시 검토해야 할 수 있다.
제거할 때는 `codex plugin remove python-lsp@copyx-python-preview`와
`codex plugin marketplace remove copyx-python-preview`를 사용한다. 기존 TS 마켓은 제거하지 않는다.

## ty와 시작 환경

ty 0.0.109만 별도 사용자 venv인 `$HOME/.local/share/codex-python-lsp/ty-0.0.109`에 준비했다.
기존 Python·전역 pip·PATH·셸 프로필·GUI 전역 환경을 바꾸지 않았다.
서버 실행 경로는 그 venv의 `bin/ty`이며, 분석 대상은 프로젝트 `.venv` 또는 명시 환경이다.
검증에서는 별도 임시 프로젝트의 실제 `.venv`를 사용해 두 환경이 다른 것도 확인했다.

설치한 `$HOME/.local/share/codex-python-lsp/run-codex`는 이 ty 경로를
`PYTHON_LSP_TY`로 설정하고 `codex`를 실행한다. 이 실행기로 연 새 app-server에서 실제 호출을 확인했다.
일반 CLI에서도 다음처럼 새 프로세스에만 전달할 수 있다.

```sh
PYTHON_LSP_TY="$HOME/.local/share/codex-python-lsp/ty-0.0.109/bin/ty" codex
```

GUI 앱은 **시작 프로세스의 환경**을 받아야 한다. 이 Mac의 `open --env` 옵션으로 해당 변수를
전달할 수 있지만 이미 실행 중인 앱의 환경은 바뀌지 않는다. 사용 중인 Codex/Orca GUI를
종료·재시작하거나 전역 환경을 변경하는 동작은 수행하지 않았다.
GUI 앱 자체의 전달/실행은 미검증이며 CLI/app-server의 정상 실행기 경로를 검증했다.
Codex 0.172.0의 plugin MCP 정책 설정은 transport/env override를 제공하지 않으므로
설치 캐시의 `.mcp.json`을 수정하는 방식도 사용하지 않았다.

## 사용자 설치본의 실제 확인

- 새 app-server에서 Python 정의·참조·호버 3개를 실제 호출했다. TS 11개 목록과 호버도 확인했다.
- Python 훅: enabled, **untrusted**. 자동 신뢰나 신뢰 파일 복사/수정을 하지 않았다.
- 기존 TS 0.2.0 훅: enabled, **trusted**. 기존 캐시·신뢰 hash와 main source/ref가 동일했다.
- 외부 모델 요청과 사용자 소스 편집은 없었다. 무관한 MCP는 검증 프로세스의 일회성 옵션에서만 껐다.
- 기존 설정 leaf는 모두 그대로였고 Python 마켓/활성화만 추가했다. 검사 중 별도 프로젝트 trust 항목의
  추가도 관찰되어 그대로 보존했다. 그 항목의 작성 주체는 이 검증으로 확정하지 않았다.

남은 사용자 검토는 `/hooks` → `PostToolUse` → `Checking Python diagnostics`에서
`python-lsp@copyx-python-preview`의 명령과 출처를 확인하고 신뢰하는 것이다.
그 뒤의 **현재 사용자 프로필 trusted 훅 실행 검증은 아직 하지 않았다**.
이전 임시 프로필의 trusted 테스트를 사용자 검토 완료로 간주하지 않는다.

공식 형식 근거는 [Codex 0.172.0 marketplace source](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core-plugins/src/marketplace.rs)와
[plugin MCP 설정 스키마](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/core/config.schema.json)이며,
이 기록의 동작 판단은 위 임시/사용자 프로필의 실제 CLI·app-server 확인 결과에 근거한다.
