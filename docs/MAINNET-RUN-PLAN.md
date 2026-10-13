# 메인넷 최소 자금 테스트 기획 (2026-10-05)

목표: 7개 venue(+HL HIP-3)에서 **입금 → 선물 거래 → (스팟) → 출금**을 실제 자금 최소액으로 한 번씩 통과시킨다.
실행 도구·옵션·단계 상세는 `docs/TEST-PLAN.md`가 기준이고, 이 문서는 **순서·예산·관문**만 정한다.
QFEX는 구현·UAT 확인(설계 §14.12의 메인넷 차단 항목) 전이라 이 계획의 마지막 단계로 분리한다.

## 1. 원칙

- 실행은 사용자가 직접 한다(`--confirm-real-money` + venue 이름 타이핑). 보고서(`~/.perp/e2e-reports/`)는 어시스턴트가 분석한다.
- **한 번에 한 venue.** 앞 venue 보고서 분석이 끝나고 포지션·주문 0을 확인한 뒤 다음으로 간다.
- 단계별 최악 노출 상한 `--max-usd 20`(기본값) 유지. 올리지 않는다.
- 결과 불명(`ORDER_PENDING`, 타임아웃)이면 러너가 멈춘다. **재실행하지 말고** 안내된 조회 명령으로 상태를 확인한다.
- 비상 정지: `touch ~/.perp/e2e-kill`.
- CLI는 반드시 `node /Users/hik/Documents/GitHub/perp-cli/dist/index.js`(= `pnpm e2e`)로 실행한다. PATH의 `perp`는 0.12.15 구버전이다.

## 2. 시작 전 관문 (자금 넣기 전, 전부 $0)

| # | 할 일 | 통과 기준 |
|---|---|---|
| G1 | 현재 작업 커밋 (기준점 확보) | `feat/venue-abstraction`에 커밋, 작업 트리 깨끗 |
| G2 | 독립 코드 리뷰 재실행 | 마지막 READY 판정 이후 변경분(Lighter 공식 서명 모듈, HL 자체 서명, 결과 확정 로직, 다른 세션의 HIP-3 러너 변경)에 대해 READY-FOR-MAINNET |
| G3 | `pnpm build && npx vitest run --exclude '**/integration/**'` | 전부 통과 |
| G4 | 7개 venue 메인넷 dry-run (`--phase all --dry-run`) | 전부 exit 0 (2026-10-05 통과 확인) |
| G5 | `perp -n mainnet arb status` | 3월의 PURR 상태 파일이 메인넷으로 표시되고 실제 포지션과 대조됨 |
| G6 | `~/.perp` 백업 (`cp -a ~/.perp ~/.perp.bak-premainnet`) | 백업 존재 |
| G7 | `strategy quarantine` 조회 | 비어 있음 |
| G8 | 메인넷 에이전트 재승인 (기존 4개는 7월 28일 만료) | `wallet agent verify <venue>` 통과 |

주의: 마스터 지갑 `main`에는 OWS 비밀번호가 없다. 메인넷 자금을 넣기 전에 비밀번호 설정 여부를 결정한다.

## 3. 예산

주문 최소 notional은 2026-10-05 메인넷 dry-run 실측값이다. 레버리지 2배 기준이며, 수수료·가스는 별도다.

| venue | 최소 주문 | 1차(선물+출금) | 2차(스팟 추가) | 입금 자산 / 체인 | 가스 |
|---|---|---|---|---|---|
| Hyperliquid | $10 (ETH) | $12 | +$23 (PURR ≈ $11, 지정가 대기분 포함 2.05배) | USDC / Arbitrum (**최소 $5, 미만은 유실**) | Arbitrum ETH |
| HL HIP-3 `xyz` | $10 (NVDA) | HL 잔고 공용 (standard 계정이면 dex로 담보 이동 필요) | — | — | — |
| Pacifica | $10 (ETH) | $12 | +$23 (SOL ≈ $11) | USDC / Solana | SOL |
| Lighter | $10 (ETH) | $12 | +$28 (ETH ≈ $13.5) | USDC / Arbitrum CCTP | Arbitrum ETH |
| Lighter RH | $10 (TSLA) | $12 | +$23 (SPY ≈ $11) | USDG / Robinhood Chain | RH ETH |
| Aster | $5 (SOL) | $8 | 수동 지정 필요 | USDT / BNB Chain (`funds deposit aster`, vault 컨트랙트) | BNB |
| Ondo | $10 (ETH) | $12 | 수동 지정 필요 | USDC / Arbitrum (`funds deposit ondo`, 계정 입금 주소로 전송) | Arbitrum ETH |
| Arcus | $5 (SOL) | $8 | 수동 지정 필요 (지갑 스팟, Permit2 승인 가스) | USDG / Robinhood Chain (웹에서 입금) | RH ETH |
| **합계** | | **약 $76** | **약 +$100** | | 체인별 소액 |

