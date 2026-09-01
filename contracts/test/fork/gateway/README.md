# Gateway Module Tests

## Overview

These tests verify our Gateway module implementation against the **real deployed Gateway contracts** on Sepolia testnet. This is critical because:

1. **ABIs can be wrong** - Documentation might be outdated or we might have misread it
2. **Function signatures matter** - `addDelegate(address)` vs `addDelegate(address,address)` are different functions
3. **Behavior can differ** - Even if the ABI is right, the contract might behave unexpectedly

## Prerequisites

1. **Foundry installed**: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. **Sepolia RPC URL**: Get one from Alchemy, Infura, or similar
3. **Dependencies installed**: Run `forge install` in the contracts directory

## Setup

```bash
cd contracts

# Install dependencies
forge install foundry-rs/forge-std
forge install OpenZeppelin/openzeppelin-contracts
forge install erc6900/reference-implementation

# Set RPC URL
export SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
```

## Running Tests

### 1. ABI Verification (Critical First Step)

```bash
# Discover what functions actually exist on Gateway
forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-contract GatewayABIDiscovery

# Verify our assumed ABI is correct
forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-contract GatewayForkTest
```

**What to look for:**
- ✓ means the function exists with that signature
- ✗ means it doesn't exist or has different parameters

### 2. Delegation Flow Tests

```bash
# Test the full delegation lifecycle
forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-test test_DelegationFlow
```

**This verifies:**
- `addDelegate(address token, address delegate)` actually works
- `isAuthorizedForBalance(address, address, address)` returns correct values
- `removeDelegate(address token, address delegate)` actually works

### 3. Module Tests

```bash
# Test the GatewayExecutionModule
forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-contract GatewayExecutionModuleTest
```

### 4. Unit Tests (No Fork Needed)

```bash
# Run unit tests without forking
forge test --match-contract GatewayExecutionModuleUnitTest
```

## Test Contracts

### `GatewayFork.t.sol`

| Test | Purpose |
|------|---------|
| `test_GatewayWalletExists` | Verify contract is deployed at expected address |
| `test_WithdrawalDelayExists` | Verify basic view function works |
| `test_IsAuthorizedForBalanceSignature` | Verify 3-param signature is correct |
| `test_FunctionSelectors` | Log computed selectors |
| `test_RawCallSelectors` | Verify selectors with raw calls |
| `test_DelegationFlow` | Test full add/remove delegate flow |
| `test_AlternativeAddDelegateSignatures` | Try different function signatures |

### `GatewayExecutionModule.t.sol`

| Test | Purpose |
|------|---------|
| `test_AuthorizeDelegate` | Module correctly calls Gateway |
| `test_RevokeDelegate` | Module correctly revokes |
| `test_DelegationLifecycle` | Full lifecycle through module |
| `test_*_RevertOnZero*` | Input validation |
| `test_DepositToGateway` | Deposit flow (needs USDC) |

## What If Tests Fail?

### "Function not found" / Selector mismatch

Our ABI assumption is wrong. Check the `GatewayABIDiscovery` test output to find the correct signature.

### "Gateway Wallet has no code"

Wrong contract address or not deployed on this network.

### Delegation tests fail

1. Check if Gateway requires any setup before delegation works
2. Check if there are access controls we missed
3. Check Circle's documentation for any prerequisites

## Contract Addresses

| Contract | Testnet (Sepolia) | Mainnet |
|----------|-------------------|---------|
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |

## Testing Deposits

To test deposits, you need testnet USDC:

1. Go to Circle's USDC faucet: https://faucet.circle.com/
2. Connect wallet and request Sepolia USDC
3. Transfer some to your test address
4. Run: `forge test --fork-url $SEPOLIA_RPC_URL -vvv --match-test test_DepositToGateway`

## Gateman Principle

> "Assume Nothing, Worship None"

These tests exist because documentation can be wrong, ABIs can be outdated, and code can behave unexpectedly. Fork testing against real contracts is how we verify our assumptions.
