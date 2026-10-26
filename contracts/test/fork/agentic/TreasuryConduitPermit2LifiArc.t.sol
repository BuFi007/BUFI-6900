// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {TreasuryConduitPermit2} from "../../../src/bufi/conduit/TreasuryConduitPermit2.sol";
import {IPermit2SignatureTransfer} from "../../../src/bufi/conduit/interfaces/IPermit2SignatureTransfer.sol";
import {Permit2ConduitHarness, Permit2TestToken} from "../../bufi/v0.7/conduit/TreasuryConduitPermit2.t.sol";
import {Permit2RpcProbe} from "../../harness/Permit2RpcProbe.sol";
import {IStandardExecutor} from "@circle/msca/6900/v0.7/interfaces/IStandardExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Executes a captured, unsigned LI.FI advanced route on a local Arc fork only.
contract TreasuryConduitPermit2LifiArcTest is Permit2ConduitHarness {
    address internal constant WARS = 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D;
    address internal constant WBRL = 0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0;
    string internal captured;

    function _fixturePath() internal pure virtual returns (string memory) {
        return "test/fixtures/permit2-lifi-arc-swap.json";
    }

    function _documentCommitment() internal pure virtual returns (bytes32) {
        return bytes32(0);
    }

    function setUp() public override {
        captured = vm.readFile(_fixturePath());
        uint256 forkBlock = vm.parseJsonUint(captured, ".blockNumber");
        vm.createSelectFork(vm.envString("ARC_PERMIT2_FORK_RPC"), forkBlock);
        require(block.chainid == 5042, "wrong fork");
        uint256 forkTimestamp = vm.getBlockTimestamp();
        super.setUp();
        vm.warp(forkTimestamp);
        // Use the exact Paris release runtime; the fork interpreter must still support the live router's opcodes.
        address release = deployCode(
            "out-permit2-release/TreasuryConduitPermit2.sol/TreasuryConduitPermit2.json",
            abi.encode(SAFE, PERMIT2, address(addressBookPlugin))
        );
        vm.etch(address(conduit), release.code);
        assertEq(address(conduit).codehash, 0x55eb4131767006c7386b08a936071d951c1474c0016680959f8feba0a2b45b79);
        input = Permit2TestToken(WARS);
        output = Permit2TestToken(WBRL);
        assertEq(address(conduit), vm.parseJsonAddress(captured, ".executor"));
        assertEq(
            _documentCommitment() == bytes32(0) ? address(treasury) : RECIPIENT,
            vm.parseJsonAddress(captured, ".recipient")
        );
        assertEq(vm.getBlockTimestamp(), vm.parseJsonUint(captured, ".timestamp"));
    }

    function _installPermit2Runtime() internal view override {
        assertEq(PERMIT2.codehash, 0x05a793d6bdba8b8715c8f4cef0725ec3a961f567d33ebb2d360f541f19f70c8f);
    }

    function test_fork_dependencies_and_local_quorum_ready() public {
        assertGt(WARS.code.length, 0);
        assertGt(WBRL.code.length, 0);
        emit log_named_address("local conduit", address(conduit));
        emit log_named_address("local treasury", address(treasury));
        emit log_named_address("local document recipient", RECIPIENT);
        emit log_named_uint("fork block", block.number);
    }

    function test_export_read_only_arc_simulation() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 101);
        bytes memory callData = abi.encodeCall(
            TreasuryConduitPermit2.executePermit2, (permit, address(treasury), _sign(intent, permit, 2), intent)
        );
        bytes memory probeData = abi.encodeCall(
            Permit2RpcProbe.simulate,
            (
                address(conduit),
                address(treasury),
                WARS,
                WBRL,
                intent.recipient,
                intent.allowanceTarget,
                intent.operationId,
                callData
            )
        );
        string memory name = _documentCommitment() == bytes32(0)
            ? "swap"
            : (_documentCommitment() == keccak256("local-invoice-frozen-terms") ? "invoice" : "reimbursement");
        string memory path = string.concat("deployments/local/permit2-native-", name);
        vm.serializeAddress(name, "conduit", address(conduit));
        vm.serializeAddress(name, "treasury", address(treasury));
        vm.serializeBytes32(name, "runtimeCodeHash", address(conduit).codehash);
        vm.serializeUint(name, "blockNumber", block.number);
        vm.serializeString(name, "minOut", vm.toString(intent.minOut));
        vm.serializeBytes(name, "probeCode", type(Permit2RpcProbe).runtimeCode);
        intent.minOut = type(uint256).max;
        IPermit2SignatureTransfer.PermitTransferFrom memory rejectedPermit = _permit(intent, 102);
        bytes memory rejectedData = abi.encodeCall(
            TreasuryConduitPermit2.executePermit2,
            (rejectedPermit, address(treasury), _sign(intent, rejectedPermit, 2), intent)
        );
        vm.serializeBytes(
            name,
            "belowFloorData",
            abi.encodeCall(
                Permit2RpcProbe.simulateFailure,
                (address(conduit), address(treasury), WARS, WBRL, intent.recipient, intent.operationId, rejectedData)
            )
        );
        string memory json = vm.serializeBytes(name, "probeData", probeData);
        vm.writeJson(json, string.concat(path, ".input.json"));
        // Fork dumps omit some clean/read-only cells; capture every cell used by the real call explicitly.
        vm.record();
        (bool localSuccess,) = address(conduit).call{gas: 5_000_000}(callData);
        require(!localSuccess, "native Arc simulation no longer required");
        address[9] memory accounts = [
            address(treasury),
            address(weightedPlugin),
            address(addressBookPlugin),
            PERMIT2,
            WARS,
            WBRL,
            address(
                uint160(uint256(vm.load(WARS, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))
            ),
            address(
                    uint160(uint256(vm.load(WBRL, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))
                ),
            address(conduit)
        ];
        string memory allStates;
        for (uint256 i; i < accounts.length; ++i) {
            (bytes32[] memory slots,) = vm.accesses(accounts[i]);
            if (slots.length == 0) continue;
            string memory key = vm.toString(accounts[i]);
            string memory state;
            for (uint256 j; j < slots.length; ++j) {
                state = vm.serializeBytes32(key, vm.toString(slots[j]), vm.load(accounts[i], slots[j]));
            }
            allStates = vm.serializeString("readStates", key, state);
        }
        vm.writeJson(allStates, string.concat(path, ".read-state.json"));
        vm.dumpState(string.concat(path, ".state.json"));
    }

    function _route() internal returns (TreasuryConduitPermit2.Permit2Intent memory intent) {
        intent = _intent();
        intent.target = vm.parseJsonAddress(captured, ".addresses.router");
        intent.allowanceTarget = vm.parseJsonAddress(captured, ".addresses.spender");
        intent.data = vm.parseJsonBytes(captured, ".prepared.tx.data");
        intent.tokenIn = WARS;
        intent.tokenOut = WBRL;
        intent.recipient = vm.parseJsonAddress(captured, ".recipient");
        intent.documentCommitment = _documentCommitment();
        intent.amountIn = vm.parseJsonUint(captured, ".prepared.executionRequirements.input.amount");
        intent.minOut = vm.parseJsonUint(captured, ".quote._raw.step.estimate.toAmountMin");
        intent.deadline = vm.parseJsonUint(captured, ".quote.expiresAt") / 1000;
        assertEq(vm.parseJsonUint(captured, ".prepared.tx.value"), 0);
        assertEq(intent.target.codehash, vm.parseJsonBytes32(captured, ".codeHashes.router"));
        assertEq(intent.allowanceTarget.codehash, vm.parseJsonBytes32(captured, ".codeHashes.spender"));
        assertEq(WARS.codehash, vm.parseJsonBytes32(captured, ".codeHashes.tokenIn"));
        assertEq(WBRL.codehash, vm.parseJsonBytes32(captured, ".codeHashes.tokenOut"));
        vm.prank(SAFE);
        conduit.setPermit2Route(intent.target, intent.allowanceTarget, true);
        deal(WARS, address(treasury), intent.amountIn * 2);
        _approve(intent.amountIn);
    }

    function _approve(uint256 amount) internal {
        assertTrue(
            _executeUserOp(
                treasury,
                abi.encodeCall(IStandardExecutor.execute, (WARS, 0, abi.encodeCall(IERC20.approve, (PERMIT2, amount)))),
                quorum
            )
        );
    }

    function test_real_lifi_route_refuses_incomplete_quorum() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 102);
        bytes memory sig = _sign(intent, permit, 1);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
        assertEq(IERC20(WARS).balanceOf(address(treasury)), intent.amountIn * 2);
    }

    function test_real_lifi_route_refuses_insufficient_allowance() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        _approve(intent.amountIn - 1);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 103);
        bytes memory sig = _sign(intent, permit, 2);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_real_lifi_changed_calldata_cannot_reuse_signature() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 107);
        bytes memory sig = _sign(intent, permit, 2);
        intent.data = bytes.concat(intent.data, hex"01");
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }

    function test_real_lifi_expired_authorization_cannot_execute() public {
        TreasuryConduitPermit2.Permit2Intent memory intent = _route();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 108);
        bytes memory sig = _sign(intent, permit, 2);
        vm.warp(intent.deadline);
        vm.expectRevert();
        conduit.executePermit2(permit, address(treasury), sig, intent);
        assertFalse(conduit.executed(address(treasury), intent.operationId));
    }
}

contract TreasuryConduitPermit2LifiInvoiceArcTest is TreasuryConduitPermit2LifiArcTest {
    function _fixturePath() internal pure override returns (string memory) {
        return "test/fixtures/permit2-lifi-arc-document.json";
    }

    function _documentCommitment() internal pure virtual override returns (bytes32) {
        return keccak256("local-invoice-frozen-terms");
    }
}

contract TreasuryConduitPermit2LifiReimbursementArcTest is TreasuryConduitPermit2LifiInvoiceArcTest {
    function _documentCommitment() internal pure override returns (bytes32) {
        return keccak256("local-reimbursement-approved-item-versions");
    }
}
