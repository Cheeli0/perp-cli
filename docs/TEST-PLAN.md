# E2E 테스트 계획 — 7개 venue 입금 → 거래 → 출금 (운영자 런북)

대상: hyperliquid(+ HIP-3 dex `xyz`, 같은 실행의 두 번째 레그), pacifica, lighter, lighter-rh, aster, ondo, arcus.
순서: **P0 단위 테스트 → P1 testnet → P2 mainnet 최소 금액 → P3 교차 venue**.
도구: `scripts/e2e/run.ts` (`pnpm e2e -- …`), 보고서 `~/.perp/e2e-reports/<ts>-<venue>-<network>.{json,md}`.
설계 확인 항목: `docs/DESIGN-venue-abstraction.md` §11(#1–#21) · §12.3(S1–S22) → 아래 §6 매핑.

역할 분담: **testnet = 어시스턴트가 이 머신에서 비대화식 실행**(`--yes-testnet`), **mainnet = 사용자가 이 문서대로 수동 실행**(대화식 확인 유지). 보고서(.json/.md)는 자기완결적 — 실행 후 어시스턴트가 분석한다.

---

## 0. 빠른 시작

```bash
pnpm build                                   # 러너는 dist/index.js 를 실행한다 (항상 최신 빌드)
pnpm e2e:typecheck                           # 러너 타입 체크
# 1) 키 없이 공개 엔드포인트만 — 모든 venue × 양 네트워크
pnpm e2e -- --venue <id> --network testnet --phase all --dry-run
# 2) testnet 실제 실행 (비대화식)
pnpm e2e -- --venue <id> --network testnet --phase preflight,trade,spot --yes-testnet [--spot-symbol S --spot-size N]
# 3) mainnet (사용자, 대화식) — 기본 상한 $20
pnpm e2e -- --venue <id> --network mainnet --phase preflight,trade --confirm-real-money
```

venue id: `hyperliquid | pacifica | lighter | lighter-rh | aster | ondo | arcus`
(`hyperliquid` 한 번 실행 = 코어 dex 전 단계 → 통과 시 **HIP-3 레그**(`-e hyperliquid --dex xyz`, preflight + trade, step id `hip3-*`)를 같은 보고서에 이어서 실행. `--dex <name>` dex 변경 · `--hip3-symbol SYM` · `--no-hip3` 생략)

| 옵션 | 의미 |
|---|---|
| `--phase` | `preflight,trade,spot,deposit,withdraw` 또는 `all` (preflight는 항상 포함) |
| `--max-usd N` | 단계별 **최악 노출(worst-case open notional)** 상한. mainnet 기본 **20**, testnet 기본 100. mainnet에서 20 초과는 `--max-usd` 명시 **+** `RAISE-CAP-<N>` 타이핑 확인 필요 |
| `--confirm-real-money` | mainnet 비-dry-run 필수 + venue 이름 타이핑 확인. stdin이 TTY가 아니면 **거부** |
| `--operator-authorized <venue-id>` | mainnet 전용, `--confirm-real-money`와 함께. 값이 `--venue`와 **정확히 같을 때만** venue 이름 타이핑을 대체해 TTY 없이 시작한다(불일치·`--confirm-real-money` 누락 → exit 2). 상한 기본 $20 유지 — 20 초과는 여전히 TTY `RAISE-CAP-<N>` 타이핑 필수(비대화식으로는 올릴 수 없음). 입금/출금/approve 확인은 자동 승인되고 보고서에 `*-operator-confirm` 단계(`operator-authorized`)로 남는다. 보고서 `operatorAuthorized: true` |
| `--yes-testnet` | testnet 전용, 모든 확인 프롬프트 생략(입금/출금/approve 포함) |
| `--dry-run` | 공개 엔드포인트만(마켓·최소 수량·네트워크 가용성) + 계획 명령 출력, **아무것도 전송 안 함**, 키 불필요 |
| `--symbol` | 기본은 후보(`scripts/e2e/venues.ts`) 중 최소 주문 notional이 가장 작은 심볼 |
| `--leverage 2` `--isolated` `--far-pct 5` `--margin-pct 10` `--slippage-bps 100` | 레버리지 / 원거리 지정가 % / 최소 notional 여유 % / 시장가 상한 |
| `--spot-symbol --spot-size [--spot-ref-price] [--spot-limit-price]` | 스팟 단계. **생략 시 자동 선택**(hyperliquid · lighter · lighter-rh · pacifica): 공개 스팟 마켓 중 quote 자산(HL/pacifica `USDC`, lighter 계열 = 네트워크 담보) 마켓 가운데 최소 주문이 상한에 들어가는 **24h 거래대금 최대** 마켓, 크기 = venue 최소(최소 수량 vs 최소 notional × 1.1, 크기 그리드 올림). 가격 없음·양방향 호가 없음·mid가 mark에서 2% 초과·최소 주문 미공개 마켓은 제외. 맞는 마켓이 없으면 제외 사유와 함께 preflight-fail. aster/ondo/arcus는 공개 스팟 리더가 없어 두 옵션 필수(`--spot-symbol`만 주면 그 마켓의 최소로 크기 결정 — 자동 선택 venue 한정) |
| `--deposit-amount` `--withdraw-amount` | 입출금 금액(≤ `--max-usd`). testnet CLI 경로에서 생략하면 경로 최소값(HL 2, 그 외 1) — mainnet은 필수 |
| `--allow-onchain-approve` | Arcus 스팟 `--yes`(Permit2 approve tx, RH ETH 가스) 허용 |
| `--wallet NAME` `--pace-ms N` `--poll-timeout-sec 900` | `-w` 전달 / 호출 간격(lighter 계열 3000ms) / 입출금 잔고 폴링 |

**위임 실행(operator mode, 2026-10-05).** 사용자가 메인넷 최소 자금 실행을 위임한 경우 `--confirm-real-money --operator-authorized <venue>`로 비대화식 실행한다(순서·명령: `docs/MAINNET-RUN-PLAN.md` §6a). 나머지 안전장치는 그대로다: 상한 $20, kill switch, 결과 불명 시 중단, 단계별 노출 확인. 스팟 단계 순서는 **매수 → 잔고 확인 → 매도 → 잔고 확인 → 원거리 지정가(GTC) → 목록 → 취소 → ALO → 취소**이고 필요한 quote는 notional × 1.05다(원거리 지정가는 매도 대금을 재사용; 매도 후 quote가 모자라면 지정가 단계만 SKIP). mainnet preflight는 입금 지갑의 온체인 잔고(입금 자산 + 가스, 읽기 전용 RPC)와 venue 잔고를 출력하고(`pf-wallet`), `--deposit-amount`가 지갑 잔고보다 크거나 가스가 0이면 거부한다. 입출금 최소값·수수료와 출처는 `scripts/e2e/venues.ts`(`minSource` / `fee`)에 있다: HL 입금 5 USDC 미만은 유실되므로 거부, HL 출금 수수료 1 USDC, Pacifica 출금 10 USDC(보수적), Lighter 계열 출금은 `assetDetails.min_withdrawal_amount`를 preflight에서 읽어 적용(`pf-funding-mins`). `--leverage N`이 마켓 최대 레버리지보다 크면 preflight-fail. 노출 계산: 정정(`t-edit`)은 교체되는 주문을 뺀 **차액**만 더하고, 상한 때문에 SKIP된 단계에 의존하는 단계·검증은 실패가 아니라 함께 SKIP된다. 확정 실패(`fail`)로 끝나면 `cleanup` 단계(`c-*`)가 이 실행이 만든 것만 정리한다(주문 취소 → 포지션 청산 → 산 스팟 매도 → 옮긴 quote 반환). 결과 불명(`stopped`)·kill switch·SIGINT 뒤에는 아무것도 보내지 않는다. Pacifica 입금은 `--no-relay`(직접 입금, SOL 0.005 필요)로만 실행한다.

종료 코드: 0 pass / dry-run, 1 fail·stopped, 2 사용법·게이트 거부, 3 kill switch, 4 preflight-fail.

---

## 1. 단계 (Phases)

### P0 — 단위 테스트 green
```bash
pnpm test            # vitest (integration 제외)
npx tsc --noEmit -p .
pnpm build
pnpm e2e:typecheck
```
통과 기준: 실패 0. → §11 #12 해소. (현재 `src/__tests__/**`는 다른 작업에서 갱신 중 — 그 작업 완료 후 판정.)

### P1 — testnet (venue별)
1. `--dry-run`으로 preflight 통과 확인 (§7 결과표).
2. 사전 준비(§2) 완료: 테스트 자금, 에이전트/API 키, 접근 화이트리스트.
3. `--phase preflight` → `trade` → `spot` → `deposit`/`withdraw`(가능 venue) 순으로 실행, 각 보고서 검토.
4. 각 venue 보고서의 **Design items** 표에서 해당 항목이 `exercised`인지 확인하고 observations를 판정해 설계 문서 §11에 기록.

### P2 — mainnet 최소 금액 (사용자 수동)
- testnet 동일 venue가 **pass**인 경우에만 진행. 상한 `$20/venue`(placeholder: `E2E_MAX_USD_<VENUE>` — 운영 메모에 venue별 값 기록).
- 순서: `preflight` → `deposit`(필요 시) → `trade` → `spot` → `withdraw`.
- 크기 = venue 최소 notional × (1 + `--margin-pct`). 상한을 넘는 **단계는 실패가 아니라 SKIP**(이유가 보고서에 기록) — 예: 최소 $10인 venue에서 `reduce 50%`는 $5.5라 venue가 거절할 수 있음(정상 관측).

### P3 — 교차 venue (dry-run → 소액 live)
| 단계 | 명령 | 기대 / 확인 | 항목 |
|---|---|---|---|
| 스캔(공개) | `perp -n <net> --json arb scan --mode spot-perp` | ok, Ondo 스팟 무인증 조회 가능 여부, Lighter RH 초기화 시간 | S15 |
| WASM 분리 | `perp -n <net> --json account positions` (`-e` 없음, lighter+lighter-rh 키 모두 등록) | 두 venue 모두 결과, `errors` 없음 | #3 |
| perp-perp 진입 dry | `perp --json arb exec <SYM> <long> <short> <usd> --dry-run` | 사이징·depth 검증 결과, 전송 없음 | — |
| perp-perp 진입 live | `perp --json arb exec <SYM> hl lighter 12` (상한 내) | 순차 레그, 두 번째 레그 = 첫 레그 검증 체결량, `ok:true`; 불명 → `ORDER_PENDING` + 격리 | — |
| 청산 | `perp --json arb close <SYM> --dry-run` → live | reduce-only 검증 청산, 양쪽 flat | — |
| spot-perp | `perp --json arb exec <SYM> spot:hl hl <usd> --dry-run` → live | 스팟 체결량만큼만 헤지, 불명 → 격리 | — |
| 봇 | `perp strategy funding-arb ...`(모니터) / `perp strategy run <s> --param ...` **dry-run 먼저** | dry-run에서 의도한 주문만 로그 → 그 다음 소액 live | — |
| 격리 확인 | `perp --json strategy quarantine` | 비어 있어야 함 | — |

**봇은 dry-run 결과를 검토하기 전에는 절대 live로 돌리지 않는다.**

---

## 2. venue별 사전 준비

| venue | testnet / sandbox | 테스트 자금 | 접근 게이트 | 가스 |
|---|---|---|---|---|
| hyperliquid | ✅ `api.hyperliquid-testnet.xyz` | app.hyperliquid-testnet.xyz/drip (1,000 mock USDC, 같은 주소의 mainnet 입금 이력 필요) | `perp -n testnet wallet agent approve hyperliquid` | mainnet 입금: Arbitrum ETH (또는 relayer) |
| hyperliquid HIP-3 레그 (`xyz`) | ✅ testnet에 `xyz` dex 존재(70 마켓) | HL 계정 공용 — **standard 계정은 dex 담보가 분리**: dex로 USDC 이동(HL 앱; CLI 경로 없음) 또는 unified 모드. 담보 0이면 `hip3-pf-dex-collateral` preflight-fail | HL 에이전트 공용 | — |
| pacifica | ✅ `test-api.pacifica.fi` | `perp -n testnet funds faucet pacifica <amount>` (devnet `mint_test_usdc`, master 서명, 시뮬레이션 후 전송; devnet SOL 필요) 또는 testnet 앱 faucet | `wallet agent approve pacifica` | mainnet: SOL (또는 relayer) |
| lighter | ✅ `testnet.zklighter.elliot.ai` (마켓 3개) | testnet 앱 faucet | `wallet agent approve lighter` (ChangePubKey, slot 4–254) | mainnet: CCTP 원 체인 가스 |
| lighter-rh | ✅ `api.rh-testnet.lighter.xyz` | **공개 faucet 없음** — RH 팀/앱으로 테스트 USDC 확보 (testnet 담보 asset 3 = USDC, mainnet 은 USDG — `assetDetails` 라이브 확인) | `wallet agent approve lighter-rh --api-key-index <4–254, 157 제외>` (0,1,2,3,157 예약) · standard 계정 60 req/min | mainnet 입금: `funds deposit lighter-rh` (RH ETH 가스) · testnet 입금 CLI 없음(`CAPABILITY_UNSUPPORTED`) |
| aster | ✅ `fapi.asterdex-testnet.com` (venue 정의 기본값, env 불필요 — §8 #1 수정됨) | testnet UI faucet (CLI 입금 없음) | `wallet agent approve aster --can-spot` (스팟은 canSpotTrade 필요; testnet = `registerAndApproveAgent`, revoke/rotate 는 testnet 미지원) | mainnet: BNB Chain |
| ondo | ✅ sandbox `api.ondoperps-sandbox.xyz` | `POST /v1/sandbox_deposit` (러너 deposit 단계가 sandbox에서만 호출) | **UI에서 API 키 생성**(scope: trade, transfer) → `printf '%s\n%s\n' "$KEY_ID" "$SECRET" \| perp -n testnet wallet agent approve ondo` · 지역 제한(US/PA) | — |
| arcus | ✅ `api.testnet.arcus.xyz` (RH testnet chain 46630) | 앱의 ~$1k 테스트 자금 버튼 + USDG mint · **RH testnet ETH는 공개 faucet 없음**(Arcus/RH에 요청) | **master 주소 화이트리스트 선행**(없으면 계정/주문 조회 403, §11 #8) · `wallet agent approve arcus --master <ows> --account-index 0` | approve/출금/스팟 Permit2: RH ETH |

### 2a. 사전 준비 — import 경로 (master 지갑이 이 컴퓨터에 없을 때)

접근 게이트 열의 `wallet agent approve` 대신, **거래소 웹사이트에서 만든 agent / API 키를 import** 해도 된다(mainnet·testnet 동일, `-n` 으로 네트워크 선택). 키는 숨김 프롬프트 또는 stdin 으로만 받고(argv 거부), 저장 **전에** venue 에서 확인한다 — 확인 실패면 아무것도 저장하지 않는다.

| venue | 웹에서 만드는 것 | import 명령 | 확인 방법 |
|---|---|---|---|
| hyperliquid | More → API 의 API wallet (개인키) | `perp [-n testnet] wallet agent import hyperliquid` | info `userRole` = 해당 master 의 agent, `extraAgents` 로 만료 |
| aster | Pro API → API wallet (signer 개인키) | `... import aster --master-address <user 0x>` | agent 서명 `GET /fapi/v3/balance` 수락 — **testnet 도 지원**(testnet approve 는 `registerAndApproveAgent`, revoke/rotate 미지원) |
| pacifica | agent wallet (개인키) | `... import pacifica --master-address <Solana 계정>` | **확인 불가 → `unverified` 로 표시**(바인딩 목록은 master 서명 `/agent/list` 뿐). 첫 주문 실패로 드러남 |
| lighter / lighter-rh | API key (개인키 + account index + key index) | `... import lighter --account-index <n> --api-key-index <slot>` | 계정 존재 · 슬롯에 키 존재 · import 키로 서명한 auth token 을 `GET /api/v1/accountActiveOrders` 가 수락 |
| arcus | API key (Ed25519 개인키; 웹 /api-keys) | `... import arcus --master-address <owner 0x>` | `GET /v1/apiKeys?address=` 에 공개키 ACTIVE |
| ondo | API key id + secret | `printf '%s\n%s\n' "$ID" "$SECRET" \| perp [-n testnet] wallet agent import ondo` | 인증 `GET /v1/account` |

- 비대화식: `printf '%s\n' "$KEY1" "$KEY2" | perp --json setup --non-interactive --venues a,b --import-agents a,b --yes [--master-address a=<addr>] [--lighter-account-index N --lighter-api-key-index S]` — `--import-agents` 순서대로 venue 당 한 줄(ondo 2줄). 모든 venue 가 import 면 `--wallet` 불필요.
- master 없이 할 수 없는 것: 입금 · 출금 · `funds transfer` · `funds bridge` · `wallet manage referral set` · `wallet agent approve` → `NO_SIGNER_AVAILABLE`(웹사이트에서 하거나 `perp wallet import` 로 master 추가). 러너는 이때 입금/출금 단계를 **"manual (master not on this machine)"** 로 기록하고 실패로 보지 않는다.
- 러너 프리플라이트는 `wallet agent list <venue>` 로 해당 네트워크 agent 의 `source`(approved/imported)를 기록. import 된 pacifica 는 `wallet agent verify` 가 `NO_SIGNER_AVAILABLE`(master 필요) — 수용.
- import 키 폐기: 웹사이트에서 폐기 후 `wallet agent revoke <venue> <name> --local-only`(로컬 키·기록만 삭제). 교체: 웹에서 새 키 → `wallet agent import <venue> --agent-name <name> --replace`.

---

## 3. 안전 규칙

1. **크기**: venue 최소 notional(+`--margin-pct`, 기본 10%) 및 lot step 올림. 러너가 공개 마켓 데이터로 계산하며, 1단위 notional이 `--max-usd`를 넘으면 시작 거부.
2. **상한(런 전체)**: mainnet `$20/venue`(사용자 결정). 노출을 늘릴 수 있는 쓰기 단계마다 러너가 먼저 `account positions` + `account orders`를 읽어 **현재 열린 노출**(포지션 |size|×mark + 미체결 주문 잔량×price, reduce-only 포함 — 보수적)을 계산하고, `현재 노출 + 그 단계의 최악 노출 > --max-usd`이면 그 단계만 SKIP한다(이전: 주문 1건 기준만 비교). spot 단계에서는 첫 spot 쓰기 전 `trade spot-balance`로 기준 보유량을 기록하고, 이후 **이번 런에서 늘어난 spot 보유량 × 공개 `market mid`**도 열린 노출에 더한다(기준/잔고/mid를 읽지 못하면 중단). 노출을 읽거나 값을 매길 수 없으면(가격 0 등) 추정하지 않고 **중단**. 포지션은 동시에 최대 1단위만 열리도록 순서를 짰다(지정가 테스트는 flat 상태에서, TP/SL·stop은 reduce-only).
   - mainnet에서 `--spot-ref-price`를 주면 공개 가격(공개 마켓 데이터의 mark)과 **±5% 이내**여야 하며, 벗어나거나 공개 가격이 없으면 preflight에서 거부한다.
2a. **쓰기 실패 = 확정 거부일 때만 계속**: 결과를 관찰만 하는(`observe`) 쓰기 단계가 에러를 받으면, 그 코드가 "보내지 않았음/venue가 거부"를 증명하는 코드(`ORDER_REJECTED`, `INVALID_PARAMS`, `CAPABILITY_UNSUPPORTED`, `SIZE_TOO_SMALL`, `INSUFFICIENT_BALANCE`, `MARGIN_INSUFFICIENT`, `RISK_VIOLATION`, `INVALID_TICK`, `TIF_REQUIRED`, `*_NOT_FOUND`, `NOT_IMPLEMENTED`)일 때만 계속한다. `EXCHANGE_ERROR` / `EXCHANGE_UNREACHABLE` / `TIMEOUT` / `RATE_LIMITED` / `UNKNOWN` / `ORDER_PARTIAL` 등은 **결과 불명**으로 보고 즉시 중단(재전송 금지, 아래 3번 확인 절차). 기대 코드 목록이 명시된 단계는 그 목록만 허용.
3. **ORDER_PENDING / finality "pending" / 쓰기 타임아웃** → 러너가 **즉시 중단**. **재전송 금지.** 확인 순서:
   ```bash
   perp -n <net> -e <venue> --json trade status <orderId> --symbol <SYM>
   perp -n <net> -e <venue> --json account positions
   perp -n <net> -e <venue> --json account orders
   ```
   체결 여부를 확인한 뒤에만 수동으로 정리(`trade close <SYM>` 등).
4. **ORDER_PARTIAL**(진입은 됐는데 TP/SL 실패): 재진입 금지, `perp trade tpsl <SYM> <long|short> --tp .. --sl ..`로 보호 후 판단.
5. **격리(quarantine)**: `perp --json strategy quarantine` → 항목이 있으면 해당 심볼은 봇/arb 전부 차단. venue에서 포지션/주문을 손으로 확인·정리 후에만 `perp strategy quarantine-clear <SYM> [--strategy <source>]`.
6. **flatten**은 venue 계정 전체를 닫으므로, 시작 시 계정 전체가 flat일 때만 러너가 실행.
7. **Kill switch**: `touch ~/.perp/e2e-kill` → 러너는 시작 거부 / 다음 단계 전에 중단. `Ctrl-C` 1회 = 현재 단계 후 중단, 2회 = 즉시 종료. 봇은 `perp jobs`로 확인 후 중지.
8. **정리 체크리스트**(중단·실패 시 보고서 `Cleanup` 절에 venue별 명령이 들어 있음):
   - [ ] `account orders` 비어 있음 (없으면 `trade cancel-all`)
   - [ ] 테스트 심볼 포지션 0 (없으면 `trade close <SYM>` — reduce-only)
   - [ ] 스팟 잔여 base 매도 / `spot-transfer to-perp`
   - [ ] `strategy quarantine` 비어 있음
   - [ ] 레버리지/마진 모드 원복이 필요하면 `trade leverage`
   - [ ] 보고서의 equity reconciliation(시작 대비 delta = 수수료 + 슬리피지 + 펀딩 ± 입출금)

---

## 4. 거래 단계 (모든 venue 공통, `--phase trade`)

`G = perp -n <net> -e <venue> [--dex xyz] --json`. 가격·수량은 러너가 마켓 데이터로 계산(보고서 `Sizing`).
모든 단계: 종료 코드와 envelope `ok`가 일치해야 함(`ok:true` ⇔ exit 0).

| id | 명령 | 기대 결과 | 확인 | 항목 |
|---|---|---|---|---|
| pf-* | `wallet agent verify <v>`, `portfolio`, `account positions/orders`, `strategy quarantine` | ok, 심볼 flat, 격리 없음 | 실패 시 사전 준비 | #2 #4 #8 |
| t-leverage | `G trade leverage <S> 2 [--isolated]` | ok | ondo는 cross만 | — |
| t-limit-gtc | `G trade limit <S> buy <mark−5%> <n> --tif GTC` | `status` open/accepted, `execution.tifSent` 기록 | `account orders`에 존재 | — |
| t-status-after-place | `G trade status <id> --symbol <S>` (async venue는 1s×10 폴링) | 조회 성공까지 ms 기록 | arcus 404 지속 시간 | #9 |
| t-edit | `G trade edit <S> <id> <mark−6%> <n+1lot>` | ok, `execution.method`(nativeAmend/cancelReplace), **tifSent 유지**(pacifica는 ALO 재생성 — 관측) | 새 가격/수량이 orders에 반영, 새 orderId 기록 | #5 #9 #14 #15 #16 |
| t-cancel | `G trade cancel <S> <id>` | `cancelled`에 ref 포함 | orders에서 사라짐 | #14 #20 |
| t-limit-alo / t-cancel-alo | `--tif ALO` 원거리 → cancel | open → cancelled. **lighter(+rh)는 `CAPABILITY_UNSUPPORTED`** | — | #13 #15 |
| t-alo-cross | `--tif ALO` 매도호가 +0.2% (교차) | 거절(`ORDER_REJECTED` 또는 status rejected/cancelled), **체결·resting 모두 실패로 판정** | 포지션 불변 | #14 #15 |
| t-ioc-nomatch | `G trade limit <S> sell <mark+5%> <n> --tif IOC` | 체결 0, 확정 결과(`ORDER_REJECTED` 등, pending 아님) | HL "could not immediately match" 문구 | #17 #20 |
| t-entry-tpsl | `G trade market <S> buy <n> --tp <+5%> --sl <−5%> --slippage-bps 100` | ok, `verifiedFilledSize`, `tpsl.method` = venue 방식, separateOrders는 legs `tp`+`sl` | 포지션 = 검증 체결량, 레그가 orders에 보임 | #9 #15 #18 |
| t-tpsl-crossed | `G trade tpsl <S> long --tp <mark−5%>` | 전송 전 `INVALID_PARAMS` | — | #18(부분) |
| t-cancel-all-1 / t-close-1 | `trade cancel-all` → `trade close <S>` | orders 0(positionLevel 제외) / flat | — | #5 #21 |
| t-market-buy | `G trade market <S> buy <n> --slippage-bps 100` | `filled`/`partiallyFilled`, `finality:"final"`, `filledSize` | **포지션 delta = filledSize (±½ lot)**, 소요 ms | #16 #17 |
| t-cancel-filled | `G trade cancel <S> <체결된 orderId>` | `cancelled` 비어 있음(거짓 취소 증명 금지) | 관측 | #17 #21 |
| t-cancel-unknown | `G trade cancel <S> 999999999` | 취소로 보고되지 않음 | 관측 | #21 |
| t-stop | `G trade stop <S> sell <n> <mark−5%>` | ok(기본 reduce-only) | orders에 보임 — **ondo는 필수**(untriggered) | #6 #19 |
| t-edit-stop (lighter 계열) | `G trade edit <S> <stopId> ...` | `CAPABILITY_UNSUPPORTED` | — | #19 |
| t-cancel-stop | pacifica `trade cancel-stop <S> <id>`, 그 외 `trade cancel <S> <id>` | ok | orders에서 사라짐 | #19 #21 |
| t-tpsl | `G trade tpsl <S> long --tp <+5%> --sl <−5%>` | ok, `method`, legs | pacifica `side` 의미(venueRaw) | #9 #14 #15 #18 |
| t-tpsl-overwrite (pacifica) | 다른 가격으로 재실행 | 관측(덮어쓰기/거절) | — | #14 |
| t-cancel-all-2 | `trade cancel-all` | ok | — | #21 |
| t-reduce | `G trade reduce <S> 50` | ok면 포지션 감소 = `sizeReduced`; 최소 notional 미달 거절도 허용(포지션 불변) | — | #5 |
| t-close-2 | `G trade close <S>` | ok | flat | #5 |
| t-market-buy-2 → t-limit-sell-far → t-flatten | 시작 시 계정 전체 flat일 때만 | flatten ok | 포지션·주문 0 | — |
| t-final / z-reconcile | `account positions/orders`, `portfolio` | 깨끗함, equity delta 기록 | 수수료/펀딩 대조 | — |

---

## 5. venue별 입금 · 스팟 · 출금

### 입금 (`--phase deposit --deposit-amount N`)
| venue | mainnet | testnet |
|---|---|---|
| hyperliquid | `perp -e hyperliquid funds deposit hyperliquid <N>` (Arbitrum, 최소 5) | **SKIPPED**(testnet Bridge2 입금 없음) — 자금: faucet(drip) |
| hyperliquid HIP-3 레그 | 해당 없음(HL 계정 공용) | 해당 없음 |
| pacifica | `perp -e pacifica funds deposit pacifica <N>` (최소 10, relayer) | **SKIPPED**(CLI 입금은 mainnet 프로그램) — 자금: testnet faucet |
| lighter | `perp -e lighter funds deposit lighter cctp arbitrum <N>` (최소 5) | **SKIPPED**(testnet CLI 입금 경로 없음) — 자금: faucet |
| lighter-rh | `perp -e lighter-rh funds deposit lighter-rh <N>` (RH 체인 USDG approve + deposit, 최소 1, master OWS 지갑 서명, RH ETH 가스) | **SKIPPED**(`funds deposit lighter-rh`는 testnet `CAPABILITY_UNSUPPORTED`) — 자금: 앱 faucet |
| aster | **수동**: UI(BNB Chain USDT) | 수동: UI faucet |
| ondo | **수동**: UI 펀딩 주소(`/v1/wallet/deposit_address/list`) | 러너가 `POST /v1/sandbox_deposit` (확인 후) |
| arcus | **수동**: deposit proxy(USDG, RH ETH 가스) | **SKIPPED** — 자금: ~$1k 버튼 / USDG mint |

러너: CLI 경로는 명령 출력 → y/N(테스트넷은 `--yes-testnet`) → 실행 → `portfolio` equity 증가까지 폴링(기본 900s). 수동 경로는 안내 출력 후 같은 폴링. testnet에서 CLI 입금이 없는 venue(위 **SKIPPED**, aster 포함)는 `d-route`를 **skipped + 사유**로 기록하고 실패로 보지 않는다(이전: 수동 안내 후 900s 폴링 → fail). 출금은 testnet에서도 CLI 경로가 있는 venue(hyperliquid · pacifica · lighter · lighter-rh · arcus)에서 실행하고, aster(출금 미지원)는 `w-route` skipped.

### 스팟 (`--phase spot [--spot-symbol S --spot-size N]`)

`s-pick`: 두 옵션이 없으면 공개 데이터로 자동 선택(§0 옵션 표) — 선택 마켓·크기·notional·24h 거래대금과 제외 사유(최대 20개)가 보고서에 기록된다. 예(testnet 2026-10-02): HL `PURR` 3(≈$13.9; 거래대금 1위 `PUCKY`는 mid가 mark에서 5% 벗어나 제외), lighter / lighter-rh `ETH` 0.0050, pacifica `SOL` 0.090.
| id | 명령 | 기대 | 항목 |
|---|---|---|---|
| s-balance-0 | `G trade spot-balance` | 관측 (aster: 에이전트 스팟 권한 필요 여부) | S1 S10 |
| s-transfer-in | `G trade spot-transfer to-spot <q>` | separate/runtime: ok · unified(pacifica, HL unified): `execution.method:"sharedAccount"` · wallet(arcus): `CAPABILITY_UNSUPPORTED` | S3 S16 |
| s-buy | `G trade spot-buy <S> <N> --slippage-bps 100 [--yes]` | `order.status` filled/partial, **`finality:"final"`**(pending → 중단, 재전송 금지) | S4 S9 S11 S13 S14 S20 S21 S22 |
| s-balance-1 | `G trade spot-balance` | base 증가 ≈ filledSize(수수료 차감 자산 관측) | S2 S18 S19 S21 |
| s-limit / s-orders / s-cancel | `spot-limit <S> buy <원거리> <N> --tif GTC` → `spot-orders <S>` → `spot-cancel <S> <id>` | open → 목록에 존재 → 취소. arcus: limit/orders `CAPABILITY_UNSUPPORTED` | S5 S7 S8 S17 #15 |
| s-limit-alo | `--tif ALO` | 관측(지원 여부) | S7 |
| s-sell | `G trade spot-sell <S> <min(available, filled)>` | final | S4 S13 S18 S20 |
| s-transfer-out | `G trade spot-transfer to-perp <q>` | ok (separate/runtime) | S3 S16 |

추천 스팟 심볼(최소 수량은 venue UI 확인): HL mainnet `HYPE` / testnet `PURR`, pacifica `SOL`(perp 마진 감소 경고), lighter `ETH`, aster `ASTER`(USDT), ondo `TSLA`, arcus `TSLA`(USDG 스왑, 시장가만).
**Aster S10/S12 수동 단계**: `--can-spot` 없이 등록된 에이전트로 `perp -e aster --json trade spot-balance`와 `trade spot-buy`(예상 `POLICY_DENIED`, remediation `wallet agent rotate aster --can-spot`) 실행 후 → `perp wallet agent rotate aster --can-spot` → 러너 스팟 단계.

### 출금 (`--phase withdraw --withdraw-amount N`, 소액, 온체인 도착 확인)
| venue | 경로 | 비고 |
|---|---|---|
| hyperliquid | `perp -e hyperliquid funds withdraw hyperliquid <N>` | Arbitrum 자기 주소, 수수료 $1 |
| pacifica | `perp -e pacifica funds withdraw pacifica <N>` | 소유자 Solana 지갑 |
| lighter | `perp -e lighter funds withdraw lighter <N>` | standard ~12h |
| lighter-rh | `perp -e lighter-rh funds withdraw lighter <N>` | `-e lighter-rh`로 RH 어댑터, asset 3 = USDG → Robinhood Chain (도움말은 venue 정의에서 파생) · #2 |
| aster | **UI** | `perp funds withdraw aster` → 통일 `CAPABILITY_UNSUPPORTED` (`withdrawAssets: null`; API 출금은 canWithdraw+IP 화이트리스트 API 지갑 + 별도 master EIP-712 서명 필요 — 미구현) |
| ondo | **수동 CLI**: `perp -e ondo funds withdraw ondo <N> --to <주소록 주소>` (`--dry-run` 먼저) | 목적지가 Ondo 주소록에 있어야 하므로 러너는 안내만 · #7 |
| arcus | `perp -e arcus funds withdraw arcus <N>` | 계정 owner로만(최소 1 USDG), agent 키 + master 지갑 서명 · #10 |

러너: 명령 출력 → 확인 → 실행 → equity 감소 폴링. 도착은 수신 지갑/익스플로러에서 사람이 확인하고 tx를 보고서에 메모.
master 지갑이 이 컴퓨터에 없으면(import 한 키만 있음) CLI 입금/출금 명령은 키를 읽거나 서명하기 전에 `NO_SIGNER_AVAILABLE` 로 거부하고, 러너는 해당 단계를 `d-manual` / `w-manual` "manual (master not on this machine)" 로 기록한다(§2a).

---

## 6. 설계 확인 항목 매핑 (§11 · §12.3)

| 항목 | 확인 단계 (러너 step id) | 비고 |
|---|---|---|
| #1 lighter-rh funding 8h | `pf-rh-funding`(공개, RH vs lighter 금리 기록) | 사람이 premium 대비 판정 |
| #2 lighter-rh L2 서명·ChangePubKey·출금·60 req/min | `pf-agent-verify`, trade 전 단계, `w-withdraw` | RATE_LIMITED 발생 여부 보고서 확인 |
| #3 WASM 분리 | `pf-wasm-isolation`(lighter/lighter-rh live preflight), P3 | |
| #4 ondo HMAC | `pf-agent-verify`, `pf-portfolio`, 모든 ondo 쓰기, sandbox deposit | |
| #5 ondo DELETE 동기 canceled · reduce-only IOC | `t-edit`(cancelReplace), `t-close-*`, `t-reduce` | |
| #6 ondo stop untriggered 조회 | `t-stop` + `t-stop-visible`(ondo는 필수) | |
| #7 ondo 출금 wallet·WS login | 출금: 수동 CLI `funds withdraw ondo --to` (러너는 안내만) · WS login은 CLI 미사용 → 미커버 | |
| #8 arcus 화이트리스트 | `pf-agent-verify`, `pf-portfolio`(403) | |
| #9 arcus entryTpsl·modify·404 | `t-entry-tpsl`, `t-edit`, `t-status-after-place`, `t-tpsl` | |
| #10 arcus 출금 uint256·scheduleCancel | 출금: 러너 withdraw 단계 `funds withdraw arcus` · scheduleCancel 미구현 → 미커버 | |
| #11 HIP-3 funding 1h | `hip3-pf-funding` (공개 fundingHistory 간격) | dry-run 결과: testnet·mainnet 모두 **중앙값 1.00h** → 1h 가정 유지 |
| #12 단위 테스트 | P0 | |
| #13 lighter post-only `2` | **미커버** — ALO 비활성(`t-limit-alo`가 `CAPABILITY_UNSUPPORTED` 확인만) | SDK 직접 probe 필요 |
| #14 pacifica edit·client_order_id·history·tpsl side/덮어쓰기 | `t-edit`, `t-cancel`, `t-alo-cross`, `t-tpsl`, `t-tpsl-overwrite` | + 미결 "포지션 TP/SL side" |
| #15 HL tif·스팟 coin·TP/SL 레그 | `t-edit`(tif 유지), `t-limit-alo`, `t-entry-tpsl`, `t-tpsl`, `s-orders` | |
| #16 pacifica history 정렬 | `t-market-buy`, `t-edit` (간접 — 결과가 맞으면 전제 성립) | |
| #17 lighter /tx 전이 시간·체결 주문 취소 | `t-market-buy`(ms), `t-ioc-nomatch`, `t-cancel-filled` | |
| #18 교차 트리거 거절 → ORDER_PARTIAL | `t-tpsl-crossed`(CLI 사전 거절만) | venue 거절 경로는 CLI로 도달 불가 |
| #19 lighter 트리거 정정 거절 | `t-stop`, `t-edit-stop`, `t-cancel-stop` | |
| #20 HL IOC no-match·취소 success | `t-ioc-nomatch`, `t-cancel` | |
| #21 lighter 취소 EXECUTED 의미 | `t-cancel-filled`, `t-cancel-unknown`, `t-cancel-all-*` | |
| S1–S5, S7, S8 ondo 스팟 | `s-balance-*`, `s-transfer-*`, `s-buy`, `s-sell`, `s-cancel`, `s-limit(-alo)` | |
| S6 ondo 오더북 depth | **부분** — 스팟 오더북 명령 없음, `s-buy`에서 간접 | |
| S9, S11, S13, S18 aster 스팟 | `s-buy`, `s-limit`, `s-sell`, `s-balance-1` | |
| S10, S12 aster 권한 | **수동**(§5 Aster 단계) | 러너는 `--can-spot` 에이전트 전제 |
| S14 arcus per-call slippage | `s-buy`(`execution.slippageSource:"flag"`) | |
| S15 spot-perp 스캔 | P3 `arb scan --mode spot-perp` | |
| S16 HL unified 이체 | `s-transfer-in/out` | |
| S17, S21, S22 lighter 스팟 | `s-orders`, `s-buy`(fillSource), `s-balance-1` | |
| S19 pacifica equity 이중 계상 | `s-balance-1`, `s-pacifica-equity` | |
| S20 arcus TakerIntent | `s-buy`/`s-sell` (불일치면 서명 거부) | |

미결 질문(§11 하단) 중 **정정 size 의미(부분 체결 후 정정)**, **Arcus 진입 TP/SL 레그 크기(부분 체결 진입)**, **HL 부분 체결 GTC 보고**는 부분 체결을 결정적으로 만들 수 없어 러너가 다루지 않는다 — 발생 시 보고서 observations로 판정.

---

## 7. dry-run 결과 (2026-10-02, `--phase all --dry-run`, 공개 엔드포인트)

| venue | testnet | mainnet | 선택 심볼 · 1단위 notional | 비고 |
|---|---|---|---|---|
| hyperliquid | ✅ | ✅ | BTC 0.00013 ≈ $11.0 | HL 최소 $10(문서) |
| hyperliquid HIP-3 레그 (xyz) | ✅ | ✅ | TSLA 0.031 ≈ $11.0 | funding 간격 1.00h (#11) |
| pacifica | ✅ | ✅ | BTC 0.00013 ≈ $11.0 | |
| lighter | ✅ | ✅ | testnet SOL 0.094 ≈ $11.1 / mainnet BTC ≈ $11.0 | CLI `market list` 키 없이 236 마켓 (§8 #2 수정됨) |
| lighter-rh | ✅ | ✅ | TSLA 0.0310 ≈ $11.0 | CLI `market list` 57 마켓, `market info TSLA/ETH` ok (§8 #2 수정됨) |
| aster | ✅ (재실행 2026-10-02: env 없이 preflight 통과, CLI `market list` 17 마켓) | ✅ | SOL 0.05 ≈ $5.9 (PERCENT_PRICE로 far 2.4%) | 기본 호스트 `fapi.asterdex-testnet.com` (§8 #1 수정됨) |
| ondo | ✅ (sandbox) | ✅ | ETH 0.005 ≈ $13.5 | 최소 notional 미공개 → $10 **가정**; CLI `market list` 키 없이 81 마켓 (§8 #3 수정됨) |
| arcus | ✅ | ✅ | SOL ≈ $5.5 (최소 $5) | |

모든 venue에서 mainnet 상한 $20 내 1단위 거래 가능. 출금 CLI: ondo/arcus 추가, aster는 통일 `CAPABILITY_UNSUPPORTED`. 입금 CLI: lighter-rh(mainnet) 추가; aster/ondo/arcus 없음(+ 모든 testnet은 faucet).

---

## 7a. 리뷰 수정 검증 항목 (2026-10-02)

- [ ] **Lighter 슬롯 점유 (N1)**: `perp -n testnet --json wallet agent verify lighter --account-index <n>`로 온체인 키 목록 확인 → 점유된 슬롯에 `wallet agent approve lighter --api-key-index <점유 슬롯>` → `INVALID_PARAMS`(서명 없음), 인덱스 생략 시 비어 있는 슬롯 선택 확인.
- [ ] **Lighter revoke 확정 (L1)**: revoke 후 `verify`에서 해당 슬롯 public key가 바뀌었는지, 로컬 keystore 파일이 삭제됐는지 확인.
- [ ] **arb state 마이그레이션 (N2)**: 실제 `~/.perp/arb-state.json`(mainnet PURR spot-perp)에서 첫 `perp --json arb status`(mainnet) 실행 후 `arb-state.json.pre-network.bak` 생성, 원본에 `"network": "mainnet"` 추가, 포지션 동일 확인. 이전에는 `perp -n testnet arb …`가 `INVALID_PARAMS`(untagged)로 거부되는지 확인.
- [ ] **MCP 네트워크 (N4)**: `PERP_NETWORK=testnet perp-mcp`의 모든 결과 `meta.network = "testnet"`, 잘못된 값(`PERP_NETWORK=Testnet`)이면 서버 기동 거부.
- [ ] **Aster DelAgent 구조체 — mainnet 검증 (OPEN)**: 공개 Aster V3 문서(asterdex/api-docs futures v3 + testnet, 2026-10-02 확인)에 에이전트 삭제 엔드포인트/`DelAgent` 구조체가 없다. `buildDelAgentTypedData`(AgentAddress, AsterChain, User, Nonce; Domain A chainId 56)는 추정. mainnet에서 소액 계정으로 `perp wallet agent approve aster` → `perp wallet agent revoke aster <name>` 실행, 응답이 확정 성공이고 Aster UI(API wallet)에서 에이전트가 사라졌는지 확인. 실패 시 `APPROVE_FAILED`(로컬 기록 유지)가 정상 — 구조체 수정 필요. testnet에서는 revoke/rotate 가 `CAPABILITY_UNSUPPORTED`(Domain A 경로 도달 불가, `aster-master-domain-testnet.test.ts`); testnet approve 는 아래 `registerAndApproveAgent` 항목.

### 7b. venue 스펙 정렬 검증 항목 (2026-10-02, testnet — 리드 실행)

- [ ] **Pacifica agent verify (P1)**: `perp -n testnet --json wallet agent approve pacifica --master <ows>` → `perp -n testnet --json wallet agent verify pacifica <name> --master <ows>`가 `ok:true`, `registered:true`. 요청은 `POST /agent/list`, 서명 메시지 `{"data":{},"expiry_window":5000,"timestamp":…,"type":"list_agent_wallets"}`, 본문에 `type` 없음. 이전 오류 "signature does not match signer and canonical payload"가 사라졌는지. **응답 형태 기록**: `data`가 배열(문자열 또는 `{agent_wallet}` 객체)인지 `{agent_wallets:[]}`인지 — 다른 형태면 `EXCHANGE_ERROR`("unrecognized shape")로 드러남 → `parsePacAgentList` 수정.
- [ ] **Pacifica 출금 상한 (P2)**: `perp -n testnet --json account balance -e pacifica`에 `availableToWithdraw`, `usdcBalance`, `borrowedUsdc`, `pendingInterest` 표시. `funds withdraw pacifica <availableToWithdraw + 1>` → `INSUFFICIENT_BALANCE`, 아무것도 서명/전송 안 됨.
- [ ] **Pacifica testnet faucet (P3)**: `perp -n testnet --dry-run --json funds faucet pacifica 1000`(계획만) → `perp -n testnet --json funds faucet pacifica 1000` 서명 반환, devnet USDP 잔고 +1000. mainnet(`perp funds faucet pacifica 1`)은 `CAPABILITY_UNSUPPORTED`. 시뮬레이션이 central_state writable 을 요구하는 오류를 내면 `src/pacifica/faucet.ts`의 플래그 수정.
- [ ] **Aster testnet approve — `registerAndApproveAgent` (A1)**: `perp -n testnet --json wallet agent approve aster --master <ows> --can-spot` → `POST /fapi/v3/registerAndApproveAgent`(쿼리 파라미터, 서명 `Message{msg}` chainId 56) 성공, 이후 `perp -n testnet -e aster --json account balance`가 agent 서명으로 동작. 서명 거부(-1022 등)면 msg 인코딩(raw `k=v&…`, ipWhitelist 공백 구분) 또는 전송 방식(쿼리 vs 폼 본문) 재확인. `--can-withdraw`는 `--ip-whitelist` 없이 `INVALID_PARAMS`.
- [ ] **Aster nonce (A5)**: 두 터미널에서 같은 agent 로 연속 주문/조회 시 nonce 중복 거부(-1021/-1022류) 없음, `~/.perp/aster-nonces.json`이 signer 별로 단조 증가.
- [ ] **Ondo spot↔perp 이체 지갑 키 (O1)**: sandbox 에서 `trade spot-transfer to-spot 1 -e ondo` / `to-perp 1` 이 `wallet: "main"` ↔ `"margin"` 로 성공(이전 `"spot"`).
- [ ] **Ondo approve 스코프 (O5/O6)**: `wallet agent approve ondo` 후 `wallet agent list ondo`의 `scopes`가 웹 UI 키 스코프와 일치(`GET /v1/api_keys`가 API-key 인증으로 응답하는지 — 401/403 이면 approve 가 실패하므로 기록). `funds withdraw ondo` 결과에 `withdrawalFeeUSD`.
- [ ] **Arcus modify 총수량 (A1x)**: testnet 에서 지정가 1.0 주문 → 일부 체결(예: 0.3) 후 `trade amend <id> --size 0.5` → 주문 상세 `originalSize` 0.8 / `remainingSize` 0.5. `--size 0` → 취소. 체결량 이하로 줄어드는 경쟁 시 `MODIFY_SIZE_ALREADY_FILLED` → 결과 `cancelled`.
- [ ] **Arcus modify 서명 identity (A2x, UNVERIFIED)**: clientId 로 낸 주문을 `trade amend` — 기본값 `ARCUS_MODIFY_SIGNED_IDENTITY = "idOnly"`(서명에 `id`만)로 수락되는지. 서명 거부(401/invalid order signature)면 `"idAndClientId"`(인증 페이지 변형: `id` + `c`)로 바꿔 재시도하고 결과를 `src/exchanges/arcus/signing.ts` 주석에 기록.
- [ ] **Arcus nonce / 출금 (A3x/A4x)**: `wallet agent approve arcus` / revoke / `funds withdraw arcus 1` 의 `nonce`가 Unix-ns 문자열로 수락. `funds withdraw arcus 1.0000001` → `INVALID_PARAMS`(서명 전).
- [ ] **Arcus 거절/429 매핑 (A5x/A6x)**: ALO 교차 주문 → `ORDER_REJECTED`(POST_ONLY_WOULD_CROSS), 포지션 보유 중 isolated `trade leverage` → `INVALID_PARAMS`(HAS_OPEN_POSITION, remediation 포함). 429 발생 시 `details.reason`/`retryAfterMs` 기록.

---

## 8. 발견 사항 (도구 준비 중) — 2026-10-02 모두 수정됨

1. ✅ **수정됨 — Aster testnet**: 기본 호스트 `testnet.asterdex.com` 해석 불가, `urls.ts` 공개 데이터 testnet `null`. → venue 정의 `networks.testnet` = `https://fapi.asterdex-testnet.com` / `wss://fstream.asterdex-testnet.com`(공식 api-docs V3, 라이브 확인), 어댑터·공개 데이터 모두 정의에서 읽음. `ASTER_TESTNET_URL` env 제거, 러너 preflight가 env 없이 통과.
2. ✅ **수정됨 — Lighter / Lighter RH `market list`(키 없음) `ok:true, data:[]`**: 원인은 키 유무가 아니라 `LighterAdapter.getMarkets`가 mark를 `/funding-rates`(mark 없음)에서 읽어 전 마켓을 버린 것. → `orderBookDetails.mark_price/index_price`(공개 경로 `lighter-public.ts`와 같은 출처) 사용, 목록 누락·전 마켓 mark 없음은 `EXCHANGE_ERROR`(빈 성공 금지). `market info ETH/TSLA` 정상.
3. ✅ **수정됨 — Ondo `market list` API 키 요구**: OWS master 지갑만 있고 Ondo 키가 없으면 자격 있음으로 판정 → `NO_SIGNER_AVAILABLE`. → 모든 `market` 명령은 read-only 어댑터(자격 미해석)로 실행.
4. ✅ **수정됨 — 출금 CLI**: `funds withdraw ondo <N> --to <addr>` / `funds withdraw arcus <N>` 추가(통일 옵션·`jsonOk` 결과·전역 `--dry-run` = 계획만, 전송 없음). aster는 문서상 `POST /fapi/v3/aster/user-withdraw`가 있으나 canWithdraw+IP 화이트리스트 API 지갑과 별도 master EIP-712 서명(`aster chain` "Mainnet" 고정)이 필요해 실출금 없이 검증 불가 → `funds withdraw aster`·어댑터 모두 통일 `CAPABILITY_UNSUPPORTED`, `withdrawAssets: null` 유지.
5. ✅ **수정됨 — lighter-rh 입금/도움말**: `funds deposit lighter-rh <N>` 추가 — RH 문서의 컨트랙트 경로(USDG approve(정확한 금액) → `deposit(_to, 3, route, amount)`), 컨트랙트·토큰·L1 체인은 `layer1BasicInfo`/`assetDetails`에서 라이브 조회, master OWS 지갑이 raw digest 서명, 최소 1 USDG, `--dry-run` 지원, testnet은 `CAPABILITY_UNSUPPORTED`(RH testnet L1 RPC 미문서). `funds withdraw lighter` 도움말은 venue 정의에서 파생(`-e lighter: USDC → Ethereum; -e lighter-rh: USDG → Robinhood Chain`).
6. ✅ **수정됨 — README `health` 행**("all 4 DEX") → venue 수 무관 문구. plugin marketplace 설명도 전 venue 나열.

---

## 9. QFEX (8번째 venue, `-e qfex`) — UAT 먼저, 그다음 mainnet $20

> 설계: `docs/DESIGN-venue-abstraction.md` §14 (§14.12 우선). 프로필·항목: `scripts/e2e/venues.ts` (`PROFILES.qfex`, `DESIGN_ITEMS` Q1–Q23). testnet = QFEX UAT (`api.qfex.io` / `trade.qfex.io` / `mds.qfex.io` / `banker.qfex.io`).
> **순서: UAT 전 단계 → mainnet.** `[MAINNET BLOCKER]` 항목이 UAT에서 통과하기 전에는 mainnet 주문을 내지 않는다.

### 9.1 사전 준비

- UAT 계정(qfex.io) + Developer Settings에서 API key 생성 — 권한: Execute orders, View orders / positions / balance. **Deposit and withdraw는 끈다**(입출금 테스트는 별도 키).
- `printf '%s\n%s\n' "$PUBLIC_KEY" "$SECRET" | perp -n testnet wallet agent import qfex --account-id <uuid>` (터미널에서 실행하면 확인된 계정 UUID를 보여주고 y/N). 저장 위치 `~/.perp/qfex-agents/<publicKey>.json`.
- `perp -n testnet wallet agent verify qfex` → 서명 읽기 + Trade WS 인증 통과.
- UAT 자금 지급 경로는 문서에 없음(UNVERIFIED) — UAT 웹 UI에서 확인.

### 9.2 지금 의도적으로 막혀 있는 것 (통일 `CAPABILITY_UNSUPPORTED`)

| 막힌 것 | 해제 조건 |
|---|---|
| stop-limit, 포지션을 여는 stop (venue에 없음), attached TP/SL (`--tp/--sl`은 별도 stop 주문으로 처리) | 해제 없음 / Q7 |
| **resting reduce-only**: `trade limit --reduce-only`를 GTC / ALO / FOK로, `trade scale-tp` (capability `reduceOnlyTif: ["IOC"]`) | Q2 잔여: 초과 resting reduce-only 주문이 체결 시점에 포지션까지만 체결(cap)됨이 확인되면 `QFEX_RESTING_REDUCE_ONLY_VERIFIED = true` → `reduceOnlyTif: null` |
| **무인 자동화**: 봇, plan, TWAP, DCA, grid, funding-arb, trailing stop, 백그라운드 job (`automationGate` → `assertCanClosePositions`, `startJob`) | Q21은 통과(2026-10-12). 남은 조건: Q2 잔여(flat 상태 resting reduce-only가 포지션을 여는가)·Q4 funding, 그리고 자동화 흐름이 스스로 보호 stop을 거는 구현 → `QFEX_AUTOMATION_VERIFIED = true` |
| `trade edit`의 reduce-only 주문 amend | Q2 잔여 (일반 LIMIT/ALO amend는 Q5 통과로 열림, 2026-10-12) |
| `--client-id` (사용자 지정 id) | 해제 없음 — venue id가 유일하지 않음. 생성 id만 사용 |
| 비-USD quote 마켓 (`SKHYNIX-KRW` 등) | 통화 환산 설계 후 |
| funding arb / funding 봇의 leg, `arb scan` 순위 | Q4 + 120/168h 연율화 수정 후 `fundingVerified: true` |

**reduce-only는 즉시 체결(IOC) 주문에 한해 2026-10-05에 해제됐다 (Q2, production 확인).** 동작하는 것: `trade close` / `close-all` / `flatten` / `reduce`, `trade limit --reduce-only --tif IOC`, MCP `trade_close`. **동작하지 않는 것(전송 전 `CAPABILITY_UNSUPPORTED`)**: resting reduce-only(`limit --reduce-only` GTC / ALO / FOK)와 `scale-tp` — venue가 포지션보다 큰 reduce-only 주문을 접수하고, 체결 시 cap은 즉시 체결(IOC) 주문에서만 확인됐다(§9.4 Q2). resting 주문이 포지션 축소 뒤에 어떻게 되는지는 미확인이라, resting 주문이 나중에 포지션을 열거나 뒤집을 수 있다(`QFEX_RESTING_REDUCE_ONLY_VERIFIED`, `src/exchanges/qfex/signing.ts`). 무인 자동화(봇 shim 포함)는 `QFEX_AUTOMATION_VERIFIED` 뒤에 있다 — stop이 막혀 있어 venue 쪽 보호 청산 수단이 없다. 수동 명령은 영향 없음.

어댑터의 전송 전 규칙(모든 reduce-only 전송): 포지션 없음 → `POSITION_NOT_FOUND`, side가 포지션과 같음 → `INVALID_PARAMS`, 수량 > |position| − (같은 심볼·side의 다른 열린 reduce-only 주문 잔량) → `SIZE_TOO_LARGE`. ACK 또는 체결이 아닌 상태 프레임(`CANCELLED` 등)에 `reduce_only: true` 에코가 없으면 `ORDER_PENDING`(`alarm: reduceOnlyNotEchoed`, 자동 취소 없음). 체결 프레임(`FILLED`)의 `reduce_only: false`는 정상 동작이라 판정하지 않는다. 설계 §14.13 "Q2 해제".

**production 라이브 확인 (2026-10-05, primary 계정, GOLD-USD, long만):**

- [x] buy 0.003 GOLD → `trade reduce GOLD 50` → `trade close GOLD` → buy 0.003 → `trade flatten` — 각 단계 포지션 변화로 검증됨. (`reduce 50`은 당시 0.0015가 아니라 0.001을 줄였다: 수량을 포지션 문자열의 소수 자릿수로 내림했기 때문. 이후 마켓 lot(`/refdata` `lot_size` 0.0001) 기준으로 수정 — 수정 후 라이브 재확인은 아직.)
- [x] 교차 가격 ALO → `ORDER_REJECTED { reason: "postOnlyWouldCross" }`.
- [x] 포지션보다 큰 reduce-only IOC → 전송 전 `SIZE_TOO_LARGE` (venue로 아무것도 안 나감).
- [ ] **미검증**: short 포지션(close / reduce / flatten), `trade close-all`, Q1의 프로세스 강제 kill 변형, 초과 resting reduce-only 주문의 체결 시점 cap.

### 9.3 러너로 도는 단계 (UAT)

```bash
pnpm e2e -- --venue qfex --network testnet --phase preflight          # 공개 + 키 확인
pnpm e2e -- --venue qfex --network testnet --phase trade --dry-run    # 계획 확인 (막힌 단계는 CAPABILITY_UNSUPPORTED로 멈춤)
```

수동 확인 (각 결과의 `venueRaw.responses` / `execution.notes`를 보고서에 붙인다):

- [ ] `market list / info / book / mid` (키 없음, mainnet + testnet). UAT `/md/contracts` 500이면 funding 조회만 실패(Q19) — 마켓·주문은 영향 없음.
- [ ] `trade leverage <SYM> 5` (REST) → Q16.
- [ ] limit GTC, **밴드 안**(`min_price` + 1 tick 근처): 결과 `accepted/pending` → `trade status c:<id> --symbol <SYM>` 가 `open` → Q14, Q18, Q22.
- [ ] `trade cancel <SYM> c:<id>` → `cancelled`. 이미 체결된 주문 취소 → `failed`(NO_SUCH_ORDER).
- [ ] limit ALO (교차 가격) → venue 거절/취소가 그대로 보고되는지.
- [ ] `trade market <SYM> buy <min>` → 보호가 IOC, `filled` + `avgPrice`(fill 프레임 합산) → Q20, Q23.
- [ ] IOC no-fill (밴드 안, 체결 불가 가격) → `ORDER_REJECTED { reason: iocNoFill }`; IOC 부분 체결 → `partiallyFilled` 또는 pending 후 `trade status`로 확정 → Q20, Q6.
- [ ] `trade cancel-all` → 증명된 건만 `cancelled`, 나머지 `pending` → Q8.
- [ ] `funds transfer <amt> primary --from <sub uuid> -e qfex` → Q16. `funds deposit qfex` (주소 표시, 네트워크/자산 단언). `funds withdraw qfex` (게이트 설정 후, `--dry-run` 먼저) → Q17.

### 9.4 Q 항목 (라이브로만 확인 가능)

| # | 확인 내용 | 차단 |
|---|---|---|
| Q1 | GTC 주문 후 socket을 닫아도(정상 close + 프로세스 kill) 주문이 남는가 — cancel-on-disconnect 기본 off. **부분 확인 (production 2026-10-05):** 정상 socket close 후 주문 유지(한 CLI 프로세스가 낸 GTC 주문을 새 프로세스가 조회). **프로세스 kill 변형 (production 2026-10-05, 관측 1회):** CLI 프로세스를 `kill -9`로 강제 종료한 뒤에도 GTC 주문이 남았다 | 확인됨 (kill 변형은 관측 1회) |
| Q2 | `add_order.reduce_only` wire 타입(bool vs 0/1), 생략 시 기본값, **venue 강제 여부**: reduce-only 수량 > 포지션, 포지션 없음. `take_profit`/`stop_loss` 생략 vs 0. **확인 (production 2026-10-05, primary 계정, GOLD-USD, long 0.003):** wire = JSON boolean(ACK가 `"reduce_only":true` 에코, 모든 `order_response`에 boolean으로 실림) / 포지션 없음 → `INVALID_QUANTITY` 거절 / **수량 0.006 > 포지션 0.003 → ACK, 전량 0.006으로 resting (접수 시 거절·cap 없음)**. **체결 시점 cap — IOC에서 확인 (production 2026-10-05, raw `add_order`):** long 0.003에 SELL LIMIT IOC 0.006 @ 4125 `reduce_only: true` → `ACK`(qty 0.006, rem 0.006, `reduce_only: true`) → `FILLED`(qty 0.003 @ 4145, rem 0.003, trade_id 있음, **`reduce_only: false`**) → `CANCELLED`(qty 0.006, rem 0.003, `reduce_only: true`), 이후 포지션 flat (포지션 크기까지만 체결, 나머지 취소, flip 없음). FILLED 프레임의 `reduce_only: false`는 정상 동작이라 에코 검사는 ACK와 체결이 아닌 상태 프레임만 판정한다. **미검증: 포지션 축소·청산 후 RESTING reduce-only 주문의 동작(나중 체결 시 cap / 취소 여부)**, 생략 시 기본값, TP/SL 생략 vs 0 | IOC만 해제 — `QFEX_REDUCE_ONLY_WIRE = "boolean"` + 어댑터 전송 전 규칙. **resting reduce-only·`scale-tp`는 계속 차단**(`QFEX_RESTING_REDUCE_ONLY_VERIFIED`), 자동화는 `QFEX_AUTOMATION_VERIFIED`. 체결 시 cap은 즉시 체결 주문에서만 확인됨 — resting 주문은 잔여 미검증이라 상수는 열지 않는다 |
| Q3 | auth 성공·실패 프레임 형태, WS timestamp 허용폭, 1분 미인증 close code | |
| Q4 | `funding_rate` 단위(`/executions` funding 금액 ÷ 포지션 notional), `funding_rate` vs `next_funding_rate` 중 정산에 쓰이는 값 | **arb / funding 포함** |
| Q5 | `modify_order`: MODIFIED에 `client_order_id` 보존?, `quantity` 총량/잔량, 응답 순서, `take_profit`/`stop_loss` 생략 시 보존 여부. **확인 (production 2026-10-12, GOLD-USD):** resting BUY LIMIT 4050 → `modify_order {order_id, symbol, side, order_type, quantity, price:4060, reduce_only:false}` → `order_response` MODIFIED, **새 order_id**(8e4a…, 이전 c563…), **같은 `client_order_id`**. resting reduce-only 주문을 flat 상태에서 교차 가격 4120으로 modify → `INVALID_QUANTITY`(거절, 주문 그대로, 포지션 안 열림). `quantity` 총량/잔량·TP/SL 보존은 미검증 | 해제 — `QFEX_MODIFY_KEEPS_CLIENT_ID = true`, `capabilities.amend: "native"` (reduce-only amend는 계속 거절) |
| Q6 | `/user/historic-orders` 반영 지연, `terminal_status` / `execution_state` 값 집합 | |
| Q7 | attached TP/SL로 생긴 stop의 id 수령 경로(`stop_orders` 프레임), 부분/무체결 진입 시 stop 수량, 다른 stop에 미치는 영향 | **mainnet** (attached TP/SL 게이트) |
| Q8 | `cancel_all_orders`가 stop·TWAP도 취소하는가, 완료 신호 유무 | |
| Q9 | refdata `market_hours`와 실제 funding 활성 구간(야간, `close` 세션, CL·US100 16–17 CT) | |
| Q10 | `PositionPublic.position` 부호(side 필드 없음), `/executions` `execution_type` 값(funding payments), 서브계정 헤더. **부분 확인 (production 2026-10-05):** short 포지션이 side short로 읽힌다. `execution_type` 값·서브계정 헤더는 미검증 | **mainnet** (부호는 확인됨) |
| Q11 | view-only 키의 trade WS auth·`get_user_orders`, 계정 한정 키의 `/user/subaccounts/balance` | |
| Q12 | pre-IPO 목록(`ANTHROPIC`, `OPENAI` 외), `PURR-USD`·`USDE-USD` 기초자산 | |
| Q13 | refdata `min_price`/`max_price` 갱신 주기 vs MDS `minmax_price` | |
| Q14 | speed bump 중 ACK 시점, `get_user_orders` 노출 시점, LIMIT IOC도 500 ms 대기?, cancel 버킷 소속 메시지 | **mainnet** |
| Q15 | idle 연결 수명(서버 ping은 문서화됨), 동시 연결 수 제한 | |
| Q16 | `/user/transfer`·`/user/leverage` 필요 권한, 멱등성 | |
| Q17 | API 키 출금: 주소 화이트리스트·MFA·수동 심사(공식 CLI: 2FA 필요, CLI 불가), 최소 금액·수수료 | |
| Q18 | `client_order_id` 허용 형식·길이 — perp-cli는 UUID 전송 | |
| Q19 | UAT `api.qfex.io/md/contracts` 500 (2026-10-04) → UAT funding 조회. (`mds.qfex.io`는 정상: 일반 GET은 prod도 503, WS 업그레이드는 101) | UAT funding 조회만 |
| Q20 | IOC/FOK 프레임 순서 — 전량·부분·무체결 (`FILLED rem>0` / `IOC_PARTIALLY_FILLED` / `IOC_CANCELLED` / `CANCELLED`) | **mainnet** |
| Q21 | stop 주문 ACK에 `client_order_id`가 에코되는가. **확인 (production 2026-10-12 ~16:03 UTC, GOLD-USD, scratchpad `qfex-probe.mts`):** `add_order {order_type:"STOP_LOSS", side:"SELL", quantity:0.003, price:3900(트리거), order_time_in_force:"GTC", client_order_id, reduce_only:true}` → `order_response` ACK가 `client_order_id`와 `reduce_only: true`를 에코(`order_origin: "STOP_ORDER"`, order_id b622…), 이후 약 1초마다 `stop_order_response` 프레임(같은 `stop_order_id`, client id 에코, `stop_order_type: "STOPLOSS"`, direction SELL — heartbeat이며 새 상태가 아님). `account orders`에 status untriggered·type STOP_LOSS로 표시. `cancel_stop_order {stop_order_id}` → `ack` 프레임 후 `order_response` CANCELLED(client id 에코) | 해제 — `QFEX_STOP_CLIENT_ID_ECHO = true`: reduce-only stop-market(`trade stop`, `trade tpsl`, `--tp/--sl` 별도 leg) 전송. 자동화 게이트는 그대로 |
| Q22 | `order_response.user_id` = 계정 id인가 사용자 id인가 (`QFEX_USER_ID_IS_ACCOUNT`) | **mainnet** |
| Q23 | 체결 후 `/user/positions` 반영 지연(1 s vs 10 s pulse) vs `placePerpVerified` ~10 s 폴링 | **mainnet** |

### 9.5 추가 드릴 (§14.12 #14)

- [x] **reduce-only 위반**(Q2, raw `add_order`, production 2026-10-05 GOLD-USD): 포지션 0.003 → reduce-only 0.006 매도는 **ACK·전량 resting(거절·cap 아님)** / 포지션 0 → reduce-only 0.003 매도는 `INVALID_QUANTITY`. 접수 시 cap이 없으므로 어댑터 전송 전 규칙으로 보완하고 **IOC reduce-only만** 풀었다(resting은 `QFEX_RESTING_REDUCE_ONLY_VERIFIED`까지 차단).
- [x] **CLI 경로**(production 2026-10-05 GOLD-USD, long만): buy 0.003 → `trade reduce 50` → `trade close` → buy → `trade flatten`; 교차 ALO → `ORDER_REJECTED` `postOnlyWouldCross`; 초과 reduce-only IOC → 전송 전 `SIZE_TOO_LARGE`.
- [ ] **short 포지션**: sell로 연 포지션의 `trade close` / `reduce` / `flatten`. 부호(Q10)는 확인됨 — production 2026-10-05, short 포지션이 side short로 읽힌다. 세 명령의 short 경로 실행은 남아 있다.
- [ ] **`trade close-all`**: 포지션 2개 이상에서.
- [x] **reduce-only 체결 시 cap — IOC**(Q2, raw `add_order`, production 2026-10-05 GOLD-USD): long 0.003에 reduce-only SELL LIMIT IOC 0.006 → 0.003만 체결, 나머지 `CANCELLED`, 포지션 flat (프레임은 §9.4 Q2 행).
- [ ] **reduce-only 체결 시 cap — resting**(Q2 잔여): 포지션이 줄거나 닫힌 뒤 RESTING reduce-only 주문은 나중 체결 시 cap되는가, 취소되는가. 통과해야 `QFEX_RESTING_REDUCE_ONLY_VERIFIED`를 연다(`limit --reduce-only` GTC / ALO, `scale-tp`). IOC 결과만으로는 열지 않는다. 부분 결과: **resting reduce-only (production 2026-10-12, GOLD-USD):** long 0.003에서 reduce-only SELL GTC 0.003 @ 4300을 둔 뒤 일반 매도로 포지션을 닫았더니 그 주문은 **취소되지 않고 OPEN으로 남았다**. flat 상태에서 시장이 그 가격에 닿으면 포지션을 여는지는 여전히 미검증 → `trade close / reduce / close-all`은 flat 심볼에 남은 reduce-only·stop 주문을 WARNING으로 나열하고, `trade flatten`은 취소한다.
- [x] **stop 주문 상관**(Q21, raw, production 2026-10-12 GOLD-USD): STOP_LOSS ACK·`stop_order_response` heartbeat·`cancel_stop_order` 모두 client id 에코 (§9.4 Q21 행).
- [x] **modify client id 보존**(Q5, raw, production 2026-10-12 GOLD-USD): MODIFIED = 새 order_id + 같은 client id (§9.4 Q5 행).
- [ ] **CLI stop / tpsl / edit** (Q21·Q5 해제 후): `trade stop`, `trade tpsl long --tp --sl`, `trade market --sl`, `trade cancel-stop`, `trade edit` — §9.4 증거를 CLI 경로로 재확인.
- [x] **socket 강제 종료**(Q1 kill 변형, production 2026-10-05, 관측 1회): GTC 주문 후 CLI 프로세스 `kill -9` → 주문이 남았다.
- [ ] **동시 세션 2개**: 같은 심볼·같은 수량을 두 프로세스에서 동시에 주문 → 각 결과의 `orderId`·fills가 자기 주문 것만인지.
- [ ] **전송 직후 socket kill**: 주문 전송 직후 네트워크 차단 → 결과 `ORDER_PENDING` + `c:<id>`, 재전송 없음, `trade status c:<id>`로 확정.
- [ ] **IOC 부분·무체결** (Q20).
- [ ] **TP/SL 붙은 주문의 amend** (Q5, raw): 가격만 정정했을 때 TP/SL이 유지되는가.
- [ ] **SIGINT**: 주문 전송 중 Ctrl-C → stderr에 `ORDER_PENDING` + `c:<id>`.
- [ ] **출금 게이트**: `settings set withdraw.qfex …`가 `--json`/파이프에서 `POLICY_DENIED`, 터미널에서는 venue 이름 입력 확인. allowlist 밖 주소·`maxPerTx`·`maxPerDay` 초과 → 전송 전 `POLICY_DENIED`.
