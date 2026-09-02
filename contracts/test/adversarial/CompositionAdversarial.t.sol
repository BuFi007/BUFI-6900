// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MockVault} from "../bufi/v0.7/earn/mocks/Mocks.sol";
import {SessionKeyHarness} from "../harness/SessionKeyHarness.sol";

import {BufiEarnModule} from "../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {BufiSessionRecipientHookPlugin} from "../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {IBufiSessionRecipientHookPlugin} from "../../src/bufi/v0.7/recipient-hook/IBufiSessionRecipientHookPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IAddressBookPlugin} from "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/IAddressBookPlugin.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CompositionAdversarialTest is SessionKeyHarness {
    BufiEarnModule internal earn;
    BufiSessionRecipientHookPlugin internal hook;
    SandboxUSDC internal usdc;
    MockVault internal vault;
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal moduleOwner;
    address internal relayer;
    address internal allowed;
    address internal stranger;
    uint256 internal configHash;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        moduleOwner = makeAddr("composition-module-owner");
        relayer = makeAddr("composition-relayer");
        allowed = makeAddr("composition-allowed");
        stranger = makeAddr("composition-stranger");
        agent = _signerFrom("composition-agent");
        earn = new BufiEarnModule(relayer, moduleOwner);
        hook = new BufiSessionRecipientHookPlugin();
        usdc = new SandboxUSDC();
        vault = new MockVault(IERC20(address(usdc)));

        Signer[] memory owners = _makeSigners("composition-owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(0xD1)));
        quorum.push(owners[0]);
        quorum.push(owners[2]);

        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput(block.chainid, address(usdc), address(vault));
        vm.prank(moduleOwner);
        configHash = earn.setConfig(cfg);

        address[] memory recipients = new address[](1);
        recipients[0] = allowed;
        assertTrue(_installAddressBook(account, recipients, quorum));
        assertTrue(_installPlugin(account, address(earn), abi.encode(configHash), _addressBookDependencies(), quorum));
        assertTrue(_installHook()); // hook before session-key: selector has no owner yet
        assertTrue(_installSessionKeyPlugin(account, quorum));
        usdc.mint(address(account), 1_000_000e6);
    }

    function _installHook() internal returns (bool) {
        return _installPlugin(
            account, address(hook), abi.encode(address(addressBookPlugin)), new FunctionReference[](0), quorum
        );
    }

    function _uninstall(address plugin) internal returns (bool) {
        return _executeUserOp(account, abi.encodeCall(IPluginManager.uninstallPlugin, (plugin, "", "")), quorum);
    }

    function _transferGrant() internal view returns (bytes[] memory) {
        return _updates(
            _permAddressEntry(address(usdc), true, true),
            _permFunctionEntry(address(usdc), IERC20.transfer.selector, true),
            _permErc20Limit(address(usdc), 100e6, 0)
        );
    }

    function test_allFourPluginsAreLive_andSessionKeyCannotReachAnyAdminSurface() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _transferGrant(), quorum));
        assertTrue(_executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(usdc), allowed, 1e6)), agent));

        bytes[] memory forbidden = new bytes[](6);
        forbidden[0] = abi.encodeCall(BufiEarnModule.autoEarn, (address(usdc), 1e6));
        forbidden[1] = abi.encodeCall(BufiEarnModule.changeConfigHash, (configHash + 1));
        forbidden[2] = _addSessionKeyCalldata(stranger, bytes32(0), new bytes[](0));
        forbidden[3] = abi.encodeCall(
            IBufiSessionKeyPlugin.removeSessionKey,
            (agent.addr, sessionKeyPlugin.findPredecessor(address(account), agent.addr))
        );
        forbidden[4] =
            abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (agent.addr, _updates(_permAllowAll())));
        forbidden[5] = abi.encodeCall(IAddressBookPlugin.addAllowedRecipients, (_one(stranger)));

        for (uint256 i = 0; i < forbidden.length; ++i) {
            PackedUserOperation memory op = _buildUserOp(address(account), forbidden[i]);
            op.signature = _signSessionKey(op, agent.key);
            _expectHandleOpsRevert(op, "");
        }

        Call[] memory throughAccount = _calls(_call(address(account), 0, forbidden[0]));
        _expectSessionKeyValidationRevert(
            account,
            throughAccount,
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), address(0)
                )
            )
        );
        assertEq(earn.accountConfig(address(account)), configHash);
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), stranger));
        assertEq(usdc.balanceOf(stranger), 0);
    }

    function test_earnRelayerCannotReachSessionOrAddressBookState() public {
        address attemptedKey = makeAddr("relayer-key");
        vm.startPrank(relayer);
        vm.expectRevert();
        IBufiSessionKeyPlugin(address(account)).addSessionKey(attemptedKey, bytes32(0), new bytes[](0));
        vm.expectRevert();
        IAddressBookPlugin(address(account)).addAllowedRecipients(_one(stranger));
        vm.expectRevert();
        BufiEarnModule(address(account)).changeConfigHash(configHash + 1);
        vm.stopPrank();

        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), attemptedKey));
        assertEq(addressBookPlugin.getAllowedRecipients(address(account)).length, 1);
        assertEq(earn.accountConfig(address(account)), configHash);
    }

    function test_weightedUninstallIsBlockedUntilAllThreeDependentsAreRemoved() public {
        (bool ok,) = _executeOwnerUserOpWithReason(
            account, abi.encodeCall(IPluginManager.uninstallPlugin, (address(weightedPlugin), "", "")), quorum
        );
        assertFalse(ok, "weighted has session, earn, and AddressBook dependents");
        assertTrue(_isInstalled(account, address(weightedPlugin)));

        assertTrue(_uninstall(address(hook)), "hook has no dependency");
        assertTrue(_uninstall(address(sessionKeyPlugin)));
        assertTrue(_uninstall(address(earn)));
        assertTrue(_uninstall(address(addressBookPlugin)));
        assertTrue(_uninstall(address(weightedPlugin)), "all dependency counters released");
        assertFalse(_isInstalled(account, address(weightedPlugin)));
    }

    function test_sessionFirstThenHookUninstallLeavesNoStaleHookOrDependency() public {
        assertTrue(_uninstall(address(sessionKeyPlugin)));
        (FunctionReference[] memory beforeUserOpHooks, FunctionReference[] memory beforeRuntimeHooks) =
            account.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(beforeUserOpHooks.length, 1, "hook userOp entry remains");
        assertEq(beforeRuntimeHooks.length, 1, "hook runtime entry remains; session always-deny was removed");
        assertTrue(_uninstall(address(hook)));
        (FunctionReference[] memory userOpHooks, FunctionReference[] memory runtimeHooks) =
            account.getPreValidationHooks(IBufiSessionKeyPlugin.executeWithSessionKey.selector);
        assertEq(userOpHooks.length, 0);
        assertEq(runtimeHooks.length, 0);
        assertEq(hook.addressBookOf(address(account)), address(0));
    }

    function test_addressBookFirstFailsAgentClosed_thenCleanupStillWorks() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _transferGrant(), quorum));
        assertTrue(_uninstall(address(addressBookPlugin)));
        assertFalse(_isInstalled(account, address(addressBookPlugin)));

        _expectSessionKeyValidationRevert(
            account,
            _calls(_erc20Transfer(address(usdc), allowed, 1e6)),
            agent,
            _aa23(
                abi.encodeWithSelector(
                    IBufiSessionRecipientHookPlugin.UnauthorizedRecipient.selector, address(account), allowed
                )
            )
        );

        assertTrue(_uninstall(address(hook)));
        assertTrue(_uninstall(address(sessionKeyPlugin)));
        assertTrue(_uninstall(address(earn)));
    }

    function test_hookFirstThenRemainingPluginsCanBeUninstalledInAnyDependencySafeOrder() public {
        assertTrue(_uninstall(address(hook)));
        assertTrue(_uninstall(address(earn)));
        assertTrue(_uninstall(address(addressBookPlugin)));
        assertTrue(_uninstall(address(sessionKeyPlugin)));
        assertTrue(_isInstalled(account, address(weightedPlugin)));
    }

    function _one(address value) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = value;
    }
}
