#!/usr/bin/env python3
"""Read-only, testnet-only deployment preflight. Never loads signing material."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
RPCS = {
    5042002: 'https://rpc.testnet.arc.network',
    43113: 'https://api.avax-test.network/ext/bc/C/rpc',
}
OWNER = '0x09Ce8E2B3Fede2727dA4392Ea8Fe618305ba0474'
V1 = '0x2F507a95Ea2d7369a81ff04faa670768C99E63d1'
MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
MINTER = '0xb43db544E2c27092c107639Ad201b3dEfAbcF192'
TOKENS = {5042002: '0x3600000000000000000000000000000000000000',
          43113: '0x5425890298aed601595a70AB815c96711a31Bc65'}
DOMAINS = {5042002: 26, 43113: 1}
IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'


def cast(*args):
    return subprocess.check_output(['cast', *args], text=True).strip()


def rpc(url, method, params):
    if method not in {'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode',
                      'eth_getStorageAt', 'eth_getBalance', 'eth_gasPrice', 'eth_estimateGas',
                      'eth_getTransactionReceipt', 'eth_getTransactionByHash'}:
        raise ValueError('read-only RPC method required')
    return json.loads(cast('rpc', '--rpc-url', url, '--rpc-timeout', '30', '--raw', method, json.dumps(params)))


def inspect(plan):
    chain = plan['chainId']
    if chain not in RPCS or plan['owner'].lower() != OWNER.lower():
        raise ValueError('only established Arc/Fuji testnet owner allowed')
    if plan['cctpV2TokenMessenger'].lower() != MESSENGER.lower():
        raise ValueError('unexpected CCTP V2 messenger')
    url = RPCS[chain]
    if int(rpc(url, 'eth_chainId', []), 16) != chain:
        raise ValueError('RPC chain mismatch')
    block = rpc(url, 'eth_getBlockByNumber', ['latest', False])
    tag = block['number']

    def call(to, signature, *args):
        return rpc(url, 'eth_call', [{'to': to, 'data': cast('calldata', signature, *args)}, tag])

    def address(value):
        return cast('to-checksum', '0x' + value[-40:])

    def code_evidence(target):
        code = rpc(url, 'eth_getCode', [target, tag])
        if code == '0x':
            raise ValueError('missing contract: ' + target)
        slot = rpc(url, 'eth_getStorageAt', [target, IMPL_SLOT, tag])
        result = {'address': target, 'runtimeBytes': (len(code) - 2) // 2,
                  'runtimeCodeHash': cast('keccak', code)}
        if int(slot, 16):
            impl = address(slot)
            impl_code = rpc(url, 'eth_getCode', [impl, tag])
            if impl_code == '0x':
                raise ValueError('missing proxy implementation')
            result['implementation'] = {'address': impl, 'runtimeCodeHash': cast('keccak', impl_code)}
        return result

    messenger = code_evidence(MESSENGER)
    if address(call(MESSENGER, 'localMessageTransmitter()')).lower() != TRANSMITTER.lower():
        raise ValueError('messenger transmitter mismatch')
    if address(call(MESSENGER, 'localMinter()')).lower() != MINTER.lower():
        raise ValueError('messenger minter mismatch')
    if int(call(TRANSMITTER, 'localDomain()'), 16) != DOMAINS[chain]:
        raise ValueError('CCTP local domain mismatch')
    remote = 1 if chain == 5042002 else 26
    if address(call(MESSENGER, 'remoteTokenMessengers(uint32)', str(remote))).lower() != MESSENGER.lower():
        raise ValueError('remote messenger mismatch')
    v1_owner = address(call(V1, 'owner()'))
    if v1_owner.lower() != OWNER.lower():
        raise ValueError('established V1 owner changed')
    factory = code_evidence(plan['create2Transaction']['to'])
    venues = [code_evidence(v) for v in plan['sourceSwapVenues']]
    balance = int(rpc(url, 'eth_getBalance', [OWNER, tag]), 16)
    gas_price = int(rpc(url, 'eth_gasPrice', []), 16)
    predicted = plan['predictedAddress']
    deployed = rpc(url, 'eth_getCode', [predicted, tag])
    if deployed == '0x':
        estimate = int(rpc(url, 'eth_estimateGas', [{
            'from': OWNER, 'to': plan['create2Transaction']['to'],
            'data': plan['create2Transaction']['data'], 'value': '0x0',
        }]), 16)
        # Registration writes cost well below this allowance. Fee admission only;
        # the actual broadcast has its own fresh gas simulation and fee estimate.
        reserve_gas = estimate * 2 + 150_000 * len(plan['registrationTransactions'])
        deployment = {'status': 'absent', 'estimatedCreate2Gas': estimate}
    else:
        actual_hash = cast('keccak', deployed)
        expected_hash = json.loads((ROOT / 'contracts/release/treasury-bridge-v2.review.json').read_text())['runtimeCodeHash']
        if actual_hash != expected_hash or address(call(predicted, 'owner()')).lower() != OWNER.lower():
            raise ValueError('existing V2 does not match release')
        reserve_gas = 150_000 * len(plan['registrationTransactions'])
        deployment = {'status': 'present', 'runtimeCodeHash': actual_hash, 'owner': OWNER,
                      'cctpV2Registered': int(call(predicted, 'bridges(uint8,address)', '0', MESSENGER), 16) == 1,
                      'venues': {v: int(call(predicted, 'targets(address)', v), 16) == 1 for v in plan['sourceSwapVenues']}}
    budget = reserve_gas * gas_price * 2
    return {
        'chainId': chain, 'rpcUrl': url, 'blockNumber': int(tag, 16), 'blockHash': block['hash'],
        'owner': OWNER, 'establishedV1Owner': v1_owner, 'predictedAddress': predicted,
        'nativeBalanceWei': str(balance), 'nativeBalance18Decimals': format(balance / 10**18, '.12f'),
        'gasPriceWei': str(gas_price), 'conservativeDeploymentAdmissionWei': str(budget),
        'fundedForDeployment': balance >= budget,
        'ownerUsdcBalance6Decimals': str(int(call(TOKENS[chain], 'balanceOf(address)', OWNER), 16)),
        'factory': factory, 'messenger': messenger, 'transmitter': code_evidence(TRANSMITTER),
        'minter': code_evidence(MINTER), 'sourceSwapVenues': venues,
        'localDomain': DOMAINS[chain], 'remoteDomain': remote, 'deployment': deployment,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    review = json.loads((ROOT / 'contracts/release/treasury-bridge-v2.review.json').read_text())
    result = {'observedAt': datetime.now(timezone.utc).isoformat(), 'mode': 'read-only-no-signing',
              'contractCommit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
              'runtimeCodeHash': review['runtimeCodeHash'],
              'circleContractAddressReference': 'https://developers.circle.com/cctp/references/contract-addresses',
              'chains': [inspect(p) for p in review['plans'] if p['chainId'] in RPCS]}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
