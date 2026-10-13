# Bridge — USDC Cross-Chain Transfer

Arbitrum, Base, Solana, Hyperliquid(HyperCore) 간 USDC 브릿지.

## Providers

| Provider | 속도 | 수수료 구조 | 지원 체인 |
|----------|------|-------------|-----------|
| **deBridge DLN** (기본) | ~1-2초 | fixFee 0.001 ETH + operating expenses (~$0.25) | arb, base, sol |
| **Relay** | ~4초 | relayer fee (~$0.02) | arb, base, sol |
| **CCTP V2** | 1-20분 | forwarding $0.20 / standard $0.01 | arb, base, sol, hyperliquid |

`--provider` 미지정 시 **deBridge DLN**이 기본 선택됨.

## CLI 사용법

### Quote 조회

```bash
# 모든 provider 견적 비교
perp bridge quote --from arbitrum --to base --amount 100

# JSON 출력
perp --json bridge quote --from arbitrum --to solana --amount 50
```

### 전송

```bash
# 기본 (deBridge DLN)
perp bridge send --from arbitrum --to base --amount 100

# Provider 지정
perp bridge send --from arbitrum --to base --amount 100 --provider cctp
perp bridge send --from arbitrum --to base --amount 100 --provider relay

# CCTP Fast 모드 (~1-2분, 자동 relay)
perp bridge send --from arbitrum --to base --amount 100 --provider cctp --fast

# Exchange 기반 (체인 자동 매핑)
perp bridge exchange --from lighter --to pacifica --amount 50
```

### Relay 자산 스왑 (`--from-asset` / `--to-asset`)

USDC 외 자산·체인(Robinhood Chain 4663 `robinhood`, BNB Chain 56 `bsc`)은 Relay 경로만 지원한다. 출발 체인은 EVM만 가능하고, OWS master 지갑이 서명하며, 수신 주소는 항상 master 지갑 자신의 주소(EVM 체인은 EVM 주소, Solana는 master의 Solana 주소)다 — 임의 `--recipient`는 거부된다.

```bash
# 견적만 (키를 열지 않음): 입력 금액, 예상 수령, 프로토콜 보장 최소 수령, 수수료, ETA, min-out 판정
perp --dry-run funds bridge send --from robinhood --to arbitrum --from-asset USDG --to-asset USDC --amount 15

# RH USDG → Solana SOL (stable → native는 --min-out 필수, 단위는 수령 자산)
perp funds bridge send --from robinhood --to solana --from-asset USDG --to-asset SOL --amount 2 --min-out 0.015

# Arbitrum ETH → RH ETH (RH에 가스가 0이면 첫 브릿지는 Arbitrum에서 출발)
perp funds bridge send --from arbitrum --to robinhood --from-asset ETH --to-asset ETH --amount 0.00075
```

- 견적은 로컬에서 검증된다(`src/relay-swap.ts`, Relay "Input Validation" 가이드): 주문 데이터의 수신자·자산·체인·입력 금액, 주문 ID 재계산, 고정된 depository 주소(`0x4cD0…BC31`), approve는 정확한 금액 + depository spender만, 스텝 chainId. 하나라도 다르면 `POLICY_DENIED`, 아무것도 서명하지 않는다.
- 수령 보호: stable→stable / 같은 native 자산은 예상 수령 ≥ 입력 × 97%. `--min-out`을 주면 프로토콜이 보장하는 최소 수령(`minimumAmount`)이 그 이상이어야 한다.
- 입금 후 `GET /intents/status/v3`를 최대 5분 조회한다. `success` 외에 확인이 안 되면 `ORDER_PENDING`(request id + 입금 tx hash) — 다시 보내지 말고 `https://relay.link/transaction/<requestId>`를 확인한다.

### 지원 체인 확인

```bash
perp bridge chains
```

### 주문 상태 확인

```bash
perp bridge status <orderId>
```

## 지원 루트

### CCTP V2 (Circle)

| 출발 | 도착 | 방식 | 가스 필요 |
|------|------|------|-----------|
| arb → base | `depositForBurnWithHook` + Forwarding | src만 |
| base → arb | `depositForBurnWithHook` + Forwarding | src만 |
| sol → arb/base | Solana `depositForBurnWithHook` + Forwarding | src만 |
| arb/base → sol | `depositForBurnWithHook` (forwarding 미지원) | src + dst |
| arb → hyperliquid | `CctpExtension.batchDepositForBurnWithAuth` | src만 |
| base → hyperliquid | `approve + depositForBurnWithHook` | src만 |
| sol → hyperliquid | Solana `depositForBurnWithHook` + CctpForwarder | src만 |
| hyperliquid → arb/base/sol | HL API `sendToEvmWithData` + EIP-712 | 없음 |

### Finality 모드

| 모드 | 시간 | 프로토콜 수수료 | 플래그 |
|------|------|----------------|--------|
| Standard (기본) | 13-20분 (EVM), ~3분 (Sol) | 0 bps (무료) | - |
| Fast | 1-2분 | 0-14 bps | `--fast` |