출금 최소액·수수료(HL $1, Pacifica $1 등)는 1차 금액에 여유로 포함했다. 문서에 없는 값은 실행 때 확인한다.

## 3a. 자금 경로 (Robinhood Chain USDG에서 출발, 2026-10-05)

운영 자금은 Robinhood Chain(4663)의 USDG 하나에서 나간다. 체인 간 이동은 전부 `perp funds bridge send`의 Relay 경로(OWS master 서명, 수신자 = master 자신의 주소, 견적은 로컬 검증)다. 매번 `--dry-run`으로 견적을 먼저 본다.

| # | 목적 | 명령 | 비고 |
|---|---|---|---|
| 0 | RH 가스 확보 | `funds bridge send --from arbitrum --to robinhood --from-asset ETH --to-asset ETH --amount <ETH>` | **RH에 ETH가 0이라 첫 브릿지는 Arbitrum에서 출발**(가스는 Arbitrum에서 지불). 이후 RH 출발 브릿지 가능 |
| 1 | Hyperliquid / Lighter CCTP / Ondo용 USDC | `funds bridge send --from robinhood --to arbitrum --from-asset USDG --to-asset USDC --amount <N>` | 그 뒤 `funds deposit hyperliquid` / `funds deposit lighter cctp arbitrum` / `funds deposit ondo` |
| 2 | Arbitrum 가스 보충 (필요 시) | `… --from robinhood --to arbitrum --from-asset USDG --to-asset ETH --amount <N> --min-out <ETH>` | stable → native는 `--min-out` 필수 |
| 3 | Pacifica용 USDC | `… --from robinhood --to solana --from-asset USDG --to-asset USDC --amount <N>` | 수신 = master의 Solana 주소 → `funds deposit pacifica` |
| 4 | Solana 가스 | `… --from robinhood --to solana --from-asset USDG --to-asset SOL --amount <N> --min-out <SOL>` | Pacifica 직접 입금에 SOL ≥ 0.005 |
| 5 | Aster용 USDT | `… --from robinhood --to bsc --from-asset USDG --to-asset USDT --amount <N>` | BNB 가스는 별도로 필요(이 표의 경로로는 BNB를 받지 않는다 — BSC 지갑에 BNB가 없으면 입금 불가) → `funds deposit aster` |
| 6 | Lighter RH / Arcus | 브릿지 불필요 (USDG 그대로) | `funds deposit lighter-rh` |

venue 입금 (전부 `--dry-run` 지원, 테스트넷은 `CAPABILITY_UNSUPPORTED`):

- **Aster**: `perp funds deposit aster <N> [--chain bsc|arbitrum] [--asset USDT|USDC]` — approve(vault, 정확한 금액) → `deposit(token, amount, 1)`. 전송 전에 chainId·decimals·supportToken·paused·잔고·가스를 읽고, 영수증의 `Deposit(account, currency, broker=1)` 이벤트를 확인한 뒤 venue 입금 내역이 `SUCCESS`가 될 때까지 조회한다(3분, 초과 시 `ORDER_PENDING` + tx hash). **API 지갑(에이전트)을 먼저 승인해야 한다** — 입금 확인을 그 지갑으로 읽는다.
- **Ondo**: `perp funds deposit ondo <N> [--chain arbitrum|ethereum] [--probe <amt>]` — 계정의 첫 번째 USDC 입금 주소(계정 ID 일치 확인)로 ERC-20 전송. `--probe`를 주면 소액을 먼저 보내고 입금 확인 후 나머지를 보낸다(10분 안에 확인이 안 되면 나머지는 보내지 않는다).
- **Hyperliquid / Lighter**: `funds deposit hyperliquid`, `funds deposit lighter ethereum|cctp`도 OWS master 지갑으로 서명한다(이전에는 raw key 전용이라 OWS 지갑에서 실패).

출금: `perp funds withdraw aster <N> [--chain bsc|arbitrum]`은 에이전트가 `--can-withdraw --ip-whitelist <ip>`로 승인돼 있어야 한다(없으면 `POLICY_DENIED` + 재승인 안내). `perp funds withdraw ondo`는 목적지가 주소록에 없으면 전송 전에 거부한다 — master 자신의 주소는 `perp funds address-book add ondo <주소>`로 추가한다. **이번 실행에서는 출금을 라이브로 돌리지 않는다.**

Relay 견적 실측 (2026-10-05, 읽기 전용 `POST /quote`, user `0xabf2…37D3`, Solana 수신 `4iTF…waB7`):

