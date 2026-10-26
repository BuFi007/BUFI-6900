// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {DeployTreasuryConduitPermit2} from "../../../../script/DeployTreasuryConduitPermit2.s.sol";
import {TreasuryConduitPermit2} from "../../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {Test} from "forge-std/src/Test.sol";

/// @notice Local deployment/configuration proofs only. No RPC or broadcast.
contract TreasuryConduitPermit2DeploymentTest is Test {
    DeployTreasuryConduitPermit2 internal deployment;
    address internal constant AVALANCHE_SAFE = 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B;

    function setUp() public {
        deployment = new DeployTreasuryConduitPermit2();
    }

    function test_arc_configuration_keeps_its_existing_safe_and_permit2_hash() public view {
        (address owner, bytes32 permit2Hash) = deployment.deploymentConfig(5042);
        assertEq(owner, deployment.ARC_SAFE());
        assertEq(permit2Hash, 0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f);
    }

    function test_avalanche_configuration_has_its_own_safe_and_verified_permit2_hash() public view {
        (address owner, bytes32 permit2Hash) = deployment.deploymentConfig(43114);
        assertEq(owner, AVALANCHE_SAFE);
        assertEq(permit2Hash, 0x081beff14e75c5a5c1e60740445f58d54ba0fef228148a11d3e4287dc3551cbb);
    }

    function test_supported_chains_keep_the_same_dependency_addresses_and_salt() public view {
        assertEq(deployment.PERMIT2(), 0x000000000022D473030F116dDEE9F6B43aC78BA3);
        assertEq(deployment.ADDRESS_BOOK(), 0x0000000d81083B16EA76dfab46B0315B0eDBF3d0);
        assertEq(deployment.CREATE2_DEPLOYER(), 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        assertEq(deployment.SALT(), keccak256("bufi.treasury-conduit-permit2.v1"));
    }

    function test_unsupported_chain_is_refused_before_any_deployment() public {
        vm.chainId(43113);
        vm.expectRevert("Arc or Avalanche mainnet only");
        deployment.run(AVALANCHE_SAFE);
    }

    function test_chain_owner_cannot_be_swapped() public {
        address arcSafe = deployment.ARC_SAFE();
        vm.chainId(43114);
        vm.expectRevert("owner must be the chain Safe");
        deployment.run(arcSafe);
        vm.chainId(5042);
        vm.expectRevert("owner must be the chain Safe");
        deployment.run(AVALANCHE_SAFE);
    }

    function test_avalanche_missing_safe_and_changed_permit2_are_refused() public {
        vm.chainId(43114);
        vm.expectRevert("Safe missing");
        deployment.run(AVALANCHE_SAFE);
        vm.etch(AVALANCHE_SAFE, hex"00");
        vm.etch(deployment.PERMIT2(), hex"00");
        vm.expectRevert("Permit2 code changed");
        deployment.run(AVALANCHE_SAFE);
    }

    function test_exact_frozen_release_preserves_arc_prediction_and_distinguishes_avalanche() public view {
        string memory artifact =
            vm.readFile("out-permit2-release/TreasuryConduitPermit2.sol/TreasuryConduitPermit2.json");
        bytes memory frozenCreation = vm.parseJsonBytes(artifact, ".bytecode.object");
        assertEq(keccak256(type(TreasuryConduitPermit2).creationCode), keccak256(frozenCreation));
        (address arcOwner,) = deployment.deploymentConfig(5042);
        (address avalancheOwner,) = deployment.deploymentConfig(43114);
        bytes32 arcInitHash = keccak256(
            abi.encodePacked(frozenCreation, abi.encode(arcOwner, deployment.PERMIT2(), deployment.ADDRESS_BOOK()))
        );
        bytes32 avalancheInitHash = keccak256(
            abi.encodePacked(
                frozenCreation, abi.encode(avalancheOwner, deployment.PERMIT2(), deployment.ADDRESS_BOOK())
            )
        );
        assertEq(
            vm.computeCreate2Address(deployment.SALT(), arcInitHash, deployment.CREATE2_DEPLOYER()),
            0xB63DA0934E2a89169F89EED0679c35cc4d5959a5
        );
        assertEq(avalancheInitHash, 0x3b894ecb29543d83c87d595d03a85a84782d0dd6d0af68530ff1eea7cc919e6c);
        assertEq(
            vm.computeCreate2Address(deployment.SALT(), avalancheInitHash, deployment.CREATE2_DEPLOYER()),
            0xAeBB9c395AB6D627Eb0deFc3b16E7f49dc30C19F
        );
    }

    function test_safe_initializer_does_not_change_frozen_runtime() public {
        // Constructor dependency-presence stubs; this does not certify live dependency code.
        vm.etch(deployment.PERMIT2(), hex"00");
        vm.etch(deployment.ADDRESS_BOOK(), hex"00");
        TreasuryConduitPermit2 arc =
            new TreasuryConduitPermit2(deployment.ARC_SAFE(), deployment.PERMIT2(), deployment.ADDRESS_BOOK());
        TreasuryConduitPermit2 avalanche =
            new TreasuryConduitPermit2(AVALANCHE_SAFE, deployment.PERMIT2(), deployment.ADDRESS_BOOK());
        assertEq(address(arc).codehash, address(avalanche).codehash);
        assertEq(address(avalanche).codehash, 0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79);
        assertEq(avalanche.owner(), AVALANCHE_SAFE);
    }
}
