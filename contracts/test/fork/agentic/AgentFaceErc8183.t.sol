// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {BufiSessionRecipientHookPlugin} from "../../../src/bufi/v0.7/recipient-hook/BufiSessionRecipientHookPlugin.sol";
import {BufiSessionKeyPlugin} from "../../../src/bufi/v0.7/session/BufiSessionKeyPlugin.sol";
import {IBufiSessionKeyPlugin} from "../../../src/bufi/v0.7/session/IBufiSessionKeyPlugin.sol";
import {SessionKeyHarness} from "../../harness/SessionKeyHarness.sol";

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UpgradableMSCA} from "@circle/msca/6900/v0.7/account/UpgradableMSCA.sol";
import {Call, FunctionReference} from "@circle/msca/6900/v0.7/common/Structs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/src/Vm.sol";

/// @notice The ERC-8183 surface BUFI drives, with the exact signatures proven by job 182422 on Arc testnet
///         (`tasks/notes/2026-08-30-arc-native-w2w-8183.md` in desk-v1; every selector re-confirmed against those
///         transactions before this test was written).
interface IErc8183Jobs {
    /// @dev ARGUMENT ORDER CONFIRMED against the proven job 182422, NOT taken from the desk service's parameter
    ///      names: the third word of that live call is `0x6b0b5d53` (a 2026 unix timestamp) and the fifth is
    ///      `address(0)`, so the third argument is a DEADLINE and the amount is supplied later by `setBudget`.
    ///      desk-v1's `w2w-onchain.service.ts` calls the same selector with an amount in that slot, which on Arc
    ///      reads as a deadline in 1973 and reverts `0xf7a0748c` — recorded in the repo notes.
    function createJob(
        address provider,
        address evaluator,
        uint256 deadline,
        string calldata metadata,
        address paymentToken
    ) external returns (uint256);
    function setBudget(uint256 jobId, uint256 amount, bytes calldata data) external;
    function fund(uint256 jobId, bytes calldata data) external;
    function submit(uint256 jobId, bytes32 deliverableHash, bytes calldata data) external;
    function complete(uint256 jobId, bytes32 reasonHash, bytes calldata data) external;
    function reject(uint256 jobId, bytes32 reasonHash, bytes calldata data) external;
}

/**
 * @notice Test doubles for the two Arc precompiles `USDC` calls, neither of which Foundry's EVM implements (both
 *         die with `StackUnderflow` on a fork, taking every token movement down with them).
 *
 *         `ArcComplianceStub` answers "not blocklisted", which is true of every address in this test — a real
 *         blocklist decision cannot be exercised on a Foundry fork of Arc.
 *
 *         `ArcNativeBankStub` is the balance mover. Arc's USDC is the native token, so the predeploy delegates
 *         the actual movement to `0x18…00`. The stub reproduces it faithfully by moving native balance with the
 *         `deal` cheatcode, so escrow accounting and account balances stay consistent with each other.
 */
contract ArcComplianceStub {
    function isBlocklisted(address) external pure returns (bool) {
        return false;
    }
}

contract ArcNativeBankStub {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function transfer(address from, address to, uint256 amount) external returns (bool) {
        require(from.balance >= amount, "ArcNativeBankStub: insufficient balance");
        VM.deal(from, from.balance - amount);
        VM.deal(to, to.balance + amount);
        return true;
    }
}

/**
 * @title AgentFaceErc8183ForkTest
 * @notice The agentic-wallet proof behind `docs/AGENTIC-WALLET.md`, on an **Arc testnet fork**: a Circle
 *         PRODUCTION modular account, owned by a 2-of-3 weighted multisig, runs the buyer side of an ERC-8183 job
 *         on Circle's native Arc contract using nothing but a `BufiSessionKeyPlugin` session key — and the policy
 *         holds when the agent steps outside its grant.
 *
 *         Nothing in Circle's stack is redeployed: the factory, PluginManager, weighted multisig, AddressBook and
 *         EntryPoint are the live production contracts at their canonical addresses on Arc. Only BUFI's recipient
 *         hook is deployed here (the session-key plugin is the live post-fix build).
 *
 *         Run:
 *           cd contracts && FOUNDRY_PROFILE=fork forge test \
 *             --fork-url https://rpc.testnet.arc.network --fork-block-number 60099079 \
 *             --match-contract AgentFaceErc8183ForkTest -vv
 */
