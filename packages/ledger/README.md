# @bufi6900/ledger

**Ledger hardware-wallet signing for BUFI treasuries**, on web and React Native. A team can
bring an existing Ledger device and use it as a signer on a Circle MSCA weighted-multisig
treasury, so shared workflows (invoicing, reimbursements, payroll, contracts, deals) are
approved from hardware rather than a hot key.

## Contents

| Path | Canonical home in desk-v1 | What it does |
| --- | --- | --- |
| `src/web/ledger-provider.ts` | `apps/app/src/lib/wallet/ledger-provider.ts` | browser transport + signer |
| `src/native/ledger-native.service.ts` | `apps/expo/services/ledger-native.service.ts` | React Native BLE/HID transport |
| `src/csp/ledger-csp.qa-regression.test.ts` | `apps/app/src/proxy.ledger-csp.qa-regression.test.ts` | pins the Content-Security-Policy the device bridge needs |

The CSP regression is included deliberately: the web transport is one `connect-src` entry
away from silently failing, and the only symptom is a device that never appears.

## Provenance

Extracted verbatim from the BUFI product monorepo (`BuFi007/desk-v1`) for the ETHGlobal
ETHOnline 2026 submission, so the hackathon work can be read as a standalone package.

**These sources are lifted, not re-authored.** They still import from the product
monorepo workspace (`@bu/*`, `@bufinance/*`), so this package does not build in isolation
here — it is published for review and portability. The per-file paths below are the
canonical homes; treat `desk-v1` as the source of truth.

