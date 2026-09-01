// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleCanonical} from "../../../harness/CircleCanonical.sol";
import {SessionCounter, SessionKeyHarness, SessionTestPaymaster} from "../../../harness/SessionKeyHarness.sol";

import {BufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {
    ISessionKeyPermissionsUpdates
} from "../../../../src/bufi/v0.7/session/permissions/ISessionKeyPermissionsUpdates.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

// The audited upstream interfaces, compiled side by side to prove ABI equality.
import {ISessionKeyPlugin as AlchemySessionKeyPlugin} from "@alchemy-mav1/plugins/session/ISessionKeyPlugin.sol";
import {
    ISessionKeyPermissionsUpdates as AlchemyPermissionsUpdates
} from "@alchemy-mav1/plugins/session/permissions/ISessionKeyPermissionsUpdates.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {PublicKey} from "@circle/common/CommonStructs.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {PluginMetadata} from "@circle/msca/6900/v0.7/common/PluginManifest.sol";
import {Call, ExecutionFunctionConfig, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPlugin} from "@circle/msca/6900/v0.7/interfaces/IPlugin.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Integration of BufiSessionKeyPlugin on Circle's production UpgradableMSCA: install with the production
///         dependency slots, manifest stability, ABI equality with the audited Alchemy interface, and the full
///         owner-grants / agent-spends / owner-revokes lifecycle through the EntryPoint.
contract SessionKeyOnCircleMscaTest is SessionKeyHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    SandboxUSDC internal usdc;
    SessionCounter internal counter;
    address internal merchant;
    address internal stranger;

    uint256 internal constant T0 = 1_700_000_000;

    function setUp() public {
        vm.warp(T0);
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();

        (UpgradableMSCA msca, Signer[] memory q) = _createAccountWithSessionKeyPlugin("treasury", bytes32(uint256(11)));
        account = msca;
        quorum.push(q[0]);
        quorum.push(q[1]);

        agent = _signerFrom("agent");
        usdc = new SandboxUSDC();
        usdc.mint(address(account), 10_000e6);
        counter = new SessionCounter();
        merchant = makeAddr("merchant");
        stranger = makeAddr("stranger");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Install / manifest / ABI                                                       ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_installedWithProductionDependencySlots() public view {
        assertTrue(_isInstalled(account, address(sessionKeyPlugin)));
        assertTrue(_isInstalled(account, address(weightedPlugin)));

        // executeWithSessionKey: validated by the plugin itself (SELF, function id 0), no runtime validation.
        ExecutionFunctionConfig memory cfg =
            account.getExecutionFunctionConfig(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(cfg.plugin, address(sessionKeyPlugin));
        assertEq(cfg.userOpValidationFunction.plugin, address(sessionKeyPlugin));
        assertEq(
            cfg.userOpValidationFunction.functionId,
            uint8(IBufiSessionKeyPlugin.FunctionId.USER_OP_VALIDATION_SESSION_KEY)
        );
        assertEq(cfg.runtimeValidationFunction.plugin, address(0));

        // Key management: userOp path → Weighted owner validation (id 0); runtime path → Weighted id 1
        // (unimplemented).
        bytes4[4] memory management = [
            IBufiSessionKeyPlugin.addSessionKey.selector,
            IBufiSessionKeyPlugin.removeSessionKey.selector,
            IBufiSessionKeyPlugin.rotateSessionKey.selector,
            IBufiSessionKeyPlugin.updateKeyPermissions.selector
        ];
        for (uint256 i = 0; i < management.length; i++) {
            cfg = account.getExecutionFunctionConfig(management[i]);
            assertEq(cfg.plugin, address(sessionKeyPlugin));
            assertEq(cfg.userOpValidationFunction.plugin, address(weightedPlugin));
            assertEq(cfg.userOpValidationFunction.functionId, CircleCanonical.WEIGHTED_USER_OP_VALIDATION_OWNER);
            assertEq(cfg.runtimeValidationFunction.plugin, address(weightedPlugin));
            assertEq(cfg.runtimeValidationFunction.functionId, CircleCanonical.WEIGHTED_RUNTIME_DEPENDENCY_FAIL_CLOSED);
        }

        // The always-deny pre-runtime hook on executeWithSessionKey is registered; there is no pre-userOp hook.
        (FunctionReference[] memory preUserOpHooks, FunctionReference[] memory preRuntimeHooks) =
            account.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(preUserOpHooks.length, 0);
        assertEq(preRuntimeHooks.length, 1);
    }

    function test_manifestHashIsStable() public view {
        bytes32 h1 = keccak256(abi.encode(sessionKeyPlugin.pluginManifest()));
        bytes32 h2 = keccak256(abi.encode(sessionKeyPlugin.pluginManifest()));
        assertEq(h1, h2);
        // The install helper computed the same hash; PluginManager would have reverted InvalidPluginManifestHash
        // otherwise. Re-derive it the way the SDK does and compare.
        assertEq(h1, keccak256(abi.encode(IPlugin(address(sessionKeyPlugin)).pluginManifest())));

        PluginMetadata memory metadata = sessionKeyPlugin.pluginMetadata();
        assertEq(metadata.name, "BUFI Session Key Plugin");
        assertEq(metadata.version, "1.0.1");
        assertEq(metadata.permissionDescriptors.length, 4);
    }

    function test_supportsInterface() public view {
        assertTrue(sessionKeyPlugin.supportsInterface(type(IPlugin).interfaceId), "Circle IPlugin");
        assertTrue(sessionKeyPlugin.supportsInterface(type(IBufiSessionKeyPlugin).interfaceId));
        assertTrue(sessionKeyPlugin.supportsInterface(type(IERC165).interfaceId));
        assertFalse(sessionKeyPlugin.supportsInterface(0xffffffff));
    }

    /// @dev The TypeScript SDK is written against Alchemy's ABI: every selector (and therefore the ERC-165
    ///      interface id) must be identical.
    function test_abiMatchesAlchemyInterface() public pure {
        assertEq(type(IBufiSessionKeyPlugin).interfaceId, type(AlchemySessionKeyPlugin).interfaceId, "interfaceId");

        assertEq(
            IBufiSessionKeyPlugin.executeWithSessionKey.selector, AlchemySessionKeyPlugin.executeWithSessionKey.selector
        );
        assertEq(IBufiSessionKeyPlugin.addSessionKey.selector, AlchemySessionKeyPlugin.addSessionKey.selector);
        assertEq(IBufiSessionKeyPlugin.removeSessionKey.selector, AlchemySessionKeyPlugin.removeSessionKey.selector);
        assertEq(IBufiSessionKeyPlugin.rotateSessionKey.selector, AlchemySessionKeyPlugin.rotateSessionKey.selector);
        assertEq(
            IBufiSessionKeyPlugin.updateKeyPermissions.selector, AlchemySessionKeyPlugin.updateKeyPermissions.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.resetSessionKeyGasLimitTimestamp.selector,
            AlchemySessionKeyPlugin.resetSessionKeyGasLimitTimestamp.selector
        );
        assertEq(IBufiSessionKeyPlugin.sessionKeysOf.selector, AlchemySessionKeyPlugin.sessionKeysOf.selector);
        assertEq(IBufiSessionKeyPlugin.isSessionKeyOf.selector, AlchemySessionKeyPlugin.isSessionKeyOf.selector);
        assertEq(IBufiSessionKeyPlugin.findPredecessor.selector, AlchemySessionKeyPlugin.findPredecessor.selector);
        assertEq(
            IBufiSessionKeyPlugin.getAccessControlType.selector, AlchemySessionKeyPlugin.getAccessControlType.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.getAccessControlEntry.selector, AlchemySessionKeyPlugin.getAccessControlEntry.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.isSelectorOnAccessControlList.selector,
            AlchemySessionKeyPlugin.isSelectorOnAccessControlList.selector
        );
        assertEq(IBufiSessionKeyPlugin.getKeyTimeRange.selector, AlchemySessionKeyPlugin.getKeyTimeRange.selector);
        assertEq(
            IBufiSessionKeyPlugin.getNativeTokenSpendLimitInfo.selector,
            AlchemySessionKeyPlugin.getNativeTokenSpendLimitInfo.selector
        );
        assertEq(IBufiSessionKeyPlugin.getGasSpendLimit.selector, AlchemySessionKeyPlugin.getGasSpendLimit.selector);
        assertEq(
            IBufiSessionKeyPlugin.getERC20SpendLimitInfo.selector,
            AlchemySessionKeyPlugin.getERC20SpendLimitInfo.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.getRequiredPaymaster.selector, AlchemySessionKeyPlugin.getRequiredPaymaster.selector
        );

        // Permission-update encodings.
        assertEq(
            ISessionKeyPermissionsUpdates.setAccessListType.selector,
            AlchemyPermissionsUpdates.setAccessListType.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.updateAccessListAddressEntry.selector,
            AlchemyPermissionsUpdates.updateAccessListAddressEntry.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.updateAccessListFunctionEntry.selector,
            AlchemyPermissionsUpdates.updateAccessListFunctionEntry.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.updateTimeRange.selector, AlchemyPermissionsUpdates.updateTimeRange.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.setNativeTokenSpendLimit.selector,
            AlchemyPermissionsUpdates.setNativeTokenSpendLimit.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.setERC20SpendLimit.selector,
            AlchemyPermissionsUpdates.setERC20SpendLimit.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.setGasSpendLimit.selector, AlchemyPermissionsUpdates.setGasSpendLimit.selector
        );
        assertEq(
            ISessionKeyPermissionsUpdates.setRequiredPaymaster.selector,
            AlchemyPermissionsUpdates.setRequiredPaymaster.selector
        );

        // Events and errors.
        assertEq(IBufiSessionKeyPlugin.SessionKeyAdded.selector, AlchemySessionKeyPlugin.SessionKeyAdded.selector);
        assertEq(IBufiSessionKeyPlugin.SessionKeyRemoved.selector, AlchemySessionKeyPlugin.SessionKeyRemoved.selector);
        assertEq(IBufiSessionKeyPlugin.SessionKeyRotated.selector, AlchemySessionKeyPlugin.SessionKeyRotated.selector);
        assertEq(IBufiSessionKeyPlugin.PermissionsUpdated.selector, AlchemySessionKeyPlugin.PermissionsUpdated.selector);
        assertEq(
            IBufiSessionKeyPlugin.ERC20SpendLimitExceeded.selector,
            AlchemySessionKeyPlugin.ERC20SpendLimitExceeded.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.InvalidPermissionsUpdate.selector,
            AlchemySessionKeyPlugin.InvalidPermissionsUpdate.selector
        );
        assertEq(IBufiSessionKeyPlugin.InvalidSessionKey.selector, AlchemySessionKeyPlugin.InvalidSessionKey.selector);
        assertEq(IBufiSessionKeyPlugin.InvalidSignature.selector, AlchemySessionKeyPlugin.InvalidSignature.selector);
        assertEq(IBufiSessionKeyPlugin.InvalidToken.selector, AlchemySessionKeyPlugin.InvalidToken.selector);
        assertEq(IBufiSessionKeyPlugin.LengthMismatch.selector, AlchemySessionKeyPlugin.LengthMismatch.selector);
        assertEq(
            IBufiSessionKeyPlugin.NativeTokenSpendLimitExceeded.selector,
            AlchemySessionKeyPlugin.NativeTokenSpendLimitExceeded.selector
        );
        assertEq(
            IBufiSessionKeyPlugin.PermissionsCheckFailed.selector,
            AlchemySessionKeyPlugin.PermissionsCheckFailed.selector
        );
        assertEq(IBufiSessionKeyPlugin.SessionKeyNotFound.selector, AlchemySessionKeyPlugin.SessionKeyNotFound.selector);
    }

    /// @dev Circle's factory installs init-time plugins with an EMPTY dependency list, and this plugin declares two
    ///      dependency slots — so, exactly like ColdStorageAddressBookPlugin, it can only be installed on an
    ///      existing account through `installPlugin`. Recorded here so nobody tries to pre-bake it at creation.
    function test_cannotBeInstalledAtAccountCreation() public {
        address[] memory allow = new address[](1);
        allow[0] = address(sessionKeyPlugin);
        _allowPluginsOnFactory(allow);

        Signer[] memory owners = _makeSigners("fresh", 1);
        address[] memory plugins = new address[](2);
        plugins[0] = address(weightedPlugin);
        plugins[1] = address(sessionKeyPlugin);
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = keccak256(abi.encode(weightedPlugin.pluginManifest()));
        hashes[1] = keccak256(abi.encode(sessionKeyPlugin.pluginManifest()));
        bytes[] memory installData = new bytes[](2);
        installData[0] = _weightedInstallData(_addresses(owners), _uniformWeights(1, 1), 1);
        installData[1] = _emptySessionKeyInstallData();

        vm.expectRevert();
        factory.createAccount(
            addressToBytes32(owners[0].addr), bytes32(uint256(99)), abi.encode(plugins, hashes, installData)
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Owner grants, agent spends                                                     ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev {USDC.transfer only, `limit` USDC per `interval`, valid in [validAfter, validUntil]}.
    function _usdcTransferGrant(uint256 limit, uint48 interval, uint48 validAfter, uint48 validUntil)
        internal
        view
        returns (bytes[] memory)
    {
        return _updates(
            _permAddressEntry(address(usdc), true, true),
            _permFunctionEntry(address(usdc), usdc.transfer.selector, true),
            _permErc20Limit(address(usdc), limit, interval),
            _permTimeRange(validAfter, validUntil)
        );
    }

    function test_ownersGrantKeyViaUserOp_agentTransfersWithinLimit() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32("bu-agent"), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 200e6)), agent));
        assertEq(usdc.balanceOf(merchant), 200e6);

        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        assertEq(info.limitUsed, 200e6);
    }

    /// @dev ERC-20 limits are re-checked and enforced in the EXECUTION phase (by design in the audited original:
    ///      the token amount lives inside calldata the validation phase does not decode for ERC-20s). The
    ///      EntryPoint accepts the op; the plugin reverts it and no funds move.
    function test_erc20OverLimit_revertsInExecution() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));

        (bool ok, bytes memory reason) =
            _executeSessionKeyUserOpWithReason(account, _calls(_erc20Transfer(address(usdc), merchant, 501e6)), agent);
        assertFalse(ok);
        assertEq(
            reason,
            abi.encodeWithSelector(
                IBufiSessionKeyPlugin.ERC20SpendLimitExceeded.selector, address(account), agent.addr, address(usdc)
            )
        );
        assertEq(usdc.balanceOf(merchant), 0);
    }

    /// @dev Native-token limits are checked in VALIDATION: the EntryPoint rejects the op outright.
    function test_nativeOverLimit_rejectedInValidation() public {
        assertTrue(
            _addSessionKey(
                account, agent.addr, bytes32(0), _updates(_permAllowAll(), _permNativeLimit(1 ether, 0)), quorum
            )
        );
        assertTrue(_executeSessionKeyUserOp(account, _calls(_nativeTransfer(merchant, 0.5 ether)), agent));
        assertEq(merchant.balance, 0.5 ether);

        _expectSessionKeyValidationRevert(
            account, _calls(_nativeTransfer(merchant, 0.6 ether)), agent, _aa23PermissionsCheckFailed()
        );
        assertEq(merchant.balance, 0.5 ether);
    }

    function test_timeRange_beforeValidAfter_andAfterValidUntil() public {
        uint48 validAfter = uint48(T0 + 1 days);
        uint48 validUntil = uint48(T0 + 7 days);
        assertTrue(
            _addSessionKey(
                account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, validAfter, validUntil), quorum
            )
        );
        Call[] memory calls = _calls(_erc20Transfer(address(usdc), merchant, 10e6));

        // Not yet due.
        _expectSessionKeyValidationRevert(account, calls, agent, _aa22());

        vm.warp(validAfter + 1);
        assertTrue(_executeSessionKeyUserOp(account, calls, agent));
        assertEq(usdc.balanceOf(merchant), 10e6);

        // Expired.
        vm.warp(validUntil + 1);
        _expectSessionKeyValidationRevert(account, calls, agent, _aa22());
        assertEq(usdc.balanceOf(merchant), 10e6);
    }

    function test_targetOutsideAccessListRejected() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        _expectSessionKeyValidationRevert(
            account,
            _calls(_call(address(counter), 0, abi.encodeCall(SessionCounter.increment, ()))),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(counter.number(), 0);
    }

    function test_selectorOutsideAccessListRejected() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        _expectSessionKeyValidationRevert(
            account, _calls(_erc20Approve(address(usdc), stranger, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
        assertEq(usdc.allowance(address(account), stranger), 0);
    }

    function test_gasSpendLimitExceededRejected() public {
        bytes[] memory grant = _usdcTransferGrant(500e6, 0, 0, 0);
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), grant, quorum));
        assertTrue(_updateKeyPermissions(account, agent.addr, _updates(_permGasLimit(0.5 ether, 0)), quorum));

        Call[] memory calls = _calls(_erc20Transfer(address(usdc), merchant, 1e6));
        // (300k + 300k) * 1000 gwei = 0.6 ether > 0.5 ether budget.
        PackedUserOperation memory op =
            _buildSessionKeyUserOpWithGas(account, calls, agent.addr, 300_000, 300_000, 0, 1_000 gwei, 0, "");
        assertEq(_requiredPrefundV07(op), 0.6 ether);
        op.signature = _signSessionKey(op, agent.key);
        _expectHandleOpsRevert(op, _aa23PermissionsCheckFailed());

        // (200k + 200k) * 1000 gwei = 0.4 ether fits.
        op = _buildSessionKeyUserOpWithGas(account, calls, agent.addr, 200_000, 200_000, 0, 1_000 gwei, 0, "");
        assertEq(_requiredPrefundV07(op), 0.4 ether);
        op.signature = _signSessionKey(op, agent.key);
        (bool ok,) = _runOp(op);
        assertTrue(ok);
        (IBufiSessionKeyPlugin.SpendLimitInfo memory info,) =
            sessionKeyPlugin.getGasSpendLimit(address(account), agent.addr);
        assertEq(info.limitUsed, 0.4 ether);
    }

    function test_requiredPaymaster() public {
        SessionTestPaymaster paymaster = new SessionTestPaymaster(entryPoint);
        paymaster.deposit{value: 10 ether}();
        bytes[] memory grant = _usdcTransferGrant(500e6, 0, 0, 0);
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), grant, quorum));
        assertTrue(
            _updateKeyPermissions(account, agent.addr, _updates(_permRequiredPaymaster(address(paymaster))), quorum)
        );

        Call[] memory calls = _calls(_erc20Transfer(address(usdc), merchant, 1e6));
        _expectSessionKeyValidationRevert(account, calls, agent, _aa23PermissionsCheckFailed());

        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            calls,
            agent.addr,
            SK_VERIFICATION_GAS,
            SK_CALL_GAS,
            0,
            SK_MAX_FEE,
            SK_MAX_PRIORITY_FEE,
            _paymasterAndData(address(paymaster), 200_000, 100_000)
        );
        op.signature = _signSessionKey(op, agent.key);
        (bool ok,) = _runOp(op);
        assertTrue(ok);
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_erc20LimitRefreshIntervalRollsOver() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 1 days, 0, 0), quorum));

        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 500e6)), agent));
        (bool ok,) =
            _executeSessionKeyUserOpWithReason(account, _calls(_erc20Transfer(address(usdc), merchant, 1e6)), agent);
        assertFalse(ok, "budget for this interval is exhausted");
        assertEq(usdc.balanceOf(merchant), 500e6);

        vm.warp(T0 + 1 days);
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 500e6)), agent));
        assertEq(usdc.balanceOf(merchant), 1000e6);

        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        assertEq(info.limitUsed, 500e6);
        assertEq(info.lastUsedTime, T0 + 1 days);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Owner lifecycle: rotate / remove / uninstall                                   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_ownerRotatesKey_permissionsFollowTheNewKey() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 100e6)), agent));

        Signer memory agent2 = _signerFrom("agent-rotated");
        assertTrue(_rotateSessionKey(account, agent.addr, agent2.addr, quorum));

        Call[] memory calls = _calls(_erc20Transfer(address(usdc), merchant, 100e6));
        _expectSessionKeyValidationRevert(account, calls, agent, _aa23PermissionsCheckFailed());
        assertTrue(_executeSessionKeyUserOp(account, calls, agent2));
        assertEq(usdc.balanceOf(merchant), 200e6);

        // Usage carried over with the permissions.
        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent2.addr, address(usdc));
        assertEq(info.limit, 500e6);
        assertEq(info.limitUsed, 200e6);
    }

    function test_ownerRemovesKey() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        assertTrue(_removeSessionKey(account, agent.addr, quorum));
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));
        _expectSessionKeyValidationRevert(
            account, _calls(_erc20Transfer(address(usdc), merchant, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
    }

    function test_runtimePathToManagementIsFailClosed_userOpPathWorks() public {
        bytes[] memory none = new bytes[](0);
        // Every owner, and the account itself, is rejected at runtime: slot 0 → Weighted id 1 (unimplemented).
        for (uint256 i = 0; i < quorum.length; i++) {
            vm.prank(quorum[i].addr);
            vm.expectRevert();
            IBufiSessionKeyPlugin(address(account)).addSessionKey(agent.addr, bytes32(0), none);
        }
        vm.prank(agent.addr);
        vm.expectRevert();
        IBufiSessionKeyPlugin(address(account)).addSessionKey(agent.addr, bytes32(0), none);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));

        // The multisig userOp path is the only way in.
        assertTrue(_addSessionKey(account, agent.addr, quorum));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));

        // Below quorum: rejected by Weighted owner validation.
        Signer[] memory solo = new Signer[](1);
        solo[0] = quorum[0];
        _expectValidationRevert(account, _addSessionKeyCalldata(stranger, bytes32(0), none), solo);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), stranger));
    }

    function test_uninstallCleansUpAndReinstallStartsFresh() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 100e6)), agent));

        PackedUserOperation memory op = _prepareUserOp(
            account, abi.encodeCall(IPluginManager.uninstallPlugin, (address(sessionKeyPlugin), "", "")), quorum
        );
        vm.expectEmit(true, true, true, true, address(sessionKeyPlugin));
        emit IBufiSessionKeyPlugin.SessionKeyRemoved(address(account), agent.addr);
        (bool ok,) = _runOp(op);
        assertTrue(ok);

        assertFalse(_isInstalled(account, address(sessionKeyPlugin)));
        assertEq(sessionKeyPlugin.sessionKeysOf(address(account)).length, 0);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));
        vm.expectRevert(abi.encodeWithSelector(IBufiSessionKeyPlugin.InvalidSessionKey.selector, agent.addr));
        sessionKeyPlugin.getKeyTimeRange(address(account), agent.addr);

        // The selector is gone from the account: the EntryPoint rejects the op.
        _expectSessionKeyValidationRevert(account, _calls(_erc20Transfer(address(usdc), merchant, 1e6)), agent);

        // Reinstall + re-add: the key gets a NEW id, so nothing from the previous grant survives.
        assertTrue(_installSessionKeyPlugin(account, quorum));
        assertTrue(_addSessionKey(account, agent.addr, quorum));
        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        assertFalse(info.hasLimit);
        assertEq(info.limitUsed, 0);
        (bool isOnList,) = sessionKeyPlugin.getAccessControlEntry(address(account), agent.addr, address(usdc));
        assertFalse(isOnList);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Confinement                                                                    ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Every native / owner-only selector is validated by the Weighted owner plugin, so a session-key
    ///      signature never passes for them — regardless of the key's permissions.
    function test_keyCannotCallOwnerFunctions() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));

        bytes[] memory forbidden = new bytes[](9);
        forbidden[0] = _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.transfer, (stranger, 1e6)));
        forbidden[1] =
            abi.encodeCall(IStandardExecutor.executeBatch, (_calls(_erc20Transfer(address(usdc), stranger, 1e6))));
        forbidden[2] = _installPluginCalldata(
            address(addressBookPlugin), abi.encode(new address[](0)), _addressBookDependencies()
        );
        forbidden[3] = abi.encodeCall(IPluginManager.uninstallPlugin, (address(sessionKeyPlugin), "", ""));
        forbidden[4] = _addSessionKeyCalldata(stranger, bytes32(0), new bytes[](0));
        forbidden[5] = abi.encodeCall(
            IBufiSessionKeyPlugin.updateKeyPermissions,
            (agent.addr, _updates(_permErc20Limit(address(usdc), type(uint256).max, 0)))
        );
        forbidden[6] =
            abi.encodeCall(IBufiSessionKeyPlugin.rotateSessionKey, (agent.addr, bytes32(uint256(1)), stranger));
        forbidden[7] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, "");
        address[] memory newOwners = new address[](1);
        newOwners[0] = agent.addr;
        forbidden[8] = abi.encodeCall(
            weightedPlugin.addOwners, (newOwners, _uniformWeights(1, 1), new PublicKey[](0), new uint256[](0), 1)
        );

        for (uint256 i = 0; i < forbidden.length; i++) {
            PackedUserOperation memory op = _buildUserOp(address(account), forbidden[i]);
            op.signature = _signSessionKey(op, agent.key);
            _expectHandleOpsRevert(op, "");
        }
        assertEq(usdc.balanceOf(stranger), 0);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), stranger));
        assertTrue(_isInstalled(account, address(sessionKeyPlugin)));
    }

    /// @dev Through executeWithSessionKey the account refuses to call itself or any plugin, so the key cannot
    ///      reach management functions "from the inside" either.
    function test_keyCannotReachAccountOrPluginThroughExecuteWithSessionKey() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_call(address(account), 0, _addSessionKeyCalldata(stranger, bytes32(0), new bytes[](0)))),
            agent
        );
        assertFalse(ok, "target == account");

        (ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_call(address(sessionKeyPlugin), 0, _addSessionKeyCalldata(stranger, bytes32(0), new bytes[](0)))),
            agent
        );
        assertFalse(ok, "target == plugin");

        (ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(
                _call(
                    address(weightedPlugin),
                    0,
                    abi.encodeWithSignature(
                        "removeOwners(address[],(uint256,uint256)[],uint256)", new address[](0), new PublicKey[](0), 1
                    )
                )
            ),
            agent
        );
        assertFalse(ok, "target == weighted plugin");
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), stranger));
    }

    /// @dev Session-key calldata that is not `executeWithSessionKey(Call[],address)` cannot reach the plugin's
    ///      validation function (the manifest binds it to that selector only), and a session key cannot be used
    ///      for another account's ops.
    function test_secondAccountHasIsolatedState() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _usdcTransferGrant(500e6, 0, 0, 0), quorum));

        (UpgradableMSCA accountB, Signer[] memory quorumB) =
            _createAccountWithSessionKeyPlugin("other", bytes32(uint256(12)));
        usdc.mint(address(accountB), 1_000e6);

        // Same key address, different account, different grant.
        assertTrue(_addSessionKey(accountB, agent.addr, bytes32(0), _usdcTransferGrant(50e6, 0, 0, 0), quorumB));

        IBufiSessionKeyPlugin.SpendLimitInfo memory infoA =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        IBufiSessionKeyPlugin.SpendLimitInfo memory infoB =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(accountB), agent.addr, address(usdc));
        assertEq(infoA.limit, 500e6);
        assertEq(infoB.limit, 50e6);

        assertTrue(_executeSessionKeyUserOp(accountB, _calls(_erc20Transfer(address(usdc), merchant, 50e6)), agent));
        (bool ok,) =
            _executeSessionKeyUserOpWithReason(accountB, _calls(_erc20Transfer(address(usdc), merchant, 1e6)), agent);
        assertFalse(ok, "B's budget is exhausted");
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), merchant, 400e6)), agent));

        infoA = sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        infoB = sessionKeyPlugin.getERC20SpendLimitInfo(address(accountB), agent.addr, address(usdc));
        assertEq(infoA.limitUsed, 400e6);
        assertEq(infoB.limitUsed, 50e6);

        // Removing the key on B does not touch A.
        assertTrue(_removeSessionKey(accountB, agent.addr, quorumB));
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(accountB), agent.addr));
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));
    }

    /// @dev A session-key userOp signed for account A cannot be replayed against account B (the userOpHash binds
    ///      the sender), and a key registered only on A is rejected on B.
    function test_keyRegisteredOnOneAccountIsRejectedOnAnother() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        (UpgradableMSCA accountB,) = _createAccountWithSessionKeyPlugin("other", bytes32(uint256(13)));
        usdc.mint(address(accountB), 1_000e6);

        _expectSessionKeyValidationRevert(
            accountB, _calls(_erc20Transfer(address(usdc), merchant, 1e6)), agent, _aa23PermissionsCheckFailed()
        );
    }
}
