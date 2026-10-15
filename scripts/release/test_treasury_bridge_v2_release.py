"""Offline regression checks for release identity and owner policy."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

MODULE = Path(__file__).with_name('prepare-treasury-bridge-v2.py')
SPEC = importlib.util.spec_from_file_location('bridge_release', MODULE)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

class ReleasePlanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = json.loads((release.ROOT / 'contracts/out-release/TreasuryBridgeConduitV2.sol/TreasuryBridgeConduitV2.json').read_text())
        cls.inputs = json.loads((release.ROOT / 'contracts/release/treasury-bridge-v2.inputs.json').read_text())

    def test_review_fixture_is_the_current_source_and_build(self):
        expected = json.loads((release.ROOT / 'contracts/release/treasury-bridge-v2.review.json').read_text())
        actual = release.prepare(self.inputs, self.artifact)
        self.assertEqual(actual, expected)
        self.assertEqual(actual['plans'][0]['predictedAddress'], actual['plans'][1]['predictedAddress'])
        self.assertNotEqual(actual['plans'][2]['predictedAddress'], actual['plans'][3]['predictedAddress'])
        self.assertEqual(actual['status'], 'review-only-not-deployed')

    def test_mainnet_requires_its_own_chain_safe(self):
        values = copy.deepcopy(self.inputs)
        values[2]['owner'] = values[3]['owner']
        with self.assertRaisesRegex(ValueError, 'recorded chain Safe'):
            release.prepare(values, self.artifact)

    def test_unknown_chain_has_no_implicit_owner_policy(self):
        values = copy.deepcopy(self.inputs)
        values[0]['chainId'] = 1
        with self.assertRaisesRegex(ValueError, 'no reviewed owner policy'):
            release.prepare(values, self.artifact)

    def test_fork_compiler_output_cannot_be_used_as_release_code(self):
        artifact = copy.deepcopy(self.artifact)
        artifact['metadata']['settings']['evmVersion'] = 'cancun'
        with self.assertRaisesRegex(ValueError, 'paris'):
            release.prepare(self.inputs, artifact)

    def test_stale_source_artifact_is_refused(self):
        artifact = copy.deepcopy(self.artifact)
        name = 'src/bufi/conduit/TreasuryBridgeConduitV2.sol'
        artifact['metadata']['sources'][name]['keccak256'] = '0x' + '00' * 32
        with self.assertRaisesRegex(ValueError, 'no longer matches checkout'):
            release.prepare(self.inputs, artifact)

if __name__ == '__main__':
    unittest.main()
