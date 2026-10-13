# 메인넷 실거래 검증 현황 (2026-10-05)

**한 줄 요약: 8개 venue 모두 "선물 기본 주문 한 바퀴"와 포지션이 있는 상태의 `account margin`은 실제 돈으로 확인됐다. 2026-10-05 추가 실행(§3 단계 A · B · C)으로 scale-in / scale-tp(QFEX 제외, Ondo scale-tp는 ⛔), 네이티브 TWAP 체결(Hyperliquid, Pacifica), 라이브 `arb exec` / `status` / `close`(Aster–Arcus 쌍), `trade split` / `trade multi` / 클라이언트 TWAP / MCP 경로(Aster)도 확인됐다. 그러나 출금·계정 간 이체·리밸런스·`arb auto`·봇(grid, DCA, funding-arb)·서브계정·빌더 수수료·HIP-4는 어느 venue에서도 실거래로 돌린 적이 없다.**

이 문서는 "구현돼 있다"와 "메인넷에서 실제로 돌려 봤다"를 구분한다. 근거가 없는 항목은 검증됨으로 적지 않는다.

- 기준 코드: 브랜치 `feat/venue-abstraction`, 커밋 `6731d99+dirty` (보고서 기록값). 커밋되지 않은 변경이 있는 상태로 실행했다. 2026-10-05 추가 실행 중에 고친 코드도 커밋되지 않았다 (§4).
- 사용자가 정한 제약 (세션 기록): venue별 열린 노출 상한 **$20** / **출금 전면 금지** / OWS 지갑 `main`의 자금만 사용 / 결과 불명이면 중단, 재전송 금지 / 모든 확인은 공식 문서 근거.
- 상한 변경 (세션 기록): 사용자가 §3의 단계 A · B · C를 승인했고 2026-10-05 약 03:20–04:15 UTC에 메인넷에서 실행했다. $20 상한은 **단계 B(≈ $25–30)와 단계 C(≈ $110)에 한해서만** 올라갔다. 그 밖의 실행은 $20 그대로다. **출금은 여전히 승인되지 않았다.**
- 문서 갱신 시점 상태 (세션 기록): 추가 실행 뒤 전 venue flat (열린 포지션 없음).

## 0. 근거 표기

| 표기 | 뜻 |
|---|---|
| ✅ | 메인넷 실거래(또는 실제 서명 요청)로 확인 |
| 🟡 | 코드는 고쳤으나 메인넷에서 다시 돌리지 않음 |
| ⛔ | 거래소 또는 설계상 미지원 — 의도된 거절이 실제로 나오는 것을 확인 |
| ❌ | 미검증 (실행한 적 없음, 또는 실행했으나 실패) |
| — | 해당 기능 없음 |

근거 파일. 러너 보고서는 `~/.perp/e2e-reports/<이름>-mainnet.json|.md`, 로그는 세션 scratchpad(`/private/tmp/claude-501/-Users-hik-workspace/3e4ac928-a4af-4a66-b675-4677857ef96c/scratchpad/`)의 파일 이름이다.

| 키 | 파일 | 범위 | 결과 |
|---|---|---|---|
| R-HL | `2026-10-04T21-23-48-202Z-hyperliquid` | preflight + trade (ETH 0.0041 ≈ $11.08) + HIP-3 `xyz` (NVDA 0.047 ≈ $11.04) | pass (118 pass / 22 observed) |
| R-HL-spot | `2026-10-04T21-17-49-286Z-hyperliquid` | trade + spot (PURR 65 ≈ $11.12) | **전체 결과 fail** — spot 단계는 전부 통과, 그 뒤 HIP-3 preflight `hip3-pf-orders`가 429로 실패 |
| R-PAC | `2026-10-04T21-17-52-098Z-pacifica` | preflight + trade (ETH 0.0041 ≈ $11.10) + spot (SOL 0.091 ≈ $11.06) | pass |
| R-LT | `2026-10-05T02-06-42-578Z-lighter` | preflight + trade (SOL 0.091 ≈ $11.04); spot은 잔고 부족으로 skip | pass (skipped 1) |
| R-LT-spot | `2026-10-05T02-40-43-931Z-lighter` | spot (ETH 0.0050 ≈ $13.69) | pass (skipped 1: `s-limit-funding`) |
| R-LT-spot2 | `2026-10-05T03-54-03-490Z-lighter` | preflight + spot (ETH 0.0050): buy, sell, limit, orders, cancel, ALO | pass — spot 전 단계 통과 (19 pass / 17 observed) |
| R-RH | `2026-10-04T20-56-01-887Z-lighter-rh` | preflight + trade (TSLA 0.0295 ≈ $11.01) + spot (SPY 0.0143 ≈ $11.05) | pass (skipped 1: `s-limit-funding`) |
| R-RH-spot | `2026-10-05T03-50-31-790Z-lighter-rh` | preflight + spot (SPY 0.0143): buy, sell, limit, orders, cancel, ALO | pass — spot 전 단계 통과 (19 pass / 18 observed) |
| R-AST | `2026-10-05T01-46-55-114Z-aster` | preflight + trade (SOL 0.05 ≈ $6.05) | pass |
| R-OND | `2026-10-04T21-17-55-095Z-ondo` | preflight + trade (ETH 0.005 ≈ $13.54) | pass |
| R-OND-spot | `2026-10-05T02-34-31-040Z-ondo` | spot (TSLA 0.020 ≈ $7.5 체결, 계획 notional $10.43) | pass |
| R-ARC | `2026-10-05T01-46-57-822Z-arcus` | preflight + trade (SOL 0.045433 ≈ $5.50) | pass |
| A-* | `adv-pacifica.log`, `adv-ondo.log`, `adv-rh.log`, `adv-rh2.log`, `adv-aster.log`, `adv-aster2.log`, `adv-arcus.log`, `adv-hl.log`, `adv-lighter.log`, `adv-hip3.log` | 수동 고급 기능 점검 (조회, 격리, reduce-only, client id, stop-limit, scale-tp, close-all). `adv-hip3.log`는 HIP-3 `xyz` NVDA | 로그별 요약은 각 venue 절 |
| B-LT | `tierB-lighter.log`, `tierB-lighter2.log` | 단계 B: Lighter · Lighter RH의 `account margin`, scale-in, scale-tp, 숫자 client id(RH) | 로그별 요약은 §2.3, §2.4 |
| 세션 기록 | 파일에 남지 않은 실행 | 입금, 에이전트, QFEX 전체, TWAP, HL · Pacifica · Arcus · Ondo · Aster의 단계 A / B / C 실행, arb, split, multi, MCP 등 | — |

읽는 법:

- 러너의 `observed`는 "기대 결과를 강제하지 않고 기록한 단계"다. `t-alo-cross`, `t-ioc-nomatch`, `t-reduce`, `t-cancel-filled`, `t-cancel-unknown`이 여기에 속하며 단언(assertion)은 통과했다 (R-AST에서 직접 확인: 교차 ALO → 취소·미체결, IOC → 취소·미체결, reduce 50% → 0.05 → 0.03).
- **메인넷 러너 보고서 중 `deposit` · `withdraw` phase를 돌린 것은 하나도 없다.** 입금은 전부 세션 기록이다.
- **QFEX는 러너 보고서가 없다.** 전부 수동 실행(세션 기록)이다. 잔고는 추가 실행 뒤 약 $10.9.
- 통과 전에 중단된 실행이 있다: Pacifica 20:57(`t-cancel-all-2` ORDER_PARTIAL), Ondo 21:11(`t-stop` 주문 목록 미노출), HL 21:20(429), Aster 21:24 · 21:24 · 01:42(verify 미구현 / 교차 ALO가 resting / `-2011`), Arcus 01:42(`finality: pending`), Lighter 01:42 · 02:01(노출 조회 실패). 각각 수정 후 위 표의 마지막 통과 실행이 나왔다.

## 1. 전체 요약표

| venue | 입금 | 에이전트 | 선물 기본 | 선물 고급 | 현물 | TWAP·분할 | 자동화 | 출금 |
|---|---|---|---|---|---|---|---|---|
| Hyperliquid | ✅ 직접(Arbitrum) / ❌ relay 경로 | ✅ | ✅ | ✅ stop-limit·reduce-only·격리·`account margin`·`account settings`(포지션 있을 때) / ⛔ client id | ✅ (전체 결과 fail인 실행 안에서) | ✅ 네이티브 TWAP 시작·체결·취소 / ✅ scale-tp 2단 / ✅ scale-in 2단 | ❌ | ❌ |
| HL HIP-3 `xyz` | (HL 공용) | (HL 공용) | ✅ | ✅ 격리·stop-limit·reduce-only·cancel-all·close-all·조회 / ⛔ client id | — | ❌ scale-tp ($11 포지션은 venue가 거절, 사전 검사 수정 🟡) | ❌ | (HL 공용) |
| Pacifica | ✅ | ✅ | ✅ | ✅ (포지션 없는 reduce-only 확정 거절 포함. client id는 수정 후 세션 기록, §2.2) | ✅ | ✅ TWAP 체결(master 서명) / ⛔ 에이전트 서명 TWAP / ✅ scale-in 2단·scale-tp 2단 | ❌ | ❌ |
| Lighter | ✅ CCTP / ❌ L1 경로 | ✅ | ✅ | ✅ / ❌ client id로 취소(미지원) | ✅ 매수·매도·지정가·주문조회·취소·ALO (러너), `spot-balance` | ✅ scale-in 2단·scale-tp 2단 / ❌ TWAP | ❌ | ❌ |
| Lighter RH | ✅ | ✅ | ✅ | ✅ (숫자 client id place + status 포함) | ✅ 매수·매도·지정가·주문조회·취소·ALO (러너), `spot-balance` / ❌ transfer-out | ✅ scale-in 2단·scale-tp 2단 / ❌ TWAP | ❌ | ❌ |
| Aster | ✅ Arbitrum vault / ❌ BSC 경로 | ✅ (verify는 ⛔) | ✅ | ✅ stop-limit·reduce-only·`account margin` / ⛔ client id / ⛔ 격리(-4050) | ❌ (이체 거절 메시지 🟡) | ✅ scale-in 2단·scale-tp 2단 / ✅ 클라이언트 TWAP(`strategy twap`) / ✅ `trade split` · `trade multi` | ✅ `arb exec` / `status` / `close` (Aster–Arcus 쌍), MCP `trade_execute` / `trade_close` / ❌ `arb auto`·봇 | ❌ |
| Ondo | ✅ Arbitrum / ❌ Ethereum 경로 | ✅ import | ✅ | ✅ client id·`account margin` / ⛔ 격리·stop-limit·resting reduce-only | ✅ | ✅ scale-in 2단 / ⛔ scale-tp (resting reduce-only 불가) | ❌ | ❌ |
| Arcus | ✅ 웹 앱(사용자) / — CLI 입금 없음 | ✅ | ✅ | ✅ (`account margin`·`account settings` 포함) | ❌ | ✅ scale-in 2단·scale-tp 2단 / ✅ `trade multi`의 한쪽 leg / ❌ TWAP | ✅ `arb exec` / `close`의 한쪽 leg (Aster–Arcus 쌍) / ❌ 그 외 | ❌ |
| QFEX | ✅ 일회성 스크립트 전송 / — CLI 전송 명령 없음 | ✅ import | ✅ (수동) | ✅ reduce / close / flatten / close-all (long · short), `account margin` / ⛔ resting reduce-only·stop·TP/SL·amend·scale-tp·격리 | — (현물 없음) | ❌ | ⛔ (게이트) | ❌ |