### Forwarding Service

EVM→EVM, Sol→EVM 루트에서 Circle Forwarding Service 적용:
- Circle이 dst 체인에서 자동으로 `receiveMessage` 실행
- dst 체인 가스 불필요 (sender-pays)
- hook data: `0x636374702d666f72776172640000000000000000000000000000000000000000`

**미지원**: EVM/Sol → Solana (수동 relay 필요)

### deBridge DLN

| 출발 | 도착 | 비고 |
|------|------|------|
| arb ↔ base | 양방향 | ~1-2초 |
| arb ↔ sol | 양방향 | ~1-2초 |
| base ↔ sol | 양방향 | ~1-2초 |

수수료: fixFee 0.001 ETH (native) + operating expenses (USDC에서 차감)

### Relay

| 출발 | 도착 | 비고 |
|------|------|------|
| arb ↔ base | 양방향 | ~4초 |
| arb ↔ sol | 양방향 | ~4초 |
| base ↔ sol | 양방향 | ~4초 |

수수료: relayer fee + gas fee (USDC에서 차감)

## HyperCore (Hyperliquid) 전용

HyperCore는 CCTP V2로만 접근 가능 (deBridge/Relay 미지원).

- **CCTP Domain**: 19
- **CctpForwarder**: `0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757`
- **CctpExtension** (Arbitrum만): `0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE`

### 입금 (→ HyperCore)

1. **Arbitrum**: `CctpExtension.batchDepositForBurnWithAuth` (1TX, EIP-3009)
2. **Base 등 기타 EVM**: `approve + TokenMessengerV2.depositForBurnWithHook` (2TX)
3. **Solana**: `depositForBurnWithHook` + CctpForwarder PDA

`mintRecipient`과 `destinationCaller` 모두 CctpForwarder 주소로 설정 필수.

Hook data 포맷:
```
magic (24 bytes)  : "cctp-forward" + zero padding
version (4 bytes) : 0x00000000
dataLength (4 bytes): 0x00000018 (24)
recipient (20 bytes): HyperCore 수신 주소
dexId (4 bytes)    : 0 = perps, 0xFFFFFFFF = spot
```

### 출금 (HyperCore →)

Hyperliquid exchange API `sendToEvmWithData` + EIP-712 서명.
온체인 가스 불필요 (API 호출만).

## 아키텍처

```
bridge-engine.ts
├── getAllQuotes()          # 3개 provider 병렬 견적 조회
├── getBestQuote()          # 최저가 선택
├── executeBestBridge()     # provider 미지정 시 deBridge 우선
│
├── CCTP V2
│   ├── getCctpQuote()
│   ├── getCctpRelayFee()           # Circle fee API (bps 기반)
│   ├── getHyperCoreCctpFees()      # HyperCore 전용 fee API
│   ├── executeCctpBridge()         # 라우터
│   ├── executeCctpEvmToEvm()       # Forwarding Service
│   ├── executeCctpSolanaToEvm()    # Forwarding Service
│   ├── executeCctpEvmToSolana()    # 수동 relay
│   ├── executeCctpEvmToHyperCore() # CctpExtension / fallback
│   ├── executeCctpSolanaToHyperCore()
│   └── executeCctpHyperCoreToEvm() # HL API
│
├── deBridge DLN
│   ├── getDebridgeQuote()
│   ├── executeDebridgeBridge()
│   └── checkDebridgeStatus()
│
├── Relay
│   ├── getRelayQuote()
│   └── executeRelayBridge()
│
└── Helpers
    ├── checkBridgeGasBalance()     # 가스 프리플라이트 체크
    ├── getNativeGasBalance()
    ├── getEvmUsdcBalance()
    ├── getSolanaUsdcBalance()
    └── submitEvmTransaction() / submitSolanaTransaction()
```

## 환경 변수

```env
# 필수 (사용하는 체인에 따라)
LIGHTER_PRIVATE_KEY=0x...          # Arbitrum/Base EVM key
HL_PRIVATE_KEY=0x...               # Hyperliquid EVM key (same as LIGHTER)
PACIFICA_PRIVATE_KEY=...           # Solana key (base58)
```

deBridge affiliate / referral 파라미터는 env 가 아니라 settings `bridge.debridgeAffiliate` 에서만 읽는다
(기본값 없음 = 아무것도 보내지 않음):

```bash
perp settings set bridge.debridgeAffiliate.referralCode <code>
perp settings set bridge.debridgeAffiliate.fee <percent>,<recipient>   # 둘 다 함께 설정
perp settings unset bridge.debridgeAffiliate
```

## 실행 로그

모든 브릿지 실행은 `~/.perp/executions.jsonl`에 JSONL로 기록됨:

```json
{
  "id": "1741...",
  "timestamp": "2026-03-09T...",
  "type": "bridge",
  "exchange": "bridge",
  "symbol": "USDC",
  "side": "arbitrum->base",
  "size": "100",
  "status": "success",
  "meta": { "provider": "debridge", "txHash": "0x...", "fast": false }
}
```

`perp history --type bridge`로 조회 가능.
