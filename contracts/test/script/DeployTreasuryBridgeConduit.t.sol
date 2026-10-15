// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {DeployTreasuryBridgeConduit} from "../../script/DeployTreasuryBridgeConduit.s.sol";
import {Test} from "forge-std/src/Test.sol";

contract DeployTreasuryBridgeConduitHarness is DeployTreasuryBridgeConduit {
    function preflight() external view returns (bool mainnet, address owner) {
        return _preflight();
    }
}

contract DeployTreasuryBridgeConduitTest is Test {
    DeployTreasuryBridgeConduitHarness internal deployment;

    address internal constant OWNER = address(0x1234);
    address internal constant ARC_SAFE = 0x47Dc7D18A6E3a79F696714E7D47456a49B430D09;
    address internal constant AVALANCHE_SAFE = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;

    function setUp() public {
        deployment = new DeployTreasuryBridgeConduitHarness();
    }

    function test_chainAndOwnerPreflightBeforeCredentialAccess() public {
        // Foundry env changes are process-global. Keep every owner/opt-in mutation
        // in one sequential test so parallel test scheduling cannot change inputs.
        // No successful run() path is invoked: valid cases call only preflight().
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "not-a-private-key");
        vm.setEnv("BRIDGE_CONDUIT_OWNER", "not-an-address");
        vm.setEnv("ALLOW_MAINNET", "not-a-number");
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(DeployTreasuryBridgeConduit.UnsupportedChain.selector, uint256(143)));
        deployment.run();
        _previouslyListedUnsupportedMainnetsRejectBeforeReadingEnvironment();
        _supportedTestnetsPassWithoutMainnetOptInOrDeployerKey();
        _testnetZeroOwnerRejectsBeforeDeployerKey();
        _mainnetsRequireOptInBeforeOwnerOrDeployerKey();
        _mainnetOptInMustBeExactlyOne();
        _mainnetWrongOwnerRejectsBeforeDeployerKey();
        _mainnetSafesCannotBeInterchanged();
        _supportedMainnetsPassOnlyWithTheirSafeAndOptIn();
        _correctSafeDoesNotBypassMainnetOptIn();
    }

    function testFuzz_unknownChainsRejectBeforeReadingEnvironment(uint64 chainId) public {
        // This same sentinel is never changed to a valid credential by any test.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "not-a-private-key");
        vm.assume(chainId != 5042002 && chainId != 43113 && chainId != 5042 && chainId != 43114);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(DeployTreasuryBridgeConduit.UnsupportedChain.selector, chainId));
        deployment.run();
    }

    function _previouslyListedUnsupportedMainnetsRejectBeforeReadingEnvironment() internal {
        uint256[5] memory chainIds = [uint256(1), 10, 137, 8453, 42161];
        for (uint256 i; i < chainIds.length; i++) {
            vm.chainId(chainIds[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployTreasuryBridgeConduit.UnsupportedChain.selector, chainIds[i]));
            deployment.run();
        }
    }

    function _supportedTestnetsPassWithoutMainnetOptInOrDeployerKey() internal {
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(OWNER));
        uint256[2] memory chainIds = [uint256(5042002), 43113];
        for (uint256 i; i < chainIds.length; i++) {
            vm.chainId(chainIds[i]);
            (bool mainnet, address owner) = deployment.preflight();
            assertFalse(mainnet);
            assertEq(owner, OWNER);
        }
    }

    function _testnetZeroOwnerRejectsBeforeDeployerKey() internal {
        vm.chainId(5042002);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(address(0)));
        vm.expectRevert(bytes("BRIDGE_CONDUIT_OWNER is zero"));
        deployment.run();
    }

    function _mainnetsRequireOptInBeforeOwnerOrDeployerKey() internal {
        vm.setEnv("BRIDGE_CONDUIT_OWNER", "not-an-address");
        vm.setEnv("ALLOW_MAINNET", "0");
        uint256[2] memory chainIds = [uint256(5042), 43114];
        for (uint256 i; i < chainIds.length; i++) {
            vm.chainId(chainIds[i]);
            vm.expectRevert(bytes("mainnet chain: refused without ALLOW_MAINNET=1"));
            deployment.run();
        }
    }

    function _mainnetOptInMustBeExactlyOne() internal {
        vm.chainId(5042);
        vm.setEnv("ALLOW_MAINNET", "2");
        vm.expectRevert(bytes("mainnet chain: refused without ALLOW_MAINNET=1"));
        deployment.run();
    }

    function _mainnetWrongOwnerRejectsBeforeDeployerKey() internal {
        vm.setEnv("ALLOW_MAINNET", "1");
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(OWNER));
        uint256[2] memory chainIds = [uint256(5042), 43114];
        for (uint256 i; i < chainIds.length; i++) {
            vm.chainId(chainIds[i]);
            vm.expectRevert(bytes("mainnet owner must be the chain's Safe"));
            deployment.run();
        }
    }

    function _mainnetSafesCannotBeInterchanged() internal {
        vm.setEnv("ALLOW_MAINNET", "1");
        vm.chainId(5042);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(AVALANCHE_SAFE));
        vm.expectRevert(bytes("mainnet owner must be the chain's Safe"));
        deployment.run();
        vm.chainId(43114);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(ARC_SAFE));
        vm.expectRevert(bytes("mainnet owner must be the chain's Safe"));
        deployment.run();
    }

    function _supportedMainnetsPassOnlyWithTheirSafeAndOptIn() internal {
        vm.setEnv("ALLOW_MAINNET", "1");
        vm.chainId(5042);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(ARC_SAFE));
        (bool mainnet, address owner) = deployment.preflight();
        assertTrue(mainnet);
        assertEq(owner, ARC_SAFE);
        vm.chainId(43114);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(AVALANCHE_SAFE));
        (mainnet, owner) = deployment.preflight();
        assertTrue(mainnet);
        assertEq(owner, AVALANCHE_SAFE);
    }

    function _correctSafeDoesNotBypassMainnetOptIn() internal {
        vm.chainId(5042);
        vm.setEnv("BRIDGE_CONDUIT_OWNER", vm.toString(ARC_SAFE));
        vm.setEnv("ALLOW_MAINNET", "0");
        vm.expectRevert(bytes("mainnet chain: refused without ALLOW_MAINNET=1"));
        deployment.run();
    }
}