## 2. venue별 상세

공통 러너 단계 이름: `t-leverage`, `t-limit-gtc`, `t-edit`, `t-cancel`, `t-limit-alo`, `t-alo-cross`, `t-ioc-nomatch`, `t-entry-tpsl`(시장가 + `--tp/--sl`), `t-tpsl-crossed`, `t-cancel-all-1/2`, `t-close-1/2`, `t-market-buy`, `t-stop`, `t-tpsl`, `t-reduce`, `t-flatten`, `z-reconcile`. preflight는 `market list`, `wallet agent list/verify`, `portfolio`, `account positions`, `account orders`를 읽는다.

### 2.1 Hyperliquid (ETH 0.0041 ≈ $11.08, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit hyperliquid` (Arbitrum 직접) | ✅ | 세션 기록 | 13 USDC |
| 입금 `--relay` 경로 | ❌ | 세션 기록 | 실행 안 함 |
| 에이전트 approve / rotate / revoke → 재승인 / verify | ✅ | 세션 기록, R-HL `pf-agent-verify` | 에이전트 `perp-cli-hl`. `wallet agent verify hyperliquid`가 master 주소를 OWS 지갑에서 유도하도록 한 수정은 🟡 (재실행 안 함) |
| leverage, limit GTC, edit, cancel, ALO, 교차 ALO, IOC 무체결 | ✅ | R-HL `t-leverage` … `t-ioc-nomatch` | IOC 무체결은 `ORDER_REJECTED`로 보고 |
| 시장가 진입 + TP/SL, tpsl, stop, cancel-all, close, reduce 50%, flatten | ✅ | R-HL `t-entry-tpsl` … `t-flatten` | 시작 $13.044 → 끝 $13.027 |
| stop-limit, 포지션 있는 reduce-only 지정가, close-all | ✅ | `adv-hl.log` `stoplimit:*`, `ro-pos:place`, `close-all` | 포지션 없는 reduce-only → 거절 확인 |
| 격리 마진 `trade leverage --isolated` | ✅ | `adv-hl.log` `iso:set` | 응답은 `ok`. 로그 시점에는 `account settings`가 `[]`라서 모드 재조회로는 확인 못 함 (격리 상태의 재조회는 그 뒤에도 하지 않음) |
| client order id | ⛔ | `adv-hl.log` `cid:place` | `CAPABILITY_UNSUPPORTED` (미구현) |
| 네이티브 TWAP 시작 → 체결 → 취소 | ✅ | 세션 기록 | 단계 C. 레버리지 10x, `trade twap ETH buy 0.04 5`(≈ $110, 5분) 시작, 체결 관측(포지션 0.0129 → 0.0258 ETH), `trade cancel-twap` 성공, 남은 ≈ $70 포지션 청산, 레버리지 5x로 복구. 끝까지 돌리지 않고 중간에 취소했다 |
| `account margin ETH` (포지션 있음) | ✅ | 세션 기록 | 위 TWAP 포지션이 열린 상태에서 실행 |
| `account settings` (포지션 있음) | ✅ | 세션 기록 | ETH-PERP 10x cross 반환. 열린 포지션이 있는 마켓만 나온다 (§4) |
| scale-tp 2단 | ✅ | 세션 기록 | 위 포지션에서 2단계 배치 → 목록 확인 → 취소. `adv-hl.log`의 "No open position for ETH"(심볼 조회 버그)는 수정됨 |
| scale-in 2단 | ✅ | 세션 기록 | flat 상태에서 2단계 × 0.0041 ETH |
| 현물 buy / sell / limit / orders / cancel / ALO (PURR) | ✅ | R-HL-spot `s-buy` … `s-cancel-alo` | 해당 실행의 전체 결과는 fail(HIP-3 429). 통과 실행(R-HL)에는 spot phase가 없다 |
| 조회: history, trades, funding-history, pnl, fills, check, market info/funding/kline/trades/book/prices, risk status, builder status, health | ✅ | `adv-hl.log` `r-*` | 30 ok / 4 not ok |
| init의 `userAbstraction` 60초 디스크 캐시, 요청 weight 축소 | 🟡 | 세션 기록 | 단위 테스트만. 라이브 재실행 안 함 |
| 계산된 가격의 부동소수 표기(`markPrice`) 정리 | 🟡 | 세션 기록 | 라이브 재실행 안 함 |
| 출금, `funds transfer`(usdSend), 서브계정, 빌더 수수료 승인, `account-mode` 변경, HIP-4 outcome | ❌ | 세션 기록 | 실행 안 함 |

**HIP-3 dex `xyz` (NVDA 0.047 ≈ $11.04)**: 기본 러너 단계 전부 ✅ (R-HL `hip3-t-leverage` … `hip3-t-flatten`, 시작 $13.027 → 끝 $13.020). 고급 기능은 `adv-hip3.log` (20 ok / 6 not ok):

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 격리 마진 설정 → 원복 | ✅ | `adv-hip3.log` `iso:set`, `iso:back` | 응답 `ok`. 재조회(`iso:read`)는 포지션이 없어 `CAPABILITY_UNSUPPORTED` |
| stop-limit place / 목록 / cancel | ✅ | `adv-hip3.log` `stoplimit:*` | |
| 포지션 있는 reduce-only 지정가 | ✅ | `adv-hip3.log` `ro-pos:place` | 포지션 없는 reduce-only → venue 거절 확인 (`ro-flat`) |
| cancel-all / close-all | ✅ | `adv-hip3.log` `cancel-all`, `close-all` | 끝난 뒤 주문 0, 포지션 0 |
| 조회: fills, market info / funding / kline / trades / book | ✅ | `adv-hip3.log` `r-*` | |
| `trade check NVDA --dex xyz` | ✅ | 세션 기록 | 로그(`r-check`)에서는 "NVDA not found on hyperliquid"(오판). 수정 후 라이브 재검증: `valid: true` |
| client order id | ⛔ | `adv-hip3.log` `cid:place` | `CAPABILITY_UNSUPPORTED` |
| scale-tp | ❌ | `adv-hip3.log` `scaletp` | $11 포지션 → venue가 단계마다 거절 ("Order must have minimum value of $10"). 당시 dex에서는 전송 전 최소 금액 검사가 적용되지 않았다 — 코드 수정됨, 재실행 안 함 🟡 |
| `account settings` (dex에 포지션 없음) | ⛔ | `adv-hip3.log` `r-settings` | `CAPABILITY_UNSUPPORTED` |
| `account margin NVDA` | ❌ | `adv-hip3.log` `r-margin` | 포지션 없을 때만 실행 → `POSITION_NOT_FOUND` |

### 2.2 Pacifica (ETH 0.0041 ≈ $11.10, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit pacifica` (Solana 직접) | ✅ | 세션 기록 | 13.2 USDC |
| 에이전트 approve / rotate / revoke → 재승인 / verify | ✅ | 세션 기록, R-PAC `pf-agent-verify` | 이전 세션의 키 8개가 venue에 남아 있음 |
| 선물 기본 전 단계 | ✅ | R-PAC `t-*` | `t-tpsl-overwrite`: 기존 TP/SL 덮어쓰기 거부 확인 |
| stop-limit(mark 트리거) + `cancel-stop`, 포지션 있는 reduce-only 지정가, close-all | ✅ | `adv-pacifica.log` | |
| 포지션 없는 reduce-only → 확정 거절 | ✅ | 세션 기록 | 수정 후 라이브 재검증: `ORDER_REJECTED`(확정). `adv-pacifica.log` `ro-flat`은 수정 전 실행(venue 422가 `ORDER_PENDING`으로 분류됨)이다 |
| 격리 마진 | ✅ | `adv-pacifica.log` `iso:*` | `account settings`로 재조회 확인 |
| client order id (UUID) place / status / cancel | ✅ | 세션 기록 | 수정 후 UUID로 확인. `adv-pacifica.log`의 `cid:*`는 수정 전 실행(비 UUID id가 무시됨)이다. **UUID 실행은 파일 근거가 없다** |
| `account margin` (포지션 있음) | ✅ | 세션 기록 | 아래 TWAP 포지션(0.0082 ETH)에서 실행 |
| scale-tp 2단 | ✅ | 세션 기록 | 0.0082 ETH 포지션에서 2단계. `adv-pacifica.log` `scaletp`는 수정 전 실행(lot 배수 오류 0.00205)이다 |
| scale-in 2단 | ✅ | 세션 기록 | |
| 네이티브 TWAP 생성 → 목록 → 취소 | ✅ | 세션 기록 | `--no-agent`(master 서명), 0.0001 ETH, 체결 0 |
| 네이티브 TWAP 체결 | ✅ | 세션 기록 | `--no-agent` `trade twap ETH buy 0.0082 30`: 0.0041 × 2 slice 계획, 둘 다 FILLED (포지션 0.0082 ≈ $22.3). 그 뒤 close ✅. 참고: 60초 TWAP은 0.00273 × 3 slice(각 ≈ $7.5)로 계획돼 체결이 없었다 — slice가 venue 최소 미달 |
| 네이티브 TWAP, 에이전트 서명 | ⛔ | 세션 기록 | CLI가 전송 전에 거절: `CAPABILITY_UNSUPPORTED agentSignedTwap` (라이브 확인). 이전에는 venue가 `signature_verification_failed`로 거절 |
| 현물 buy / sell / limit / orders / cancel / ALO (SOL) | ✅ | R-PAC `s-buy` … `s-cancel-alo` | 통합 계정 |
| 조회 (2.1과 같은 목록) | ✅ | `adv-pacifica.log` `r-*` | 로그의 `account margin`은 포지션 없이 실행됨 (위 행에서 재확인) |
| 출금, lake, apikey, subaccount, referral, 빌더 승인 | ❌ | 세션 기록 | 실행 안 함 |

