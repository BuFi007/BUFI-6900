import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('testnet_preflight', Path(__file__).with_name('check-treasury-bridge-v2-testnets.py'))
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class TestnetPreflightTest(unittest.TestCase):
    def test_no_mainnet_rpc_or_signing_method(self):
        self.assertEqual(set(preflight.RPCS), {5042002, 43113})
        with patch.object(preflight, 'cast') as call:
            for method in ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign']:
                with self.assertRaisesRegex(ValueError, 'read-only'):
                    preflight.rpc(preflight.RPCS[43113], method, [])
            call.assert_not_called()

    def test_unknown_chain_or_changed_owner_refused_before_rpc(self):
        with patch.object(preflight, 'rpc') as call:
            for chain, owner in [(43114, preflight.OWNER), (43113, '0x' + '1' * 40)]:
                with self.assertRaisesRegex(ValueError, 'only established'):
                    preflight.inspect({'chainId': chain, 'owner': owner})
            call.assert_not_called()

    def test_unreviewed_messenger_refused_before_rpc(self):
        with patch.object(preflight, 'rpc') as call:
            with self.assertRaisesRegex(ValueError, 'unexpected CCTP'):
                preflight.inspect({'chainId': 43113, 'owner': preflight.OWNER,
                                   'cctpV2TokenMessenger': '0x' + '1' * 40})
            call.assert_not_called()

    def test_rpc_must_report_exact_testnet_chain(self):
        with patch.object(preflight, 'rpc', return_value=hex(43114)) as call:
            with self.assertRaisesRegex(ValueError, 'RPC chain mismatch'):
                preflight.inspect({'chainId': 43113, 'owner': preflight.OWNER,
                                   'cctpV2TokenMessenger': preflight.MESSENGER})
            self.assertEqual(call.call_count, 1)


if __name__ == '__main__':
    unittest.main()