| 경로 | 입력 | 예상 수령 | 보장 최소 | relayer 수수료 | 출발 가스 | 총 영향 |
|---|---|---|---|---|---|---|
| RH USDG → Arbitrum USDC | 2 / 15 | 1.975801 / 14.969921 | 1.909612 / 14.670522 | $0.024 / $0.028 | $0.006 | −1.20% / −0.19% |
| RH USDG → Solana USDC | 2 / 15 | 1.978094 / 14.969616 | 1.911828 / 14.670224 | $0.022 / $0.028 | $0.006 | −1.09% / −0.19% |
| RH USDG → Solana SOL | 2 / 15 | 0.016207 / 0.122630 SOL | 0.015664 / 0.120178 | $0.022 / $0.032 | $0.006 | −1.29% / −0.42% |
| RH USDG → BNB Chain USDT | 2 / 15 | 1.968347 / 14.909212 | 1.902407 / 14.611028 | $0.029 / $0.072 | $0.006 | −1.68% / −0.70% |
| Arbitrum ETH → RH ETH | 0.00075 / 0.0056 ETH (≈ $2 / $15) | 0.00074145 / 0.00558854 | 0.00071676 / 0.00547677 | $0.023 / $0.031 | $0.002 | −1.14% / −0.20% |
| RH USDG → Arbitrum ETH | 2 / 15 | 0.00072990 / 0.00552606 ETH | 0.00070545 / 0.00541554 | $0.023 / $0.034 | $0.006 | −1.27% / −0.33% |

ETA는 전 경로 약 1초(견적 기준). $2는 고정 수수료 비중이 커서 1.1–1.7% 손실, $15는 0.2–0.7%다.

## 4. 순서

테스트넷을 끝까지 통과한 venue부터, 한 번도 실제로 돌려보지 않은 venue를 뒤로 둔다.

| 순서 | venue | 테스트넷 상태 | 메인넷에서 처음 확인되는 것 |
|---|---|---|---|
| 1 | Hyperliquid | 전체 통과 | 입금(Arbitrum), 메인넷 출금 |
| 2 | Pacifica | 전체 통과 (스팟 제외) | 스팟, 포지션 TP/SL 해제 |
| 3 | Lighter | 선물 통과 | 입금(CCTP), 출금, 스팟 매도, post-only 교차 거부 |
| 4 | Lighter RH | 선물 통과 | 입금(RH 체인 고정 주소), 출금, 스팟 |
| 5 | HL HIP-3 | 담보 0으로 미실행 | HIP-3 주문 전체, 통합 계정 잔고 |
| 6 | Aster | 미실행 | 에이전트 승인, 주문 전체 |
| 7 | Ondo | 미실행 | 키 가져오기, 주문 전체, 출금 |
| 8 | Arcus | 미실행 | 키 등록, 주문 정정 서명(§14 A2), 출금 |
| 9 | QFEX | 구현 중 | UAT에서 Q1·Q2 등 차단 항목 통과 후 |

## 5. venue 한 곳의 진행 (공통)

1. **읽기만**: `pnpm e2e -- --venue <id> --network mainnet --phase preflight --confirm-real-money` — 자금 이동 없음.
2. **입금**: 1차 금액만. CLI 경로가 있으면 `--phase deposit --deposit-amount N`, 없으면 웹에서.
3. **선물**: `--phase trade`. 지정가 → 정정 → 취소 → post-only → IOC → 시장가 진입 → TP/SL → 청산 → flatten.
4. **보고서 분석** → 포지션·주문 0 확인.
5. **출금**: `--phase withdraw --withdraw-amount N` (남은 잔고 일부 또는 전부).
6. (2차) **스팟**: 금액을 추가 입금한 뒤 `--phase spot`.

각 단계는 별도 실행이다. 앞 단계 보고서에 실패·중단이 있으면 다음 단계로 가지 않는다.

## 6. 중단 기준

- 체결 수량·포지션이 거래소 화면과 다르다.
- 취소했다고 보고된 주문이 남아 있다.
- 결과 불명이 같은 단계에서 두 번 나온다.
- 출금이 접수됐는데 30분 안에 도착하지 않는다 (재시도 금지, 거래소 내역 확인).
- 위 중 하나라도 발생하면 해당 venue를 `flatten`하고, 원인 분석이 끝날 때까지 다음 venue로 가지 않는다.

## 6a. 실행 명령 (operator mode)

사용자가 이 실행을 어시스턴트에게 위임했다(비대화식 셸, TTY 없음). 고정 한도: **venue당 노출 상한 $20, 결과 불명이면 중단, 출금은 맨 마지막.**
§1의 "venue 이름 타이핑"은 `--operator-authorized <venue>`가 대체한다 — 값이 `--venue`와 정확히 같아야 하고 `--confirm-real-money`도 필요하다.
이 모드로는 상한을 올릴 수 없다(`--max-usd` 20 초과는 TTY `RAISE-CAP-<N>` 전용). 입금/출금 확인은 자동 승인되고 보고서에 `operator-authorized`로 기록된다(`operatorAuthorized: true`).