### 2.3 Lighter (SOL 0.091 ≈ $11.04, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit lighter cctp arbitrum` | ✅ | 세션 기록 | 5 + 5 USDC |
| 입금 `funds deposit lighter ethereum` (L1) | ❌ | 세션 기록 | 실행 안 함 |
| 에이전트 approve / rotate / revoke → 재승인 / verify | ✅ | 세션 기록, R-LT | 이전 세션의 API 키 슬롯 12개가 남아 있음 |
| 선물 기본 전 단계 + stop 수정(`t-edit-stop`) | ✅ | R-LT `t-*` | `t-cancel-filled` 단계는 이 venue 프로필에 없음 |
| stop-limit, 포지션 있는 reduce-only 지정가, close-all | ✅ | `adv-lighter.log` | 포지션 없는 reduce-only → `21738` 거절 확인 |
| 격리 마진 | ✅ | `adv-lighter.log` `iso:*` | `account settings`에 `isolated` 표시 확인 |
| client order id: 숫자 id로 place + status | ✅ | 세션 기록 | `adv-lighter.log`에는 비숫자 id 거절(`INVALID_PARAMS`)만 있음 |
| client order id로 취소 | ⛔ | 세션 기록 | 미지원 |
| `account margin SOL` (포지션 있음) | ✅ | `tierB-lighter.log` | 0.11 SOL 포지션 |
| scale-in 2단 | ✅ | `tierB-lighter2.log` | 2 × 0.095 SOL 배치 → 목록 → 취소. 0.055 단계는 전송 전 거절: `SIZE_TOO_SMALL`, venue 최소 주문 금액 $10 (`tierB-lighter.log`) |
| scale-tp 2단 | ✅ | `tierB-lighter2.log` | 0.17 SOL 포지션에서 2 × 0.085 SOL 배치 → 목록 → 취소 → close-all. 0.055 단계는 전송 전 거절 (`tierB-lighter.log`) |
| 현물 buy / sell / limit / orders / cancel / ALO (ETH 0.0050) | ✅ | R-LT-spot2 `s-buy` … `s-cancel-alo` | 러너 spot phase 전 단계 통과. 이전 실행(R-LT-spot)은 `s-limit-funding`에서 skip됐었다 |
| `trade spot-balance` | ✅ | 세션 기록, R-LT-spot2 `s-balance-*` | 수정 후 재검증: USDC 행 반환(`shared: true`). classic 계정의 현물 quote 행 이름 변경(`USDC_SPOT` → `USDC`)은 🟡 (재실행 안 함) |
| 조회: settings, market info / funding / trades / book | ✅ | `adv-lighter.log` `r-*` | |
| 조회: account history, trades, funding-history, pnl, trade fills | ✅ | 세션 기록 | 마켓별 fan-out 문제 수정 후 라이브 재검증. `account trades`의 수수료 값은 추정값이다 (§4) |
| 조회: market kline, prices | ❌ | — | 실행 근거 없음. mid 가격의 부동소수 표기 수정은 🟡 |
| 출금(secure / fast), 서브계정, apikey 관리 | ❌ | 세션 기록 | 실행 안 함 |

### 2.4 Lighter RH (TSLA 0.0295 ≈ $11.01, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit lighter-rh` (컨트랙트 approve + deposit) | ✅ | 세션 기록 | 1 + 12 USDG |
| 에이전트 approve / rotate / revoke → 재승인 / verify | ✅ | 세션 기록, R-RH | revoke 테스트의 임시 키가 슬롯 6에 남아 있음 (§4) |
| 선물 기본 전 단계 + `t-edit-stop` | ✅ | R-RH `t-*` | 시작 $13.000 → 끝 $12.992 |
| stop-limit, 포지션 있는 reduce-only 지정가, close-all | ✅ | `adv-rh2.log` | |
| 격리 마진 | ✅ | `adv-rh2.log` `iso:set` | tx 접수(code 200). 로그 시점에는 `account settings`가 `[]`라 재조회 확인은 못 함 (격리 상태의 재조회는 그 뒤에도 하지 않음) |
| client order id: 숫자 id로 place + status | ✅ | `tierB-lighter.log` | `--client-id 424242002` → `trade status c:424242002`. `adv-rh2.log` `cid:place`는 비숫자 id 거절 |
| `account margin TSLA` (포지션 있음) | ✅ | `tierB-lighter.log` | 0.059 TSLA (≈ $22) |
| `account settings` | ✅ | `tierB-lighter.log` | TSLA 5x cross 반환 |
| scale-in 2단 | ✅ | `tierB-lighter.log` | 2 × 0.0295 TSLA 배치 → 목록 → 취소 |
| scale-tp 2단 | ✅ | `tierB-lighter.log` | 0.059 TSLA 포지션에서 2단계 배치 → 목록 → 취소 → close-all. `adv-rh2.log` `scaletp`는 수정 전 실행(`21706`)이다 |
| 현물 buy / sell / limit / orders / cancel / ALO (SPY 0.0143) | ✅ | R-RH-spot `s-buy` … `s-cancel-alo` | 러너 spot phase 전 단계 통과. 이전 실행(R-RH)은 `s-limit-funding`에서 skip됐었다 |
| `trade spot-balance` | ✅ | 세션 기록, R-RH-spot `s-balance-*` | USDG 행 반환 |
| 현물 transfer-in | ✅ | R-RH `s-transfer-in` | |
| 현물 transfer-out | ❌ | — | R-RH에서는 skip. R-RH-spot에는 transfer 단계가 없다 |
| 조회 | 일부 ✅ | `adv-rh.log`, `adv-rh2.log` | 1차 로그는 429와 `SYMBOL_NOT_FOUND`로 중단, 2차에서 book / trades / prices 확인. history 계열(§2.3에서 수정)은 이 venue에서 재실행한 근거 없음 |
| 출금 | ❌ | 세션 기록 | 실행 안 함 |

### 2.5 Aster (SOL 0.05 ≈ $6.05, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit aster --chain arbitrum` (vault `depositFor`) | ✅ | 세션 기록 | 2 + 7 USDC |
| 입금 BSC 경로 | ❌ | 세션 기록 | 실행 안 함 |
| 에이전트 approve / rotate / revoke → 재승인 | ✅ | 세션 기록 | |
| `wallet agent verify aster` | ⛔ | 21:24:33 보고서 `pf-agent-verify` | `NOT_IMPLEMENTED` (venue에 목록 엔드포인트 없음, 의도된 동작) |
| 선물 기본 전 단계 | ✅ | R-AST `t-*` | 시작 $8.987 → 끝 $8.972 |
| stop-limit(mark), 포지션 있는 reduce-only 지정가, close-all | ✅ | `adv-aster2.log` | 포지션 없는 reduce-only → `-2022` 거절 확인 |
| 격리 마진 | ⛔ | `adv-aster2.log` `iso:set` | venue `-4050 Cross balance insufficient`. 문서에 조건 설명 없음 |
| client order id | ⛔ | `adv-aster2.log` `cid:place` | `CAPABILITY_UNSUPPORTED` (미구현) |
| scale-in 2단 + scale-tp 2단 | ✅ | 세션 기록 | 로그 파일에는 `SIZE_TOO_SMALL` 거절(단계 $2.57 < $5)만 있다 |
| `account margin SOL` (포지션 있음) | ✅ | 세션 기록 | 작은 cross 포지션에서 `liquidationPrice`가 "0"으로 출력된다 (§4) |
| `arb exec SOL aster arcus` → `arb status` → `arb close SOL` | ✅ | 세션 기록 | 1차 `arb exec SOL aster arcus 12`: 양쪽 leg 체결(각 0.09 SOL), 그러나 `arb status` / `arb close`가 쌍을 인식하지 못함(venue 목록이 hyperliquid / lighter / pacifica로 하드코딩) → leg를 손으로 청산. 수정·재빌드 후 `arb exec SOL aster arcus 7`(leg당 0.05 SOL, $6) ✅, `arb status`에 쌍 표시 ✅, `arb close SOL`이 양쪽 leg 청산 ✅ |
| `trade multi aster:SOL:buy:0.05 arcus:SOL:sell:0.05` | ✅ | 세션 기록 | 양쪽 leg 체결 후 청산 |
| `trade split` | ✅ | 세션 기록 | 첫 실행은 실패(slice 크기 계산 오류인데 ok로 보고) → 수정. 라이브 재검증: `split SOL buy 12 --min-slice 6 --max-slices 2` → 전송 전 `SIZE_TOO_SMALL`; `split SOL buy 13 …` → 0.05 × 2 slice 체결 |
| 클라이언트 TWAP `strategy twap SOL buy 0.1 40 --slices 2` | ✅ | 세션 기록 | 2 slice 체결. avgPrice 버그(보호 가격을 보고)는 수정 후 reduce-only 매도 TWAP으로 재검증 (avgPrice 120.345가 체결과 일치) |
| MCP (stdio, `PERP_NETWORK=mainnet`) | ✅ | 세션 기록 | `trade_preview` → `trade_execute`(aster SOL buy 0.05) → `get_positions` → `trade_close` |
| 현물 전체 | ❌ | 세션 기록 | 에이전트 현물 권한은 있음. 선물 계정이 USDC이고 현물은 USDT 필요 — 이체 거절 |
| 조회 | ✅ | `adv-aster.log`, `adv-aster2.log` | 로그의 `account margin`은 포지션 없이 실행됨 (위 행에서 재확인) |
| 출금 | ❌ | 세션 기록 | `--can-withdraw --ip-whitelist` 에이전트 필요 |

### 2.6 Ondo (ETH 0.005 ≈ $13.54, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 `funds deposit ondo` (Arbitrum, `--probe`) | ✅ | 세션 기록 | 2(probe) + 10 USDC |
| 입금 Ethereum 경로 | ❌ | 세션 기록 | 실행 안 함 |
| 에이전트 import (웹에서 만든 키) | ✅ | 세션 기록, R-OND `pf-agent-source: imported` | **키가 채팅에 붙여넣어짐 — 테스트 후 교체 필요** |
| 선물 기본 전 단계 | ✅ | R-OND `t-*` | 시작 $11.973 → 끝 $11.943 |
| client order id place / status / cancel | ✅ | `adv-ondo.log` `cid:*` | |
| close-all | ✅ | `adv-ondo.log` `close-all` | |
| 격리 마진 | ⛔ | `adv-ondo.log` `iso:set` | cross 전용 |
| stop-limit | ⛔ | `adv-ondo.log` `stoplimit:place` | 포지션 stop(시장가)만 제공 |
| resting reduce-only 지정가 | ⛔ | `adv-ondo.log` `ro-pos:place` | venue: `reduce_only_invalid_tif` (IOC만 허용) |
| scale-in 2단 | ✅ | 세션 기록 | 2 × 0.004 ETH |
| scale-tp | ⛔ | 세션 기록 | 전송 전 거절: `CAPABILITY_UNSUPPORTED restingReduceOnly` (venue 규칙). `adv-ondo.log` `scaletp`는 수정 전 실행(각 단계가 venue에서 거절)이다 |
| `account margin` (포지션 있음) | ✅ | 세션 기록 | |
| 현물 transfer-in / buy / sell / limit / orders / cancel / ALO / transfer-out (TSLA) | ✅ | R-OND-spot `s-*` | |
| 조회 | ✅ | `adv-ondo.log` `r-*` | 로그의 `account margin`은 포지션 없이 실행됨 (위 행에서 재확인) |
| `market kline` | ✅ | 세션 기록 | 수정 후 라이브 재검증. `adv-ondo.log`에서는 `NO_SIGNER_AVAILABLE` |
| 계산된 가격의 부동소수 표기(`avgPrice`) 정리 | 🟡 | 세션 기록 | 라이브 재실행 안 함 |
| 출금, 주소록 추가 | ❌ | 세션 기록 | 실행 안 함 |

