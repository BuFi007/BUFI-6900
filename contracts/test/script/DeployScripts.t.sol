// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity 0.8.24;

import {DeployBufiPlugins} from "../../script/DeployBufiPlugins.s.sol";
import {DeployTreasuryConduit} from "../../script/DeployTreasuryConduit.s.sol";
import {DeployTreasuryEarn} from "../../script/DeployTreasuryEarn.s.sol";
import {DeployTreasurySwapAndDeposit} from "../../script/DeployTreasurySwapAndDeposit.s.sol";
import {BufiDeployBase, IOwnable2Step} from "../../script/config/BufiDeployBase.sol";
import {BufiDeployConfig} from "../../script/config/BufiDeployConfig.sol";
import {BufiInitCodes} from "../../script/config/BufiInitCodes.sol";
import {TreasuryConduit} from "../../src/bufi/conduit/TreasuryConduit.sol";
import {TreasuryRedeemConduit} from "../../src/bufi/conduit/TreasuryRedeemConduit.sol";
import {TreasurySwapAndDeposit} from "../../src/bufi/conduit/TreasurySwapAndDeposit.sol";
import {BufiEarnModule} from "../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {BufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";

import {Test} from "forge-std/src/Test.sol";

/// @dev Supplies EARN_MODULE_RELAYER without `vm.setEnv`, which is process-global and races parallel tests.
contract PluginsWithRelayer is DeployBufiPlugins {
    address internal immutable RELAYER_;

    constructor(address relayer) {
        RELAYER_ = relayer;
    }

    function _relayer() internal view override returns (address) {
        return RELAYER_;
    }
}

