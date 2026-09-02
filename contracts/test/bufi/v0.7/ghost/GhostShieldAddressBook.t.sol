// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {CircleStackHarness} from "../../../harness/CircleStackHarness.sol";

import {MockVault} from "../earn/mocks/Mocks.sol";
import {SandboxUSDC} from "../../../../src/sandbox/SandboxUSDC.sol";

import {ColdStorageAddressBookPlugin} from
    "@circle/msca/6900/v0.7/plugins/v1_0_0/addressbook/ColdStorageAddressBookPlugin.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";

/// @notice Spike S4 for desk-v1's Treasury Ghost Mode plan: does Circle's ColdStorageAddressBookPlugin
///         block a PULLED deposit — `executeBatch([approve(pool, amt), pool.deposit(amt)])` — the way a
///         Hinkal shield is shaped?
///
///         This matters because every BUFI treasury MSCA installs the AddressBook unconditionally
///         (`ensureAddressBookTemplate`), and the live Arc treasury's allowlist holds only the ops wallet
///         and a member wallet. If the hook fires on a pull, no treasury can ever shield until the Hinkal
///         contract is allowlisted — which is a governance change, not a UI one.
///
///         A Hinkal deposit never calls ERC-20 `transfer`. The account approves the pool and the pool takes
///         the tokens with `transferFrom`. The AddressBook documents itself as gating transfer RECIPIENTS,
///         so on the documented behaviour it should not fire — but its ABI also declares `CallDataIsNotEmpty`
///         and `InvalidTargetCodeLength`, so its pre-exec hook clearly inspects target/value/data shape.
///         Reading the docs is not evidence. This runs it.
contract GhostShieldAddressBookTest is CircleStackHarness {
    UpgradableMSCA internal account;
    Signer[] internal quorum;

    SandboxUSDC internal usdc;
    MockVault internal pool;
    address internal allowed;
    address internal stranger;

    uint256 internal constant AMOUNT = 10e6;

    function setUp() public {
        _deployCircleCanonicalStack();

        Signer[] memory owners = _makeSigners("owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(0x9057)));
        quorum.push(owners[0]);
        quorum.push(owners[2]);

        usdc = new SandboxUSDC();
        pool = new MockVault(usdc);
        usdc.mint(address(account), 1_000e6);

        allowed = makeAddr("allowed-recipient");
        stranger = makeAddr("stranger");

        // The allowlist deliberately does NOT contain the pool — that is the whole question.
        address[] memory recipients = new address[](1);
        recipients[0] = allowed;
        assertTrue(_installAddressBook(account, recipients, quorum), "address book install");
    }

    function _shieldBatch() internal view returns (bytes memory) {
        Call[] memory calls = new Call[](2);
        calls[0] = Call({
            target: address(usdc),
            value: 0,
            data: abi.encodeCall(usdc.approve, (address(pool), AMOUNT))
        });
        calls[1] = Call({
            target: address(pool),
            value: 0,
            data: abi.encodeCall(pool.deposit, (AMOUNT, address(account)))
        });
        return abi.encodeCall(IStandardExecutor.executeBatch, (calls));
    }

    /// The control. If this does not revert, the hook is not live and nothing below means anything.
    function test_control_transferToStrangerIsRejected() public {
        _expectValidationRevert(
            account, _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.transfer, (stranger, 1e6))), quorum
        );
        assertEq(usdc.balanceOf(stranger), 0, "stranger must not have been paid");
    }

    /// The control's mirror: an allowlisted recipient goes through, so a revert above is the ALLOWLIST
    /// and not some unrelated validation failure.
    function test_control_transferToAllowlistedSucceeds() public {
        assertTrue(
            _executeUserOp(account, _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.transfer, (allowed, 1e6))), quorum),
            "allowlisted transfer"
        );
        assertEq(usdc.balanceOf(allowed), 1e6, "allowlisted recipient paid");
    }

    function _allowlist(address[] memory recipients) internal returns (bool) {
        return _executeUserOp(
            account, abi.encodeCall(ColdStorageAddressBookPlugin.addAllowedRecipients, (recipients)), quorum
        );
    }

    /// An `approve` IS a recognised shape — `RecipientAddressLib.getERC20TokenRecipient` treats the SPENDER as
    /// the recipient. So the first leg of a shield is gated on the pool being allowlisted, like any transfer.
    function test_approveIsGatedOnTheSpender() public {
        _expectValidationRevert(
            account, _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.approve, (address(pool), AMOUNT))), quorum
        );
        assertEq(usdc.allowance(address(account), address(pool)), 0, "approve to a stranger spender is refused");

        address[] memory add = new address[](1);
        add[0] = address(pool);
        assertTrue(_allowlist(add), "allowlist the pool");
        assertTrue(
            _executeUserOp(
                account, _executeCalldata(address(usdc), 0, abi.encodeCall(usdc.approve, (address(pool), AMOUNT))), quorum
            ),
            "approve to an allowlisted spender"
        );
        assertEq(usdc.allowance(address(account), address(pool)), AMOUNT, "allowance set");
    }

    /// THE FINDING. The deposit leg is a plain contract call, and `_getTargetOrRecipient` can only
    /// derive a recipient from ERC-20/721/1155 shapes. Anything else yields address(0) and reverts
    /// `UnauthorizedRecipient` — so a pulled deposit is unreachable through execute/executeBatch,
    /// and allowlisting cannot fix it because the failing leg names no recipient to allowlist.
    function test_depositLegIsUnreachableEvenWhenThePoolIsAllowlisted() public {
        address[] memory add = new address[](1);
        add[0] = address(pool);
        assertTrue(_allowlist(add), "allowlist the pool");

        // The approve leg alone now passes (previous test), so anything that still fails is the deposit.
        _expectValidationRevert(
            account, _executeCalldata(address(pool), 0, abi.encodeCall(pool.deposit, (AMOUNT, address(account)))), quorum
        );

        uint256 before = usdc.balanceOf(address(account));
        _expectValidationRevert(account, _shieldBatch(), quorum);
        assertEq(usdc.balanceOf(address(account)), before, "nothing moved");
        assertEq(pool.balanceOf(address(account)), 0, "no shares minted");
    }

    /// And with the pool NOT allowlisted it fails too — for the additional reason that the approve
    /// leg names an unauthorised spender. Recorded so the two causes are not conflated.
    function test_shieldBatchWithPoolNotAllowlisted() public {
        uint256 before = usdc.balanceOf(address(account));
        _expectValidationRevert(account, _shieldBatch(), quorum);
        assertEq(usdc.balanceOf(address(account)), before, "nothing moved");
    }
}