### 2.7 Arcus (SOL 0.045433 ≈ $5.50, 5x cross)

| 기능 | 상태 | 근거 | 비고 |
|---|---|---|---|
| 입금 | ✅ (사용자, 웹 앱) | 세션 기록 | 10 USDG. CLI 입금 명령 없음 |
| 에이전트 approve / rotate / revoke → 재승인 / verify | ✅ | 세션 기록, R-ARC | |
| 선물 기본 전 단계 | ✅ | R-ARC `t-*` | 시작 $10.000 → 끝 $9.994 |
| stop-limit, reduce-only(포지션 없음 → rejected, 있음 → open), close-all | ✅ | `adv-arcus.log` | |
| 격리 마진 | ✅ | `adv-arcus.log` `iso:set` | 응답이 `marginMode: isolated` 반환. 로그 시점에는 `account settings`가 `[]` |
| client order id place / status / cancel | ✅ | `adv-arcus.log` `cid:*` | status 응답의 `finality`가 `pending`으로 나옴(주문은 open). 수정됨, 재실행 안 함 🟡 |
| scale-in 2단 | ✅ | 세션 기록 | 2 × 0.05 SOL |
| scale-tp 2단 | ✅ | 세션 기록 | 0.1 SOL 포지션에서 2단계 → close-all ✅. `adv-arcus.log` `scaletp`는 `SIZE_TOO_SMALL`($3.21 < $5) 사전 거절 |
| `account margin` (포지션 있음) | ✅ | 세션 기록 | 0.1 SOL 포지션 |
| `account settings` | ✅ | 세션 기록 | 마켓별 레버리지 / 모드 목록 반환 |
| `arb exec` / `arb close`, `trade multi`의 Arcus 쪽 leg | ✅ | 세션 기록 | Aster–Arcus 쌍 (§2.5) |
| 현물 (spot router 스왑 + Permit2 승인) | ❌ | 세션 기록 | Arcus 발급 API 키 필요, 요청 형식 미문서화 |
| 조회 | ✅ | `adv-arcus.log` `r-*` (35 ok / 2 not ok) | 로그의 `account margin`은 포지션 없이 실행됨 (위 행에서 재확인) |
| 출금 | ❌ | 세션 기록 | 실행 안 함 |

### 2.8 QFEX (production, GOLD-USD 0.003 ≈ $12.5) — 전부 수동, 세션 기록

| 기능 | 상태 | 비고 |
|---|---|---|
| 입금 (계정 입금 주소로 USDC 일반 전송) | ✅ | 11 USDC. `funds deposit qfex`는 주소만 보여 준다. 전송은 일회성 스크립트로 했다 |
| 에이전트 import (웹에서 만든 키) | ✅ | **키가 채팅에 붙여넣어짐 — 테스트 후 교체 필요** |
| leverage, limit GTC, status, cancel, ALO, cancel-all, IOC 무체결 거절, 시장가 매수, positions 조회, 시장가 매도로 청산 | ✅ | |
| 정상 socket close 후 주문 유지 | ✅ | |
| 프로세스 강제 종료 후 주문 유지 (TEST-PLAN Q1 kill 변형) | ✅ | 실행 중인 CLI 프로세스를 `kill -9`로 죽였고, 그 프로세스가 낸 GTC 주문이 열린 채 남음 (관측 1회) |
| reduce-only wire 동작 (raw) | ✅ | boolean 접수·에코 / 포지션 없음 → `INVALID_QUANTITY` / **포지션보다 큰 주문은 접수되어 resting (접수 시점 cap 없음)** |
| reduce-only 체결 시점 cap (raw frame, CLI 게이트 밖의 한정 실험) | ✅ | long 0.003에 reduce-only IOC SELL 0.006 → FILLED 0.003, 나머지 CANCELLED, 포지션 flat. venue가 체결 시점에 reduce-only 주문을 cap한다 — **즉시 체결 주문에 대해서만 증명됨** |
| reduce-only 에코 규칙 | ✅ | FILLED 프레임은 `reduce_only: false`, ACK / CANCELLED 프레임은 `true`를 싣는다. 에코 규칙이 ACK와 비체결 프레임을 기준으로 판정하도록 수정, 그 뒤 일반 `trade close`가 경고 없이 실행됨. 이전 라이브 청산이 왜 옛 규칙에 걸리지 않았는지는 설명되지 않았다 (§4) |
| `trade buy GOLD 0.003` → `trade reduce GOLD 50` → `trade close GOLD` | ✅ | 리뷰 수정 적용·빌드 후 실행 (2026-10-05 ~03:20 UTC). 체결 0.003 @ 4142.1 → 0.001 감소 → 0.002 청산(검증됨). 에코 경고 없음 |
| `trade reduce` 비율 계산 | ✅ | 위 실행에서 0.003의 50%가 0.001로 내려가던 버그 수정, 라이브 재검증: 0.003의 50% → 0.0015 |
| `trade flatten` | ✅ | 두 번째 매수 0.003 후 flatten으로 0.003 청산. 그 시점 equity $10.95 |
| short 포지션 | ✅ | `trade sell`로 short 0.003 진입 → positions가 side short 표시 (TEST-PLAN Q10) → `account margin` ✅ → `trade reduce 50` → `trade close` |
| `trade close-all` | ✅ | long 0.003 → `trade close-all` |
| reduce-only IOC, 수량 0.006 > 포지션 0.003 (CLI) | ⛔ | `SIZE_TOO_LARGE` — 전송 전 거절 확인 |
| `trade limit … --reduce-only` (GTC, resting) | ⛔ | `CAPABILITY_UNSUPPORTED restingReduceOnly` — 전송 없음. 포지션이 나중에 줄어들 때 resting 주문이 어떻게 되는지 증명되지 않아 계속 게이트 (`QFEX_RESTING_REDUCE_ONLY_VERIFIED`) |
| 교차 post-only (ALO) | ✅ | `ORDER_REJECTED postOnlyWouldCross`. 이전의 "pending" 보고 버그는 수정 후 라이브 재검증됨 |
| stop, TP/SL, amend(`trade edit`), scale-tp, funding 조회 | ⛔ | 설계상 게이트 (TEST-PLAN §9.2, 설계 §14) |
| 자동화 (봇 / job / TWAP / DCA / grid) | ⛔ | 게이트 (`QFEX_AUTOMATION_VERIFIED`) |
| 격리 마진 | ⛔ | cross 전용 |
| 현물 | — | venue에 현물 없음 |
| 출금, `funds transfer -e qfex`(계정 간) | ❌ | 실행 안 함 |

`docs/TEST-PLAN.md` §9.2는 `limit --reduce-only`와 `scale-tp`도 QFEX에서 "동작한다"고 적고 있다. 세션 기록상 둘은 현재 코드에서 거절된다(resting reduce-only 게이트) — **두 근거가 다르며, 이 문서는 세션 기록(라이브 결과)을 따른다.** TEST-PLAN 쪽 갱신이 필요하다.

### 2.9 어느 venue에서도 라이브로 돌리지 않은 것 (세션 기록)

| 영역 | 명령 |
|---|---|
| 자금 | 출금 전부, `funds transfer`(HL usdSend, QFEX 계정 이체), `funds rebalance execute`, `funds bridge exchange`, 다른 입금 경로(Lighter L1, Aster BSC, HL relay, Ondo Ethereum) |
| 자동화 | 라이브 `arb auto`, 봇·DCA·grid·funding-arb, `strategy plan execute` |
| 현물 | Aster 현물(USDT 필요), Arcus 현물(Arcus 발급 API 키 필요) |
| 계정 | 서브계정, Pacifica lake / apikey / subaccount, 빌더 수수료, HIP-4 |
| 주문 | client order id — Hyperliquid, Aster (미구현), Aster 격리 마진(venue 거절 `-4050`), QFEX 게이트 기능(§2.8) |
| 기타 | alerts, dashboard |

2026-10-05 추가 실행으로 이 목록에서 빠진 것 — 단, 한 venue 또는 한 쌍에서만 확인됐다: `arb exec` / `arb status` / `arb close`(Aster–Arcus 쌍), `trade split`(Aster), `trade multi`(Aster + Arcus), 클라이언트 TWAP `strategy twap`(Aster), MCP `trade_execute` / `trade_close`(Aster). `trade twap --background`는 실행 근거가 없다. Aster · Arcus가 아닌 쌍의 `arb exec` 최소 금액 처리는 코드만 고쳤다 🟡.

dry-run으로만 확인된 것: `strategy run grid --dry-run`(중단할 때까지 반복), `arb scan`, `funds bridge quote`.
브릿지 `funds bridge send`(Relay)는 라이브로 성공했다: Arbitrum ETH → Robinhood ETH, Robinhood USDG → Solana SOL / USDC, Robinhood USDG → Arbitrum USDC 4회.

## 3. 미검증 항목과 필요한 것

이 절의 이전 판에 있던 단계 A · B · C는 2026-10-05 약 03:20–04:15 UTC에 실행됐다. 검증된 항목은 §2로 옮겼고, 아래 표는 **남은 것만** 새 번호로 적는다.

현재 잔고 (세션 기록, 근사): HL ≈ $13.1, Pacifica ≈ $13.0, Lighter ≈ $15.9, Lighter RH ≈ $13.0, Aster ≈ $8.9 (USDC), Ondo ≈ $11.9, Arcus ≈ $10.0, QFEX ≈ $10.9. 지갑: Robinhood Chain USDG ≈ 3.7, Arbitrum USDC ≈ 3.1 (ETH는 이전 기록값: Robinhood ≈ 0.00055, Arbitrum ≈ 0.001).

