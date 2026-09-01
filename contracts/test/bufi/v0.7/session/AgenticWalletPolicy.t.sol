// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../../../harness/SessionKeyHarness.sol";

import {IBufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {PublicKey} from "@circle/common/CommonStructs.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";

/// @notice BUFI "agentic wallet policy" scenarios, in the vocabulary of a grant: the workspace owners (a Circle
///         weighted passkey multisig, EOA-signed here) grant an AI agent's session key {scope, budget, expiry}.
///
///           scope  = access list: USDC `transfer` only
///           budget = ERC-20 spend limit: 500 USDC per 24h
///           expiry = time range: 7 days
contract AgenticWalletPolicyTest is SessionKeyHarness {
    UpgradableMSCA internal workspace;
    Signer[] internal owners;
    Signer internal agent;

    SandboxUSDC internal usdc;
    address internal vendor;
    address internal attacker;

    uint256 internal constant GRANT_START = 1_720_000_000;
    uint256 internal constant DAILY_BUDGET = 500e6;
    uint48 internal constant BUDGET_WINDOW = 1 days;
    uint48 internal constant GRANT_DURATION = 7 days;

    function setUp() public {
        vm.warp(GRANT_START);
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();

        (UpgradableMSCA msca, Signer[] memory q) = _createAccountWithSessionKeyPlugin("founder", bytes32(uint256(31)));
        workspace = msca;
        owners.push(q[0]);
        owners.push(q[1]);

        agent = _signerFrom("bu-agent");
        usdc = new SandboxUSDC();
        usdc.mint(address(workspace), 100_000e6);
        vendor = makeAddr("vendor");
        attacker = makeAddr("attacker");
    }

    /// @dev The grant, as the owners encode it.
    function _grant() internal view returns (bytes[] memory) {
        return _updates(
            _permAddressEntry(address(usdc), true, true),
            _permFunctionEntry(address(usdc), usdc.transfer.selector, true),
            _permErc20Limit(address(usdc), DAILY_BUDGET, BUDGET_WINDOW),
            _permTimeRange(uint48(GRANT_START), uint48(GRANT_START + GRANT_DURATION))
        );
    }

    function _agentPays(address to, uint256 amount) internal returns (bool ok) {
        (ok,) = _executeSessionKeyUserOpWithReason(workspace, _calls(_erc20Transfer(address(usdc), to, amount)), agent);
    }

    function _budgetUsed() internal view returns (uint256) {
        return sessionKeyPlugin.getERC20SpendLimitInfo(address(workspace), agent.addr, address(usdc)).limitUsed;
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  grant_scope_budget_expiry                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_grant_scope_budget_expiry() public {
        // Owners grant the agent {USDC.transfer only, 500 USDC / 24h, 7 days} in ONE multisig userOp.
        assertTrue(_addSessionKey(workspace, agent.addr, bytes32("bu-agent"), _grant(), owners));

        // Day 0: 200 + 250 within budget.
        assertTrue(_agentPays(vendor, 200e6));
        assertTrue(_agentPays(vendor, 250e6));
        assertEq(usdc.balanceOf(vendor), 450e6);
        assertEq(_budgetUsed(), 450e6);

        // 100 more would be 550 > 500: rejected, nothing moves.
        assertFalse(_agentPays(vendor, 100e6));
        assertEq(usdc.balanceOf(vendor), 450e6);
        assertEq(_budgetUsed(), 450e6);

        // Day 1: the window rolled over, the budget is fresh.
        vm.warp(GRANT_START + 1 days);
        assertTrue(_agentPays(vendor, 100e6));
        assertEq(usdc.balanceOf(vendor), 550e6);
        assertEq(_budgetUsed(), 100e6);

        // Day 6, still inside the grant.
        vm.warp(GRANT_START + 6 days);
        assertTrue(_agentPays(vendor, 500e6));
        assertEq(usdc.balanceOf(vendor), 1_050e6);

        // Day 7 + 1s: expired — the EntryPoint rejects the op before anything runs.
        vm.warp(GRANT_START + GRANT_DURATION + 1);
        _expectSessionKeyValidationRevert(workspace, _calls(_erc20Transfer(address(usdc), vendor, 1e6)), agent, _aa22());
        assertEq(usdc.balanceOf(vendor), 1_050e6);
    }

    function test_grant_scope_isExactlyUsdcTransfer() public {
        assertTrue(_addSessionKey(workspace, agent.addr, bytes32("bu-agent"), _grant(), owners));

        // approve is outside the scope.
        _expectSessionKeyValidationRevert(
            workspace, _calls(_erc20Approve(address(usdc), attacker, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
        // Any other contract is outside the scope, even with an innocuous selector.
        SandboxUSDC other = new SandboxUSDC();
        other.mint(address(workspace), 1_000e6);
        _expectSessionKeyValidationRevert(
            workspace, _calls(_erc20Transfer(address(other), vendor, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
        // Native value is outside the scope (default native limit is zero).
        _expectSessionKeyValidationRevert(
            workspace, _calls(_nativeTransfer(vendor, 1 wei)), agent, _aa23PermissionsCheckFailed()
        );
        // Smuggling an out-of-scope call into a batch poisons the whole batch.
        _expectSessionKeyValidationRevert(
            workspace,
            _calls(_erc20Transfer(address(usdc), vendor, 1e6), _erc20Approve(address(usdc), attacker, 1e6)),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(usdc.allowance(address(workspace), attacker), 0);
        assertEq(usdc.balanceOf(vendor), 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  agent_cannot_escalate                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_agent_cannot_escalate() public {
        assertTrue(_addSessionKey(workspace, agent.addr, bytes32("bu-agent"), _grant(), owners));
        Signer memory accomplice = _signerFrom("accomplice");

        bytes[] memory attempts = new bytes[](6);
        // Add a second key.
        attempts[0] = _addSessionKeyCalldata(accomplice.addr, bytes32(0), _permUnrestricted());
        // Lift its own limits.
        attempts[1] = abi.encodeCall(
            IBufiSessionKeyPlugin.updateKeyPermissions,
            (
                agent.addr,
                _updates(_permAllowAll(), _permNativeUnlimited(), _permErc20Limit(address(usdc), type(uint256).max, 0))
            )
        );
        // Rotate itself to a key the owners never saw.
        attempts[2] =
            abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (agent.addr, bytes32(uint256(1)), accomplice.addr));
        // Install / uninstall plugins.
        attempts[3] = _installPluginCalldata(
            address(addressBookPlugin), abi.encode(new address[](0)), _addressBookDependencies()
        );
        attempts[4] = abi.encodeCall(IPluginManager.uninstallPlugin, (address(sessionKeyPlugin), "", ""));
        // Become an owner.
        address[] memory newOwners = new address[](1);
        newOwners[0] = agent.addr;
        attempts[5] = abi.encodeCall(
            weightedPlugin.addOwners, (newOwners, _uniformWeights(1, 100), new PublicKey[](0), new uint256[](0), 1)
        );

        for (uint256 i = 0; i < attempts.length; i++) {
            PackedUserOperation memory op = _buildUserOp(address(workspace), attempts[i]);
            op.signature = _signSessionKey(op, agent.key);
            _expectHandleOpsRevert(op, "");
        }

        // Nor from inside executeWithSessionKey: the scoped grant rejects the account and the plugin as targets
        // at validation (an unrestricted key would be refused by the account at execution instead — see
        // SessionKeyOnCircleMsca.t.sol). Nor at runtime: the management functions are fail-closed for everyone.
        _expectSessionKeyValidationRevert(
            workspace, _calls(_call(address(workspace), 0, attempts[0])), agent, _aa23PermissionsCheckFailed()
        );
        _expectSessionKeyValidationRevert(
            workspace, _calls(_call(address(sessionKeyPlugin), 0, attempts[0])), agent, _aa23PermissionsCheckFailed()
        );
        vm.prank(agent.addr);
        vm.expectRevert();
        IBufiSessionKeyPlugin(address(workspace)).addSessionKey(accomplice.addr, bytes32(0), _permUnrestricted());

        // Nothing changed.
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(workspace), accomplice.addr));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(workspace), agent.addr));
        assertEq(
            sessionKeyPlugin.getERC20SpendLimitInfo(address(workspace), agent.addr, address(usdc)).limit, DAILY_BUDGET
        );
        assertEq(
            uint8(sessionKeyPlugin.getAccessControlType(address(workspace), agent.addr)),
            uint8(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST)
        );
        assertTrue(_isInstalled(workspace, address(sessionKeyPlugin)));
        assertFalse(_isInstalled(workspace, address(addressBookPlugin)));
        // The grant itself is intact and usable.
        assertTrue(_agentPays(vendor, 1e6));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  owner_revokes_mid_grant                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_owner_revokes_mid_grant() public {
        assertTrue(_addSessionKey(workspace, agent.addr, bytes32("bu-agent"), _grant(), owners));
        assertTrue(_agentPays(vendor, 100e6));
        assertEq(usdc.balanceOf(vendor), 100e6);

        // Day 3: owners pull the key.
        vm.warp(GRANT_START + 3 days);
        assertTrue(_removeSessionKey(workspace, agent.addr, owners));
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(workspace), agent.addr));

        _expectSessionKeyValidationRevert(
            workspace, _calls(_erc20Transfer(address(usdc), vendor, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
        assertEq(usdc.balanceOf(vendor), 100e6);

        // A userOp the agent signed BEFORE the revocation is equally dead once it lands after it.
        PackedUserOperation memory stale =
            _prepareSessionKeyUserOp(workspace, _calls(_erc20Transfer(address(usdc), vendor, 1e6)), agent);
        _expectHandleOpsRevert(stale, _aa23PermissionsCheckFailed());
    }

    function test_owner_shrinks_budget_mid_grant() public {
        assertTrue(_addSessionKey(workspace, agent.addr, bytes32("bu-agent"), _grant(), owners));
        assertTrue(_agentPays(vendor, 100e6));

        // Owners cut the budget to 50 USDC/day. Upstream semantics (kept verbatim): reconfiguring a limit restarts
        // the window but does NOT clear `limitUsed` — the 100 already spent carries over, so the agent is frozen
        // until the window rolls over, then gets exactly the new budget.
        assertTrue(
            _updateKeyPermissions(
                workspace, agent.addr, _updates(_permErc20Limit(address(usdc), 50e6, BUDGET_WINDOW)), owners
            )
        );
        assertEq(_budgetUsed(), 100e6, "usage carried over the reconfiguration");
        assertFalse(_agentPays(vendor, 1e6));

        vm.warp(block.timestamp + BUDGET_WINDOW);
        assertFalse(_agentPays(vendor, 51e6));
        assertTrue(_agentPays(vendor, 50e6));
        assertEq(usdc.balanceOf(vendor), 150e6);

        // Owners freeze the key entirely by shrinking its expiry into the past.
        assertTrue(
            _updateKeyPermissions(
                workspace,
                agent.addr,
                _updates(_permTimeRange(uint48(GRANT_START), uint48(block.timestamp - 1))),
                owners
            )
        );
        _expectSessionKeyValidationRevert(workspace, _calls(_erc20Transfer(address(usdc), vendor, 1e6)), agent, _aa22());
        assertEq(usdc.balanceOf(vendor), 150e6);
    }
}
