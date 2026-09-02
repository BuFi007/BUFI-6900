// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionCounter, SessionKeyHarness, SessionTestPaymaster} from "../harness/SessionKeyHarness.sol";

import {IBufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";

import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ValidationDataLib} from "@circle/msca/6900/shared/libs/ValidationDataLib.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/src/Vm.sol";

contract SenderTaxToken is ERC20 {
    constructor() ERC20("Sender-tax token", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from != address(0) && to != address(0) && amount != 0) {
            super._update(from, address(0), amount / 10);
        }
    }
}

contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract ZeroTransferReverter is ERC20 {
    error ZeroTransfer();

    constructor() ERC20("Zero-reverting token", "ZERO") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (amount == 0) revert ZeroTransfer();
        return super.transfer(to, amount);
    }
}

contract RebaseToken is ERC20 {
    constructor() ERC20("Rebase token", "RBS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function slash(address account, uint256 amount) external {
        _burn(account, amount);
    }
}

contract EmptySelectorTarget {
    uint256 public calls;

    receive() external payable {
        ++calls;
    }
}

contract ReentrantSessionTarget {
    bool public addSucceeded;
    bool public removeSucceeded;
    bool public updateSucceeded;
    bool public nestedExecuteSucceeded;

    function attack(address account, address attemptedKey, address currentKey, bytes32 predecessor) external {
        bytes[] memory noUpdates = new bytes[](0);
        (addSucceeded,) =
            account.call(abi.encodeCall(IBufiSessionKeyPlugin.addSessionKey, (attemptedKey, bytes32(0), noUpdates)));
        (removeSucceeded,) =
            account.call(abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (currentKey, predecessor)));
        (updateSucceeded,) =
            account.call(abi.encodeCall(IBufiSessionKeyPlugin.updateKeyPermissions, (currentKey, noUpdates)));
        Call[] memory noCalls = new Call[](0);
        (nestedExecuteSucceeded,) =
            account.call(abi.encodeCall(IBufiSessionKeyPlugin.executeWithSessionKey, (noCalls, attemptedKey)));
    }
}

