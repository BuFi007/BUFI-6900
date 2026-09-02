// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleV08Harness} from "../../../harness/CircleV08Harness.sol";
import {MockGatewayWallet} from "../../../mocks/MockGatewayWallet.sol";

import {GatewayExecutionModule} from "../../../../src/bufi/v0.8/gateway/GatewayExecutionModule.sol";
import {GatewayHelper} from "../../../../src/bufi/v0.8/gateway/GatewayHelper.sol";
import {IGatewayExecutionModule} from "../../../../src/bufi/v0.8/gateway/interfaces/IGatewayExecutionModule.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {InvalidExecutionFunction} from "@circle/msca/6900/shared/common/Errors.sol";
import {BaseMSCA} from "@circle/msca/6900/v0.8/account/BaseMSCA.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.8/account/UpgradableMSCA.sol";
import {
    ColdStorageAddressBookModule
} from "@circle/msca/6900/v0.8/modules/addressbook/ColdStorageAddressBookModule.sol";
import {IAddressBookModule} from "@circle/msca/6900/v0.8/modules/addressbook/IAddressBookModule.sol";
import {IERC6900Account} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900Account.sol";
import {
    ExecutionManifest as ExecutionManifestV081,
    IERC6900ExecutionModule
} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900ExecutionModule.sol";
import {IERC6900Module} from "@erc6900/reference-implementation-v0.8.1/interfaces/IERC6900Module.sol";
import {DIRECT_CALL_VALIDATION_ENTITY_ID} from "@erc6900/reference-implementation/helpers/Constants.sol";
import {ExecutionManifest, IExecutionModule} from "@erc6900/reference-implementation/interfaces/IExecutionModule.sol";
import {
    Call,
    IModularAccount,
    ModuleEntity,
    ValidationConfig
} from "@erc6900/reference-implementation/interfaces/IModularAccount.sol";
import {ExecutionDataView} from "@erc6900/reference-implementation/interfaces/IModularAccountView.sol";
import {IModule} from "@erc6900/reference-implementation/interfaces/IModule.sol";
import {IValidationHookModule} from "@erc6900/reference-implementation/interfaces/IValidationHookModule.sol";
import {ModuleEntityLib} from "@erc6900/reference-implementation/libraries/ModuleEntityLib.sol";
import {ValidationConfigLib} from "@erc6900/reference-implementation/libraries/ValidationConfigLib.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice `GatewayExecutionModule` on a REAL Circle ERC-6900 v0.8 account (`UpgradableMSCA`, `circle.msca.2.0.0`)
///         driven by owner-signed userOps through EntryPoint v0.7, against `MockGatewayWallet`. Two questions:
///         (1) does a module written against reference-implementation **v0.8.1** install on Circle's
///         **v0.8.0**-typed account at all — yes, the types are ABI-identical (`test_compat_*`); and (2) once it is
///         installed, whom does Gateway see as the depositor — the MODULE, never the account, now reproduced
///         end-to-end through the account's fallback router rather than a pranked EOA (finding #2 of the local
///         README). The sound pattern (`execute` + `GatewayHelper` calldata) is shown alongside, on a single-signer
///         and on a 2-of-3 weighted account, and Circle's v0.8 `ColdStorageAddressBookModule` is put on both paths.
contract GatewayModuleOnCircleV08Test is CircleV08Harness {
    uint256 internal constant WITHDRAWAL_DELAY_BLOCKS = 100;
    uint256 internal constant ACCOUNT_USDC = 10_000e6;
    /// A second `SingleSignerValidationModule` entity on the same account: the "cold" validation the address book
    /// hangs off in `test_addressBook_onAColdValidation_*`.
    uint32 internal constant COLD_ENTITY_ID = 1;

    MockGatewayWallet internal gateway;
    SandboxUSDC internal usdc;
    GatewayExecutionModule internal module;
    GatewayHelper internal helper;
    UpgradableMSCA internal account;
    Signer internal owner;
    Signer internal coldSigner;

    address internal delegate = makeAddr("delegate");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        _deployCircleV08Stack();
        gateway = new MockGatewayWallet(WITHDRAWAL_DELAY_BLOCKS);
        usdc = new SandboxUSDC();
        gateway.setSupportedToken(address(usdc), true);
        module = new GatewayExecutionModule(address(gateway));
        helper = new GatewayHelper(address(gateway));
        vm.label(address(gateway), "MockGatewayWallet");
        vm.label(address(module), "GatewayExecutionModule");
        vm.label(address(helper), "GatewayHelper");

        owner = _makeSigner("owner");
        coldSigner = _makeSigner("cold-signer");
        account = _createSingleSignerAccount(owner, bytes32(uint256(0x6A)));
        usdc.mint(address(account), ACCOUNT_USDC);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  v0.8.0 (Circle) vs v0.8.1 (module) — same bytes, different names               ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// The reference implementation renamed `IModule` → `IERC6900Module`, `IExecutionModule` →
    /// `IERC6900ExecutionModule` and `IModularAccount` → `IERC6900Account` between v0.8.0 and v0.8.1 without
    /// touching a single function signature or struct field. Solidity treats the two `ExecutionManifest`s as
    /// distinct nominal types, so a test has to re-encode (`_circleManifest`), but on the wire nothing differs:
    /// same ERC-165 ids, same selectors, byte-identical `installExecution` calldata.
    function test_compat_v081ModuleTypesAreAbiIdenticalToCirclesV080Types() public view {
        assertEq(type(IERC6900Module).interfaceId, type(IModule).interfaceId, "IERC6900Module == IModule");
        assertEq(
            type(IERC6900ExecutionModule).interfaceId,
            type(IExecutionModule).interfaceId,
            "IERC6900ExecutionModule == IExecutionModule"
        );
        assertEq(IERC6900Account.installExecution.selector, IModularAccount.installExecution.selector);
        assertEq(IERC6900Account.uninstallExecution.selector, IModularAccount.uninstallExecution.selector);
        assertEq(IERC6900Account.installValidation.selector, IModularAccount.installValidation.selector);
        assertEq(IERC6900Account.uninstallValidation.selector, IModularAccount.uninstallValidation.selector);
        assertEq(IERC6900Account.execute.selector, IModularAccount.execute.selector);
        assertEq(IERC6900Account.executeBatch.selector, IModularAccount.executeBatch.selector);

        ExecutionManifestV081 memory m081 = module.executionManifest();
        ExecutionManifest memory m080 = _circleManifest();
        assertEq(abi.encode(m080), abi.encode(m081), "ExecutionManifest encodes identically");
        assertEq(m080.executionFunctions.length, m081.executionFunctions.length);
        for (uint256 i = 0; i < m080.executionFunctions.length; i++) {
            assertEq(m080.executionFunctions[i].executionSelector, m081.executionFunctions[i].executionSelector);
            assertEq(m080.executionFunctions[i].allowGlobalValidation, m081.executionFunctions[i].allowGlobalValidation);
            assertEq(m080.executionFunctions[i].skipRuntimeValidation, m081.executionFunctions[i].skipRuntimeValidation);
        }
        assertEq(m080.interfaceIds[0], m081.interfaceIds[0]);
        assertEq(
            abi.encodeCall(IERC6900Account.installExecution, (address(module), m081, "")),
            _installExecutionCalldata(address(module), m080, ""),
            "installExecution calldata is byte-identical whichever version encodes it"
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  (a) installExecution                                                          ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_installExecution_routesEveryManifestSelectorToTheModule_andAdvertisesItsInterface() public {
        ExecutionManifest memory m = _circleManifest();
        assertEq(_executionModule(account, IGatewayExecutionModule.authorizeDelegate.selector), address(0));
        assertFalse(account.supportsInterface(type(IGatewayExecutionModule).interfaceId));

        _installModule();

        assertTrue(_routesManifestTo(account, m, address(module)));
        for (uint256 i = 0; i < m.executionFunctions.length; i++) {
            ExecutionDataView memory d = account.getExecutionData(m.executionFunctions[i].executionSelector);
            assertEq(d.module, address(module));
            assertEq(d.allowGlobalValidation, m.executionFunctions[i].allowGlobalValidation, "flag from manifest");
            assertFalse(d.skipRuntimeValidation);
            assertEq(d.executionHooks.length, 0);
        }
        assertTrue(account.supportsInterface(type(IERC165).interfaceId));
        assertTrue(account.supportsInterface(type(IGatewayExecutionModule).interfaceId), "manifest.interfaceIds");
        assertFalse(account.supportsInterface(type(IERC6900Module).interfaceId), "IModule is never added");
    }

    /// Circle's `_onInstall` only runs — and only checks ERC-165 — when install data is non-empty. With data, the
    /// module passes because its `IERC6900Module` id IS Circle's `IModule` id; a contract with no ERC-165 at all is
    /// refused, proving the gate is live on a real account and not just in the local suite's reasoning.
    function test_installExecution_withInstallData_runsCirclesIModuleErc165Gate() public {
        bytes memory install = _installExecutionCalldata(address(module), _circleManifest(), hex"01");
        assertTrue(_executeUserOp(account, install, owner.key), "IERC6900Module == IModule: gate passes");
        assertTrue(_routesManifestTo(account, _circleManifest(), address(module)));

        UpgradableMSCA other = _createSingleSignerAccount(owner, bytes32(uint256(0x6B)));
        bytes memory bogus = _installExecutionCalldata(address(helper), _circleManifest(), hex"01");
        assertFalse(_executeUserOp(other, bogus, owner.key), "GatewayHelper has no supportsInterface");
        assertEq(
            _lastUserOpRevertReason(),
            abi.encodeWithSelector(BaseMSCA.InterfaceNotSupported.selector, address(helper), type(IModule).interfaceId)
        );
        assertEq(_executionModule(other, IGatewayExecutionModule.authorizeDelegate.selector), address(0), "no state");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  (b) Through the account: msg.sender at Gateway is the MODULE                   ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// `allowGlobalValidation: false` on a v0.8 account means: the owner's global validation is refused for the
    /// selector (flag 1), and the per-selector flag (0) only works once the owner validation has been re-installed
    /// with that selector in its list. Both refusals are the account's own `InvalidValidationFunction`.
    function test_authorizeDelegate_isRefusedUnderGlobalValidation_untilTheOwnerIsGrantedTheSelector() public {
        _installModule();
        bytes memory callData = abi.encodeCall(IGatewayExecutionModule.authorizeDelegate, (address(usdc), delegate));
        bytes memory refused = abi.encodeWithSelector(
            BaseMSCA.InvalidValidationFunction.selector,
            IGatewayExecutionModule.authorizeDelegate.selector,
            _ownerValidation()
        );
        _expectFailedOpWithRevert(_prepareOwnerUserOp(account, callData, owner.key), refused);
        _expectFailedOpWithRevert(_prepareOwnerUserOpPerSelector(account, callData, owner.key), refused);
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));

        assertTrue(_grantSelectorsToOwner(account, _perSelectorSelectors(), owner.key));
        assertTrue(
            _validationHasSelector(account, _ownerValidation(), IGatewayExecutionModule.authorizeDelegate.selector)
        );
        _expectFailedOpWithRevert(_prepareOwnerUserOp(account, callData, owner.key), refused);
        assertTrue(_executeUserOpPerSelector(account, callData, owner.key), "per-selector, after the grant");
    }

    /// The account's fallback forwards the call with `msg.sender == account` (the module's event says so), the
    /// module then calls Gateway with `msg.sender == module`, and that is the key Gateway stores under.
    function test_authorizeDelegate_throughTheAccount_landsOnTheModulesGatewayPosition() public {
        _installModuleAndGrantSelectors();
        PackedUserOperation memory op = _prepareOwnerUserOpPerSelector(
            account, abi.encodeCall(IGatewayExecutionModule.authorizeDelegate, (address(usdc), delegate)), owner.key
        );
        vm.expectEmit(true, true, true, true, address(module));
        emit IGatewayExecutionModule.DelegateAuthorized(address(account), address(usdc), delegate);
        assertTrue(_executeSignedUserOp(op));

        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate), "keyed to the module");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(account), delegate), "account got nothing");
        assertTrue(module.isDelegateAuthorized(address(usdc), address(module), delegate));
        assertFalse(module.isDelegateAuthorized(address(usdc), address(account), delegate));

        // revokeDelegate is `allowGlobalValidation: true`: the plain owner flag reaches it.
        bytes memory revoke = abi.encodeCall(IGatewayExecutionModule.revokeDelegate, (address(usdc), delegate));
        assertTrue(_executeUserOp(account, revoke, owner.key));
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));
    }

    /// Finding #2 through a real account: the account holds the USDC and approved Gateway, yet `depositToGateway`
    /// pulls from the MODULE (its `safeIncreaseAllowance` + `deposit` run as the module), so the execution phase
    /// dies on the module's zero balance. Give the module USDC and the deposit lands on the module's position.
    function test_depositToGateway_throughTheAccount_failsOnTheModulesZeroBalance_thenSpendsTheModulesOwnUsdc() public {
        _installModuleAndGrantSelectors();
        uint256 amount = 1_000e6;
        _approveGatewayThroughExecute(amount);
        assertEq(usdc.allowance(address(account), address(gateway)), amount);

        bytes memory deposit = abi.encodeCall(IGatewayExecutionModule.depositToGateway, (address(usdc), amount));
        assertFalse(_executeUserOpPerSelector(account, deposit, owner.key), "execution phase fails");
        assertEq(
            _lastUserOpRevertReason(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(module), 0, amount)
        );
        assertEq(usdc.balanceOf(address(account)), ACCOUNT_USDC, "the account's USDC never moved");
        assertEq(gateway.totalBalance(address(usdc), address(account)), 0);

        usdc.mint(address(module), amount);
        assertTrue(_executeUserOpPerSelector(account, deposit, owner.key), "the module's own USDC deposits");
        assertEq(gateway.totalBalance(address(usdc), address(module)), amount, "credited to the module");
        assertEq(gateway.totalBalance(address(usdc), address(account)), 0, "not to the account that signed");
        assertEq(usdc.balanceOf(address(account)), ACCOUNT_USDC);
    }

    function test_withdrawal_throughTheAccount_paysTheModule_notTheAccount() public {
        _installModuleAndGrantSelectors();
        uint256 amount = 500e6;
        usdc.mint(address(module), amount);
        bytes memory deposit = abi.encodeCall(IGatewayExecutionModule.depositToGateway, (address(usdc), amount));
        bytes memory initiate = abi.encodeCall(IGatewayExecutionModule.initiateWithdrawal, (address(usdc), amount));
        assertTrue(_executeUserOpPerSelector(account, deposit, owner.key));
        assertTrue(_executeUserOpPerSelector(account, initiate, owner.key));
        assertEq(gateway.withdrawingBalance(address(usdc), address(module)), amount);

        vm.roll(block.number + WITHDRAWAL_DELAY_BLOCKS);
        PackedUserOperation memory op = _prepareOwnerUserOp(
            account, abi.encodeCall(IGatewayExecutionModule.completeWithdrawal, (address(usdc))), owner.key
        );
        // The event reads `withdrawableBalance(token, msg.sender)` — the ACCOUNT's position, 0 — while Gateway
        // pays out the MODULE's (finding #3).
        vm.expectEmit(true, true, false, true, address(module));
        emit IGatewayExecutionModule.WithdrawalCompleted(address(account), address(usdc), 0);
        assertTrue(_executeSignedUserOp(op), "completeWithdrawal is global");

        assertEq(usdc.balanceOf(address(module)), amount, "Gateway paid msg.sender: the module");
        assertEq(usdc.balanceOf(address(account)), ACCOUNT_USDC, "the signing account received nothing");
        assertEq(gateway.totalBalance(address(usdc), address(module)), 0);
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  (c) The sound pattern: execute() + GatewayHelper calldata                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// `execute` is a plain call FROM the account, so Gateway keys everything by the account. Runs with the module
    /// installed to show the two Gateway positions (account vs module) are unrelated keys.
    function test_soundPattern_accountExecutesHelperCalldata_theAccountIsTheDepositor() public {
        _installModuleAndGrantSelectors();
        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "authorize via execute");
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(account), delegate), "keyed to the account");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));

        uint256 amount = 2_500e6;
        Call[] memory calls = new Call[](2);
        (calls[0].target, calls[0].data) = helper.encodeApproveGateway(address(usdc), amount);
        (calls[1].target, calls[1].data) = helper.encodeDeposit(address(usdc), amount);
        assertTrue(_executeUserOp(account, _executeBatchCalldata(calls), owner.key), "approve + deposit batch");
        assertEq(gateway.totalBalance(address(usdc), address(account)), amount, "credited to the account");
        assertEq(gateway.totalBalance(address(usdc), address(module)), 0);
        assertEq(usdc.balanceOf(address(account)), ACCOUNT_USDC - amount);

        (target, data) = helper.encodeInitiateWithdrawal(address(usdc), amount);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "initiate");
        vm.roll(block.number + WITHDRAWAL_DELAY_BLOCKS);
        (target, data) = helper.encodeCompleteWithdrawal(address(usdc));
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "complete");
        assertEq(usdc.balanceOf(address(account)), ACCOUNT_USDC, "USDC back on the account");
        assertEq(gateway.totalBalance(address(usdc), address(account)), 0);

        (target, data) = helper.encodeRevokeDelegate(address(usdc), delegate);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key));
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(account), delegate));
    }

    /// Same pattern on the v0.8 analogue of a BUFI treasury: a 2-of-3 `WeightedMultisigValidationModule` account.
    function test_soundPattern_onAWeightedMultisigAccount_2of3() public {
        Signer[] memory signers = _makeSigners("treasury", 3);
        UpgradableMSCA treasury = _createWeightedAccount(signers, _uniformWeights(3, 1), 2, bytes32(uint256(0x7A)));
        Signer[] memory quorum = new Signer[](2);
        quorum[0] = signers[0];
        quorum[1] = signers[2];
        Signer[] memory solo = new Signer[](1);
        solo[0] = signers[1];

        (address target, bytes memory data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        _expectWeightedValidationRevert(treasury, _executeCalldata(target, 0, data), solo);
        assertTrue(_executeWeightedUserOp(treasury, _executeCalldata(target, 0, data), quorum), "2 of 3");
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(treasury), delegate));
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));

        bytes memory install = _installExecutionCalldata(address(module), _circleManifest(), "");
        assertTrue(_executeWeightedUserOp(treasury, install, quorum), "the module installs the same way");
        assertTrue(_routesManifestTo(treasury, _circleManifest(), address(module)));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  (d) Circle's v0.8 ColdStorageAddressBookModule                                 ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// The v0.8 address book is a validation hook, and `_installValidation` ERC-165-checks a hook module for
    /// `IValidationHookModule` whenever hook install data is non-empty. Circle's module only advertises
    /// `IAddressBookModule` + `IModule` (its `TestAddressBookModule` advertises `IValidationHookModule`, which is
    /// why Circle's own hook test passes) — so the allowlist cannot be seeded through the hook. Seed it through the
    /// module's execution manifest instead (`_seedAddressBook`) and attach the hook with empty data.
    function test_addressBook_cannotBeSeededThroughHookInstallData_itDoesNotAdvertiseIValidationHookModule() public {
        assertFalse(addressBook.supportsInterface(type(IValidationHookModule).interfaceId), "not advertised");
        assertTrue(addressBook.supportsInterface(type(IAddressBookModule).interfaceId));
        assertTrue(addressBook.supportsInterface(type(IModule).interfaceId));

        bytes[] memory hooks = new bytes[](1);
        hooks[0] = _addressBookHook(
            ColdStorageAddressBookModule.EntityId.PRE_VALIDATION_HOOK_EXECUTE_ADDRESS_BOOK,
            abi.encode(_single(address(gateway)))
        );
        bytes4[] memory selectors = _single(IModularAccount.execute.selector);
        assertFalse(
            _installSingleSignerValidation(account, COLD_ENTITY_ID, coldSigner.addr, false, selectors, hooks, owner.key)
        );
        assertEq(
            _lastUserOpRevertReason(),
            abi.encodeWithSelector(
                BaseMSCA.InterfaceNotSupported.selector, address(addressBook), type(IValidationHookModule).interfaceId
            )
        );
        assertEq(addressBook.getAllowedRecipients(address(account)).length, 0);
    }

    /// A dedicated "cold" validation (second single-signer entity, per-selector for `execute` only) carries the
    /// address-book hook. Through it: `approve(gateway, …)` passes (ERC-20 spender == allowlisted recipient), every
    /// Gateway-targeted selector fails closed exactly like v0.7 (finding #6), and anything outside its selector
    /// list is refused before the hook even runs. The hook gates ONLY the validation it hangs off — the global
    /// owner validation walks straight past it.
    function test_addressBook_onAColdValidation_gatesExecuteRecipients_andLeavesTheOwnerValidationUngated() public {
        _installModule();
        _seedAddressBook(_single(address(gateway)));

        bytes[] memory hooks = new bytes[](1);
        hooks[0] = _addressBookHook(ColdStorageAddressBookModule.EntityId.PRE_VALIDATION_HOOK_EXECUTE_ADDRESS_BOOK, "");
        bytes4[] memory selectors = _single(IModularAccount.execute.selector);
        assertTrue(
            _installSingleSignerValidation(
                account, COLD_ENTITY_ID, coldSigner.addr, false, selectors, hooks, owner.key
            ),
            "cold validation"
        );
        ModuleEntity cold = ModuleEntityLib.pack(address(singleSigner), COLD_ENTITY_ID);
        assertEq(_validationData(account, cold).validationHooks.length, 1);

        (address target, bytes memory data) = helper.encodeApproveGateway(address(usdc), 1e6);
        assertTrue(_executeCold(_executeCalldata(target, 0, data)), "approve: spender allowlisted");
        assertEq(usdc.allowance(address(account), address(gateway)), 1e6);

        bytes memory noRecipient =
            abi.encodeWithSelector(IAddressBookModule.UnauthorizedRecipient.selector, address(account), address(0));
        (target, data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        _expectColdRevert(_executeCalldata(target, 0, data), noRecipient);
        (target, data) = helper.encodeDeposit(address(usdc), 1e6);
        _expectColdRevert(_executeCalldata(target, 0, data), noRecipient);
        (target, data) = helper.encodeInitiateWithdrawal(address(usdc), 1e6);
        _expectColdRevert(_executeCalldata(target, 0, data), noRecipient);
        (target, data) = helper.encodeCompleteWithdrawal(address(usdc));
        _expectColdRevert(_executeCalldata(target, 0, data), noRecipient);
        _expectColdRevert(
            _executeCalldata(address(usdc), 0, abi.encodeCall(IERC20.transfer, (stranger, 1))),
            abi.encodeWithSelector(IAddressBookModule.UnauthorizedRecipient.selector, address(account), stranger)
        );

        Call[] memory calls = new Call[](1);
        (calls[0].target, calls[0].data) = helper.encodeApproveGateway(address(usdc), 1e6);
        _expectColdRevert(
            _executeBatchCalldata(calls),
            abi.encodeWithSelector(
                BaseMSCA.InvalidValidationFunction.selector, IModularAccount.executeBatch.selector, cold
            )
        );
        _expectColdRevert(
            abi.encodeCall(IGatewayExecutionModule.revokeDelegate, (address(usdc), delegate)),
            abi.encodeWithSelector(
                BaseMSCA.InvalidValidationFunction.selector, IGatewayExecutionModule.revokeDelegate.selector, cold
            )
        );
        assertEq(gateway.totalBalance(address(usdc), address(account)), 0, "nothing reached Gateway");
        assertFalse(gateway.isAuthorizedForBalance(address(usdc), address(account), delegate));

        (target, data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "owner: ungated");
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(account), delegate));
    }

    /// Attach the same hook to the account's ONLY global validation (what Circle's `DynamicValidationHookData.t.sol`
    /// does with its test module) and the account is administratively bricked: the hook decodes EVERY owner-signed
    /// userOp as `execute(target, value, data)`, so `revokeDelegate`, `uninstallExecution`, `installValidation` and
    /// `uninstallValidation` itself all die in the hook. Only `execute` to an allowlisted recipient survives.
    function test_addressBook_onTheOwnerValidation_rejectsEveryOwnerOpThatIsNotAnExecute() public {
        _installModule();
        _seedAddressBook(_single(address(gateway)));
        bytes[] memory hooks = new bytes[](1);
        hooks[0] = _addressBookHook(ColdStorageAddressBookModule.EntityId.PRE_VALIDATION_HOOK_EXECUTE_ADDRESS_BOOK, "");
        assertTrue(_attachHooksToOwner(account, hooks, owner.key));

        (address target, bytes memory data) = helper.encodeApproveGateway(address(usdc), 1e6);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "approve(gateway) ok");
        (target, data) = helper.encodeAuthorizeDelegate(address(usdc), delegate);
        _expectFailedOpWithRevert(
            _prepareOwnerUserOp(account, _executeCalldata(target, 0, data), owner.key),
            abi.encodeWithSelector(IAddressBookModule.UnauthorizedRecipient.selector, address(account), address(0))
        );

        // 64 bytes of (token, delegate) cannot decode as (address, uint256, bytes): abi.decode reverts.
        _expectValidationRevert(
            account, abi.encodeCall(IGatewayExecutionModule.revokeDelegate, (address(usdc), delegate)), owner.key
        );
        // (module, manifestOffset = 0x60, "") DOES decode: to the hook it is "send 96 wei to the module".
        _expectFailedOpWithRevert(
            _prepareOwnerUserOp(
                account, _uninstallExecutionCalldata(address(module), _circleManifest(), ""), owner.key
            ),
            abi.encodeWithSelector(IAddressBookModule.UnauthorizedRecipient.selector, address(account), address(module))
        );
        assertTrue(_routesManifestTo(account, _circleManifest(), address(module)), "could not be uninstalled");
        ValidationConfig ownerConfig = ValidationConfigLib.pack(_ownerValidation(), true, true, true);
        _expectValidationRevert(
            account, _installValidationCalldata(ownerConfig, new bytes4[](0), "", new bytes[](0)), owner.key
        );
        _expectValidationRevert(
            account,
            abi.encodeCall(IModularAccount.uninstallValidation, (_ownerValidation(), "", new bytes[](0))),
            owner.key
        );
    }

    /// Circle's manifest marks `addAllowedRecipients` `skipRuntimeValidation: true` (with a `// TODO: allow global
    /// validation` beside it). On a real account that means the fallback forwards it with NO validation of any
    /// kind, and the module records recipients under `msg.sender == account`: any address can extend an account's
    /// allowlist. `removeAllowedRecipients` is validated normally. This is Circle's WIP module ("not deployed on
    /// any mainnets yet"), recorded here so nobody installs its execution manifest on a treasury as-is.
    function test_addressBook_addAllowedRecipients_skipsRuntimeValidation_soAnyoneCanExtendTheAllowlist() public {
        _seedAddressBook(_single(address(gateway)));
        ExecutionDataView memory d = account.getExecutionData(IAddressBookModule.addAllowedRecipients.selector);
        assertEq(d.module, address(addressBook));
        assertTrue(d.skipRuntimeValidation, "manifest: skipRuntimeValidation");
        assertFalse(d.allowGlobalValidation);

        vm.prank(stranger);
        IAddressBookModule(address(account)).addAllowedRecipients(_single(stranger));
        address[] memory allowed = addressBook.getAllowedRecipients(address(account));
        assertEq(allowed.length, 2);
        assertTrue(_contains(allowed, stranger), "a stranger allowlisted itself");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BaseMSCA.InvalidValidationFunction.selector,
                IAddressBookModule.removeAllowedRecipients.selector,
                ModuleEntityLib.pack(stranger, DIRECT_CALL_VALIDATION_ENTITY_ID)
            )
        );
        IAddressBookModule(address(account)).removeAllowedRecipients(_single(stranger));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  (e) uninstallExecution                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function test_uninstallExecution_unroutesTheModule_dropsItsInterface_andLeavesGatewayStateBehind() public {
        _installModuleAndGrantSelectors();
        bytes memory authorize = abi.encodeCall(IGatewayExecutionModule.authorizeDelegate, (address(usdc), delegate));
        assertTrue(_executeUserOpPerSelector(account, authorize, owner.key));
        assertTrue(gateway.isAuthorizedForBalance(address(usdc), address(module), delegate));

        ExecutionManifest memory m = _circleManifest();
        assertTrue(_executeUserOp(account, _uninstallExecutionCalldata(address(module), m, ""), owner.key), "global");

        for (uint256 i = 0; i < m.executionFunctions.length; i++) {
            ExecutionDataView memory d = account.getExecutionData(m.executionFunctions[i].executionSelector);
            assertEq(d.module, address(0));
            assertFalse(d.allowGlobalValidation);
            assertFalse(d.skipRuntimeValidation);
        }
        assertFalse(account.supportsInterface(type(IGatewayExecutionModule).interfaceId));
        assertTrue(
            _validationHasSelector(account, _ownerValidation(), IGatewayExecutionModule.authorizeDelegate.selector),
            "the owner's selector grant is append-only and survives the uninstall"
        );
        // Validation still admits the selector; execution has nowhere to route it.
        assertFalse(_executeUserOpPerSelector(account, authorize, owner.key));
        assertEq(
            _lastUserOpRevertReason(),
            abi.encodeWithSelector(
                InvalidExecutionFunction.selector, IGatewayExecutionModule.authorizeDelegate.selector
            )
        );
        assertTrue(
            gateway.isAuthorizedForBalance(address(usdc), address(module), delegate),
            "the delegation outlives the install, as the module's own onUninstall warns"
        );

        _installModule();
        assertTrue(_routesManifestTo(account, m, address(module)), "re-install is clean");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Helpers                                                                        ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// The module's v0.8.1-typed manifest re-typed as Circle's v0.8.0 struct — a pure re-encode, see
    /// `test_compat_v081ModuleTypesAreAbiIdenticalToCirclesV080Types`.
    function _circleManifest() internal view returns (ExecutionManifest memory) {
        return abi.decode(abi.encode(module.executionManifest()), (ExecutionManifest));
    }

    function _installModule() internal {
        bytes memory callData = _installExecutionCalldata(address(module), _circleManifest(), "");
        assertTrue(_executeUserOp(account, callData, owner.key), "installExecution");
    }

    /// The three manifest selectors with `allowGlobalValidation: false`.
    function _perSelectorSelectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = IGatewayExecutionModule.authorizeDelegate.selector;
        s[1] = IGatewayExecutionModule.depositToGateway.selector;
        s[2] = IGatewayExecutionModule.initiateWithdrawal.selector;
    }

    function _installModuleAndGrantSelectors() internal {
        _installModule();
        assertTrue(_grantSelectorsToOwner(account, _perSelectorSelectors(), owner.key), "grant selectors");
    }

    function _approveGatewayThroughExecute(uint256 amount) internal {
        (address target, bytes memory data) = helper.encodeApproveGateway(address(usdc), amount);
        assertTrue(_executeUserOp(account, _executeCalldata(target, 0, data), owner.key), "approve");
    }

    /// Seeds the address book's allowlist for `account` the only way Circle's v0.8 module allows: through its
    /// execution manifest, whose `onInstall` decodes `abi.encode(address[])`.
    function _seedAddressBook(address[] memory recipients) internal {
        bytes memory callData =
            _installExecutionCalldata(address(addressBook), addressBook.executionManifest(), abi.encode(recipients));
        assertTrue(_executeUserOp(account, callData, owner.key), "seed address book");
        assertEq(addressBook.getAllowedRecipients(address(account)), recipients);
    }

    function _executeCold(bytes memory callData) internal returns (bool) {
        return _executeUserOpAs(account, callData, COLD_ENTITY_ID, false, coldSigner.key);
    }

    function _expectColdRevert(bytes memory callData, bytes memory inner) internal {
        _expectFailedOpWithRevert(_prepareUserOp(account, callData, COLD_ENTITY_ID, false, coldSigner.key), inner);
    }

    function _single(address a) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = a;
    }

    function _single(bytes4 s) internal pure returns (bytes4[] memory out) {
        out = new bytes4[](1);
        out[0] = s;
    }

    function _contains(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }
}
