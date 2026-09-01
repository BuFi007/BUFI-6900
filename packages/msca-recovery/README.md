# @bufi/msca-recovery

Fork of [`circlefin/msca-wallet-recovery`](https://github.com/circlefin/msca-wallet-recovery)
(commit `76c4168`, release `2025-03-18T162928`, Apache-2.0 — original license in `LICENSE.upstream`,
original README in `README.upstream.md`).

Purpose in BUFI-6900: the **independent recovery lane**. It drives a Circle ERC-6900 MSCA through any
ERC-4337 bundler with plain viem + permissionless — no Circle Modular Wallets API — which is exactly what an
operator needs when Circle's API is unavailable, and what an auditor needs to exercise the wallet without
BUFI's own SDK. The upstream ABIs (`src/abi/`) are the production Circle contracts; BUFI adds ABIs for its
plugins as they are finalised (`BufiSessionKeyPlugin`, `BufiEarnModule`) and a `session-key-transfer`
scenario that spends from an MSCA with an agent session key instead of the owner set.

Runs against the local sandbox: point `BUNDLER_RPC_URL` at `@bufi/mock-circle`
(`http://127.0.0.1:8788/v1/rpc/w3s/buidl`) and `MSCA_WALLET_ADDRESS` at an account created there.

Upstream usage is unchanged — see `README.upstream.md`. This package is `private` and not published.