공통 접두(venue마다 `V`만 바꾼다. 한 번 실행 = 한 venue, 한 단계):

```bash
cd /Users/hik/Documents/GitHub/perp-cli && pnpm build
V=hyperliquid   # pacifica | lighter | lighter-rh
RUN="pnpm e2e -- --venue $V --network mainnet --confirm-real-money --operator-authorized $V --leverage 5"
```

| 순서 | 단계 | 명령 | 통과 기준 |
|---|---|---|---|
| 0 | 계획 확인 ($0) | `pnpm e2e -- --venue $V --network mainnet --phase all --dry-run --leverage 5` | exit 0, `pf-sizing` / `s-plan` 금액 확인 |
| 1 | preflight (읽기만) | `$RUN --phase preflight` | exit 0. `pf-wallet`: 입금 지갑의 자산·가스 잔고, `pf-equity`: venue 잔고 |
| 2 | 입금 | `$RUN --phase deposit --deposit-amount <D>` | `d-balance-change` pass (잔고 증가) |
| 3 | 선물 (레버리지 5) | `$RUN --phase trade` | pass, `t-final`: 포지션·주문 0 |
| 4 | 스팟 | `$RUN --phase spot` | pass (또는 사유가 적힌 SKIP), 마지막 `s-balance-final` |
| — | **1–4를 네 venue 모두 끝낸 뒤** | | 각 보고서 분석, 포지션·주문 0 |
| 5 | 출금 (마지막) | `$RUN --phase withdraw --withdraw-amount <W>` | `w-balance-change` pass → 도착은 지갑/탐색기에서 확인 |

venue 순서는 §4 그대로: hyperliquid → pacifica → lighter → lighter-rh. 출금도 같은 순서로 맨 끝에 한다.

금액 (2026-10-05 메인넷 dry-run, `--leverage 5`):

| venue | 선물 1단위 | 최대 증거금(레버리지 5) | 스팟 (필요 quote = notional × 1.05) | 입금 최소 | 권장 입금 `<D>` | 출금 최소 / 수수료 |
|---|---|---|---|---|---|---|
| hyperliquid (+ HIP-3 `xyz`) | ETH 0.0041 ≈ $11.06 (HIP-3 NVDA 0.047 ≈ $11.04) | ≈ $4.43 | PURR 65 ≈ $11.08 → 11.64 USDC | **5 USDC (미만은 유실 — 러너가 거부)** | 13 | 2 / 1 USDC |
| pacifica | ETH 0.0041 ≈ $11.07 | ≈ $4.43 | SOL 0.091 ≈ $11.07 → 11.62 USDC | 10 USDC | 13 | 10 (보수적) / 1 USDC |
| lighter | ETH 0.0041 ≈ $11.06 | ≈ $4.42 | ETH 0.0050 ≈ $13.50 → 14.18 USDC | 5 USDC (CCTP) | 16 | 1 USDC (실시간 `assetDetails`) |
| lighter-rh | TSLA 0.0295 ≈ $11.00 | ≈ $4.40 | SPY 0.0143 ≈ $11.04 → 11.59 USDG | 1 USDG | 13 | 1 USDG (실시간 `assetDetails`) |

- 스팟은 **매수 → 매도 → 원거리 지정가** 순서라 quote가 notional × 1.05만 필요하다(§3 표의 2.05배는 이전 순서 기준). 권장 입금 합계 약 **$55** + 체인별 가스.
- 스팟은 레버리지가 없어 권장 입금액을 스팟 필요 quote가 결정한다. 선물만 돌릴 venue는 입금 최소값(+ 증거금 ≈ $4.4)이면 된다.
- 출금액 `<W>`는 그 시점 `perp -e $V portfolio`의 출금 가능액 이하, 위 최소값 이상으로 정한다. 출금 수수료는 venue가 뗀다.
- HIP-3 레그는 hyperliquid 실행에 포함된다. standard 계정이면 dex 담보가 없어 `pf-dex-collateral`에서 멈춘다(자금 이동 없음).
- `fail`(확정 실패)로 끝나면 러너가 `cleanup` 단계에서 이 실행이 만든 주문·포지션·스팟·옮긴 quote만 정리하고 보고서에 남긴다. `stopped`(결과 불명)에서는 아무것도 보내지 않는다.
- Pacifica 입금은 직접 입금(`--no-relay`)이라 Solana 지갑에 SOL 0.005 이상이 필요하다(preflight `pf-wallet`가 확인).
- 러너가 멈추면(`stopped` / `fail`) 같은 단계를 **다시 실행하지 않는다**. 보고서의 "Cleanup / verify by hand" 조회 명령으로 상태를 확인하고 §6 기준을 따른다. 비상 정지: `touch ~/.perp/e2e-kill`.
