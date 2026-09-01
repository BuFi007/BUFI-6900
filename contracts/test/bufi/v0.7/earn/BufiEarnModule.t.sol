// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import { Test } from "forge-std/src/Test.sol";

import { BufiEarnModule } from "../../../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import { MockMsca, MockUsdc, MockVault } from "./mocks/Mocks.sol";

contract BufiEarnModuleTest is Test {
    BufiEarnModule internal module;
    MockMsca internal account;
    MockUsdc internal usdc;
    MockVault internal vault;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal configHash;

    uint256 internal constant TREASURY_BALANCE = 1_000_000e6;

    function setUp() public {
        usdc = new MockUsdc();
        vault = new MockVault(usdc);
        module = new BufiEarnModule(relayer, owner);
        account = new MockMsca();

        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({
            chainId: block.chainid,
            token: address(usdc),
            vault: address(vault)
        });
        vm.prank(owner);
        configHash = module.setConfig(configs);

        account.installPlugin(address(module), module.manifestHash(), abi.encode(configHash));

        usdc.mint(address(account), TREASURY_BALANCE);
    }

    function test_relayerAutoEarnDepositsIntoVault() public {
        uint256 amount = 250_000e6;

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), amount);

        assertEq(usdc.balanceOf(address(account)), TREASURY_BALANCE - amount);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(amount));
        assertEq(usdc.balanceOf(address(vault)), amount);
        // shares mint to the account itself — never to relayer or module
        assertEq(vault.balanceOf(relayer), 0);
        assertEq(vault.balanceOf(address(module)), 0);
    }

    function test_ownerCanAlsoTriggerAutoEarn() public {
        vm.prank(owner);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(1e6));
    }

    function test_strangerCannotTriggerAutoEarn() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.NotAuthorized.selector, stranger));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
    }

    function test_unconfiguredTokenReverts() public {
        MockUsdc other = new MockUsdc();
        other.mint(address(account), 1e6);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(BufiEarnModule.ConfigNotFound.selector, address(other))
        );
        BufiEarnModule(address(account)).autoEarn(address(other), 1e6);
    }

    function test_directPluginCallFromUninitializedAccountReverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(BufiEarnModule.ModuleNotInitialized.selector, stranger)
        );
        module.autoEarn(address(usdc), 1e6);
    }

    function test_uninstallClearsConfigAndBlocksAutoEarn() public {
        account.uninstallPlugin("");
        assertFalse(module.isInitialized(address(account)));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                BufiEarnModule.ModuleNotInitialized.selector, address(account)
            )
        );
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
    }

    function test_installRejectsZeroConfigHash() public {
        MockMsca fresh = new MockMsca();
        bytes32 hash = module.manifestHash();
        vm.expectRevert(BufiEarnModule.InvalidConfigHash.selector);
        fresh.installPlugin(address(module), hash, abi.encode(uint256(0)));
    }

    function test_installRejectsDoubleInstall() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                BufiEarnModule.ModuleAlreadyInitialized.selector, address(account)
            )
        );
        vm.prank(address(account));
        module.onInstall(abi.encode(configHash));
    }

    function test_setConfigOnlyOwner() public {
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({
            chainId: block.chainid,
            token: address(usdc),
            vault: address(vault)
        });
        vm.prank(stranger);
        vm.expectRevert();
        module.setConfig(configs);
    }

    function test_relayerManagementOnlyOwner() public {
        // deviation from Fluidkey: relayers cannot add relayers
        vm.prank(relayer);
        vm.expectRevert();
        module.addAuthorizedRelayer(stranger);

        vm.prank(owner);
        module.addAuthorizedRelayer(stranger);
        assertTrue(module.authorizedRelayers(stranger));

        vm.prank(owner);
        module.removeAuthorizedRelayer(stranger);
        assertFalse(module.authorizedRelayers(stranger));
    }

    function test_accountCanChangeConfigHash() public {
        MockVault newVault = new MockVault(usdc);
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({
            chainId: block.chainid,
            token: address(usdc),
            vault: address(newVault)
        });
        vm.prank(owner);
        uint256 newHash = module.setConfig(configs);

        // the account itself adopts the new set (multisig action IRL)
        account.callPlugin(abi.encodeCall(BufiEarnModule.changeConfigHash, (newHash)));
        assertEq(module.accountConfig(address(account)), newHash);

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 5e6);
        assertEq(newVault.balanceOf(address(account)), newVault.convertToShares(5e6));
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function test_ownerCannotSilentlyRerouteAdoptedConfig() public {
        // re-registering a different vault under the SAME (chainId, token) list
        // produces a DIFFERENT hash — the account's adopted mapping is untouched
        MockVault evilVault = new MockVault(usdc);
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](1);
        configs[0] = BufiEarnModule.ConfigInput({
            chainId: block.chainid,
            token: address(usdc),
            vault: address(evilVault)
        });
        vm.prank(owner);
        uint256 otherHash = module.setConfig(configs);
        assertTrue(otherHash != configHash);

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), vault.convertToShares(1e6));
        assertEq(evilVault.balanceOf(address(account)), 0);
    }

    function test_getAllConfigsReturnsCurrentChainSet() public view {
        BufiEarnModule.ConfigWithToken[] memory configs = module.getAllConfigs(address(account));
        assertEq(configs.length, 1);
        assertEq(configs[0].token, address(usdc));
        assertEq(configs[0].vault, address(vault));
    }

    function test_manifestHashMatchesManifestEncoding() public view {
        assertEq(
            module.manifestHash(), keccak256(abi.encode(module.pluginManifest()))
        );
    }

    function test_multiChainConfigSharesOneHash() public {
        // Avalanche (43114) + Arc entries in one set: only the current chain's
        // mapping resolves; the other chain's tokens don't leak in
        BufiEarnModule.ConfigInput[] memory configs = new BufiEarnModule.ConfigInput[](2);
        configs[0] = BufiEarnModule.ConfigInput({
            chainId: 43_114,
            token: address(usdc),
            vault: address(vault)
        });
        configs[1] = BufiEarnModule.ConfigInput({
            chainId: block.chainid,
            token: address(usdc),
            vault: address(vault)
        });
        vm.prank(owner);
        uint256 multiHash = module.setConfig(configs);

        assertEq(module.getTokens(multiHash, 43_114).length, 1);
        assertEq(module.getTokens(multiHash, block.chainid).length, 1);
        assertEq(module.config(multiHash, 43_114, address(usdc)), address(vault));
    }
}
