// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {SessionKeyHarness} from "../harness/SessionKeyHarness.sol";

import {BufiSessionRecipientHookPlugin} from "../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SandboxUSDC} from "../../src/sandbox/SandboxUSDC.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The two properties an agent grant is supposed to guarantee, asserted over ARBITRARY sequences of
///         session-key operations rather than the hand-picked ones the unit suites run.
///
///         Both are properties of BUFI code — the session-key plugin's spend accounting and the recipient hook's
///         allowlist — not of Circle's vendored stack, which is exercised here only as the account the two run on.
///
///         The handler deliberately asks for amounts ABOVE the budget and recipients OUTSIDE the allowlist. Those
///         ops are expected to be rejected in the EntryPoint's validation phase, so `handleOps` reverts and the
///         handler swallows it (the suite runs with `fail_on_revert = true`). A rejection is the system working;
///         the invariant is what must hold after every accepted AND rejected attempt.
contract AgentEnvelopeInvariantTest is SessionKeyHarness {
    BufiSessionRecipientHookPlugin internal hook;
    SandboxUSDC internal usdc;

    UpgradableMSCA internal account;
    Signer internal agent;

    address[] internal allowlist;
    address[] internal strangers;

    uint256 internal constant FUNDING = 1_000e6;
    uint256 internal constant AGENT_BUDGET = 100e6;

    /// @dev Handler bookkeeping, surfaced by `invariant_callSummary` so a run that rejected everything cannot be
    ///      mistaken for a run that proved something.
    uint256 public accepted;
    uint256 public rejected;

    function setUp() public {
        _deployCircleCanonicalStack();
        _deploySessionKeyPlugin();
        hook = new BufiSessionRecipientHookPlugin();
        usdc = new SandboxUSDC();
        agent = _signerFrom("agent");

        allowlist.push(makeAddr("payee-a"));
        allowlist.push(makeAddr("payee-b"));
        strangers.push(makeAddr("stranger-a"));
        strangers.push(makeAddr("stranger-b"));

        Signer[] memory owners = _makeSigners("owner", 3);
        account = _createWeightedMsca(owners, _uniformWeights(3, 1), 2, bytes32(uint256(0x1117)));
        Signer[] memory quorum = new Signer[](2);
        quorum[0] = owners[0];
        quorum[1] = owners[1];

        assertTrue(_installAddressBook(account, allowlist, quorum), "address book install");
        assertTrue(_installSessionKeyPlugin(account, quorum), "session key plugin install");
        assertTrue(
            _installPlugin(account, address(hook), abi.encode(address(addressBookPlugin)), _noDeps(), quorum),
            "hook install"
        );
        assertTrue(_addSessionKey(account, agent.addr, quorum), "grant session key");
        assertTrue(
            _updateKeyPermissions(
                account,
                agent.addr,
                _updates(
                    _permAddressEntry(address(usdc), true, true),
                    _permFunctionEntry(address(usdc), usdc.transfer.selector, true),
                    _permErc20Limit(address(usdc), AGENT_BUDGET, 0)
                ),
                quorum
            ),
            "scope the grant"
        );

        usdc.mint(address(account), FUNDING);

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = this.handler_transferToAllowlisted.selector;
        selectors[1] = this.handler_transferToStranger.selector;
        selectors[2] = this.handler_passTime.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
        targetContract(address(this));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Handlers                                                                       ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @dev Amounts range well past the budget on purpose: the interesting sequences are the ones that walk the
    ///      spend right up to the limit and then try to cross it.
    function handler_transferToAllowlisted(uint256 seed, uint256 amount) public {
        _attemptTransfer(allowlist[seed % allowlist.length], _bound(amount, 0, AGENT_BUDGET * 2));
    }

    function handler_transferToStranger(uint256 seed, uint256 amount) public {
        _attemptTransfer(strangers[seed % strangers.length], _bound(amount, 0, AGENT_BUDGET * 2));
    }

    /// @dev The grant has no refresh interval, so time must never restore budget. Jumping around proves it.
    function handler_passTime(uint256 dt) public {
        vm.warp(block.timestamp + _bound(dt, 1, 30 days));
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Invariants                                                                     ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    /// @notice The agent can never spend more than it was granted, however the sequence is arranged, and the
    ///         account can never be drained past the envelope even though it holds 10x the budget.
    function invariant_agentNeverSpendsBeyondItsGrant() public view {
        IBufiSessionKeyPlugin.SpendLimitInfo memory info =
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc));
        assertTrue(info.hasLimit, "the grant still carries an ERC-20 limit");
        assertEq(info.limit, AGENT_BUDGET, "no handler can widen the limit");
        assertLe(info.limitUsed, info.limit, "recorded spend never exceeds the limit");
        assertGe(usdc.balanceOf(address(account)), FUNDING - AGENT_BUDGET, "account drained at most by the budget");
    }

    /// @notice The recipient hook's reason to exist: no token reaches an address outside the account's
    ///         AddressBook, no matter what the agent asks for.
    function invariant_noTokenEverReachesAnUnlistedAddress() public view {
        for (uint256 i = 0; i < strangers.length; i++) {
            assertEq(usdc.balanceOf(strangers[i]), 0, "unlisted address received tokens");
        }
    }

    /// @notice Conservation: every token that left the account is sitting at an allowlisted address.
    function invariant_everySpentTokenIsAtAnAllowlistedAddress() public view {
        uint256 out;
        for (uint256 i = 0; i < allowlist.length; i++) {
            out += usdc.balanceOf(allowlist[i]);
        }
        assertEq(usdc.balanceOf(address(account)) + out, FUNDING, "USDC conserved between account and allowlist");
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Non-vacuity                                                                    ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
    //
    // Three invariants that hold because nothing ever happened would pass just as green. These two tests are
    // deterministic proof that the handlers move real state in BOTH directions — one accepted op, one rejected —
    // so a green invariant run means the properties survived activity rather than silence.
    //
    // They are plain tests, not a fourth invariant: foundry evaluates invariants against the INITIAL state too,
    // where no handler has run yet, so `accepted + rejected > 0` is false there by construction.

    function test_handlerAcceptsAnInBudgetTransferToAnAllowlistedPayee() public {
        address payee = allowlist[0];
        _attemptTransfer(payee, 10e6);

        assertEq(accepted, 1, "op accepted");
        assertEq(rejected, 0);
        assertEq(usdc.balanceOf(payee), 10e6, "payee received the tokens");
        assertEq(
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc)).limitUsed,
            10e6,
            "spend recorded against the grant"
        );
    }

    function test_handlerRejectsATransferToAStranger() public {
        address stranger = strangers[0];
        _attemptTransfer(stranger, 10e6);

        assertEq(rejected, 1, "op rejected in the validation phase");
        assertEq(accepted, 0);
        assertEq(usdc.balanceOf(stranger), 0, "stranger received nothing");
        assertEq(
            sessionKeyPlugin.getERC20SpendLimitInfo(address(account), agent.addr, address(usdc)).limitUsed,
            0,
            "a rejected op consumes no budget"
        );
    }

    // ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
    // ┃  Internals                                                                      ┃
    // ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

    function _attemptTransfer(address to, uint256 amount) internal {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({target: address(usdc), value: 0, data: abi.encodeCall(IERC20.transfer, (to, amount))});

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = _prepareSessionKeyUserOp(account, calls, agent);

        // A rejection is the system working, so it must not fail the handler under `fail_on_revert = true`.
        try entryPoint.handleOps(ops, beneficiary) {
            accepted++;
        } catch {
            rejected++;
        }
    }

    function _noDeps() internal pure returns (FunctionReference[] memory) {
        return new FunctionReference[](0);
    }
}
