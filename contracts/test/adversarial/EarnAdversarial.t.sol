// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {MockVault} from "../bufi/v0.7/earn/mocks/Mocks.sol";
import {SessionKeyHarness} from "../harness/SessionKeyHarness.sol";

import {BufiEarnModule} from "../../src/bufi/v0.7/earn/BufiEarnModule.sol";
import {IBufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IPluginManager} from "@circle/msca/6900/v0.7/interfaces/IPluginManager.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RevertingDepositVault {
    error DepositRejected();

    function deposit(uint256, address) external pure returns (uint256) {
        revert DepositRejected();
    }
}

contract ZeroShareTakingVault {
    IERC20 public immutable asset;
    mapping(address => uint256) public balanceOf;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function deposit(uint256 assets, address) external returns (uint256 shares) {
        asset.transferFrom(msg.sender, address(this), assets);
        return 0;
    }
}

contract ReentrantDepositVault {
    IERC20 public immutable asset;
    mapping(address => uint256) public balanceOf;
    bool public reenteredAutoEarn;
    bool public reenteredConfigChange;

    constructor(IERC20 asset_) {
        asset = asset_;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        (reenteredAutoEarn,) = msg.sender.call(abi.encodeCall(BufiEarnModule.autoEarn, (address(asset), 1)));
        (reenteredConfigChange,) = msg.sender.call(abi.encodeCall(BufiEarnModule.changeConfigHash, (uint256(1))));
        asset.transferFrom(msg.sender, address(this), assets);
        balanceOf[receiver] += assets;
        return assets;
    }
}