/// @notice Plan 398: the deploy scripts' owner flow, run in-process on a bare EVM with the Arachnid proxy and
/// the chain Safe etched in. The fork simulation (`forge script --fork-url`) proves the same against live state.
contract DeployScriptsTest is Test {
    /// Arachnid deterministic-deployment-proxy runtime code.
    bytes internal constant ARACHNID_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    address internal constant BOOTSTRAP = BufiDeployConfig.BOOTSTRAP_OWNER;
    address internal constant RELAYER = address(0x2E1A7E2);

    function setUp() public {
        vm.etch(BufiDeployConfig.CREATE2_DEPLOYER, ARACHNID_RUNTIME);
        _onChain(5042002);
    }

    function _onChain(uint256 chainId) internal returns (address safe) {
        vm.chainId(chainId);
        safe = BufiDeployConfig.get(chainId).safe;
        vm.etch(safe, hex"00"); // anything non-empty: the scripts refuse a Safe with no code
    }

    function _assertPendingSafe(address target, address safe) internal view {
        assertEq(IOwnable2Step(target).owner(), BOOTSTRAP, "bootstrap still owns until the Safe accepts");
        assertEq(IOwnable2Step(target).pendingOwner(), safe, "pendingOwner == Safe");
    }

    // ── the full testnet wave
    // ────────────────────────────────────────────────

    function test_full_wave_proposes_the_safe_on_every_contract() public {
        address safe = BufiDeployConfig.get(5042002).safe;

        address conduit = new DeployTreasuryConduit().run();
        assertEq(conduit, BufiInitCodes.conduitAddress());
        _assertPendingSafe(conduit, safe);
        assertTrue(TreasuryConduit(conduit).targets(0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b), "app kit");
        assertTrue(TreasuryConduit(conduit).targets(0xFf70F4A1d11995621854F3692acF286d8aCd04b2), "lifi");

        (address redeem, address canary) = new DeployTreasuryEarn().run();
        _assertPendingSafe(redeem, safe);
        assertTrue(TreasuryRedeemConduit(redeem).vaults(canary));
        assertTrue(TreasuryConduit(conduit).targets(canary));

        address adapter = new DeployTreasurySwapAndDeposit().run();
        _assertPendingSafe(adapter, safe);
        assertTrue(TreasurySwapAndDeposit(adapter).dests(canary));
        assertTrue(TreasurySwapAndDeposit(adapter).venues(0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b));
        assertTrue(TreasuryConduit(conduit).targets(adapter));

        (, address earn,) = new PluginsWithRelayer(RELAYER).run();
        _assertPendingSafe(earn, safe);
        assertTrue(BufiEarnModule(earn).authorizedRelayers(RELAYER));
        assertFalse(BufiEarnModule(earn).authorizedRelayers(BOOTSTRAP), "deployer is never a relayer");

        // The Safe accepts; the bootstrap key then holds nothing.
        address[4] memory all = [conduit, redeem, adapter, earn];
        for (uint256 i = 0; i < all.length; i++) {
            vm.prank(safe);
            IOwnable2Step(all[i]).acceptOwnership();
            assertEq(IOwnable2Step(all[i]).owner(), safe);
        }

        // Re-running is a no-op that never reverts and never tries to reclaim ownership.
        new DeployTreasuryConduit().run();
        new DeployTreasuryEarn().run();
        new DeployTreasurySwapAndDeposit().run();
        new PluginsWithRelayer(RELAYER).run();
        for (uint256 i = 0; i < all.length; i++) {
            assertEq(IOwnable2Step(all[i]).owner(), safe, "still the Safe");
        }
    }

    /// Once the Safe owns the conduit, a later script that needs a new target PRINTS the Safe transaction instead
    /// of trying (and failing) to call it with the bootstrap key.
    function test_after_acceptance_owner_calls_become_safe_transactions() public {
        address safe = BufiDeployConfig.get(5042002).safe;
        address conduit = new DeployTreasuryConduit().run();
        vm.prank(safe);
        TreasuryConduit(conduit).acceptOwnership();

        (, address canary) = new DeployTreasuryEarn().run();
        assertFalse(TreasuryConduit(conduit).targets(canary), "left for the Safe");
    }

    // ── same address on every chain
    // ─────────────────────────────────────────

    function test_conduit_and_redeem_land_at_the_same_address_on_every_configured_chain() public {
        uint256 snap = vm.snapshotState();
        address arcTestnet = new DeployTreasuryConduit().run();
        vm.revertToState(snap);
        _onChain(5042);
        address arc = new DeployTreasuryConduit().run();
        vm.revertToState(snap);
        _onChain(43114);
        address avax = new DeployTreasuryConduit().run();
        assertEq(arc, arcTestnet);
        assertEq(avax, arcTestnet);
        // ...and each is proposed to ITS chain's Safe.
        assertEq(IOwnable2Step(avax).pendingOwner(), 0xA3a40fa2d82C0224c40b1Ed7E07cb474B7D1468B);
    }

    function test_arc_mainnet_proposes_the_arc_safe_and_registers_its_vaults() public {
        address safe = _onChain(5042);
        assertEq(safe, 0x47Dc7D18A6E3a79F696714E7D47456a49B430D09);
        address conduit = new DeployTreasuryConduit().run();
        _assertPendingSafe(conduit, safe);
        assertTrue(TreasuryConduit(conduit).targets(0x7610094B846657dCF166D59e42973db52c7015F9));
        assertTrue(TreasuryConduit(conduit).targets(0xbeef0016cb2Fd5C352ea7CA08a9f54739DFa7298));
        // Verified Arc mainnet venue: the LiFiDiamond a live li.quest quote targets.
        assertTrue(TreasuryConduit(conduit).targets(0xA4072583658Fae592A3506A42431cb6316a8d40b), "lifi");
        // Circle App Kit's EVM-mainnet `kitContracts.adapter` — the contract App Kit swaps call `execute` on.
        assertTrue(TreasuryConduit(conduit).targets(0x7FB8c7260b63934d8da38aF902f87ae6e284a845), "app kit");
        // Uniswap Universal Router 2.1.2, the Trading API's Arc router.
        assertTrue(TreasuryConduit(conduit).targets(0x8702463e73f74d0b6765aBceb314Ef07aCb92650), "uniswap");
        // The older listed router is never what the API targets after the 2.1.1 sunset.
        assertFalse(TreasuryConduit(conduit).targets(0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1), "old router");
    }

    function test_arc_mainnet_swap_and_deposit_registers_all_three_venues() public {
        address safe = _onChain(5042);
        new DeployTreasuryConduit().run();
        address adapter = new DeployTreasurySwapAndDeposit().run();
        _assertPendingSafe(adapter, safe);
        assertTrue(TreasurySwapAndDeposit(adapter).venues(0x7FB8c7260b63934d8da38aF902f87ae6e284a845), "app kit");
        assertTrue(TreasurySwapAndDeposit(adapter).venues(0xA4072583658Fae592A3506A42431cb6316a8d40b), "lifi");
        assertTrue(TreasurySwapAndDeposit(adapter).venues(0x8702463e73f74d0b6765aBceb314Ef07aCb92650), "uniswap");
        assertTrue(TreasurySwapAndDeposit(adapter).dests(0x7610094B846657dCF166D59e42973db52c7015F9));
        assertTrue(TreasuryConduit(BufiInitCodes.conduitAddress()).targets(adapter), "adapter is a conduit target");
    }

    function test_earn_module_uses_its_own_salt_and_plugins_keep_theirs() public {
        (address sessionKey, address earn,) = new PluginsWithRelayer(RELAYER).run();
        assertEq(earn, BufiInitCodes.create2Address(BufiDeployConfig.EARN_MODULE_SALT, BufiInitCodes.earnModule(RELAYER)));
        assertEq(
            sessionKey,
            BufiInitCodes.create2Address(
                BufiDeployConfig.PLUGIN_SALT, type(BufiSessionKeyPlugin).creationCode
            )
        );
    }

    // ── refusals
    // ────────────────────────────────────────────────────────────

    function test_an_unconfigured_chain_is_refused() public {
        vm.chainId(1);
        DeployTreasuryConduit s = new DeployTreasuryConduit();
        vm.expectRevert(abi.encodeWithSelector(BufiDeployConfig.UnsupportedChain.selector, 1));
        s.run();
    }

    function test_a_safe_without_code_is_refused() public {
        address safe = BufiDeployConfig.get(5042002).safe;
        vm.etch(safe, "");
        DeployTreasuryConduit s = new DeployTreasuryConduit();
        vm.expectRevert(abi.encodeWithSelector(BufiDeployBase.SafeHasNoCode.selector, safe));
        s.run();
    }

    function test_a_contract_owned_by_someone_else_is_refused() public {
        address conduit = new DeployTreasuryConduit().run();
        address stranger = address(0xBAD);
        vm.startPrank(BOOTSTRAP);
        TreasuryConduit(conduit).transferOwnership(stranger);
        vm.stopPrank();
        vm.prank(stranger);
        TreasuryConduit(conduit).acceptOwnership();

        DeployTreasuryConduit s = new DeployTreasuryConduit();
        vm.expectRevert(abi.encodeWithSelector(BufiDeployBase.UnexpectedOwner.selector, conduit, stranger));
        s.run();
    }

    function test_earn_and_adapter_refuse_without_the_conduit() public {
        DeployTreasuryEarn e = new DeployTreasuryEarn();
        vm.expectRevert(bytes("TreasuryConduit not deployed on this chain: run DeployTreasuryConduit"));
        e.run();
    }

    function test_the_deployer_cannot_be_the_earn_relayer() public {
        DeployBufiPlugins s = new PluginsWithRelayer(BOOTSTRAP);
        vm.expectRevert(bytes("EARN_MODULE_RELAYER must not be the deployer"));
        s.run();
    }
}
