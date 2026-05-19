Kafka Client — macOS 빌드 가이드
================================

이 zip은 소스 코드 핸드오프용입니다. macOS는 Mac에서 직접
빌드해야 합니다 (Wails가 Windows에서 macOS cross-compile을
지원하지 않습니다).

사전 준비
---------
1) Go 1.22 이상
   brew install go
   go version

2) Node.js 16 이상
   brew install node
   node -v

3) Wails CLI (v2)
   go install github.com/wailsapp/wails/v2/cmd/wails@latest
   # ~/go/bin이 PATH에 없으면 추가:
   export PATH="$PATH:$HOME/go/bin"
   wails version

4) Xcode Command Line Tools
   xcode-select --install

빌드
----
zip을 풀고 디렉터리로 이동한 뒤:

    cd kafka-client
    wails build -platform darwin/universal

빌드 결과:
    build/bin/kafka-client.app

처음 빌드 시 frontend의 npm install 단계가 수 분 걸릴 수 있습니다.

실행
----
Finder에서 build/bin/kafka-client.app 더블 클릭.

Gatekeeper 차단 (서명 안 된 앱)
-------------------------------
앱이 "확인되지 않은 개발자" 경고로 실행이 거부되면:

방법 1) 우클릭 → "열기" → 확인.

방법 2) 터미널에서 quarantine attribute 제거:
    xattr -dr com.apple.quarantine build/bin/kafka-client.app

설정 파일
---------
~/.kafka-client/profiles.json
(클러스터 등록 정보. 백업/이전 시 이 파일만 복사)

사용법
------
앱 실행 후 좌측 사이드바 하단의 [📖 도움말] 버튼.

문제 해결
---------
- npm install 단계 실패 → node 버전 확인 (16+), 네트워크 확인
- wails 명령을 못 찾음 → PATH에 $HOME/go/bin 추가
- 빌드 후 .app이 안 뜸 → wails doctor 실행해서 환경 점검