contract EarnAdversarialTest is SessionKeyHarness {
    BufiEarnModule internal module;
    SandboxUSDC internal usdc;
    MockVault internal vault;
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;

    address internal moduleOwner;
    address internal relayer;
    address internal stranger;
    uint256 internal configHash;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        (UpgradableMSCA msca, Signer[] memory q) =
            _createAccountWithSessionKeyPlugin("earn-owner", bytes32(uint256(0xB1)));
        account = msca;
        quorum.push(q[0]);
        quorum.push(q[1]);

        moduleOwner = makeAddr("module-owner");
        relayer = makeAddr("relayer");
        stranger = makeAddr("stranger");
        agent = _signerFrom("earn-agent");
        module = new BufiEarnModule(relayer, moduleOwner);
        usdc = new SandboxUSDC();
        vault = new MockVault(IERC20(address(usdc)));
        configHash = _register(address(usdc), address(vault));
        usdc.mint(address(account), 1_000_000e6);
    }

    function _register(address token, address vault_) internal returns (uint256) {
        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput({chainId: block.chainid, token: token, vault: vault_});
        vm.prank(moduleOwner);
        return module.setConfig(cfg);
    }

    function _installEarn(uint256 hash) internal returns (bool) {
        return _installPlugin(account, address(module), abi.encode(hash), _addressBookDependencies(), quorum);
    }

    function _uninstallEarn() internal returns (bool) {
        return
            _executeUserOp(account, abi.encodeCall(IPluginManager.uninstallPlugin, (address(module), "", "")), quorum);
    }

    function test_unauthorizedAndRevokedRelayersCannotGriefTheLegitimateRelayer() public {
        assertTrue(_installEarn(configHash));
        vm.prank(stranger);
        vm.expectRevert();
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);

        vm.prank(moduleOwner);
        module.removeAuthorizedRelayer(relayer);
        vm.prank(relayer);
        vm.expectRevert();
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);

        address replacement = makeAddr("replacement-relayer");
        vm.prank(moduleOwner);
        module.addAuthorizedRelayer(replacement);
        vm.prank(replacement);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 1e6);
        assertEq(vault.balanceOf(address(account)), vault.previewDeposit(1e6));
    }

    function test_configHashHasNoAbiPackingCollision_butOrderingIsNotCanonical() public {
        SandboxUSDC secondToken = new SandboxUSDC();
        MockVault secondVault = new MockVault(IERC20(address(secondToken)));
        BufiEarnModule.ConfigInput[] memory ordered = new BufiEarnModule.ConfigInput[](2);
        ordered[0] = BufiEarnModule.ConfigInput(block.chainid, address(usdc), address(vault));
        ordered[1] = BufiEarnModule.ConfigInput(block.chainid, address(secondToken), address(secondVault));
        BufiEarnModule.ConfigInput[] memory reversed = new BufiEarnModule.ConfigInput[](2);
        reversed[0] = ordered[1];
        reversed[1] = ordered[0];

        // FIXED (F-08): `setConfig` now demands the canonical (chainId, token) order its own docs claimed, so one
        // logical policy has exactly one hash. Before the fix both orderings were accepted and produced two hashes.
        (ordered, reversed) =
            uint160(address(usdc)) < uint160(address(secondToken)) ? (ordered, reversed) : (reversed, ordered);

        vm.startPrank(moduleOwner);
        uint256 orderedHash = module.setConfig(ordered);
        uint256 sameHash = module.setConfig(ordered);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ConfigNotSorted.selector, uint256(1)));
        module.setConfig(reversed);
        vm.stopPrank();

        assertEq(orderedHash, sameHash, "same tuple sequence is idempotent");
        assertEq(module.config(orderedHash, block.chainid, ordered[0].token), ordered[0].vault);
    }

    function test_nonOwnerCannotFrontRunSetConfig() public {
        BufiEarnModule.ConfigInput[] memory cfg = new BufiEarnModule.ConfigInput[](1);
        cfg[0] = BufiEarnModule.ConfigInput(block.chainid, address(usdc), stranger);
        vm.prank(stranger);
        vm.expectRevert();
        module.setConfig(cfg);
        assertEq(module.config(configHash, block.chainid, address(usdc)), address(vault));
    }

    function test_autoEarnBoundaryAmountsAndUnknownToken() public {
        assertTrue(_installEarn(configHash));
        uint256 beforeBalance = usdc.balanceOf(address(account));

        // FIXED (F-06): a zero-amount sweep mints no shares, so it now reverts instead of emitting a success event
        // for a no-op. Relayers must not schedule empty sweeps.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ZeroSharesMinted.selector, address(vault)));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 0);
        assertEq(usdc.balanceOf(address(account)), beforeBalance);
        assertEq(vault.balanceOf(address(account)), 0);

        vm.prank(relayer);
        vm.expectRevert();
        BufiEarnModule(address(account)).autoEarn(address(usdc), beforeBalance + 1);
        assertEq(usdc.allowance(address(account), address(vault)), 0, "approval rolled back");

        SandboxUSDC unknown = new SandboxUSDC();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ConfigNotFound.selector, address(unknown)));
        BufiEarnModule(address(account)).autoEarn(address(unknown), 0);
    }

    function test_revertingVaultRollsBackApprovalAndAssets() public {
        RevertingDepositVault badVault = new RevertingDepositVault();
        uint256 badHash = _register(address(usdc), address(badVault));
        assertTrue(_installEarn(badHash));
        uint256 beforeBalance = usdc.balanceOf(address(account));

        // FIXED (F-06): the vault's `asset()` claim is checked before any approval, so a vault that does not even
        // expose the interface fails earlier than its `deposit`. Both outcomes leave the account untouched.
        vm.prank(relayer);
        vm.expectRevert();
        BufiEarnModule(address(account)).autoEarn(address(usdc), 100e6);

        assertEq(usdc.balanceOf(address(account)), beforeBalance);
        assertEq(usdc.allowance(address(account), address(badVault)), 0);
    }

    /// SAFE assertion intentionally fails if a vault can take assets while returning zero/minting no shares.
    function test_SAFE_zeroShareVaultCannotCauseSilentValueLoss() public {
        ZeroShareTakingVault badVault = new ZeroShareTakingVault(IERC20(address(usdc)));
        uint256 badHash = _register(address(usdc), address(badVault));
        assertTrue(_installEarn(badHash));
        uint256 beforeBalance = usdc.balanceOf(address(account));

        // FIXED (F-06): `autoEarn` now reverts when the adopted vault mints no shares, so the sweep is atomic and
        // the account keeps its assets. Before the fix this call succeeded and emitted AutoEarnExecuted.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ZeroSharesMinted.selector, address(badVault)));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 100e6);

        assertEq(
            usdc.balanceOf(address(account)),
            beforeBalance,
            "SAFE: zero shares must revert instead of consuming account assets"
        );
        assertEq(usdc.allowance(address(account), address(badVault)), 0, "approval rolled back");
        assertEq(badVault.balanceOf(address(account)), 0, "no shares, no state");
    }

    function test_uninstallWithOutstandingSharesPreservesAndAllowsOwnerRedemption() public {
        assertTrue(_installEarn(configHash));
        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 100e6);
        uint256 shares = vault.balanceOf(address(account));
        assertGt(shares, 0);

        assertTrue(_uninstallEarn());
        assertEq(vault.balanceOf(address(account)), shares, "uninstall does not erase the position");
        assertTrue(
            _executeUserOp(
                account,
                _executeCalldata(
                    address(vault), 0, abi.encodeCall(IERC4626.redeem, (shares, address(account), address(account)))
                ),
                quorum
            )
        );
        assertEq(vault.balanceOf(address(account)), 0);
    }

    function test_maliciousVaultCannotReenterEitherEarnExecutionFunction() public {
        ReentrantDepositVault reentrantVault = new ReentrantDepositVault(IERC20(address(usdc)));
        uint256 reentrantHash = _register(address(usdc), address(reentrantVault));
        assertTrue(_installEarn(reentrantHash));

        vm.prank(relayer);
        BufiEarnModule(address(account)).autoEarn(address(usdc), 100e6);

        assertFalse(reentrantVault.reenteredAutoEarn());
        assertFalse(reentrantVault.reenteredConfigChange());
        assertEq(reentrantVault.balanceOf(address(account)), 100e6);
        assertEq(module.accountConfig(address(account)), reentrantHash);
    }

    function test_correctOwnerRouteChangesConfig_legacyExecuteTargetRemainsBlocked() public {
        assertTrue(_installEarn(configHash));
        MockVault newVault = new MockVault(IERC20(address(usdc)));
        uint256 newHash = _register(address(usdc), address(newVault));
        bytes memory adopt = abi.encodeCall(BufiEarnModule.changeConfigHash, (newHash));

        (bool legacyOk,) = _executeOwnerUserOpWithReason(account, _executeCalldata(address(module), 0, adopt), quorum);
        assertFalse(legacyOk);
        assertEq(module.accountConfig(address(account)), configHash);

        assertTrue(_executeUserOp(account, adopt, quorum));
        assertEq(module.accountConfig(address(account)), newHash);
    }

    /// SAFE assertion intentionally fails when a miswired dependency lets a session key validate changeConfigHash.
    /// @notice KNOWN, ACCEPTED — adversarial finding F-07. ERC-6900 types dependencies only as `IPlugin`, so
    /// Circle's PluginManager cannot tell the weighted owner validator from any other installed plugin. If owners
    /// install the earn module with the session-key plugin wired into the owner slot, session-key-shaped calldata
    /// validates `changeConfigHash` — a denial of service on config adoption, not asset movement (the resulting
    /// hash resolves to no vault, so `autoEarn` reverts `ConfigNotFound`). The control is the installer:
    /// the SDK's `earnModuleDependencies()` helper always emits the weighted validator.
    function test_KNOWN_F07_wrongDependencySlotGivesSessionKeyConfigAuthority() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        FunctionReference[] memory wrong = new FunctionReference[](2);
        wrong[0] = _addressBookDependencies()[0];
        wrong[1] = FunctionReference(address(sessionKeyPlugin), 0);
        assertTrue(_installPlugin(account, address(module), abi.encode(configHash), wrong, quorum));

        Call[] memory validationCalls = _calls(_call(stranger, 0, ""));
        bytes memory aliased =
            bytes.concat(BufiEarnModule.changeConfigHash.selector, abi.encode(validationCalls, agent.addr));
        PackedUserOperation memory op = _buildUserOp(address(account), aliased);
        op.nonce = _sessionKeyNonce(account, agent.addr);
        op.signature = _signSessionKey(op, agent.key);
        (bool ok,) = _runOp(op);
        assertTrue(ok, "crafted calldata passed the miswired session-key validator");

        assertEq(
            module.accountConfig(address(account)),
            64,
            "KNOWN F-07: a mis-wired dependency slot lets a session key set the config hash"
        );
        // The consequence is denial of service, not theft: the adopted hash resolves to no vault.
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BufiEarnModule.ConfigNotFound.selector, address(usdc)));
        BufiEarnModule(address(account)).autoEarn(address(usdc), 100e6);
    }
}