contract SessionKeyAdversarialTest is SessionKeyHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;
    Signer internal agent;
    address internal recipient;

    uint256 internal constant T0 = 1_900_000_000;

    function setUp() public {
        vm.warp(T0);
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        (UpgradableMSCA msca, Signer[] memory q) =
            _createAccountWithSessionKeyPlugin("adversarial-owner", bytes32(uint256(0xA1)));
        account = msca;
        quorum.push(q[0]);
        quorum.push(q[1]);
        agent = _signerFrom("adversarial-agent");
        recipient = makeAddr("recipient");
    }

    /// SAFE assertion intentionally fails if an unmetered session key can consume the owners' nonce lane.
    function test_SAFE_pendingOwnerRevocationSurvivesAgentNonceLaneCollision() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));

        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), agent.addr);
        PackedUserOperation memory pendingRevocation = _prepareUserOp(
            account, abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (agent.addr, predecessor)), quorum
        );

        // FIXED (F-01 / port deviation D10): the nonce-lane rule now applies to EVERY session key, not only
        // gas-limited ones, so an agent can no longer sit in lane 0 and burn the nonce an owner operation is
        // waiting on. The collision attempt is rejected during validation and the pending revocation still lands.
        PackedUserOperation memory collision =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), agent.addr);
        collision.nonce = entryPoint.getNonce(address(account), 0);
        collision.signature = _signSessionKey(collision, agent.key);
        PackedUserOperation[] memory collisionOps = new PackedUserOperation[](1);
        collisionOps[0] = collision;
        (bool agentSucceeded,) =
            address(entryPoint).call(abi.encodeCall(IEntryPoint.handleOps, (collisionOps, beneficiary)));
        assertFalse(agentSucceeded, "an agent operation outside its own nonce lane must be rejected");

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = pendingRevocation;
        (bool ownerSucceeded,) = address(entryPoint).call(abi.encodeCall(IEntryPoint.handleOps, (ops, beneficiary)));

        assertTrue(ownerSucceeded, "SAFE: an agent must not invalidate a pending owner revocation");
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));
    }

    function test_gasLimitedKeyCannotUseTheOwnerNonceLane_evenAfterPublicReset() public {
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permNativeUnlimited(), _permGasLimit(10 ether, 1 days)),
                quorum
            )
        );
        sessionKeyPlugin.resetSessionKeyGasLimitTimestamp(address(account), agent.addr);

        PackedUserOperation memory op =
            _buildSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), agent.addr);
        op.nonce = entryPoint.getNonce(address(account), 0);
        op.signature = _signSessionKey(op, agent.key);
        _expectHandleOpsRevert(op, _aa23PermissionsCheckFailed());
    }

    function test_preparedOldKeyOperationIsRejectedWhenRotationLandsFirst() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        PackedUserOperation memory stale =
            _prepareSessionKeyUserOp(account, _calls(_nativeTransfer(recipient, 1 wei)), agent);

        Signer memory replacement = _signerFrom("replacement-agent");
        assertTrue(_rotateSessionKey(account, agent.addr, replacement.addr, quorum));
        _expectHandleOpsRevert(stale, _aa23PermissionsCheckFailed());
        assertEq(recipient.balance, 0);
    }

    function test_refreshAndKeyTimeBoundsAreInclusiveAtExactEdges() public {
        RebaseToken token = new RebaseToken();
        token.mint(address(account), 1_000 ether);
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(
                    _permAllowAll(),
                    _permErc20Limit(address(token), 100 ether, 1 days),
                    _permTimeRange(uint48(T0), uint48(T0 + 1 days))
                ),
                quorum
            )
        );

        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token), recipient, 100 ether)), agent)
        );
        vm.warp(T0 + 1 days);
        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token), recipient, 100 ether)), agent)
        );
        assertEq(token.balanceOf(recipient), 200 ether);
    }

    function test_circleValidationDataRejectsEqualAndInvertedBounds_andRepacksZeroUntil() public {
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        Call[] memory calls = _calls(_nativeTransfer(recipient, 0));

        assertTrue(_updateKeyPermissions(account, agent.addr, _updates(_permTimeRange(uint48(T0), uint48(T0))), quorum));
        PackedUserOperation memory op = _prepareSessionKeyUserOp(account, calls, agent);
        uint256 validationData = _validateAsEntryPoint(account, op);
        assertEq(uint160(validationData), 1, "equal bounds are signature-failed");

        assertTrue(
            _updateKeyPermissions(account, agent.addr, _updates(_permTimeRange(uint48(T0 + 1), uint48(T0))), quorum)
        );
        op = _prepareSessionKeyUserOp(account, calls, agent);
        bytes32 invertedHash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        vm.expectRevert(ValidationDataLib.WrongTimeBounds.selector);
        account.validateUserOp(op, invertedHash, 0);

        assertTrue(_updateKeyPermissions(account, agent.addr, _updates(_permTimeRange(uint48(T0), 0)), quorum));
        op = _prepareSessionKeyUserOp(account, calls, agent);
        validationData = _validateAsEntryPoint(account, op);
        assertEq(uint48(validationData >> 160), type(uint48).max);
        assertEq(uint160(validationData), 0);
    }

    /// SAFE assertion intentionally fails for tokens that surcharge the sender beyond the calldata amount.
    /// @notice KNOWN, ACCEPTED — adversarial finding F-04. Budgets count the amount encoded in calldata, so a
    /// sender-taxed (fee-on-transfer) token debits the account by more than the nominal budget. Enforcing an actual
    /// balance delta cannot be made general (a hostile token can lie in `balanceOf` too). Mitigation: the supported
    /// -token policy in grant issuance (USDC / EURC are not fee-on-transfer).
    function test_KNOWN_F04_feeOnTransferDebitsMoreThanTheNominalBudget() public {
        SenderTaxToken token = new SenderTaxToken();
        token.mint(address(account), 1_000 ether);
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permErc20Limit(address(token), 100 ether, 0)),
                quorum
            )
        );

        uint256 beforeBalance = token.balanceOf(address(account));
        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token), recipient, 100 ether)), agent)
        );
        uint256 debited = beforeBalance - token.balanceOf(address(account));

        // The budget counts the calldata amount (100), the token taxes the sender 10% on top, so the account is
        // debited 110. Pinned so the deviation is visible if a future change tries to enforce actual deltas.
        assertEq(debited, 110 ether, "KNOWN F-04: a taxed token debits more than the nominal budget");
    }

    function test_externalRebaseDoesNotResetOrBypassNominalSpendAccounting() public {
        RebaseToken token = new RebaseToken();
        token.mint(address(account), 1_000 ether);
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permErc20Limit(address(token), 100 ether, 0)),
                quorum
            )
        );
        assertTrue(
            _executeSessionKeyUserOp(account, _calls(_erc20Transfer(address(token), recipient, 40 ether)), agent)
        );
        token.slash(address(account), 100 ether);

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account, _calls(_erc20Transfer(address(token), recipient, 61 ether)), agent
        );
        assertFalse(ok);
        assertEq(
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(token)).limitUsed, 40 ether
        );
    }

    function test_zeroValueRevertingTokenRollsBackLimitAccounting() public {
        ZeroTransferReverter token = new ZeroTransferReverter();
        token.mint(address(account), 1 ether);
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permErc20Limit(address(token), 0, 0)),
                quorum
            )
        );

        (bool ok,) =
            _executeSessionKeyUserOpWithReason(account, _calls(_erc20Transfer(address(token), recipient, 0)), agent);
        assertFalse(ok);
        assertEq(sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(token)).limitUsed, 0);
    }

    /// SAFE assertion intentionally fails because executeWithSessionKey ignores a standard ERC-20 false return.
    /// @notice KNOWN, ACCEPTED — adversarial finding F-05. `executeWithSessionKey` returns raw bytes and does not
    /// check a token's ERC-20 boolean, so a `false`-returning token yields a "successful" user operation while the
    /// key's budget is consumed. This is the audited upstream behaviour (Alchemy MAv1) and is kept deliberately.
    /// Mitigation: grant issuance only allows a supported-token list (USDC / EURC), which revert rather than return
    /// false. Adding SafeERC20-style checking would be port deviation D11 and is NOT applied.
    function test_KNOWN_F05_falseReturningTokenIsReportedAsSuccess() public {
        FalseReturnToken token = new FalseReturnToken();
        token.mint(address(account), 100 ether);
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permErc20Limit(address(token), 100 ether, 0)),
                quorum
            )
        );

        (bool ok,) = _executeSessionKeyUserOpWithReason(
            account,
            _calls(_call(address(token), 0, abi.encodeCall(FalseReturnToken.transfer, (recipient, 10 ether)))),
            agent
        );
        assertTrue(ok, "KNOWN F-05: a false-returning token is still reported as a successful userOp");
    }

    function test_accessListEmptySelectorSemanticsAcrossAllModes() public {
        EmptySelectorTarget target = new EmptySelectorTarget();
        assertTrue(
            _addSessionKey(
                account, agent.addr, bytes32(0), _updates(_permAddressEntry(address(target), true, true)), quorum
            )
        );
        Call[] memory emptySelectorCall = _calls(_call(address(target), 0, ""));

        _expectSessionKeyValidationRevert(account, emptySelectorCall, agent, _aa23PermissionsCheckFailed());
        assertTrue(
            _updateKeyPermissions(
                account, agent.addr, _updates(_permFunctionEntry(address(target), bytes4(0), true)), quorum
            )
        );
        assertTrue(_executeSessionKeyUserOp(account, emptySelectorCall, agent));

        assertTrue(
            _updateKeyPermissions(
                account,
                agent.addr,
                _updates(_permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.DENYLIST)),
                quorum
            )
        );
        _expectSessionKeyValidationRevert(account, emptySelectorCall, agent, _aa23PermissionsCheckFailed());
        assertTrue(
            _updateKeyPermissions(
                account, agent.addr, _updates(_permFunctionEntry(address(target), bytes4(0), false)), quorum
            )
        );
        assertTrue(_executeSessionKeyUserOp(account, emptySelectorCall, agent));

        assertTrue(_updateKeyPermissions(account, agent.addr, _updates(_permAllowAll()), quorum));
        assertTrue(_executeSessionKeyUserOp(account, emptySelectorCall, agent));
        assertEq(target.calls(), 3);
    }

    function test_duplicateTargetsAreCumulative_andMixedDisallowedBatchIsAtomic() public {
        RebaseToken token = new RebaseToken();
        token.mint(address(account), 1_000 ether);
        SessionCounter disallowed = new SessionCounter();
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(
                    _permAddressEntry(address(token), true, true),
                    _permFunctionEntry(address(token), IERC20.transfer.selector, true),
                    _permErc20Limit(address(token), 100 ether, 0)
                ),
                quorum
            )
        );

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _erc20Transfer(address(token), recipient, 50 ether),
                    _erc20Transfer(address(token), recipient, 50 ether)
                ),
                agent
            )
        );
        assertEq(token.balanceOf(recipient), 100 ether);

        _expectSessionKeyValidationRevert(
            account,
            _calls(
                _erc20Transfer(address(token), recipient, 0),
                _call(address(disallowed), 0, abi.encodeCall(SessionCounter.increment, ()))
            ),
            agent,
            _aa23PermissionsCheckFailed()
        );
        assertEq(disallowed.number(), 0);
    }

    function test_reentrantTargetCannotReachManagementOrNestedSessionExecution() public {
        ReentrantSessionTarget target = new ReentrantSessionTarget();
        address attemptedKey = makeAddr("reentrant-added-key");
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), _permUnrestricted(), quorum));
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(account), agent.addr);

        assertTrue(
            _executeSessionKeyUserOp(
                account,
                _calls(
                    _call(
                        address(target),
                        0,
                        abi.encodeCall(
                            ReentrantSessionTarget.attack, (address(account), attemptedKey, agent.addr, predecessor)
                        )
                    )
                ),
                agent
            )
        );
        assertFalse(target.addSucceeded());
        assertFalse(target.removeSucceeded());
        assertFalse(target.updateSucceeded());
        assertFalse(target.nestedExecuteSucceeded());
        assertTrue(sessionKeyPlugin.isSessionKeyOf(address(account), agent.addr));
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), attemptedKey));
    }

    function test_droppedNotContractCallerCanOnlyInitializeTheDirectCallersNamespace() public {
        address codelessCaller = makeAddr("codeless-caller");
        address isolatedKey = makeAddr("isolated-key");
        address[] memory keys = new address[](1);
        keys[0] = isolatedKey;
        bytes32[] memory tags = new bytes32[](1);
        bytes[][] memory permissions = new bytes[][](1);

        vm.prank(codelessCaller);
        sessionKeyPlugin.onInstall(_sessionKeyInstallData(keys, tags, permissions));

        assertTrue(sessionKeyPlugin.isSessionKeyOf(codelessCaller, isolatedKey));
        assertFalse(sessionKeyPlugin.isSessionKeyOf(address(account), isolatedKey));
    }

    function test_paymasterFieldsChargeExactlyTheEntryPointV07RequiredPrefund() public {
        SessionTestPaymaster paymaster = new SessionTestPaymaster(entryPoint);
        paymaster.deposit{value: 10 ether}();
        assertTrue(
            _addSessionKey(
                account,
                agent.addr,
                bytes32(0),
                _updates(_permAllowAll(), _permNativeUnlimited(), _permGasLimit(1 ether, 0)),
                quorum
            )
        );

        PackedUserOperation memory op = _buildSessionKeyUserOpWithGas(
            account,
            _calls(_call(recipient, 0, "")),
            agent.addr,
            300_000,
            200_000,
            100_000,
            1_000 gwei,
            0,
            _paymasterAndData(address(paymaster), 150_000, 50_000)
        );
        uint256 requiredPrefund = _requiredPrefundV07(op);
        assertEq(requiredPrefund, 0.8 ether);
        op.signature = _signSessionKey(op, agent.key);
        vm.recordLogs();
        _handleOps(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 actualGasCost;
        bool succeeded;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, succeeded, actualGasCost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
        assertTrue(succeeded);
        assertLt(actualGasCost, requiredPrefund, "unused prefund is refunded, while the policy charges the maximum");

        (IBufiSessionKeyPlugin.SpendLimitInfo memory info,) =
            sessionKeyPlugin.getGasSpendLimit(address(account), agent.addr);
        assertEq(info.limitUsed, requiredPrefund);
    }
}