| # | 항목 | 왜 미검증인가 | 필요한 것 | 문서 규칙 |
|---|---|---|---|---|
| 1 | QFEX resting reduce-only · scale-tp, stop / TP·SL / amend, 자동화 게이트 해제 | 체결 시점 cap은 즉시 체결(IOC) 주문에서만 증명됨. 포지션이 나중에 줄어들 때 resting 주문의 동작은 미증명 (`QFEX_RESTING_REDUCE_ONLY_VERIFIED`, `QFEX_AUTOMATION_VERIFIED`) | resting 주문 raw 드릴(자금 추가 없음, 상한 $20) → 상수 변경 → 재리뷰 | 문서 없음 (reduce-only 초과 주문 처리는 문서에 없고 실측으로 확인) |
| 2 | HIP-3 `xyz` scale-tp, 포지션 있는 상태의 `account margin` / `account settings` | $11 포지션은 venue가 거절(단계당 $10 최소). 전송 전 검사 수정은 재실행 안 함. `account margin` / `settings`는 포지션 없이만 실행 | dex 포지션 ≥ $20.5 → **상한 $25** (단계 B에서 승인된 범위와 같은 크기 — 재실행 전 사용자 확인). 자금 추가 없음 | "Order must have minimum value of $10." — [error-responses](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses) |
| 3 | 코드만 고치고 라이브로 다시 돌리지 않은 것 🟡: HL `userAbstraction` 60초 디스크 캐시와 요청 weight 축소 / 계산된 가격의 부동소수 표기(HL markPrice, Ondo avgPrice, Lighter mid) / Lighter classic 계정 현물 quote 행 이름(`USDC_SPOT` → `USDC`) / `wallet agent verify hyperliquid`의 master 주소 유도 / Aster · Arcus 외 쌍의 `arb exec` 최소 금액 / HIP-3 scale-tp 전송 전 최소 금액 / Arcus `trade status` finality / Aster spot-transfer 거절 메시지 | 수정 뒤 재실행 안 함 (단위 테스트만 있는 것 포함) | 재실행. 대부분 자금 불필요. `arb exec`(다른 쌍)은 leg ≥ $10, HIP-3 scale-tp는 2번과 같음 | — |
| 4 | 실행 근거가 없는 잔여: Lighter `market kline` / `prices`, Lighter RH history 계열 조회, Lighter RH 현물 transfer-out, Pacifica UUID client id(파일 근거) | 추가 실행에 포함되지 않았거나 파일로 남지 않음 | 재실행 + 로그 저장. 자금 추가 없음 | "60 requests per rolling minute" — [rate-limits](https://apidocs.lighter.xyz/docs/rate-limits) |
| 5 | Aster 현물 | 계정에 USDT 없음 | **USDT ≈ $6 이상** 신규 입금(Aster 현물 계정) + 가스. 현물 최소 주문: 심볼별 `MIN_NOTIONAL` 필터 | [asterdex/api-docs](https://github.com/asterdex/api-docs) (MIN_NOTIONAL 필터) |
| 6 | Arcus 현물 | API 키 없음, 요청 형식 미문서화 | Arcus가 발급한 API 키(사용자 요청: vip@arcus.xyz), Permit2 승인용 RH ETH, USDG ≈ $6 | "Integrating requires an API key issued by Arcus, so getting in touch is the first step." — [spot-integration](https://docs.arcus.xyz/concepts/spot-integration.md) |
| 7 | Aster 격리 마진 | venue `-4050` | 조건 미상. 잔고를 늘려 재시도하거나 Aster에 문의 | 문서 없음 (오류 코드 `-4050 CROSS_BALANCE_INSUFFICIENT`만 나열) |
| 8 | client order id — HL, Aster | 미구현 | 코드 구현(HL `cloid`, Aster `newClientOrderId`) 후 $11 / $6 주문 | — |
| 9 | Pacifica TWAP 에이전트 서명 | ⛔ — CLI가 전송 전에 거절하고 `--no-agent`를 안내 (라이브 확인) | Pacifica에 문의: 에이전트 키의 TWAP 허용 여부 — 문서 없음 | [api-agent-keys](https://docs.pacifica.fi/api-documentation/api/signing/api-agent-keys.md) |
| 10 | 입금 다른 경로: Lighter L1, Aster BSC, HL relay, Ondo Ethereum | 미실행 | Lighter L1: Ethereum USDC ≥ 5 + L1 가스($3–10+). Aster BSC: USDT + BNB 가스. HL relay: `PERP_RELAYER_URL`. Ondo: Ethereum USDC + 가스 | Lighter "Ethereum Mainnet: $5 minimum" — [deposits](https://apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals.md). HL 최소 입금: 문서 없음(해당 페이지를 찾지 못함, 저장소 계획서는 $5로 기재) |
| 11 | 출금 — 전 venue | 사용자가 금지 (여전히 미승인) | **사용자가 출금 금지를 해제해야 함.** venue별 조건은 아래 표 | 아래 표 |
| 12 | `funds transfer` (HL usdSend / QFEX 계정 이체) | 미실행 | HL: 받는 주소(사용자의 두 번째 HL 계정). QFEX: 서브계정 생성 | [transfer-balance](https://docs.qfex.com/api-reference/rest/user/transfer-balance.md) |
| 13 | `funds rebalance execute`, `funds bridge exchange` | 출금을 포함 | 11번 해제 후. 최소 금액은 출금·입금 최소의 합 | — |
| 14 | `arb auto`, 봇·grid·DCA·funding-arb·`plan execute`, `trade twap --background`, Aster–Arcus 외 쌍의 라이브 arb | 미실행 | 설정에서 주문 크기를 최소로 고정($5.5–11), 실행 시간 제한, 감시. Aster · Arcus는 상한 $20 안. 주문 2개 이상을 쌓는 전략을 $10 최소 venue에서 돌리면 **상한 $25–30** (사용자 확인 필요) | — |
| 15 | 빌더 수수료 승인 / 해제 | 빌더 계정 없음 | 빌더 주소(HL은 빌더 계정 요건 충족 필요) + `settings builder.<venue>` | [builder-codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes.md) |
| 16 | HL HIP-4 outcome 매매 | USDH 없음 | USDH 확보(현물에서 USDC → USDH) + 최소 주문 금액 | [HIP-4](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-4-outcome-markets.md) |
| 17 | 서브계정, Pacifica lake / apikey / subaccount | 미실행 | 사용자 결정(계정 구조 변경). Pacifica 서브계정 이체는 소액 가능 | [subaccounts](https://docs.pacifica.fi/api-documentation/api/rest-api/subaccounts/create-subaccount.md) |
| 18 | alerts, dashboard | 미실행 | Telegram / Discord 설정. 자금 불필요 | — |

출금(11번) venue별 조건:

| venue | 필요한 것 | 문서 규칙 |
|---|---|---|
| Hyperliquid | 잔고 ≥ 수수료 + 금액 (저장소 계획서: 수수료 $1) | 문서 없음 (bridge 페이지를 찾지 못함) |
| Pacifica | ≥ $2 (최소 $1 + 수수료 $1) | "Minimum withdrawal: $1", "$1 per withdrawal (gas)" — [deposits-and-withdrawals](https://docs.pacifica.fi/trading-on-pacifica/deposits-and-withdrawals.md) |
| Lighter | secure ≥ $1 (자기 L1 주소, Ethereum 정산) / fast ≥ $4 USDC | [deposits-transfers-and-withdrawals](https://apidocs.lighter.xyz/docs/deposits-transfers-and-withdrawals.md) |
| Lighter RH | USDG → Robinhood Chain. 최소·소요 시간: 문서 없음 | 문서 없음 |
| Aster | `--can-withdraw --ip-whitelist <ip>`로 에이전트 재승인 + 수수료(estimate-withdraw-fee API). CLI 도움말은 USDT 출금만 적고 있어 **USDC 잔고 출금 가능 여부 미확인** | [asterdex/api-docs](https://github.com/asterdex/api-docs) |
| Ondo | master 주소를 주소록에 추가(`funds address-book add ondo`, SIWE 서명) 후 출금 | "USDC can be withdrawn on Ethereum or Arbitrum", "USDC withdrawals may include [a fee]" — [withdrawals](https://docs.ondoperps.xyz/withdrawals.md). 주소록 요건은 이 페이지에 없음 |
| Arcus | ≥ 1 USDG, 수신자는 계정 소유 지갑 | "must be at least 1000000000 quote quantums", "the recipient is always the wallet that owns the account" — [submit-withdrawal](https://docs.arcus.xyz/api-reference/exchange/submit-withdrawal.md) |
| QFEX | "Deposit and withdraw" 권한 + All accounts 키, `settings withdraw.qfex` 게이트 설정. 최소·수수료는 QFEX 화면에서 확인 | "check Deposit / Withdraw in QFEX for the current fees" — [programmatic-funding](https://docs.qfex.com/api-reference/programmatic-funding.md) |

### 단계별 합계

| 단계 | 상태 | 남은 범위 (위 표 번호) | 추가 자금 | 필요한 상한 | 그 밖에 필요한 것 |
|---|---|---|---|---|---|
| A | **실행됨** (2026-10-05, 상한 $20) | 1, 3, 4, 18 + Aster · Arcus에서의 14 | **$0** | $20 (현재 그대로) | QFEX resting 드릴, 재실행 로그 저장 |
| A+ | 미실행 | 5 (Aster 현물) | **≈ $6–7 USDT** (남은 지갑 자금 ≈ $6.8로는 브릿지 수수료까지 빠듯함 → 약 $5 추가 권장) | $20 | BSC 또는 Arbitrum에서 USDT 확보 |
| B | **실행됨** (2026-10-05, 상한 ≈ $25–30로 상향) | 2 + $10 최소 venue에서의 14 | $0 (마진은 현재 잔고로 충분) | **$25–30** | 추가 실행에 대한 사용자 확인 (상향은 단계 B 실행에 한해 승인됐다) |
| C | **실행됨** (2026-10-05, 상한 ≈ $110로 상향) | 없음 (HL 네이티브 TWAP 완료) | — | — | — |
| D | 미실행 — **출금 미승인** | 11, 12, 13 (출금·이체·리밸런스) | $0 (venue당 $2–5씩 기존 잔고에서 출금, 수수료 합계 약 $3–5) | $20 | **출금 금지 해제**, Ondo 주소록 등록, Aster 에이전트 재승인, QFEX 출금 권한 키, HL 두 번째 계정 / QFEX 서브계정 |
| E | 미실행 | 6, 15, 16, 17, 10, 9, 7, 8 | 10번만 자금 필요(Ethereum USDC ≥ 5 + L1 가스 $3–10+, BSC USDT + BNB) | $20 | Arcus 현물 API 키, 빌더 계정, USDH, 서브계정 결정, 코드 구현(HL · Aster client id), venue 문의(Aster 격리, Pacifica TWAP 에이전트 서명) |

A · B의 남은 것은 새 돈이 필요 없다. A+는 약 $5–7이 든다. D는 돈도 상한도 아니라 사용자의 출금 허용이 필요하다.

## 4. 열린 버그·미완료 작업

| # | 항목 | 영향 |
|---|---|---|
| 1 | 아무것도 커밋되지 않음 (`feat/venue-abstraction`, 미커밋 파일 약 250개 이상) | 기준점 없음. 2026-10-05에 고친 코드도 포함 |
| 2 | Ondo · QFEX API 키가 채팅에 붙여넣어짐 | 반드시 교체 |
| 3 | 통합 테스트 14건 실패 — 2026-10-13 분류: 의도된 변경 뒤 갱신 안 된 테스트 7(`bridge` → `funds bridge` 4, 오류 exit code 1, lighter-rh 추가, network별 arb state), 라이브 마켓 변화 3(TSLA가 HL `xyz` dex에만 있음, `hyna` dex에 BTC 없음), 네트워크 타임아웃 2(10초 한도, spread 조회 단독 ≈ 4.3초), 로컬 `.env` 키 필요 1(`bridge-strict`, SSOT Rule #3에도 어긋남), CCTP 동일 체인 1("offline" 테스트가 실제 fee API를 호출, API 400) | 제품 회귀는 없음. **2026-10-13 수정**: 통합 테스트 167 통과 / 0 실패 / 175 건너뜀(`bridge-strict`는 `PERP_BRIDGE_STRICT=1`일 때만, 읽기 전용, `.env` 키 제거). 함께 수정: plan · 봇 config 파일 없음 → `INVALID_PARAMS`(400), 브리지 동일 체인 → 네트워크 호출 전 `INVALID_PARAMS`. 테스트 타입 검사 `typecheck:test` 추가 — 기존 테스트에 타입 오류 235개(44개 파일)가 남아 CI에는 아직 연결 안 함 |
| 4 | venue에 남은 키: Pacifica 에이전트 키 8개, Lighter API 키 슬롯 12개, Lighter RH 슬롯 6(revoke 테스트의 임시 키) | 정리 필요 |
| 5 | `arb close <spot-perp 심볼>`이 여전히 state 파일만 보고 라우팅함. `arb rebalance` / funding-positions의 venue 목록이 여전히 하드코딩 | 같은 종류의 버그(§2.5의 `arb status` / `close`)가 이 경로에는 남아 있음 |
| 6 | Lighter `account trades`의 거래 수수료는 추정값 (문서 근거 없음) | 표시 값의 정확성 미보장 |
| 7 | Aster `liquidationPrice`가 작은 cross 포지션에서 "0"으로 출력 | 표시 문제 |
| 8 | HL `account settings`가 열린 포지션이 있는 마켓만 표시 | 포지션 없는 마켓의 레버리지 / 격리 모드 재조회 불가 |
| 9 | QFEX: 이전 라이브 청산이 옛 에코 규칙에 왜 걸리지 않았는지 설명되지 않음 (프레임 캡처 없음) | 원인 미상 |
| 10 | QFEX `account positions`의 entryPrice가 한 번 `4142.099999999999`로 표시 (부동소수 표기) | 표시 문제 (경미) |
| 11 | 코드만 고치고 라이브 재실행하지 않은 것 (§3 #3) | 🟡 |
| 12 | `docs/TEST-PLAN.md` §9.2가 QFEX `limit --reduce-only` / `scale-tp`를 "동작한다"고 적음 (§2.8) | 문서 불일치 |

같은 세션에서 이미 고친 것 (세션 기록). "라이브 재확인" 열이 아니오인 항목은 🟡다.

| 증상 | 수정 | 라이브 재확인 |
|---|---|---|
| `trade scale-tp`가 모든 단계가 거절됐는데도 성공으로 종료 (`adv-pacifica.log`, `adv-rh2.log`, `adv-ondo.log`) | 단계 수량을 lot으로 내림, 최소 미달은 전송 전 `SIZE_TOO_SMALL`, 실패 시 `ORDER_REJECTED` / `ORDER_PARTIAL` / `ORDER_PENDING` | 예 — 2단 성공: Aster, HL, Pacifica, Lighter, Lighter RH, Arcus. 최소 미달 사전 거절: Arcus · Lighter · Aster. Ondo는 전송 전 `CAPABILITY_UNSUPPORTED` |
| HL scale-tp가 포지션이 있는데 "No open position for ETH" (`adv-hl.log`) | 심볼 조회 수정 | 예 — HL 2단 |
| HIP-3 dex에서 scale-tp 전송 전 최소 금액 검사가 적용되지 않음 (`adv-hip3.log`) | 수정 (전송 전 최소 금액 검사) | 아니오 |
| `trade check NVDA --dex xyz`가 symbol not found (`adv-hip3.log` `r-check`) | 수정 | 예 — `valid: true` |
| Pacifica: 포지션 없는 reduce-only 422가 `ORDER_PENDING`으로 분류 | 해당 `error_id`를 확정 거절로 분류 | 예 — `ORDER_REJECTED` |
| Pacifica `--client-id`가 조용히 무시됨 | UUID만 허용하고 실제 전송, client id로 status / cancel 지원 | 예 — UUID로 place / status / cancel (파일 근거 없음) |
| Arcus: `trade status`가 open 주문에 `finality: pending` | 조회 경로에서 open / partiallyFilled를 final로 보고 | 아니오 |
| Ondo: `market kline`이 키가 있는데 `NO_SIGNER_AVAILABLE` | 인증이 필요한 캔들 조회에 등록된 키 사용 | 예 |
| `account settings`가 `[]` (HL, Aster, Arcus, Lighter 계열) | venue별 레버리지 / 마진 모드 조회 연결, 조회 불가면 `CAPABILITY_UNSUPPORTED` | 예 — Aster, Lighter, Lighter RH(TSLA 5x cross), Arcus, HL(포지션 있을 때 ETH-PERP 10x cross; 포지션 없는 dex는 `CAPABILITY_UNSUPPORTED`) |
| Lighter 포지션 레버리지가 0.8로 표시 | venue의 설정 레버리지 · 마진 모드 표시 | 예 — Lighter (5x, cross) |
| Aster 포지션 없는 reduce-only(-2022)가 결과 불명으로 분류 | 문서의 오류 코드표대로 확정 거절 분류 | 예 — Aster |
| Pacifica 네이티브 TWAP, 에이전트 서명 거절 | 에이전트 서명일 때 전송 전 거절 + `--no-agent` 안내 (원인은 venue 쪽 제약으로 추정, 문서 없음) | 예 — `CAPABILITY_UNSUPPORTED agentSignedTwap` |
| Lighter RH 에이전트 revoke가 슬롯 확인을 너무 빨리 해 `APPROVE_PARTIAL` | 문서 예제대로 최대 30초 폴링 | 예 — Lighter RH, Lighter |
| Lighter / Lighter RH `trade spot-balance`가 통합 계정에서 `[]` | 수정 | 예 — Lighter(USDC 행, `shared: true`), Lighter RH(USDG 행). 러너 spot phase 전 단계 통과 (R-LT-spot2, R-RH-spot) |
| Lighter classic 계정의 현물 quote 행 이름이 `USDC_SPOT` | `USDC`로 변경 | 아니오 |
| Lighter history 계열 명령이 마켓별로 fan-out (60 req/분 한도 초과) | 수정 | 예 — account history, trades, funding-history, pnl, trade fills |
| HL init이 호출마다 `userAbstraction`을 읽음 (HL 429로 실행이 두 번 중단된 기록 있음) | 60초 디스크 캐시, 요청 weight 축소 | 아니오 (단위 테스트만) |
| 계산된 가격의 부동소수 표기 (HL markPrice, Ondo avgPrice, Lighter mid) | 표기 정리 | 아니오 |
| `wallet agent verify hyperliquid`의 master 주소 | OWS 지갑에서 유도 | 아니오 |
| QFEX `trade reduce GOLD 50`이 0.003의 50%를 0.001로 내림 | 비율 계산 수정 | 예 — 0.0015 |
| QFEX reduce-only 에코 규칙이 FILLED 프레임(`reduce_only: false`)을 기준으로 판정 | ACK와 비체결 프레임 기준으로 판정 | 예 — 일반 `trade close`가 경고 없이 실행 |
| `arb status` / `arb close`가 Aster–Arcus 쌍을 인식하지 못함 (venue 목록 하드코딩) | 수정, 재빌드 | 예 — `arb status` 표시, `arb close SOL` 양쪽 leg 청산 |
| Aster · Arcus 외 쌍의 `arb exec` 최소 금액 | 수정 | 아니오 |
| `trade split`의 slice 크기 계산 오류 (실패인데 ok로 보고) | 수정, 최소 미달은 전송 전 `SIZE_TOO_SMALL` | 예 — Aster ($12 → 사전 거절, $13 → 0.05 × 2 체결) |
| `strategy twap`의 avgPrice가 보호 가격을 보고 | 수정 | 예 — reduce-only 매도 TWAP, avgPrice 120.345 |
| Aster spot-transfer 거절 메시지가 자산별(USDT) 이체 가능 잔고를 알려 주지 않음 | 메시지 수정 | 아니오 |

## 5. 다음 단계 제안

1. Ondo · QFEX API 키를 교체한다.
2. 현재 작업을 커밋해 기준점을 만든다 (미커밋 파일 약 250개 이상).
3. 🟡 항목을 라이브로 다시 돌린다 (§3 #3): HL 캐시 / 요청 weight, 가격 표기, Lighter classic 현물 quote 행, `wallet agent verify hyperliquid`, Arcus `trade status`, 다른 쌍의 `arb exec`.
4. 남은 arb 경로를 고친다: `arb close <spot-perp 심볼>`의 라우팅, `arb rebalance` / funding-positions의 하드코딩된 venue 목록 (§4 #5).
5. QFEX: resting reduce-only raw 드릴(포지션이 줄어들 때의 동작) → 게이트 상수 재검토, `docs/TEST-PLAN.md` §9.2를 현재 게이트 상태에 맞게 갱신.
6. 근거 보강 (§3 #4): Lighter kline / prices, Lighter RH history 조회와 transfer-out, Pacifica UUID client id를 로그로 남긴다.
7. HIP-3 scale-tp를 포지션 ≥ $20.5로 재실행한다 (§3 #2) — 상한 $25에 대한 사용자 확인 후.
8. Aster 현물용 USDT ≈ $6–7 확보 후 현물 phase 실행 (단계 A+).
9. 사용자에게 출금 허용 여부를 묻는다 → 허용되면 venue별 최소 금액으로 출금 한 번씩 (단계 D). 테스트 자금 회수와 겸한다.
10. `arb auto`·봇·grid·DCA·funding-arb(§3 #14)와 단계 E는 사용자 결정 사항으로 분리한다.
11. 통합 테스트 실패 14개 분류, 남은 키(Pacifica 8, Lighter 12, Lighter RH 슬롯 6) 정리, 작은 표시 문제(§4 #6–#10) 처리.

## 6. 2026-10-12–13 거래 기능 전체 라이브 테스트 (그룹 1–3)

> 이 절은 §1 · §2 · §3의 이전 행보다 우선한다. 특히 QFEX stop · TP/SL · amend(§1, §2.8에는 ⛔), HL · Aster client id(§2.9, §3 #8), HIP-4 · 자동화(§2.9, §3 #14, #16)는 이 절에서 라이브로 확인됐다.

사용자 승인 (세션 기록): 그룹 1(자동화·기타 기능, 상한 $20), 그룹 2(venue당 상한 ≈ $25–30), 그룹 3(미구현·게이트 기능 구현 또는 해제). **출금은 여전히 미승인이며 마지막에 진행한다.** 봇은 최소 크기, 짧은 실행 시간으로 돌리고 끝나면 멈춘 뒤 청산했다. 이 절이 §2.9 · §3 #8 · #14 · #16과 다르면 이 절을 따른다.

### 6.1 라이브로 확인된 것

| 영역 | 확인된 내용 | venue |
|---|---|---|
| grid / DCA / trailing stop (`strategy grid` · `dca` · `trailing-stop`) | 주문 · 체결 · 정지 | Aster |
| 엔진 전략 12종 (`strategy start <cfg>`) | 호가형(simple-mm, avellaneda-mm 등)은 호가를 내고 취소, mean-reversion · aggressive-taker는 체결 | Aster |
| `strategy quick-grid` / `quick-dca` (백그라운드 포함) | quick-dca는 `--orders 2` 뒤 스스로 종료하고 열린 롱을 표시. `background stop`은 SIGINT로 정상 종료하고 남은 주문을 취소 ("Nothing left open on aster for SOL") | Aster |
| 백그라운드 TWAP | 체결 · 종료 | Arcus |
| `strategy plan execute` | 10개 동작 중 9개. `cancel_order`는 단계 참조 기능이 없어 미확인 | — |
| funding-arb 자동 실행 → `arb close --pair` | SOL | Pacifica / HL |
| `arb auto` 진입 → `arb close` | ETH | Lighter / HL |
| `strategy quick-arb` → Ctrl-C → `arb close --pair` | JUP 30 (leg당 ≈ $10), 정지 시 두 leg 표시 | Pacifica / HL |
| 현물-선물 arb `arb exec HYPE spot:hl pacifica 11` → `arb close` | 체결 · 청산 | HL 현물 / Pacifica |
| `strategy delta-neutral` → Ctrl-C | HYPE 현물 0.13 + Pacifica 숏 0.13 진입. 가짜 손실 종료 없음, Ctrl-C에 즉시 정지. 청산은 `arb close HYPE --spot-exch hl --perp-exch pacifica` | HL 현물 / Pacifica |
| `strategy apex` | 기본 기준에서는 진입 신호 없음(10 tick). `strategy run apex` 기준 완화(`minRadarScore=0`, `minPulseTier=NONE`, `size=0.06`)로 시장가 진입 체결, 정지 시 포지션 표시 | Aster |
| HIP-4 outcome | GTC 주문 → 취소, IOC 매수 13개 → 매도 12개 (`--all` / `--size`). 1개(≈ $0.90) 잔여 | HL |
| HIP-3 `xyz` scale-tp | GOLD 0.005 (≈ $20.8) 롱, 50%씩 2단(4289 / 4372) 걸림, 청산 후 주문 0 | HL xyz |
| client order id | HL cloid로 주문 · 조회 · 취소, HIP-3 `--auto-id`. Lighter · Lighter RH client id로 취소 | HL, Lighter, Lighter RH |
| QFEX 게이트 기능 | `trade stop`(거절 경우 포함), `c:id`로 손절 취소, tpsl 양쪽 leg, 고아 손절 경고와 함께 close, 시장가 `--sl` 후 flatten, `c:id`로 정정 | QFEX |
| `strategy funding-auto` (`strategy run … --exchanges hyperliquid,pacifica`) | PENGU HL 롱 / Pacifica 숏 1597 (leg당 ≈ $12.5) 진입, 정지 시 `arb close --pair` 안내 → 청산. `sizeUsd`는 전략 내부 최소 $12 이상이어야 진입 | HL / Pacifica |
| `strategy delta-neutral` 재확인 (봇 수정 후) | 진입 시 arb state 기록(`arb status` confirmed), 정지 요약에 현물 leg + `arb close --spot-exch … --perp-exch …`, equity 미상은 `null` + 경고. `arb close HYPE`가 플래그 없이 현물-선물로 자동 청산 | HL 현물 / Pacifica |
| `strategy preset grid-conservative SOL --size 0.4` | 8개 주문(0.05씩) 배치, 정지 시 전부 취소 | Aster |
| `trade split` (2 slice) | HL $21, Pacifica $21, Lighter $22, Lighter RH $22, Arcus $12, Ondo $26, QFEX $26 — 전부 2 slice 체결 → close. Pacifica · Lighter · Lighter RH · Arcus는 체결 응답에 평균가가 없어 `avgPrice: null` | 7개 venue (Aster는 10-05) |
| `trade multi` | `hyperliquid:ETH:buy` + `pacifica:ETH:sell`, `lighter:SOL:buy` + `ondo:ETH:sell` — 양쪽 filled | HL, Pacifica, Lighter, Ondo |
| `arb exec` 다른 쌍 | Lighter–Arcus SOL $12.5 → `arb status` → `arb close --pair`. $11은 계산 금액 $9.90 < Lighter 최소 $10으로 전송 전 `SIZE_TOO_SMALL` | Lighter / Arcus |
| Aster client id | `--client-id` place → `status c:id` → `cancel c:id` → cancelled 확인, `--auto-id` | Aster |
| HIP-3 포지션 상태 `account margin` / `account settings` | GOLD 0.003: margin(레버리지 20, 노셔널 $12.50) / settings `xyz:GOLD 20x cross` | HL xyz |
| Ondo scale-tp 대안 | `trade tpsl ETH long --tp … --size 0.002` + `--size 0.003` — 부분 TP 2개 공존, close 후 주문 0 | Ondo |
| QFEX `trade scale-in` | GOLD 2단(−5%, −7%) × 0.003 배치 → cancel-all → 주문 0 | QFEX |
| 클라이언트 TWAP `trade twap SOL buy 0.2 60 --slices 2` | 2 slice 체결 → close. 첫 실행에서 `--json` 출력이 진행 로그와 섞여 JSON이 깨짐 → 진행 로그를 stderr로 보내도록 수정 후 재실행: 단일 JSON | Lighter |
| 클라이언트 TWAP 추가 | Lighter RH TSLA 0.059, Ondo ETH 0.01 — 각각 2 slice 체결 → close. QFEX `trade twap`은 전송 전 `CAPABILITY_UNSUPPORTED`(자동화 게이트), 주문·포지션 0 확인 | Lighter RH, Ondo, QFEX |
| HIP-3 leg `trade multi` | `--dex xyz trade multi hyperliquid:GOLD:buy:0.003 pacifica:ETH:sell:0.0042` — 전역 `--dex`가 HL leg에 적용되어 xyz:GOLD 체결, 양쪽 filled → close. leg 형식 자체에는 dex 칸이 없다 | HL xyz, Pacifica |
| HIP-3 `trade split` | GOLD $22, 2 slice 체결 → close | HL xyz |
| `trade multi` | `lighter-rh:TSLA:buy` + `qfex:GOLD:sell` — 양쪽 filled → 각각 close | Lighter RH, QFEX |
| 격리 마진 재조회 | `trade leverage <sym> 5 --isolated` → 최소 포지션 → `account settings`가 `isolated` 표시 → close → cross 복구 확인. HL ETH, HIP-3 GOLD(20x cross로 복구), Lighter RH TSLA(`marginMode: isolated` 포지션 표시), Arcus SOL | HL, HL xyz, Lighter RH, Arcus |
| 🟡 재확인 | Arcus `trade status`(open → `finality: final`), `wallet agent verify hyperliquid`(registered), HL `userAbstraction` 캐시 파일 생성, 가격 표기(HL markPrice, Lighter mid/mark, Ondo avgPrice 정상). HL `openInterest`의 긴 소수(`…0009`)는 HL API 원값 그대로 | HL, Arcus, Lighter, Ondo |

QFEX 실측 (production raw probe): 손절 ACK가 `client_order_id`를 돌려준다. `modify_order`는 새 order_id를 주고 client id는 유지한다. resting reduce-only 주문은 포지션이 0이 된 뒤에도 남는다. 이 주문을 교차 가격으로 정정하면 `INVALID_QUANTITY`로 거절된다.

### 6.2 이번에 고친 것

| 증상 | 수정 | 라이브 재확인 |
|---|---|---|
| 전략 봇이 config의 exchange를 무시 (pacifica에서 실행) | `resolveConfigVenue` | 예 |
| `time_after`가 봇을 끝내지 않음 | 수정 | 예 |
| arb 잔고 검사가 레버리지를 무시 | 레버리지 반영 `hasEnoughBalance` | 예 |
| 호가형 전략이 tick 단위가 아닌 가격 때문에 호가를 내지 못함 | `src/bot/quote-rules.ts` (tick 반올림, lot 내림, 최소 미달 건너뜀) | 예 |
| avellaneda-mm가 SOL ≈ $109에서 ≈ $38에 호가 | 가격 단위 공식 | 예 |
| HIP-4가 USDH를 가정 (venue quote는 USDC) | outcomeMeta의 quoteToken 사용 | 예 |
| DCA 평균가가 보호 가격 | venue 체결 기준 | 예 |
| `arb status` / `close`가 aster · arcus와 봇이 연 쌍을 못 봄 | 수정 | 예 |
| `arb auto`가 진입하지 않는 이유를 말하지 않음 | 건너뛴 이유 로그 | 예 |
| `background stop`이 tmux를 죽이고 주문을 남김 | SIGINT → 대기 → 보고 | 예 |
| quick-dca가 `--orders` 뒤 멈추지 않음 | 수정 | 예 |
| delta-neutral이 현물 매수를 손실로 계산해 종료, 정지가 안 됨 | 수정 | 예 |
| quick-arb가 쌍을 안내 없이 남김 | 정지 시 열린 포지션 표시 | 예 |
| `arb close <심볼>`이 state 항목 없는 현물-선물 쌍을 못 닫음 | `--spot-exch` + `--perp-exch`를 함께 주면 state 없이 현물-선물 경로로 청산 | 예 — HYPE |
| `strategy run funding-auto`가 `--exchanges`를 무시하고 4개 venue를 항상 사용, 실패는 조용히 무시 | 지정한 venue만 사용(봇 자신의 venue 포함 필수), 지정 venue 로드 실패는 오류, 기본 목록의 실패는 경고 | 예 — HL, Pacifica만 사용 |
| `strategy preset`에 크기 옵션 없음 (grid-conservative는 Aster에서 주문당 0.00625 < 0.01로 `SIZE_TOO_SMALL`) | `--size` 추가 (grid 총 크기 / DCA 주문당 크기 / arb leg당 $) | 예 — `--size 0.4` |
| 봇의 현물-선물 진입이 arb state를 쓰지 않음, 정지 요약에 현물 leg 없음, JSON 모드에서 정지 요약 미출력, 다중 venue 봇 equity 0 표시 | state 기록·갱신·삭제, 현물 leg + 청산 명령, `done` 줄에 `close` 필드, 정지 요약 stderr 출력, 미상 equity는 `null`(잔고 조건도 미상이면 발동 안 함) | 예 — delta-neutral |
| 클라이언트 TWAP의 `--json` 출력에 진행 로그가 섞임 | JSON 모드에서 진행 로그는 stderr | 예 — Lighter |
| 현물-선물 경로의 venue 별칭이 hl / pac / lt만 처리 (`lrh`, `ast` 등은 그대로 전달), 판정 불가 시 `jsonOk({error})` + exit 0 | venue 레지스트리(`resolveVenueId`)로 해석, 모르는 venue는 `UNKNOWN_VENUE`, 판정 불가는 `INVALID_PARAMS` | 예 — dry-run (`lrh` / `ast` / 모르는 venue) |
| `arb close`에 `--spot-exch` / `--perp-exch` 중 하나만 주면 조용히 무시 | `INVALID_PARAMS` | 예 |
| QFEX 결과 불명 손절 취소 뒤 재조회 실패가 예외로 전파 (cancel-all의 남은 주문 처리 중단) | 재조회 실패도 pending + 이유 | 아니오 (단위 테스트) |
| `arb exec`의 실행 기록 meta 키(`longExch`)가 provenance 판정 키와 달라 쌍이 항상 `inferred` | `arbPairId` / `longExchange` / `shortExchange` 추가 | 예 — Lighter–Arcus가 `executionLog`(confirmed) |
| QFEX flatten이 이미 사라진 손절 주문 때문에 `ORDER_PARTIAL` | 아래 6.3 | 부분 |

### 6.3 남은 문제

| # | 항목 | 내용 |
|---|---|---|
| 1 | QFEX: 포지션을 닫은 직후 손절 · 익절 취소 | `cancel_stop_order`가 "ServerError: unexpected error"를 돌려주는데 직후 조회하면 주문이 없다. QFEX는 손절 주문을 `/user/historic-orders`에 남기지 않고 `/user/trade`에는 주문 ID가 없어 취소를 증명할 수 없다. 규칙(알 수 없음은 알 수 없음)대로 `ORDER_PARTIAL`을 유지하고, 이유와 확인 방법을 메시지에 적었다. 문서 없음 |
| 2 | 다중 venue 봇 equity 미상 (HL 계정의 HIP-4 outcome 토큰에 현물 가격 없음) | equity가 `null`이라 drawdown / daily-loss 한도가 평가되지 않는다. HIP-4 토큰을 outcome 마켓 가격으로 평가하거나 제외할지 결정 필요 |
| 2a | `funding-arb` 봇 전략의 현물-선물 경로 arb state 기록 | 수정됨 (단위 테스트, 라이브 재실행 안 함 🟡). 봇이 venue에서 복구한 포지션과 funding-arb의 perp-perp 경로는 여전히 state를 쓰지 않음 |
| 2b | grid 봇 `fills`가 주문 배치를 체결로 셈 | 수정됨 — venue가 보고한 체결만 `fills`, 배치는 `ordersPlaced`. 라이브: preset 실행 `fills: 0, ordersPlaced: 8`. resting 주문이 나중에 체결된 것은 세지 못함(체결 내역 대조 없음) |
| 2c | `trade cancel-all`은 심볼 인자를 받지 않는다 (`trade cancel-all GOLD` → CLI 오류) | 사용법 주의 |
| 3 | `~/.perp/arb-state.json`의 오래된 PURR 항목 | `perp arb close PURR --state-only --yes`로 삭제 가능. 사용자 상태라 지우지 않았다 |
| 4 | 미실행: claude-agent 전략(Anthropic 키 필요), plan `cancel_order`(단계 참조 기능 없음). 현물(Aster: USDT 필요, Arcus: 발급 키 필요)은 사용자 지시로 이번 범위에서 제외 | 사용자 결정 / 자금 필요 |
| 6 | QFEX resting reduce-only / scale-tp 게이트 | 실측: resting reduce-only는 포지션이 0이 된 뒤에도 남는다. 나중에 체결될 때의 동작은 미증명이라 게이트 유지 (IOC만 허용). 해제하려면 resting 주문이 실제로 매칭되는 상황의 실험이 필요 |
| 5 | funding-auto의 `sizeUsd` 기본값 $100 fallback 등 기존 코드의 `?? default` | SSOT 규칙 위반, 정리 필요 |

### 6.4 출금 (2026-10-13, 사용자 승인: 전액 회수, 목적지는 main 지갑 자신의 주소)

| venue | 명령 | 결과 | 도착 확인 (main 지갑) |
|---|---|---|---|
| Hyperliquid | `-e hyperliquid funds withdraw hyperliquid 12.22` | `status: ok`. 수수료 $1은 금액에서 차감 | Arbitrum USDC +11.22 |
| Pacifica | `funds withdraw pacifica 12.98` | `requested_amount 12.98, fee_amount 1` | Solana USDC +11.98 |
| Lighter | `-e lighter funds withdraw lighter 15.95` | tx 접수 (code 200) | Ethereum USDC +15.95 |
| Lighter RH | `-e lighter-rh funds withdraw lighter 12.96` | tx 접수 (code 200) | Robinhood Chain USDG (합계로 확인) |
| Arcus | `funds withdraw arcus 9.94` | withdrawalId 발급, `PENDING` 접수 | Robinhood Chain USDG — Lighter RH와 합쳐 +22.90 (3.7 → 26.6) |
| Aster | `funds withdraw aster 8.74 --chain arbitrum --asset USDC` | withdrawId 발급, 수수료 0.51 | Arbitrum USDC +8.23 |
| Ondo | — | **미완료**: `funds address-book add ondo`가 venue에서 거절 (`key_not_allowed_for_action`, API 키로는 주소록 엔드포인트 불가). Ondo 웹앱에서 주소록 등록 필요 | — |
| QFEX | — | **미완료**: 출금 권한 키와 `settings withdraw.qfex` 게이트 필요 (사용자 작업) | — |

이번에 발견해서 고친 것:
- Aster 출금이 USDT로 고정 → 계정 증거금이 USDC면 출금 불가. `user-withdraw-info` 원값에 USDC 행(체인 1 / 56 / 4663 / 5042 / 42161)이 있어 `--asset USDT|USDC` 추가.
- Aster `user-withdraw-info`가 `perpMaxWithdrawAmount` / `withdrawFee`를 JSON number로 보냄 → 파서가 문자열만 받아 `EXCHANGE_ERROR`(전송 전). 숫자도 소수 문자열로 변환하도록 수정.
- Aster 출금 권한 에이전트(--can-withdraw + IP 화이트리스트)는 출금 후 `approve --rotate --no-withdraw`로 원복 (이전 키는 venue 확인 후 해제).

발견만 한 것: `funds withdraw hyperliquid`의 dry-run은 `-e hyperliquid` 없이 통과하지만 실제 실행은 `Requires --exchange hyperliquid`(`UNKNOWN`, 500)로 거절된다 (전송 없음).

남은 venue 잔고: Ondo ≈ $11.89, QFEX ≈ $10.73, 그 외 venue는 $0.03 미만. HL 현물 HYPE 0.0333(≈ $2.8, HL 현물 최소 주문 $10 미만이라 매도 불가)과 HIP-4 outcome 1주, Pacifica SOL 0.00096은 남아 있다.

### 6.5 추가 검증과 수정 (2026-10-13)

| 항목 | 결과 |
|---|---|
| `funds bridge send --from arbitrum --to solana --amount 5` | **수정 후 라이브 성공** (deBridge, Solana USDC +4.996). 수정 전: OWS 지갑이면 `ows:main`을 개인키로 해석해 `UNKNOWN` 500 (`send` / `exchange` / `quote` 공통). 이제 OWS master 서명(`src/bridge-signers.ts`) |
| deBridge 실제 비용 | 위 전송에서 실제로 **5.9397 USDC + 0.001 ETH**가 나갔는데 견적은 "amountIn 5, fee $0.004"였다 (`prependOperatingExpenses=true`가 운영비를 입력에 더함, `fixFee`는 tx value). 수정: `false`로 정확히 `--amount`만 나가게 하고(운영비는 받는 금액에서 차감), `fixFee`를 `nativeFee`로 표시, 견적 순위를 "받는 금액 − 네이티브 수수료(USD)"로 계산 |
| `funds rebalance plan` / `execute --withdraw-only` | 라이브: HL $11 입금 → plan `$5 hyperliquid→lighter` → execute가 HL에서 $5 출금(`withdrawn`). dry-run이 `status: "executed"`로 보고하던 것을 `simulated`로 수정. `--auto-bridge` 경로는 Arbitrum ETH 부족(deBridge 고정 수수료로 소진)으로 라이브 미실행 |
| `funds withdraw hyperliquid` / `pacifica`, `funds transfer`(HL) | 서브명령이 venue를 직접 가져오도록 수정 — `-e` 없이 라이브 출금 성공 (HL 6.0) |
| alerts | `add` / `list` / `remove` 정상. `--exchange` 필터가 루트 옵션에 먹혀 `"*"`로 저장되던 것 수정. 채널 미설정 시 `test` / `start`가 텍스트 + exit 0이던 것을 `INVALID_PARAMS`로 수정. Telegram / Discord 전송은 토큰이 없어 미실행 |
| HIP-4 outcome 토큰 평가 | `allMids`의 outcome mid로 평가 → 다중 venue 봇 equity가 다시 계산됨 (+14881 × 1 ≈ $0.90, 읽기 전용 라이브 확인) |
| HL `account settings` | 포지션이 없어도 최근 거래 마켓(최대 5개)의 레버리지를 `activeAssetData`로 조회 |
| Aster `liquidationPrice: "0"` | `null`로 보고 (Aster 문서: 값이 음수가 되면 0으로 보고) |
| `spot-adapter-cross-validate` 테스트 | `.env` 개인키 읽기 제거, 계정 케이스는 OWS 공개 주소 + `PERP_SPOT_XVAL_ACCOUNT=1` |

남은 것: `funds rebalance execute --auto-bridge` 라이브(가스 필요, 가스 사전 점검 없음), HyperCore → Solana CCTP 경로(`bridge exchange --from hyperliquid --to pacifica`)는 주소 인코딩이 의심되나 미검증, Solana v0 트랜잭션의 OWS 서명은 mock 테스트만.
