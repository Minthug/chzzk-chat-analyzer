# 치지직 채팅 분석기 Chrome 확장 프로그램

치지직(chzzk.naver.com) VOD와 라이브 방송의 채팅 급증 구간을 자동으로 감지해,
영상 편집자가 편집 포인트를 쉽게 찾을 수 있도록 돕는 Chrome 확장 프로그램.

## 기능

- **채팅 자동 수집**: WebSocket 인터셉트로 실시간 채팅 수집 (라이브 / VOD)
- **스파이크 감지**: Z-Score 알고리즘으로 채팅 급증 구간 자동 감지
- **오버레이 그래프**: 비디오 플레이어 아래 채팅량 히스토그램 표시
- **편집 포인트 클릭**: 급증 구간 클릭 → 해당 시점으로 영상 이동
- **내보내기**: `.txt` / `.csv` 형식으로 타임스탬프 내보내기

## 설치 방법

1. Chrome 주소창에 `chrome://extensions/` 입력
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `chzzk-chat-analyzer/` 폴더 선택

## 사용 방법

1. 치지직 라이브 방송 또는 VOD 페이지 접속
2. 채팅이 쌓이면 영상 플레이어 아래 그래프가 자동 표시됨
3. 빨간 바 = 급증 구간 / 초록 바 = 일반 구간
4. 확장 아이콘 클릭 → 팝업에서 편집 포인트 목록 확인 및 내보내기

## 알고리즘

```
windowSize = 30초
Z-Score = (현재 윈도우 채팅수 - 최근 10개 윈도우 평균) / 표준편차
Z-Score > 3.0 → 스파이크 판정
```

설정에서 Z-Score 임계값과 윈도우 크기를 조정할 수 있습니다.

## 구조

```
chzzk-chat-analyzer/
├── manifest.json
├── src/
│   ├── background/background.js   # 스파이크 감지 엔진 + 데이터 저장
│   ├── content/
│   │   ├── page-inject.js         # MAIN world - WebSocket 훅
│   │   ├── content.js             # ISOLATED world - 코디네이터
│   │   └── overlay.js             # 채팅량 그래프 오버레이
│   └── popup/
│       ├── popup.html
│       └── popup.js
└── icons/icon128.png
```