contract AgentFaceErc8183ForkTest is SessionKeyHarness {
    /// Circle's native ERC-8183 agentic-commerce contract on Arc testnet.
    IErc8183Jobs internal constant JOBS = IErc8183Jobs(0x0747EEf0706327138c69792bF28Cd525089e4583);
    /// Arc's USDC: the chain's native gas token, also exposed as a 6-decimal ERC-20 predeploy.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    /// Arc's two precompiles behind USDC: the compliance check and the native-balance bank. See the stubs above.
    address internal constant ARC_COMPLIANCE_PRECOMPILE = 0x1800000000000000000000000000000000000001;
    address internal constant ARC_NATIVE_BANK_PRECOMPILE = 0x1800000000000000000000000000000000000000;

    /// `JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, ...)`.
    bytes32 internal constant JOB_CREATED_TOPIC = 0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9;

    uint256 internal constant JOB_AMOUNT = 100e6;
    uint256 internal constant AGENT_BUDGET = 1_000e6;

    BufiSessionRecipientHookPlugin internal hook;

    UpgradableMSCA internal buyer;
    Signer[] internal buyerOwners;
    Signer[] internal buyerQuorum;
    Signer internal buyerAgent;

    UpgradableMSCA internal provider;
    Signer[] internal providerOwners;
    Signer internal providerAgent;

    address internal stranger = makeAddr("stranger");

    function setUp() public {
        require(block.chainid == 5042002, "run with --fork-url <arc testnet rpc>");
        vm.etch(ARC_COMPLIANCE_PRECOMPILE, address(new ArcComplianceStub()).code);
        vm.etch(ARC_NATIVE_BANK_PRECOMPILE, address(new ArcNativeBankStub()).code);
        // The stub moves balances with a cheatcode, which an etched address is not trusted to use by default.
        vm.allowCheatcodes(ARC_NATIVE_BANK_PRECOMPILE);
        vm.label(ARC_COMPLIANCE_PRECOMPILE, "Arc compliance precompile (stub: not blocklisted)");
        vm.label(ARC_NATIVE_BANK_PRECOMPILE, "Arc native bank precompile (stub: moves native balance)");

        _deployCircleCanonicalStack();
        // The live post-fix session-key plugin on Arc (`contracts/deployments/arc-testnet.json`) is what a real
        // agent face installs. Prove the fork is running THAT bytecode rather than a locally compiled copy, then
        // point the harness at it.
        address liveSessionKeyPlugin = 0xBd607dBAC82CF1351C352FB65fC29dE9D0095339;
        assertGt(liveSessionKeyPlugin.code.length, 0, "session key plugin is deployed on Arc");
        sessionKeyPlugin = BufiSessionKeyPlugin(liveSessionKeyPlugin);
        assertEq(
            keccak256(abi.encode(sessionKeyPlugin.pluginManifest())),
            keccak256(abi.encode(new BufiSessionKeyPlugin().pluginManifest())),
            "the deployed manifest matches this source tree"
        );
        hook = new BufiSessionRecipientHookPlugin();

        buyerOwners = _makeSigners("buyer-owner", 3);
        buyer = _createWeightedMsca(buyerOwners, _uniformWeights(3, 1), 2, bytes32(uint256(0xB4E5)));
        buyerQuorum.push(buyerOwners[0]);
        buyerQuorum.push(buyerOwners[1]);
        (buyerAgent.addr, buyerAgent.key) = makeAddrAndKey("buyer-agent");

        providerOwners = _makeSigners("provider-owner", 1);
        provider = _createWeightedMsca(providerOwners, _uniformWeights(1, 1), 1, bytes32(uint256(0x9401)));
        (providerAgent.addr, providerAgent.key) = makeAddrAndKey("provider-agent");

        _fundUsdc(address(buyer), 10_000e6);
        vm.label(address(JOBS), "ERC8183 jobs (Circle, Arc)");
        vm.label(ARC_USDC, "Arc USDC");
    }

    /// @dev Arc's USDC is the chain's NATIVE token surfaced as an ERC-20 predeploy: `balanceOf` reports the
    ///      account's native balance scaled from 18 to 6 decimals, and the predeploy keeps no ledger of its own
    ///      (no balance mapping slot exists to write). Funding is therefore a `vm.deal` of `amount * 1e12`.
    ///      Asserted rather than assumed — if Arc ever gives the predeploy its own storage this stops the run.
    uint256 internal constant USDC_TO_WEI = 1e12;

    function _fundUsdc(address who, uint256 amount) internal {
        vm.deal(who, amount * USDC_TO_WEI);
        assertEq(IERC20(ARC_USDC).balanceOf(who), amount, "Arc USDC balance mirrors the native balance");
    }

    function _installAgentStack(
        UpgradableMSCA account,
        Signer[] memory owners,
        Signer memory agent,
        bytes[] memory permissions,
        address[] memory allowlist
    ) internal {
        assertTrue(_installSessionKeyPlugin(account, owners), "session key plugin installed");
        if (allowlist.length > 0) {
            assertTrue(_installAddressBook(account, allowlist, owners), "address book installed");
            assertTrue(
                _installPlugin(
                    account, address(hook), abi.encode(address(addressBookPlugin)), new FunctionReference[](0), owners
                ),
                "recipient hook installed"
            );
        }
        assertTrue(_addSessionKey(account, agent.addr, bytes32(0), permissions, owners), "agent key granted");
    }

    /// @dev The buyer grant, exactly as `erc8183BuyerGrant` in the SDK emits it.
    function _buyerPermissions() internal view returns (bytes[] memory) {
        bytes[] memory updates = new bytes[](9);
        updates[0] = _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST);
        updates[1] = _permAddressEntry(ARC_USDC, true, true);
        updates[2] = _permFunctionEntry(ARC_USDC, IERC20.approve.selector, true);
        updates[3] = _permFunctionEntry(ARC_USDC, IERC20.transfer.selector, true);
        updates[4] = _permAddressEntry(address(JOBS), true, true);
        updates[5] = _permFunctionEntry(address(JOBS), IErc8183Jobs.createJob.selector, true);
        updates[6] = _permFunctionEntry(address(JOBS), IErc8183Jobs.fund.selector, true);
        updates[7] = _permFunctionEntry(address(JOBS), IErc8183Jobs.reject.selector, true);
        updates[8] = _permErc20Limit(ARC_USDC, AGENT_BUDGET, 86_400);
        return updates;
    }

    function _providerPermissions() internal view returns (bytes[] memory) {
        bytes[] memory updates = new bytes[](4);
        updates[0] = _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST);
        updates[1] = _permAddressEntry(address(JOBS), true, true);
        updates[2] = _permFunctionEntry(address(JOBS), IErc8183Jobs.setBudget.selector, true);
        updates[3] = _permFunctionEntry(address(JOBS), IErc8183Jobs.submit.selector, true);
        return updates;
    }

    function _buyerAllowlist() internal view returns (address[] memory list) {
        list = new address[](2);
        list[0] = address(JOBS);
        list[1] = address(provider);
    }

    function _installBoth() internal {
        _installAgentStack(buyer, buyerQuorum, buyerAgent, _buyerPermissions(), _buyerAllowlist());
        _installAgentStack(provider, providerOwners, providerAgent, _providerPermissions(), new address[](0));
    }

    function _agentCreateJob() internal returns (uint256 jobId) {
        assertTrue(
            _executeSessionKeyUserOp(
                buyer,
                _calls(
                    _call(
                        address(JOBS),
                        0,
                        abi.encodeCall(
                            IErc8183Jobs.createJob,
                            (
                                address(provider),
                                address(buyer),
                                block.timestamp + 30 days,
                                "bufi-6900-agent-face",
                                address(0)
                            )
                        )
                    )
                ),
                buyerAgent
            ),
            "agent created the job"
        );
        jobId = _lastOpIndexedTopic(address(JOBS), JOB_CREATED_TOPIC);
        assertGt(jobId, 0, "jobId decoded from the indexed topic");
    }

    /// @dev The role split is Circle's, not ours, and it is the reverse of what desk's parameter names suggest:
    ///      the PROVIDER states the price with `setBudget`, the buyer funds it. Confirmed against job 182422,
    ///      whose `setBudget` and `submit` user operations were both sent by the provider account.
    function _runJobToFunded() internal returns (uint256 jobId) {
        jobId = _agentCreateJob();
        assertTrue(
            _executeSessionKeyUserOp(
                provider,
                _calls(_call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.setBudget, (jobId, JOB_AMOUNT, "")))),
                providerAgent
            ),
            "provider agent stated the price"
        );
        assertTrue(
            _executeSessionKeyUserOp(
                buyer,
                _calls(_call(ARC_USDC, 0, abi.encodeCall(IERC20.approve, (address(JOBS), JOB_AMOUNT)))),
                buyerAgent
            ),
            "buyer agent approved the jobs contract (allowlisted spender)"
        );
        assertTrue(
            _executeSessionKeyUserOp(
                buyer, _calls(_call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.fund, (jobId, "")))), buyerAgent
            ),
            "buyer agent funded the job"
        );
    }

    function test_agentBuyer_createsAndFundsAJob_withinBudget() public {
        _installBoth();

        uint256 balanceBefore = IERC20(ARC_USDC).balanceOf(address(buyer));
        uint256 jobId = _runJobToFunded();

        assertEq(
            balanceBefore - IERC20(ARC_USDC).balanceOf(address(buyer)),
            JOB_AMOUNT,
            "exactly the job amount left the agent face"
        );
        emit log_named_uint("funded jobId", jobId);
    }

    /// @notice Provider submits, and settlement is attempted both ways. This is where Circle's AddressBook and
    ///         BUFI's hook visibly diverge: `complete(uint256,bytes32,bytes)` carries no token recipient, so
    ///         Circle's plugin — which hooks the owners' `execute` path and fails closed on anything it cannot
    ///         decode — rejects the owners' own settlement, while the hook's target branch lets an agent key
    ///         scoped to `complete` settle against the same allowlisted contract.
    function test_providerSubmits_thenSettlement_ownersBlocked_agentAllowed() public {
        _installBoth();
        uint256 jobId = _runJobToFunded();

        assertTrue(
            _executeSessionKeyUserOp(
                provider,
                _calls(
                    _call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.submit, (jobId, keccak256("deliverable"), "")))
                ),
                providerAgent
            ),
            "provider agent submitted"
        );

        // (a) Owners settling through `execute`: rejected by Circle's ColdStorageAddressBookPlugin, which cannot
        //     decode a recipient from `complete` and fails closed. An AddressBook-gated account cannot settle its
        //     own jobs by hand — the same shape as the Gateway finding in test/bufi/v0.8/gateway/README.md.
        PackedUserOperation memory ownerSettle = _prepareUserOp(
            buyer,
            _executeCalldata(
                address(JOBS), 0, abi.encodeCall(IErc8183Jobs.complete, (jobId, keccak256("accepted"), ""))
            ),
            buyerQuorum
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = ownerSettle;
        vm.expectRevert();
        entryPoint.handleOps(ops, beneficiary);

        // (b) An agent key scoped to `complete` settles: the hook resolves the call by its TARGET, and the jobs
        //     contract is on the AddressBook. Owners grant this deliberately (`includeComplete` in the SDK preset).
        Signer memory settler;
        (settler.addr, settler.key) = makeAddrAndKey("buyer-settler");
        bytes[] memory settleGrant = new bytes[](4);
        settleGrant[0] = _permAccessListType(IBufiSessionKeyPlugin.ContractAccessControlType.ALLOWLIST);
        settleGrant[1] = _permAddressEntry(address(JOBS), true, true);
        settleGrant[2] = _permFunctionEntry(address(JOBS), IErc8183Jobs.complete.selector, true);
        settleGrant[3] = _permErc20Limit(ARC_USDC, 0, 86_400);
        assertTrue(_addSessionKey(buyer, settler.addr, bytes32("settler"), settleGrant, buyerQuorum));

        uint256 providerBefore = IERC20(ARC_USDC).balanceOf(address(provider));
        assertTrue(
            _executeSessionKeyUserOp(
                buyer,
                _calls(
                    _call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.complete, (jobId, keccak256("accepted"), "")))
                ),
                settler
            ),
            "a key scoped to complete settles the job"
        );
        assertGt(IERC20(ARC_USDC).balanceOf(address(provider)), providerBefore, "escrow paid out to the provider face");
    }

    function test_policy_holds() public {
        _installBoth();
        uint256 jobId = _agentCreateJob();

        // Settling is outside the grant: rejected at validation, before the signature is even checked.
        _expectSessionKeyValidationRevert(
            buyer,
            _calls(_call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.complete, (jobId, keccak256("self"), "")))),
            buyerAgent
        );

        // Stating the price is the provider's job; the buyer's key is not scoped to it.
        _expectSessionKeyValidationRevert(
            buyer,
            _calls(_call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.setBudget, (jobId, JOB_AMOUNT, "")))),
            buyerAgent
        );

        // The recipient hook rejects an approval to anything that is not on the AddressBook.
        _expectSessionKeyValidationRevert(
            buyer, _calls(_call(ARC_USDC, 0, abi.encodeCall(IERC20.approve, (stranger, 1e6)))), buyerAgent
        );

        // Over budget: the ERC-20 limit is an execution-phase check, so the operation is included and reverts.
        uint256 balanceBefore = IERC20(ARC_USDC).balanceOf(address(buyer));
        (bool overBudget,) = _executeSessionKeyUserOpWithReason(
            buyer,
            _calls(_call(ARC_USDC, 0, abi.encodeCall(IERC20.approve, (address(JOBS), AGENT_BUDGET + 1)))),
            buyerAgent
        );
        assertFalse(overBudget, "an over-budget approval does not execute");
        assertEq(IERC20(ARC_USDC).balanceOf(address(buyer)), balanceBefore, "no funds moved");

        // Owners revoke; the key is dead immediately.
        bytes32 predecessor = sessionKeyPlugin.findPredecessor(address(buyer), buyerAgent.addr);
        assertTrue(
            _executeUserOp(
                buyer,
                abi.encodeCall(IBufiSessionKeyPlugin.removeSessionKey, (buyerAgent.addr, predecessor)),
                buyerQuorum
            ),
            "owners revoked the agent key"
        );
        _expectSessionKeyValidationRevert(
            buyer, _calls(_call(address(JOBS), 0, abi.encodeCall(IErc8183Jobs.fund, (jobId, "")))), buyerAgent
        );
    }
}
