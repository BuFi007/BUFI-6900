#!/usr/bin/env python3
"""Build a deterministic offline review package. No RPC, keys, signing, or submission."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
SAFES = {5042: '0x47Dc7D18A6E3a79F696714E7D47456a49B430D09', 43114: '0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B'}
TESTNETS = {5042002, 43113}

def cast(*args):
    return subprocess.check_output(['cast', *args], text=True).strip()

def address(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value) or int(value, 16) == 0:
        raise ValueError('nonzero EVM address required')
    return cast('to-checksum', value)

def prepare(inputs, artifact):
    metadata = artifact['metadata']
    settings = metadata['settings']
    if not metadata['compiler']['version'].startswith('0.8.24+') or settings['evmVersion'] != 'paris' or settings.get('viaIR') is not True or settings['optimizer'] != {'enabled': True, 'runs': 200}:
        raise ValueError('release requires solc 0.8.24, paris, viaIR, optimizer 200; build into out-release')
    source_hashes = {}
    for name, facts in metadata['sources'].items():
        content = (ROOT / 'contracts' / name).read_bytes()
        if cast('keccak', '0x' + content.hex()) != facts['keccak256']:
            raise ValueError('artifact source no longer matches checkout: ' + name)
        source_hashes[name] = facts['keccak256']
    salt = cast('keccak', 'bufi.treasury-bridge-conduit.v2')
    creation = artifact['bytecode']['object']
    runtime = artifact['deployedBytecode']['object']
    if artifact['bytecode'].get('linkReferences') or artifact['deployedBytecode'].get('immutableReferences'):
        raise ValueError('unsupported linked/immutable artifact; refresh release generator')
    plans = []
    for item in inputs:
        chain = item['chainId']
        if chain not in SAFES and chain not in TESTNETS:
            raise ValueError('chain has no reviewed owner policy')
        owner = address(item['owner'])
        if chain in SAFES and owner.lower() != SAFES[chain].lower():
            raise ValueError('mainnet constructor owner must be the recorded chain Safe')
        messenger = address(item['cctpV2TokenMessenger'])
        venues = [address(v) for v in item.get('sourceSwapVenues', [])]
        if messenger.lower() in [v.lower() for v in venues] or len(set(v.lower() for v in venues)) != len(venues):
            raise ValueError('duplicate venue or bridge registered as swap venue')
        init_code = creation + cast('abi-encode', 'f(address)', owner)[2:]
        init_hash = cast('keccak', init_code)
        prediction_hash = cast('keccak', '0xff' + FACTORY[2:] + salt[2:] + init_hash[2:])
        predicted = address('0x' + prediction_hash[-40:])
        registration = [{
            'to': predicted, 'value': '0', 'operation': 0,
            'data': cast('calldata', 'setBridge(uint8,address,bool)', '0', messenger, 'true'),
            'description': 'Allow exact CCTP V2 TokenMessenger; no CCTPx registration',
        }]
        registration.extend({
            'to': predicted, 'value': '0', 'operation': 0,
            'data': cast('calldata', 'setTarget(address,bool)', venue, 'true'),
            'description': 'Allow reviewed source swap venue',
        } for venue in venues)
        plans.append({
            **item, 'owner': owner, 'network': 'mainnet' if chain in SAFES else 'testnet',
            'status': 'review-only-not-deployed', 'predictedAddress': predicted,
            'initCodeHash': init_hash,
            'create2Transaction': {'to': FACTORY, 'value': '0', 'data': salt + init_code[2:]},
            'registrationTransactions': registration,
            'activationRequires': [
                'external audit and release approval' if chain in SAFES else 'authorized testnet broadcast',
                'receipt and canonical runtime code hash readback', 'owner() readback equals this chain owner',
                'bridge and each venue code, proxy implementation and registration readback',
                'canonical Desk deployment registry update with transaction and audit status',
                'sealed server release evidence and source/destination gas policy',
                'destination continuation proof and end-to-end automated recovery smoke',
            ],
        })
    source = ROOT / 'contracts/src/bufi/conduit/TreasuryBridgeConduitV2.sol'
    return {
        'schemaVersion': 1, 'contract': 'TreasuryBridgeConduitV2', 'status': 'review-only-not-deployed',
        'baseCommit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'f9b9d94^{commit}'], text=True).strip(),
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'compiler': {'solc': '0.8.24', 'evmVersion': 'paris', 'optimizerRuns': 200, 'viaIR': True},
        'runtimeCodeHash': cast('keccak', runtime), 'runtimeSizeBytes': (len(runtime) - 2) // 2,
        'creationCodeHash': cast('keccak', creation), 'salt': salt,
        'sourceHashes': source_hashes,
        'authority': {'treasury': 'live weighted ERC1271 quorum ERC3009', 'personal': 'human normal transaction and exact allowance'},
        'capabilityScope': 'USDC CCTP V2; optional reviewed atomic source swap; output USDC; no destination swap',
        'auditStatus': 'unaudited', 'plans': plans,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, default=ROOT / 'contracts/release/treasury-bridge-v2.inputs.json')
    parser.add_argument('--artifact', type=Path, default=ROOT / 'contracts/out-release/TreasuryBridgeConduitV2.sol/TreasuryBridgeConduitV2.json')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    document = prepare(json.loads(args.inputs.read_text()), json.loads(args.artifact.read_text()))
    rendered = json.dumps(document, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end='')

if __name__ == '__main__':
    main()
