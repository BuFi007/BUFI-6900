#!/usr/bin/env python3
"""Independently read actual testnet receipts and verify the frozen release plan."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import subprocess

SPEC = importlib.util.spec_from_file_location('testnet_preflight', Path(__file__).with_name('check-treasury-bridge-v2-testnets.py'))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
ROOT = check.ROOT
FROZEN_COMMIT = '997dfad6aca5e3e9ae3d6c1d66b15fecbd47f012'


def record(plan):
    chain = plan['chainId']
    if chain not in check.RPCS:
        raise ValueError('only testnet deployment receipts allowed')
    rpc = check.RPCS[chain]
    broadcast = ROOT / f'contracts/broadcast/DeployTreasuryBridgeConduitV2.s.sol/{chain}/run-latest.json'
    expected = [plan['create2Transaction'], *plan['registrationTransactions']]
    if broadcast.is_file():
        transactions = json.loads(broadcast.read_text())['transactions']
    else:
        # A fresh clone uses only public transaction identities from the saved
        # proof. Every identity and byte of calldata is still checked on-chain.
        manifest = json.loads((ROOT / 'contracts/release/treasury-bridge-v2.testnet-deployments.json').read_text())
        recorded = next(c for c in manifest['chains'] if c['chainId'] == chain)
        transactions = [{'hash': r['transactionHash']} for r in recorded['receipts']]
    if len(transactions) != len(expected):
        raise ValueError('broadcast must match complete reviewed deployment plan')
    receipts = []
    finalized = check.rpc(rpc, 'eth_getBlockByNumber', ['finalized', False])
    for original, reviewed in zip(transactions, expected):
        tx_hash = original['hash']
        actual = check.rpc(rpc, 'eth_getTransactionByHash', [tx_hash])
        receipt = check.rpc(rpc, 'eth_getTransactionReceipt', [tx_hash])
        if not actual or not receipt or int(receipt['status'], 16) != 1:
            raise ValueError('successful mined original receipt required')
        if (int(actual['chainId'], 16) != chain or actual['from'].lower() != check.OWNER.lower()
                or actual['to'].lower() != reviewed['to'].lower() or int(actual['value'], 16) != 0
                or actual['input'].lower() != reviewed['data'].lower()
                or receipt['transactionHash'].lower() != tx_hash.lower()
                or actual['blockHash'] != receipt['blockHash']):
            raise ValueError('on-chain transaction differs from frozen release plan')
        block = check.rpc(rpc, 'eth_getBlockByNumber', [receipt['blockNumber'], False])
        if block['hash'] != receipt['blockHash'] or int(finalized['number'], 16) < int(block['number'], 16):
            raise ValueError('canonical finalized receipt required')
        receipts.append({
            'action': 'deployCreate2' if len(receipts) == 0 else reviewed['description'],
            'transactionHash': tx_hash, 'from': actual['from'], 'to': actual['to'],
            'nonce': int(actual['nonce'], 16), 'inputHash': check.cast('keccak', actual['input']),
            'status': 'success', 'blockNumber': int(receipt['blockNumber'], 16),
            'blockHash': receipt['blockHash'], 'gasUsed': str(int(receipt['gasUsed'], 16)),
            'effectiveGasPriceWei': str(int(receipt['effectiveGasPrice'], 16)),
            'nativeFeeWei': str(int(receipt['gasUsed'], 16) * int(receipt['effectiveGasPrice'], 16)),
            'finality': 'finalized',
        })
    evidence = check.inspect(plan)
    deployed = evidence['deployment']
    if deployed['status'] != 'present' or not deployed['cctpV2Registered'] or not all(deployed['venues'].values()):
        raise ValueError('post-deployment runtime, owner, bridge and venue readback required')
    return {**evidence, 'deploymentTransactionHash': receipts[0]['transactionHash'],
            'receipts': receipts, 'totalNativeGasFeeWei': str(sum(int(r['nativeFeeWei']) for r in receipts)),
            'finalizedObservation': {'number': int(finalized['number'], 16), 'hash': finalized['hash']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    review = json.loads((ROOT / 'contracts/release/treasury-bridge-v2.review.json').read_text())
    frozen_review = json.loads(subprocess.check_output([
        'git', '-C', str(ROOT), 'show', FROZEN_COMMIT + ':contracts/release/treasury-bridge-v2.review.json',
    ], text=True))
    if review != frozen_review:
        raise ValueError('deployment proof requires the frozen reviewed release')
    result = {
        'schemaVersion': 1, 'observedAt': datetime.now(timezone.utc).isoformat(),
        'contract': 'TreasuryBridgeConduitV2', 'status': 'testnet-deployed-and-registered',
        'contractCommit': FROZEN_COMMIT,
        'runtimeCodeHash': review['runtimeCodeHash'], 'runtimeSizeBytes': review['runtimeSizeBytes'],
        'compiler': review['compiler'], 'auditStatus': 'unaudited',
        'authorization': 'Explicit user authorization for testnet deployment and registrations only',
        'mainnetStatus': 'review-only-not-deployed-no-broadcast',
        'scope': 'Testnet contract deployment proof; application destination settlement and recovery have separate evidence',
        'chains': [record(p) for p in review['plans'] if p['chainId'] in check.RPCS],
    }
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'chains': [{
        'chainId': c['chainId'], 'address': c['predictedAddress'],
        'owner': c['deployment']['owner'], 'runtimeCodeHash': c['deployment']['runtimeCodeHash'],
        'receiptCount': len(c['receipts']), 'totalNativeGasFeeWei': c['totalNativeGasFeeWei'],
        'deploymentTransactionHash': c['deploymentTransactionHash'],
    } for c in result['chains']]}, indent=2))


if __name__ == '__main__':
    main()
